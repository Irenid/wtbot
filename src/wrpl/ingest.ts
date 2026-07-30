import path from 'node:path'
import {
  BATTLE_INGEST_MAX_ATTEMPTS,
  getIngestStats,
  getPendingBattleItems,
  markBattleIngest,
  type PendingBattleItem,
} from '../db/index.js'
import { loadBattleData } from './battle-data.js'
import {
  isWorkerPoolSchedulingError,
  runWorkerTask,
  transferableBuffer,
} from '../workers/pool.js'
import { dropReplayCache, replayFetchAdmissionSnapshot } from './replay-cache.js'
import {
  ReplayPartsFetchError,
  isReplayByteBudgetSchedulingError,
  replayProcessByteBudgetSnapshot,
} from './replay-events.js'
import { realNamesFromItem, replayPartUrls } from './replay.js'
import {
  shouldContinueIngestImmediately,
  type IngestOutcome,
} from './ingest-scheduler.js'
import {
  IngestTelemetryAccumulator,
  type IngestBattleTelemetry,
  type IngestTelemetrySnapshot,
} from './ingest-telemetry.js'
import {
  IngestAdmissionController,
  type IngestAdmissionSnapshot,
} from './ingest-admission.js'

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
export const INGEST_MAX_ATTEMPTS = BATTLE_INGEST_MAX_ATTEMPTS
/** Минимальный интервал между стартами загрузки разных боёв — вежливость к CDN. */
const PAUSE_MS = 500
const TELEMETRY_LOG_MS = 60_000

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
let ingestDbPath: string | null = null
/** Логируем размер бэклога один раз, чтобы не спамить в консоль каждый тик */
let backlogLogged = false
let lastTelemetryLogAtMs = 0
const ingestTelemetry = new IngestTelemetryAccumulator()
let admission: IngestAdmissionController | null = null
/**
 * SQLite допускает только одного writer. Сериализация оставляет один persist
 * task в полёте, а сам fsync/checkpoint выполняет CPU worker вне event loop.
 */
let sqliteCommitTail: Promise<void> = Promise.resolve()

async function runSerializedSqliteCommit<T>(work: () => T | Promise<T>): Promise<T> {
  const previous = sqliteCommitTail
  let release!: () => void
  sqliteCommitTail = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await previous
    await new Promise<void>((resolve) => setImmediate(resolve))
    return await work()
  } finally {
    release()
  }
}

/** HTTP 404/410 от CDN — части ушли, повторять бесполезно */
function isExpired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP (404|410)\b/.test(msg)
}

