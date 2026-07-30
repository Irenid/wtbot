import type { WorkerTaskTiming } from '../workers/pool.js'
import type { ReplayPartsTiming } from './replay-events.js'
import type { IngestOutcome } from './ingest-scheduler.js'

export const INGEST_TELEMETRY_STAGES = [
  'eligible',
  'download',
  'ready',
  'parse',
  'persist',
] as const

export type IngestTelemetryStage = typeof INGEST_TELEMETRY_STAGES[number]

const LATENCY_BUCKETS_MS = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  20_000,
  60_000,
  120_000,
  300_000,
] as const
const RATE_WINDOW_SECONDS = 60

export interface IngestDistributionSnapshot {
  count: number
  minMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  maxMs: number | null
  meanMs: number | null
}

export interface IngestStageSnapshot {
  currentQueued: number
  currentActive: number
  currentQueuedBytes: number
  currentActiveBytes: number
  highWaterQueued: number
  highWaterActive: number
  highWaterQueuedBytes: number
  highWaterActiveBytes: number
  enqueued: number
  started: number
  completed: number
  cancelled: number
  completedBytes: number
  waitMs: IngestDistributionSnapshot
  activeMs: IngestDistributionSnapshot
}

export interface IngestReplaySnapshot {
  completed: number
  succeeded: number
  failed: number
  aborted: number
  bytes: number
  cacheHits: number
  networkParts: number
  networkAttempts: number
  retries: number
  httpErrors: number
  status: {
    success2xx: number
    redirect3xx: number
    client4xx: number
    rateLimited429: number
    server5xx: number
    other: number
  }
  ttfbMs: IngestDistributionSnapshot
  downloadMs: IngestDistributionSnapshot
  slotWaitMs: IngestDistributionSnapshot
  processBudgetWaitMs: IngestDistributionSnapshot
  retryDelayMs: IngestDistributionSnapshot
}

export interface IngestSqliteSnapshot {
  commits: number
  checkpoints: number
  queueMs: IngestDistributionSnapshot
  transactionMs: IngestDistributionSnapshot
  checkpointMs: IngestDistributionSnapshot
}

export interface IngestBacklogSnapshot {
  /** Exact eligible row count when supplied by the indexed DB snapshot. */
  pendingCount: number | null
  selectedCount: number
  selectionLimit: number
  saturated: boolean
  /** Exact only when the newest-first selection did not hit its LIMIT. */
  oldestAgeMs: number | null
  /** Always valid for a non-empty selection; a lower bound when saturated. */
  oldestAgeLowerBoundMs: number
  sampledAtMs: number
}

export interface IngestBacklogObservation {
  pendingCount: number
}

export interface IngestTelemetrySnapshot {
  startedAtMs: number
  sampledAtMs: number
  battlesPerMinute: number
  outcomes: Record<IngestOutcome, number>
  discoveredToTerminalMs: IngestDistributionSnapshot
  backlog: IngestBacklogSnapshot
  stages: Record<IngestTelemetryStage, IngestStageSnapshot>
  replay: IngestReplaySnapshot
  sqlite: IngestSqliteSnapshot
}

interface MutableStage {
  currentQueued: number
  currentActive: number
  currentQueuedBytes: number
  currentActiveBytes: number
  highWaterQueued: number
  highWaterActive: number
  highWaterQueuedBytes: number
  highWaterActiveBytes: number
  enqueued: number
  started: number
  completed: number
  cancelled: number
  completedBytes: number
  waitMs: FixedHistogram
  activeMs: FixedHistogram
}

type StageTokenState = 'queued' | 'active' | 'finished'

interface StageToken {
  readonly stage: IngestTelemetryStage
  readonly queuedAtMs: number
  bytes: number
  startedAtMs: number | null
  waitRecorded: boolean
  state: StageTokenState
}

class FixedHistogram {
  private readonly buckets = new Uint32Array(LATENCY_BUCKETS_MS.length + 1)
  private count = 0
  private total = 0
  private min = Number.POSITIVE_INFINITY
  private max = 0

