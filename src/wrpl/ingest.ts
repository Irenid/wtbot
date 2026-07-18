import {
  getIngestStats,
  getPendingBattleItems,
  markBattleIngest,
  saveBattle,
  type StoredItem,
} from '../db/index.js'
import { buildBattleInput, loadBattleData } from './battle-data.js'
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

/** Сколько боёв разбирать за один тик */
const BATCH = 2
/** Как часто просыпаться */
const TICK_MS = 20_000
/** Сколько раз повторять разбор боя при временных ошибках, прежде чем сдаться */
export const INGEST_MAX_ATTEMPTS = 3
/** Пауза между боями внутри тика — вежливость к CDN */
const PAUSE_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let timer: NodeJS.Timeout | null = null
let busy = false
/** Логируем размер бэклога один раз, чтобы не спамить в консоль каждый тик */
let backlogLogged = false

/** HTTP 404/410 от CDN — части ушли, повторять бесполезно */
function isExpired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP (404|410)\b/.test(msg)
}

async function ingestOne(item: StoredItem): Promise<'ok' | 'no_parts' | 'expired' | 'error'> {
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
    const loaded = await loadBattleData(parts, realNamesFromItem(data))
    saveBattle(
      buildBattleInput(
        { missionName: data.missionName, gameMode: data.gameMode, gameVersion: data.gameVersion },
        loaded,
      ),
    )
    markBattleIngest(item.externalId, 'ok')
    dropReplayCache(loaded.header.sessionIdHex)
    const ev = loaded.events
    console.log(
      `[ingest] бой ${item.externalId} (${item.title.trim()}): ` +
        `игроков ${loaded.results.players.length}, убийств ${ev.kills.length}, ` +
        `победитель ${ev.teamWon > 0 ? `команда ${ev.teamWon}` : '?'}`,
    )
    return 'ok'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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

async function tick(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const pending = getPendingBattleItems(INGEST_MAX_ATTEMPTS, BATCH)
    if (pending.length === 0) return

    if (!backlogLogged) {
      backlogLogged = true
      const s = getIngestStats()
      if (s.pending > 0) console.log(`[ingest] в очереди на разбор: ${s.pending} боёв (уже разобрано ${s.ingested})`)
    }

    for (let i = 0; i < pending.length; i++) {
      if (i > 0) await sleep(PAUSE_MS)
      await ingestOne(pending[i]!)
    }
  } catch (err) {
    console.error(`[ingest] сбой тика: ${(err as Error).message}`)
  } finally {
    busy = false
  }
}

export function startIngestWorker(): void {
  const s = getIngestStats()
  console.log(`[ingest] воркер запущен · разобрано боёв: ${s.ingested}, в очереди: ${s.pending}`)
  void tick()
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref()
}

export function stopIngestWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
