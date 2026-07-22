import {
  getIngestStats,
  getPendingBattleItems,
  markBattleIngest,
  saveBattle,
  type StoredItem,
} from '../db/index.js'
import { loadBattleData } from './battle-data.js'
import { isWorkerPoolSchedulingError } from '../workers/pool.js'
import { dropReplayCache } from './replay-cache.js'
import { realNamesFromItem, replayPartUrls } from './replay.js'

/**
 * Фоновый разбор боёв (ingest).
 *
 * Парсер wt-replays кладёт в items только ответ сайта (карта, время, ники) —
 * фрагов, очков, техники и победителя там нет. Всё это лежит в самом файле
 * реплея на CDN, который живёт ~2 недели. Воркер берёт ещё не разобранные
 * записи, скачивает части, разбирает results-BLK и пакетный поток и
 * раскладывает бой по нормализованным таблицам (battles / battle_players /
 * battle_kills / battle_chat). После успеха части реплея с диска удаляются —
 * данные уже в БД, реплей больше не нужен.
 *
 * Это разбирает и накопленный бэклог (все item'ы, что собраны до включения
 * воркера), и новые бои по мере их появления. Новые (больший id) идут
 * первыми: их части точно ещё живы на CDN.
 */

/** Две волны поддерживают рассчитанную загрузку CPU без вечного захвата backlog. */
const BATCH_MULTIPLIER = 2
/** Как часто просыпаться */
const TICK_MS = 20_000
/** Сколько раз повторять разбор боя при временных ошибках, прежде чем сдаться */
export const INGEST_MAX_ATTEMPTS = 3
/** Минимальный интервал между стартами загрузки разных боёв — вежливость к CDN. */
const PAUSE_MS = 500

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve()
    return
  }
  const done = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, { once: true })
})

let timer: NodeJS.Timeout | null = null
let busy = false
let stopping = false
let activeTick: Promise<void> | null = null
let currentAbort: AbortController | null = null
let ingestConcurrency = 1
/** Логируем размер бэклога один раз, чтобы не спамить в консоль каждый тик */
let backlogLogged = false

/** HTTP 404/410 от CDN — части ушли, повторять бесполезно */
function isExpired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP (404|410)\b/.test(msg)
}

async function ingestOne(
  item: StoredItem,
  signal: AbortSignal,
): Promise<'ok' | 'no_parts' | 'expired' | 'error' | 'cancelled' | 'deferred'> {
  const data = item.data as {
    missionName?: string
    gameMode?: string
    gameVersion?: string
    replayParts?: string[] | null
    url?: string
    partsCount?: number
    players?: unknown
  }
  const parts = replayPartUrls(data)
  if (parts.length === 0) {
    markBattleIngest(item.externalId, 'no_parts', 'нет ссылок на части реплея')
    return 'no_parts'
  }

  try {
    const loaded = await loadBattleData(
      parts,
      realNamesFromItem(data),
      { missionName: data.missionName, gameMode: data.gameMode, gameVersion: data.gameVersion },
      'background',
      signal,
    )
    if (signal.aborted) return 'cancelled'
    saveBattle(loaded.battle)
    markBattleIngest(item.externalId, 'ok')
    await dropReplayCache(loaded.header.sessionIdHex)
    const events = loaded.summary
    console.log(
      `[ingest] бой ${item.externalId} (${item.title.trim()}): ` +
        `игроков ${loaded.results.players.length}, убийств ${events.kills}, ` +
        `победитель ${events.teamWon > 0 ? `команда ${events.teamWon}` : '?'}`,
    )
    return 'ok'
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return 'cancelled'
    const message = err instanceof Error ? err.message : String(err)
    if (isWorkerPoolSchedulingError(err)) {
      console.warn(`[ingest] бой ${item.externalId}: CPU scheduler занят (${message}); попытка не расходуется`)
      return 'deferred'
    }
    if (isExpired(err)) {
      markBattleIngest(item.externalId, 'expired', message)
      console.warn(`[ingest] бой ${item.externalId}: части ушли с CDN — пропускаю`)
      return 'expired'
    }
    markBattleIngest(item.externalId, 'error', message)
    console.warn(`[ingest] бой ${item.externalId}: ${message}`)
    return 'error'
  }
}

/**
 * Загружает независимые бои параллельно, но разносит старты CDN-запросов.
 * SQLite commit остаётся последовательным в main thread, а тяжёлый WRPL-
 * разбор ограничивает общий CPU pool.
 */
async function ingestBatch(items: StoredItem[], concurrency: number, signal: AbortSignal): Promise<void> {
  let nextIndex = 0
  let nextStartAt = Date.now()
  const waitForStartSlot = async (): Promise<void> => {
    const now = Date.now()
    const startAt = Math.max(now, nextStartAt)
    nextStartAt = startAt + PAUSE_MS
    const delay = startAt - now
    if (delay > 0) await sleep(delay, signal)
  }
  const runner = async (): Promise<void> => {
    while (!signal.aborted && !stopping) {
      const item = items[nextIndex++]
      if (!item) return
      await waitForStartSlot()
      if (signal.aborted || stopping) return
      await ingestOne(item, signal)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
  )
}

async function tick(): Promise<void> {
  if (busy || stopping) return
  busy = true
  const controller = new AbortController()
  currentAbort = controller
  try {
    const concurrency = ingestConcurrency
    const pending = getPendingBattleItems(INGEST_MAX_ATTEMPTS, concurrency * BATCH_MULTIPLIER)
    if (pending.length === 0) return

    if (!backlogLogged) {
      backlogLogged = true
      const s = getIngestStats()
      if (s.pending > 0) console.log(`[ingest] в очереди на разбор: ${s.pending} боёв (уже разобрано ${s.ingested})`)
    }

    await ingestBatch(pending, concurrency, controller.signal)
  } catch (err) {
    console.error(`[ingest] сбой тика: ${(err as Error).message}`)
  } finally {
    if (currentAbort === controller) currentAbort = null
    busy = false
  }
}

export function startIngestWorker(concurrency = 1): void {
  stopping = false
  ingestConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1
  const s = getIngestStats()
  console.log(
    `[ingest] воркер запущен · разобрано боёв: ${s.ingested}, в очереди: ${s.pending}` +
      ` · параллельность ${ingestConcurrency}`,
  )
  scheduleTick()
  timer = setInterval(scheduleTick, TICK_MS)
  timer.unref()
}

function scheduleTick(): void {
  if (activeTick || stopping) return
  activeTick = tick().finally(() => {
    activeTick = null
  })
}

export async function stopIngestWorker(): Promise<void> {
  stopping = true
  currentAbort?.abort()
  if (timer) clearInterval(timer)
  timer = null
  await activeTick
}