  observe(value: number): void {
    if (!Number.isFinite(value)) return
    const normalized = Math.max(0, value)
    let index = 0
    while (index < LATENCY_BUCKETS_MS.length && normalized > LATENCY_BUCKETS_MS[index]!) index += 1
    this.buckets[index] = Math.min(0xffff_ffff, this.buckets[index]! + 1)
    this.count += 1
    this.total += normalized
    this.min = Math.min(this.min, normalized)
    this.max = Math.max(this.max, normalized)
  }

  snapshot(): IngestDistributionSnapshot {
    if (this.count === 0) {
      return {
        count: 0,
        minMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
        meanMs: null,
      }
    }
    return {
      count: this.count,
      minMs: this.min,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.max,
      meanMs: this.total / this.count,
    }
  }

  private percentile(fraction: number): number {
    const target = Math.max(1, Math.ceil(this.count * fraction))
    let seen = 0
    for (let index = 0; index < this.buckets.length; index += 1) {
      seen += this.buckets[index]!
      if (seen < target) continue
      return index < LATENCY_BUCKETS_MS.length
        ? LATENCY_BUCKETS_MS[index]!
        : this.max
    }
    return this.max
  }
}

function createStage(): MutableStage {
  return {
    currentQueued: 0,
    currentActive: 0,
    currentQueuedBytes: 0,
    currentActiveBytes: 0,
    highWaterQueued: 0,
    highWaterActive: 0,
    highWaterQueuedBytes: 0,
    highWaterActiveBytes: 0,
    enqueued: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
    completedBytes: 0,
    waitMs: new FixedHistogram(),
    activeMs: new FixedHistogram(),
  }
}

function createOutcomes(): Record<IngestOutcome, number> {
  return {
    ok: 0,
    error: 0,
    expired: 0,
    no_parts: 0,
    deferred: 0,
    cancelled: 0,
  }
}