async function ingestOne(
  item: PendingBattleItem,
  signal: AbortSignal,
  telemetry: IngestBattleTelemetry,
): Promise<IngestOutcome> {
  let outcome: IngestOutcome = 'error'
  let terminalAtMs: number | undefined
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
    outcome = 'no_parts'
    telemetry.finish(outcome)
    return outcome
  }

  try {
    telemetry.startDownload()
    const loaded = await loadBattleData(
      parts,
      realNamesFromItem(data),
      { missionName: data.missionName, gameMode: data.gameMode, gameVersion: data.gameVersion },
      'background',
      signal,
      undefined,
      (event) => {
        if (event.phase === 'replay-ready') {
          telemetry.replayReady(event.replay, event.atMs)
        } else if (event.phase === 'worker-submitted') {
          telemetry.parseSubmitted(event.inputBytes, event.atMs)
        } else {
          telemetry.parseFinished(event.worker, event.atMs)
        }
      },
    )
    if (signal.aborted) {
      outcome = 'cancelled'
      return outcome
    }
    const dbPath = ingestDbPath
    if (!dbPath) throw new Error('не задан путь SQLite для ingest worker')
    const sqliteQueuedAt = performance.now()
    const eventsBlob = transferableBuffer(loaded.battle.eventsBlob)
    telemetry.persistQueued(eventsBlob.byteLength)
    const persisted = await runSerializedSqliteCommit(async () => {
      if (signal.aborted || stopping) return null
      telemetry.persistStarted()
      return await runWorkerTask(
        {
          kind: 'persist-ingested-battle',
          input: {
            dbPath,
            sessionId: item.externalId,
            battle: { ...loaded.battle, eventsBlob },
          },
        },
        {
          priority: 'normal',
          transferList: [eventsBlob],
          signal,
        },
      )
    })
    if (persisted === null) {
      outcome = 'cancelled'
      return outcome
    }
    const { committedAtMs, sqliteMs, transactionMs, checkpointMs } = persisted
    terminalAtMs = committedAtMs
    telemetry.persistFinished(committedAtMs, sqliteMs)
    const sqliteQueueMs = Math.max(0, performance.now() - sqliteQueuedAt - sqliteMs)
    telemetry.persistTiming(sqliteQueueMs, transactionMs, checkpointMs)
    admission?.observePersist(sqliteQueueMs)
    await dropReplayCache(loaded.header.sessionIdHex)
    const events = loaded.summary
    console.log(
      `[ingest] бой ${item.externalId} (${item.title.trim()}): ` +
        `игроков ${loaded.results.players.length}, убийств ${events.kills}, ` +
        `победитель ${events.teamWon > 0 ? `команда ${events.teamWon}` : '?'}`,
    )
    logIngestTiming(
      item,
      loaded.timing,
      committedAtMs,
      sqliteQueueMs,
      sqliteMs,
      transactionMs,
      checkpointMs,
    )
    outcome = 'ok'
    return outcome
  } catch (err) {
    if (err instanceof ReplayPartsFetchError) {
      telemetry.replayFailed(err.timing)
      if (!signal.aborted) logReplayFailureTiming(item, err)
    }
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      outcome = 'cancelled'
      return outcome
    }
    const message = err instanceof Error ? err.message : String(err)
    if (isReplayByteBudgetSchedulingError(err)) {
      console.warn(`[ingest] бой ${item.externalId}: memory budget занят (${message}); попытка не расходуется`)
      outcome = 'deferred'
      return outcome
    }
    if (isWorkerPoolSchedulingError(err)) {
      console.warn(`[ingest] бой ${item.externalId}: CPU scheduler занят (${message}); попытка не расходуется`)
      outcome = 'deferred'
      return outcome
    }
    if (isExpired(err)) {
      markBattleIngest(item.externalId, 'expired', message)
      console.warn(`[ingest] бой ${item.externalId}: части ушли с CDN — пропускаю`)
      outcome = 'expired'
      return outcome
    }
    markBattleIngest(item.externalId, 'error', message)
    console.warn(`[ingest] бой ${item.externalId}: ${message}`)
    outcome = 'error'
    return outcome
  } finally {
    telemetry.finish(outcome, terminalAtMs)
  }
}

/**
 * Загружает независимые бои параллельно, но разносит старты CDN-запросов.
 * SQLite commit остаётся последовательным вне main thread, а тяжёлый WRPL-
 * разбор ограничивает общий CPU pool.
 */
async function ingestBatch(
  items: PendingBattleItem[],
  concurrency: number,
  signal: AbortSignal,
): Promise<IngestOutcome[]> {
  let nextIndex = 0
  let nextStartAt = Date.now()
  const outcomes = new Array<IngestOutcome | undefined>(items.length)
  const telemetry = items.map((item) => ingestTelemetry.beginBattle(item.firstSeenAt * 1_000))
  const waitForStartSlot = async (): Promise<void> => {
    const now = Date.now()
    const startAt = Math.max(now, nextStartAt)
    nextStartAt = startAt + PAUSE_MS
    const delay = startAt - now
    if (delay > 0) await sleep(delay, signal)
  }
  const runner = async (): Promise<void> => {
    while (!signal.aborted && !stopping) {
      const index = nextIndex++
      const item = items[index]
      if (!item) return
      await waitForStartSlot()
      if (signal.aborted || stopping) return
      outcomes[index] = await ingestOne(item, signal, telemetry[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
  )
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index] === undefined) telemetry[index]!.finish('cancelled')
  }
  return outcomes.filter((outcome): outcome is IngestOutcome => outcome !== undefined)
}

