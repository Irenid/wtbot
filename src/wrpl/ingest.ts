import path from 'node:path'
import { emitBattleLifecycle, subscribeBattleLifecycle } from '../battle-lifecycle.js'
import {
  BATTLE_INGEST_MAX_ATTEMPTS,
  getIngestStats,
  getPendingBattleItems,
  markBattleIngest,
  type PendingBattleItem,
} from '../db/index.js'
import {
  loadBattleData,
  parsePreparedBattleData,
  prepareBattleData,
  type BattleLoadPhaseEvent,
  type PreparedBattleData,
} from './battle-data.js'
import {
  isWorkerExecutionTimeout,
  isWorkerPoolSchedulingError,
  runWorkerTask,
  transferableBuffer,
} from '../workers/pool.js'
import { ExecTimeoutBudget } from '../workers/exec-timeout-budget.js'
import { dropBattleArtifacts } from './battle-media.js'
import { dropReplayCache, replayFetchAdmissionSnapshot } from './replay-cache.js'
import {
  ReplayPartsFetchError,
  isReplayByteBudgetSchedulingError,
  replayProcessByteBudgetSnapshot,
} from './replay-events.js'
import { listedUserIdsFromItem, realNamesFromItem, resolveReplayPartUrls } from './replay.js'
import {
  ReplayPartWaitList,
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
import { IngestReadyQueue } from './ingest-ready-queue.js'

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
const READY_QUEUE_HIGH_COUNT = 4
const READY_QUEUE_LOW_COUNT = 2
const READY_QUEUE_HIGH_BYTES = 256 * 1024 * 1024
const READY_QUEUE_LOW_BYTES = 128 * 1024 * 1024
/**
 * Сколько таймаутов разбора подряд прощается без расхода попытки. Таймауты
 * записи в SQLite (медленный диск) бьют по всем боям сразу и попытку не
 * расходуют никогда: иначе перегрузка диска превратилась бы в потерю боёв.
 */
const PARSE_EXEC_TIMEOUTS_BEFORE_ERROR = 3
const parseExecTimeouts = new ExecTimeoutBudget(PARSE_EXEC_TIMEOUTS_BEFORE_ERROR)
/** Свежие бои, чьи части ещё не выложены на CDN (см. ReplayPartWaitList). */
const partWaitList = new ReplayPartWaitList()

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
let stagedPipelineEnabled = true
/** Логируем размер бэклога один раз, чтобы не спамить в консоль каждый тик */
let backlogLogged = false
let lastTelemetryLogAtMs = 0
let wakeRequested = false
let ingestSweep = 0
const ingestTelemetry = new IngestTelemetryAccumulator()
let admission: IngestAdmissionController | null = null
let unsubscribeLifecycle: (() => void) | null = null
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

/** HTTP 404/410 от CDN: части ещё не выложены (свежий бой) или уже ушли */
function isMissingReplayPart(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP (404|410)\b/.test(msg)
}

function battleEndMs(item: PendingBattleItem): number | null {
  const end = (item.data as { endTime?: unknown } | null)?.endTime
  return typeof end === 'number' && Number.isFinite(end) && end > 0 ? end * 1_000 : null
}

/**
 * 404/410 части: свежий бой ждёт, пока части доедут до CDN (попытка не
 * расходуется), бой старше окна выкладки помечается expired — повторять бесполезно.
 */
function deferOrExpire(item: PendingBattleItem, message: string): 'deferred' | 'expired' {
  const delayMs = partWaitList.defer(item.externalId, battleEndMs(item), item.firstSeenAt * 1_000, Date.now())
  if (delayMs !== null) {
    console.warn(
      `[ingest] бой ${item.externalId}: часть ещё не выложена на CDN (${message}); ` +
        `повтор через ${Math.round(delayMs / 1_000)} с`,
    )
    return 'deferred'
  }
  markBattleIngest(item.externalId, 'expired', message)
  console.warn(`[ingest] бой ${item.externalId}: части ушли с CDN — пропускаю`)
  return 'expired'
}

async function ingestOne(
  item: PendingBattleItem,
  signal: AbortSignal,
  telemetry: IngestBattleTelemetry,
  prepared: PreparedBattleData | undefined = undefined,
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
  const { urls: parts, problem: partsProblem } = resolveReplayPartUrls(data)
  if (parts.length === 0) {
    markBattleIngest(item.externalId, 'no_parts', partsProblem ?? 'нет ссылок на части реплея')
    outcome = 'no_parts'
    telemetry.finish(outcome)
    return outcome
  }

  // true, пока ошибка может прийти из разбора (parse-battle), а не из записи в SQLite.
  let parsing = true
  try {
    if (!prepared) telemetry.startDownload()
    const onPhase = (event: BattleLoadPhaseEvent): void => {
      if (event.phase === 'replay-ready') {
        telemetry.replayReady(event.replay, event.atMs)
      } else if (event.phase === 'worker-submitted') {
        telemetry.parseSubmitted(event.inputBytes, event.atMs)
      } else {
        telemetry.parseFinished(event.worker, event.atMs)
      }
    }
    const loaded = prepared
      ? await parsePreparedBattleData(
          prepared,
          realNamesFromItem(data),
          {
            missionName: data.missionName,
            gameMode: data.gameMode,
            gameVersion: data.gameVersion,
            listedUserIds: listedUserIdsFromItem(data),
          },
          'background',
          signal,
          undefined,
          onPhase,
        )
      : await loadBattleData(
          parts,
          realNamesFromItem(data),
          {
            missionName: data.missionName,
            gameMode: data.gameMode,
            gameVersion: data.gameVersion,
            listedUserIds: listedUserIdsFromItem(data),
          },
          'background',
          signal,
          undefined,
          onPhase,
        )
    parsing = false
    parseExecTimeouts.clear(item.externalId)
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
    // До события committed: анонс и сайт после него должны строить media по
    // новым строкам, а не отдать кэш прежнего разбора этой же сессии.
    await dropBattleArtifacts(loaded.header.sessionIdHex).catch((error: unknown) => {
      console.warn(
        `[ingest] бой ${item.externalId}: не удалось очистить кэш media: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    })
    emitBattleLifecycle({ kind: 'committed', sessionId: item.externalId })
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
    if (parsing && isWorkerExecutionTimeout(err)) {
      if (parseExecTimeouts.register(item.externalId)) {
        markBattleIngest(
          item.externalId,
          'error',
          `${message} (разбор ${PARSE_EXEC_TIMEOUTS_BEFORE_ERROR} раза подряд не уложился в таймаут)`,
        )
        console.warn(
          `[ingest] бой ${item.externalId}: разбор ${PARSE_EXEC_TIMEOUTS_BEFORE_ERROR} раза подряд превысил таймаут — считаю попыткой`,
        )
        outcome = 'error'
        return outcome
      }
      console.warn(
        `[ingest] бой ${item.externalId}: таймаут разбора ` +
          `${parseExecTimeouts.count(item.externalId)}/${PARSE_EXEC_TIMEOUTS_BEFORE_ERROR}; попытка не расходуется`,
      )
      outcome = 'deferred'
      return outcome
    }
    if (isWorkerPoolSchedulingError(err)) {
      console.warn(`[ingest] бой ${item.externalId}: CPU scheduler занят (${message}); попытка не расходуется`)
      outcome = 'deferred'
      return outcome
    }
    if (isMissingReplayPart(err)) {
      outcome = deferOrExpire(item, message)
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

type PreparedIngestResult =
  | { prepared: PreparedBattleData }
  | { outcome: IngestOutcome }

async function prepareIngest(
  item: PendingBattleItem,
  signal: AbortSignal,
  telemetry: IngestBattleTelemetry,
): Promise<PreparedIngestResult> {
  const data = item.data as {
    url?: string
    partsCount?: number
    replayParts?: string[] | null
  }
  const { urls: parts, problem: partsProblem } = resolveReplayPartUrls(data)
  if (parts.length === 0) {
    markBattleIngest(item.externalId, 'no_parts', partsProblem ?? 'нет ссылок на части реплея')
    telemetry.finish('no_parts')
    return { outcome: 'no_parts' }
  }
  telemetry.startDownload()
  try {
    return {
      prepared: await prepareBattleData(parts, signal, (event) => {
        if (event.phase === 'replay-ready') telemetry.replayReady(event.replay, event.atMs)
      }, Date.now() - item.firstSeenAt * 1_000 < 10 * 60_000 ? 'live' : 'background'),
    }
  } catch (err) {
    if (err instanceof ReplayPartsFetchError) {
      telemetry.replayFailed(err.timing)
      if (!signal.aborted) logReplayFailureTiming(item, err)
    }
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      telemetry.finish('cancelled')
      return { outcome: 'cancelled' }
    }
    const message = err instanceof Error ? err.message : String(err)
    if (isReplayByteBudgetSchedulingError(err) || isWorkerPoolSchedulingError(err)) {
      telemetry.finish('deferred')
      return { outcome: 'deferred' }
    }
    if (isMissingReplayPart(err)) {
      const outcome = deferOrExpire(item, message)
      telemetry.finish(outcome)
      return { outcome }
    }
    markBattleIngest(item.externalId, 'error', message)
    telemetry.finish('error')
    return { outcome: 'error' }
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
  return stagedPipelineEnabled
    ? ingestBatchStaged(items, concurrency, signal)
    : ingestBatchLegacy(items, concurrency, signal)
}

async function ingestBatchStaged(
  items: PendingBattleItem[],
  concurrency: number,
  signal: AbortSignal,
): Promise<IngestOutcome[]> {
  let nextIndex = 0
  const producerCount = Math.min(concurrency, items.length)
  const readyQueue = new IngestReadyQueue<{
    index: number
    item: PendingBattleItem
    prepared: PreparedBattleData
  }>(
    producerCount,
    READY_QUEUE_HIGH_COUNT,
    READY_QUEUE_LOW_COUNT,
    READY_QUEUE_HIGH_BYTES,
    READY_QUEUE_LOW_BYTES,
  )
  const wakeQueue = (): void => readyQueue.abortWaiters()
  signal.addEventListener('abort', wakeQueue, { once: true })
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
  const downloadRunner = async (): Promise<void> => {
    try {
      while (!signal.aborted && !stopping) {
        const index = nextIndex++
        const item = items[index]
        if (!item) return
        await waitForStartSlot()
        if (signal.aborted || stopping) return
        const result = await prepareIngest(item, signal, telemetry[index]!)
        if ('outcome' in result) {
          outcomes[index] = result.outcome
          continue
        }
        const queued = await readyQueue.enqueue(
          { index, item, prepared: result.prepared },
          result.prepared.inputBytes,
          signal,
        )
        if (!queued) {
          result.prepared.release()
          outcomes[index] = 'cancelled'
          telemetry[index]!.finish('cancelled')
        }
      }
    } finally {
      readyQueue.producerDone()
    }
  }
  const parseRunner = async (): Promise<void> => {
    while (!signal.aborted && !stopping) {
      const next = await readyQueue.take(signal)
      if (!next) return
      outcomes[next.index] = await ingestOne(next.item, signal, telemetry[next.index]!, next.prepared)
    }
  }
  const consumerCount = Math.min(Math.max(1, Math.min(concurrency, 4)), items.length)
  try {
    await Promise.all([
      ...Array.from({ length: producerCount }, () => downloadRunner()),
      ...Array.from({ length: consumerCount }, () => parseRunner()),
    ])
  } finally {
    signal.removeEventListener('abort', wakeQueue)
    for (const queued of readyQueue.drain()) {
      queued.prepared.release()
      telemetry[queued.index]!.finish('cancelled')
      outcomes[queued.index] = 'cancelled'
    }
  }
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index] === undefined) telemetry[index]!.finish('cancelled')
  }
  return outcomes.filter((outcome): outcome is IngestOutcome => outcome !== undefined)
}

async function ingestBatchLegacy(
  items: PendingBattleItem[],
  concurrency: number,
  signal: AbortSignal,
): Promise<IngestOutcome[]> {
  let nextIndex = 0
  const outcomes = new Array<IngestOutcome | undefined>(items.length)
  const telemetry = items.map((item) => ingestTelemetry.beginBattle(item.firstSeenAt * 1_000))
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
  const phases = timing.parseProfile
  console.log(
    `[ingest:timing] бой ${item.externalId}: ` +
      `discovered→cache ${formatMs(timing.replayReadyAtMs - discoveredAtMs)}, ` +
      `replay ${formatMs(replay.totalMs)} ` +
      `(${replay.cacheHits}/${replay.requestedParts} cache, ${formatMiB(replay.bytes)}, ` +
      `${replay.retries} retry), ` +
      `cache→parsed ${formatMs(timing.workerFinishedAtMs - timing.replayReadyAtMs)} ` +
      `(input ${formatMs(timing.inputPrepareMs)}, queue ${formatMs(worker?.queueMs ?? 0)}, ` +
      `exec ${formatMs(worker?.executionMs ?? timing.workerWallMs)}; ` +
      `header/results ${formatMs(phases.headerResultsMs)}, ECS ${formatMs(phases.ecsHashesMs)}, ` +
      `events ${formatMs(phases.eventsMs)}, normalize ${formatMs(phases.normalizeMs)}, ` +
      `transform+gzip ${formatMs(phases.transformAndGzipMs)}), ` +
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
    ingestSweep += 1
    const order = ingestSweep % 8 === 0 ? 'oldest' : 'newest'
    // Бои, ждущие выкладки частей на CDN, пропускаются до своего повтора;
    // выборка берёт столько же строк сверх лимита, чтобы они не вытесняли очередь.
    const now = Date.now()
    const pending = getPendingBattleItems(
      INGEST_MAX_ATTEMPTS,
      selectionLimit + partWaitList.waitingCount(now),
      order,
    )
      .filter((item) => !partWaitList.isWaiting(item.externalId, now))
      .slice(0, selectionLimit)
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
  pipelineEnabled = true,
): void {
  stopping = false
  stagedPipelineEnabled = pipelineEnabled
  ingestConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1
  admission = new IngestAdmissionController(ingestConcurrency, adaptiveAdmissionEnabled)
  ingestDbPath = path.resolve(dbPath)
  backlogLogged = false
  lastTelemetryLogAtMs = 0
  wakeRequested = false
  ingestSweep = 0
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = subscribeBattleLifecycle((event) => {
    if (event.kind === 'discovered') wakeIngestWorker()
  })
  const s = getIngestStats()
  console.log(
    `[ingest] воркер запущен · разобрано боёв: ${s.ingested}, в очереди: ${s.pending}` +
      ` · параллельность ${ingestConcurrency}`,
  )
  scheduleTick()
  timer = setInterval(scheduleTick, TICK_MS)
  timer.unref()
}

export function wakeIngestWorker(): void {
  if (stopping || ingestDbPath === null) return
  if (activeTick) {
    wakeRequested = true
    return
  }
  scheduleTick()
}

function scheduleTick(): void {
  if (activeTick || stopping) return
  activeTick = tick().then((continueImmediately) => {
    activeTick = null
    const shouldContinue = continueImmediately || wakeRequested
    wakeRequested = false
    if (shouldContinue && !stopping) setImmediate(scheduleTick)
  })
}

export async function stopIngestWorker(): Promise<void> {
  stopping = true
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = null
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