export class IngestTelemetryAccumulator {
  private readonly startedAtMs: number
  private readonly stages: Record<IngestTelemetryStage, MutableStage>
  private readonly outcomes = createOutcomes()
  private readonly discoveredToTerminalMs = new FixedHistogram()
  private readonly completionEpochSeconds = new Float64Array(RATE_WINDOW_SECONDS).fill(-1)
  private readonly completionCounts = new Uint32Array(RATE_WINDOW_SECONDS)
  private readonly replayTtfbMs = new FixedHistogram()
  private readonly replayDownloadMs = new FixedHistogram()
  private readonly replaySlotWaitMs = new FixedHistogram()
  private readonly replayProcessBudgetWaitMs = new FixedHistogram()
  private readonly replayRetryDelayMs = new FixedHistogram()
  private readonly sqliteQueueMs = new FixedHistogram()
  private readonly sqliteTransactionMs = new FixedHistogram()
  private readonly sqliteCheckpointMs = new FixedHistogram()
  private sqliteCommits = 0
  private sqliteCheckpoints = 0
  private readonly replay = {
    completed: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
    bytes: 0,
    cacheHits: 0,
    networkParts: 0,
    networkAttempts: 0,
    retries: 0,
    httpErrors: 0,
    status: {
      success2xx: 0,
      redirect3xx: 0,
      client4xx: 0,
      rateLimited429: 0,
      server5xx: 0,
      other: 0,
    },
  }
  private backlog: IngestBacklogSnapshot

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now()
    this.stages = {
      eligible: createStage(),
      download: createStage(),
      ready: createStage(),
      parse: createStage(),
      persist: createStage(),
    }
    this.backlog = {
      pendingCount: null,
      selectedCount: 0,
      selectionLimit: 0,
      saturated: false,
      oldestAgeMs: 0,
      oldestAgeLowerBoundMs: 0,
      sampledAtMs: this.startedAtMs,
    }
  }

  beginBattle(discoveredAtMs: number, nowMs = this.now()): IngestBattleTelemetry {
    return new IngestBattleTelemetry(this, discoveredAtMs, this.queueStage('eligible', 0, nowMs))
  }

  recordSelection(
    firstSeenAtSeconds: number[],
    selectionLimit: number,
    nowMs = this.now(),
    exact?: IngestBacklogObservation,
  ): void {
    const oldestFirstSeenAtMs = firstSeenAtSeconds.length > 0
      ? Math.min(...firstSeenAtSeconds) * 1_000
      : nowMs
    const oldestAgeLowerBoundMs = Math.max(0, nowMs - oldestFirstSeenAtMs)
    const observedPendingCount = exact?.pendingCount
    const pendingCount = typeof observedPendingCount === 'number'
      && Number.isSafeInteger(observedPendingCount)
      && observedPendingCount >= 0
      ? observedPendingCount
      : null
    const saturated = pendingCount === null
      ? selectionLimit > 0 && firstSeenAtSeconds.length >= selectionLimit
      : pendingCount > firstSeenAtSeconds.length
    this.backlog = {
      pendingCount,
      selectedCount: firstSeenAtSeconds.length,
      selectionLimit,
      saturated,
      oldestAgeMs: saturated ? null : oldestAgeLowerBoundMs,
      oldestAgeLowerBoundMs,
      sampledAtMs: nowMs,
    }
  }

  snapshot(nowMs = this.now()): IngestTelemetrySnapshot {
    return {
      startedAtMs: this.startedAtMs,
      sampledAtMs: nowMs,
      battlesPerMinute: this.completionsInWindow(nowMs),
      outcomes: { ...this.outcomes },
      discoveredToTerminalMs: this.discoveredToTerminalMs.snapshot(),
      backlog: { ...this.backlog },
      stages: {
        eligible: this.stageSnapshot(this.stages.eligible),
        download: this.stageSnapshot(this.stages.download),
        ready: this.stageSnapshot(this.stages.ready),
        parse: this.stageSnapshot(this.stages.parse),
        persist: this.stageSnapshot(this.stages.persist),
      },
      replay: {
        ...this.replay,
        status: { ...this.replay.status },
        ttfbMs: this.replayTtfbMs.snapshot(),
        downloadMs: this.replayDownloadMs.snapshot(),
        slotWaitMs: this.replaySlotWaitMs.snapshot(),
        processBudgetWaitMs: this.replayProcessBudgetWaitMs.snapshot(),
        retryDelayMs: this.replayRetryDelayMs.snapshot(),
      },
      sqlite: {
        commits: this.sqliteCommits,
        checkpoints: this.sqliteCheckpoints,
        queueMs: this.sqliteQueueMs.snapshot(),
        transactionMs: this.sqliteTransactionMs.snapshot(),
        checkpointMs: this.sqliteCheckpointMs.snapshot(),
      },
    }
  }

  queueStage(stage: IngestTelemetryStage, bytes: number, nowMs = this.now()): StageToken {
    const normalizedBytes = normalizeBytes(bytes)
    const current = this.stages[stage]
    current.currentQueued += 1
    current.currentQueuedBytes += normalizedBytes
    current.enqueued += 1
    current.highWaterQueued = Math.max(current.highWaterQueued, current.currentQueued)
    current.highWaterQueuedBytes = Math.max(current.highWaterQueuedBytes, current.currentQueuedBytes)
    return {
      stage,
      queuedAtMs: nowMs,
      bytes: normalizedBytes,
      startedAtMs: null,
      waitRecorded: false,
      state: 'queued',
    }
  }

  startStage(token: StageToken, nowMs = this.now(), waitMs?: number | null): void {
    if (token.state !== 'queued') return
    const current = this.stages[token.stage]
    current.currentQueued = Math.max(0, current.currentQueued - 1)
    current.currentQueuedBytes = Math.max(0, current.currentQueuedBytes - token.bytes)
    current.currentActive += 1
    current.currentActiveBytes += token.bytes
    current.started += 1
    current.highWaterActive = Math.max(current.highWaterActive, current.currentActive)
    current.highWaterActiveBytes = Math.max(current.highWaterActiveBytes, current.currentActiveBytes)
    if (waitMs !== null) {
      current.waitMs.observe(waitMs ?? nowMs - token.queuedAtMs)
      token.waitRecorded = true
    }
    token.startedAtMs = nowMs
    token.state = 'active'
  }

  finishStage(
    token: StageToken,
    options: {
      nowMs?: number | undefined
      bytes?: number | undefined
      waitMs?: number | undefined
      activeMs?: number | undefined
    } = {},
  ): void {
    if (token.state === 'finished') return
    const nowMs = options.nowMs ?? this.now()
    if (token.state === 'queued') this.startStage(token, nowMs)
    if (token.state !== 'active') return
    const current = this.stages[token.stage]
    const completedBytes = options.bytes === undefined ? token.bytes : normalizeBytes(options.bytes)
    current.currentActive = Math.max(0, current.currentActive - 1)
    current.currentActiveBytes = Math.max(0, current.currentActiveBytes - token.bytes)
    current.completed += 1
    current.completedBytes += completedBytes
    if (!token.waitRecorded) current.waitMs.observe(options.waitMs ?? nowMs - token.queuedAtMs)
    current.activeMs.observe(options.activeMs ?? nowMs - (token.startedAtMs ?? nowMs))
    token.state = 'finished'
  }

  cancelStage(token: StageToken): void {
    if (token.state === 'finished') return
    const current = this.stages[token.stage]
    if (token.state === 'queued') {
      current.currentQueued = Math.max(0, current.currentQueued - 1)
      current.currentQueuedBytes = Math.max(0, current.currentQueuedBytes - token.bytes)
    } else {
      current.currentActive = Math.max(0, current.currentActive - 1)
      current.currentActiveBytes = Math.max(0, current.currentActiveBytes - token.bytes)
    }
    current.cancelled += 1
    token.state = 'finished'
  }

  recordReplay(timing: ReplayPartsTiming): void {
    this.replay.completed += 1
    this.replay[timing.outcome === 'success'
      ? 'succeeded'
      : timing.outcome === 'aborted'
        ? 'aborted'
        : 'failed'] += 1
    this.replay.bytes += normalizeBytes(timing.bytes)
    this.replay.cacheHits += Math.max(0, timing.cacheHits)
    this.replay.networkParts += Math.max(0, timing.networkParts)
    this.replay.networkAttempts += Math.max(0, timing.networkAttempts)
    this.replay.retries += Math.max(0, timing.retries)
    this.replay.httpErrors += Math.max(0, timing.httpErrors)
    this.replayProcessBudgetWaitMs.observe(timing.processBudgetWaitMs)
    for (const part of timing.parts) {
      for (const attempt of part.attempts) {
        if (attempt.ttfbMs !== null) this.replayTtfbMs.observe(attempt.ttfbMs)
        if (attempt.downloadMs !== null) this.replayDownloadMs.observe(attempt.downloadMs)
        this.replaySlotWaitMs.observe(attempt.slotWaitMs)
        if (attempt.retryDelayMs > 0) this.replayRetryDelayMs.observe(attempt.retryDelayMs)
        this.recordHttpStatus(attempt.status)
      }
    }
  }

  recordOutcome(outcome: IngestOutcome, discoveredAtMs: number, nowMs = this.now()): void {
    this.outcomes[outcome] += 1
    this.discoveredToTerminalMs.observe(nowMs - discoveredAtMs)
    if (outcome !== 'ok') return
    const epochSecond = Math.floor(nowMs / 1_000)
    const index = modulo(epochSecond, RATE_WINDOW_SECONDS)
    if (this.completionEpochSeconds[index] !== epochSecond) {
      this.completionEpochSeconds[index] = epochSecond
      this.completionCounts[index] = 0
    }
    this.completionCounts[index] = Math.min(0xffff_ffff, this.completionCounts[index]! + 1)
  }

  recordPersistTiming(queueMs: number, transactionMs: number, checkpointMs: number): void {
    this.sqliteCommits += 1
    this.sqliteQueueMs.observe(queueMs)
    this.sqliteTransactionMs.observe(transactionMs)
    if (checkpointMs <= 0) return
    this.sqliteCheckpoints += 1
    this.sqliteCheckpointMs.observe(checkpointMs)
  }

  private stageSnapshot(stage: MutableStage): IngestStageSnapshot {
    return {
      currentQueued: stage.currentQueued,
      currentActive: stage.currentActive,
      currentQueuedBytes: stage.currentQueuedBytes,
      currentActiveBytes: stage.currentActiveBytes,
      highWaterQueued: stage.highWaterQueued,
      highWaterActive: stage.highWaterActive,
      highWaterQueuedBytes: stage.highWaterQueuedBytes,
      highWaterActiveBytes: stage.highWaterActiveBytes,
      enqueued: stage.enqueued,
      started: stage.started,
      completed: stage.completed,
      cancelled: stage.cancelled,
      completedBytes: stage.completedBytes,
      waitMs: stage.waitMs.snapshot(),
      activeMs: stage.activeMs.snapshot(),
    }
  }

  private completionsInWindow(nowMs: number): number {
    const nowSecond = Math.floor(nowMs / 1_000)
    let total = 0
    for (let index = 0; index < RATE_WINDOW_SECONDS; index += 1) {
      const epochSecond = this.completionEpochSeconds[index]!
      if (epochSecond >= nowSecond - RATE_WINDOW_SECONDS + 1 && epochSecond <= nowSecond) {
        total += this.completionCounts[index]!
      }
    }
    return total
  }

  private recordHttpStatus(status: number | null): void {
    if (status === null || !Number.isFinite(status)) {
      this.replay.status.other += 1
    } else if (status >= 200 && status < 300) {
      this.replay.status.success2xx += 1
    } else if (status >= 300 && status < 400) {
      this.replay.status.redirect3xx += 1
    } else if (status === 429) {
      this.replay.status.rateLimited429 += 1
    } else if (status >= 400 && status < 500) {
      this.replay.status.client4xx += 1
    } else if (status >= 500 && status < 600) {
      this.replay.status.server5xx += 1
    } else {
      this.replay.status.other += 1
    }
  }
}