function logIngestTiming(
  item: PendingBattleItem,
  timing: Awaited<ReturnType<typeof loadBattleData>>['timing'],
  committedAtMs: number,
  sqliteQueueMs: number,
  sqliteMs: number,
  sqliteTransactionMs: number,
  sqliteCheckpointMs: number,
): void {
  const discoveredAtMs = item.firstSeenAt * 1000
  const replay = timing.replay
  const worker = timing.worker
  console.log(
    `[ingest:timing] бой ${item.externalId}: ` +
      `discovered→cache ${formatMs(timing.replayReadyAtMs - discoveredAtMs)}, ` +
      `replay ${formatMs(replay.totalMs)} ` +
      `(${replay.cacheHits}/${replay.requestedParts} cache, ${formatMiB(replay.bytes)}, ` +
      `${replay.retries} retry), ` +
      `cache→parsed ${formatMs(timing.workerFinishedAtMs - timing.replayReadyAtMs)} ` +
      `(input ${formatMs(timing.inputPrepareMs)}, queue ${formatMs(worker?.queueMs ?? 0)}, ` +
      `exec ${formatMs(worker?.executionMs ?? timing.workerWallMs)}), ` +
      `SQLite ${formatMs(sqliteMs)} (queue ${formatMs(sqliteQueueMs)}, ` +
      `write ${formatMs(sqliteTransactionMs)}, checkpoint ${formatMs(sqliteCheckpointMs)}), ` +
      `discovered→commit ${formatMs(committedAtMs - discoveredAtMs)}`,
  )
}