export class IngestBattleTelemetry {
  private current: StageToken | null
  private finished = false

  constructor(
    private readonly owner: IngestTelemetryAccumulator,
    private readonly discoveredAtMs: number,
    eligible: StageToken,
  ) {
    this.current = eligible
  }

  startDownload(nowMs?: number): void {
    this.transition('download', 0, nowMs)
  }

  replayReady(timing: ReplayPartsTiming, nowMs = timing.completedAtMs): void {
    this.finishCurrent({ nowMs, bytes: timing.bytes, activeMs: timing.totalMs })
    this.owner.recordReplay(timing)
    this.current = this.owner.queueStage('ready', timing.bytes, nowMs)
    this.owner.startStage(this.current, nowMs)
  }

  replayFailed(timing: ReplayPartsTiming, nowMs = timing.completedAtMs): void {
    this.finishCurrent({ nowMs, bytes: timing.bytes, activeMs: timing.totalMs })
    this.owner.recordReplay(timing)
  }

  parseSubmitted(inputBytes: number, nowMs?: number): void {
    this.finishCurrent({ nowMs })
    this.current = this.owner.queueStage('parse', inputBytes, nowMs)
    this.owner.startStage(this.current, nowMs, null)
  }

  parseFinished(worker: WorkerTaskTiming | null, nowMs?: number): void {
    this.finishCurrent({
      nowMs,
      waitMs: worker?.queueMs ?? 0,
      activeMs: worker?.executionMs ?? undefined,
    })
  }

  persistQueued(bytes: number, nowMs?: number): void {
    this.finishCurrent({ nowMs })
    this.current = this.owner.queueStage('persist', bytes, nowMs)
  }

  persistStarted(nowMs?: number): void {
    if (this.current?.stage === 'persist') this.owner.startStage(this.current, nowMs)
  }

  persistFinished(nowMs?: number, activeMs?: number): void {
    this.finishCurrent({ nowMs, activeMs })
  }

  persistTiming(queueMs: number, transactionMs: number, checkpointMs: number): void {
    this.owner.recordPersistTiming(queueMs, transactionMs, checkpointMs)
  }

  finish(outcome: IngestOutcome, nowMs?: number): void {
    if (this.finished) return
    if (this.current) this.owner.cancelStage(this.current)
    this.current = null
    this.owner.recordOutcome(outcome, this.discoveredAtMs, nowMs)
    this.finished = true
  }

  private transition(stage: IngestTelemetryStage, bytes: number, nowMs?: number): void {
    this.finishCurrent({ nowMs })
    this.current = this.owner.queueStage(stage, bytes, nowMs)
    this.owner.startStage(this.current, nowMs)
  }

  private finishCurrent(options: {
    nowMs?: number | undefined
    bytes?: number | undefined
    waitMs?: number | undefined
    activeMs?: number | undefined
  }): void {
    if (!this.current) return
    this.owner.finishStage(this.current, options)
    this.current = null
  }
}

function normalizeBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}