function logReplayFailureTiming(item: PendingBattleItem, error: ReplayPartsFetchError): void {
  const timing = error.timing
  console.warn(
    `[ingest:timing] бой ${item.externalId}: replay ${timing.outcome} за ${formatMs(timing.totalMs)}, ` +
      `${timing.completedParts}/${timing.requestedParts} частей, ` +
      `${timing.retries} retry, ${timing.httpErrors} HTTP errors, ${formatMiB(timing.bytes)}`,
  )
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '?'
  const duration = Math.max(0, value)
  if (duration >= 10_000) return `${(duration / 1000).toFixed(1)} с`
  return `${duration.toFixed(1)} мс`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МиБ`
}

export function getIngestTelemetrySnapshot(): IngestTelemetrySnapshot & {
  replayProcessByteBudget: ReturnType<typeof replayProcessByteBudgetSnapshot>
  replayFetchAdmission: ReturnType<typeof replayFetchAdmissionSnapshot>
  admission: IngestAdmissionSnapshot | null
} {
  return {
    ...ingestTelemetry.snapshot(),
    replayProcessByteBudget: replayProcessByteBudgetSnapshot(),
    replayFetchAdmission: replayFetchAdmissionSnapshot(),
    admission: admission?.snapshot() ?? null,
  }
}

function logIngestTelemetry(force = false): void {
  const now = Date.now()
  if (!force && now - lastTelemetryLogAtMs < TELEMETRY_LOG_MS) return
  const snapshot = ingestTelemetry.snapshot(now)
  const byteBudget = replayProcessByteBudgetSnapshot()
  const admissionSnapshot = admission?.snapshot()
  const oldest = snapshot.backlog.oldestAgeMs ?? snapshot.backlog.oldestAgeLowerBoundMs
  const lowerBound = snapshot.backlog.oldestAgeMs === null ? '≥' : ''
  console.log(
    `[ingest:metrics] ${snapshot.battlesPerMinute} боёв/мин, ` +
      `очередь ${snapshot.backlog.pendingCount ?? '?'}, ` +
      `выбрано ${snapshot.backlog.selectedCount}/${snapshot.backlog.selectionLimit}, ` +
      `oldest ${lowerBound}${formatMs(oldest)}, ` +
      `active download/parse/persist ` +
      `${snapshot.stages.download.currentActive}/${snapshot.stages.parse.currentActive}/` +
      `${snapshot.stages.persist.currentActive}, ` +
      `persist queue ${snapshot.stages.persist.currentQueued}, ` +
      `memory ${(byteBudget.usedBytes / 1024 / 1024).toFixed(0)}/` +
      `${(byteBudget.limitBytes / 1024 / 1024).toFixed(0)} МиБ ` +
      `(wait ${byteBudget.queuedCount}), ` +
      `replay ${formatMiB(snapshot.replay.bytes)}, retry ${snapshot.replay.retries}, ` +
      `429 ${snapshot.replay.status.rateLimited429}, 5xx ${snapshot.replay.status.server5xx}, ` +
      `TTFB p95 ${formatMs(snapshot.replay.ttfbMs.p95Ms ?? 0)}, ` +
      `admission ${admissionSnapshot?.currentConcurrency ?? ingestConcurrency}/` +
      `${admissionSnapshot?.maxConcurrency ?? ingestConcurrency} ` +
      `(${admissionSnapshot?.reason ?? 'disabled'})`,
  )
  lastTelemetryLogAtMs = now
}

async function tick(): Promise<boolean> {
  if (busy || stopping) return false
  busy = true
  const controller = new AbortController()
  currentAbort = controller
  try {
    const concurrency = admission?.concurrency() ?? ingestConcurrency
    const selectionLimit = concurrency * BATCH_MULTIPLIER
    const stats = getIngestStats()
    const pending = getPendingBattleItems(INGEST_MAX_ATTEMPTS, selectionLimit)
    ingestTelemetry.recordSelection(
      pending.map((item) => item.firstSeenAt),
      selectionLimit,
      Date.now(),
      {
        pendingCount: stats.pending,
      },
    )
    if (pending.length === 0) return false

    if (!backlogLogged) {
      backlogLogged = true
      if (stats.pending > 0) {
        console.log(
          `[ingest] в очереди на разбор: ${stats.pending} боёв ` +
            `(уже разобрано ${stats.ingested})`,
        )
      }
    }

    const outcomes = await ingestBatch(pending, concurrency, controller.signal)
    const snapshot = ingestTelemetry.snapshot()
    const processBudget = replayProcessByteBudgetSnapshot()
    admission?.observeReplay({
      retries: snapshot.replay.retries,
      rateLimited429: snapshot.replay.status.rateLimited429,
      server5xx: snapshot.replay.status.server5xx,
      processBudgetWaitMs: processBudget.waitMs.total,
      processBudgetQueuedCount: processBudget.queuedCount,
      processBudgetUsedBytes: processBudget.usedBytes,
      processBudgetLimitBytes: processBudget.limitBytes,
    })
    logIngestTelemetry()
    return shouldContinueIngestImmediately(
      pending.length,
      selectionLimit,
      outcomes,
      stopping || controller.signal.aborted,
    )
  } catch (err) {
    console.error(`[ingest] сбой тика: ${(err as Error).message}`)
    return false
  } finally {
    if (currentAbort === controller) currentAbort = null
    busy = false
  }
}

export function startIngestWorker(
  concurrency = 1,
  dbPath = './data/wtbot.db',
  adaptiveAdmissionEnabled = false,
): void {
  stopping = false
  ingestConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1
  admission = new IngestAdmissionController(ingestConcurrency, adaptiveAdmissionEnabled)
  ingestDbPath = path.resolve(dbPath)
  backlogLogged = false
  lastTelemetryLogAtMs = 0
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
  activeTick = tick().then((continueImmediately) => {
    activeTick = null
    if (continueImmediately && !stopping) setImmediate(scheduleTick)
  })
}

export async function stopIngestWorker(): Promise<void> {
  stopping = true
  currentAbort?.abort()
  if (timer) clearInterval(timer)
  timer = null
  await activeTick
  if (ingestDbPath) {
    try {
      const checkpoint = await runWorkerTask(
        {
          kind: 'checkpoint-ingest-database',
          input: { dbPath: ingestDbPath },
        },
        {
          priority: 'normal',
          timeoutMs: 30_000,
        },
      )
      console.log(`[ingest] shutdown WAL checkpoint ${formatMs(checkpoint.checkpointMs)}`)
    } catch (error) {
      console.warn(
        `[ingest] shutdown WAL checkpoint не выполнен: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (ingestTelemetry.snapshot().discoveredToTerminalMs.count > 0) logIngestTelemetry(true)
}
