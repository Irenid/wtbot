export type IngestAdmissionReason =
  | 'startup'
  | 'disabled'
  | 'stable'
  | 'network-pressure'
  | 'memory-pressure'
  | 'persist-pressure'

export interface IngestReplayPressure {
  retries: number
  rateLimited429: number
  server5xx: number
  processBudgetWaitMs: number
  processBudgetQueuedCount: number
  processBudgetUsedBytes: number
  processBudgetLimitBytes: number
}

export interface IngestAdmissionSnapshot {
  enabled: boolean
  minConcurrency: number
  maxConcurrency: number
  currentConcurrency: number
  reason: IngestAdmissionReason
  stableSamples: number
  decreases: number
  increases: number
  lastChangedAtMs: number
  lastPressureAtMs: number
}

const DECREASE_COOLDOWN_MS = 30_000
const INCREASE_INTERVAL_MS = 120_000
const STABLE_SAMPLES_TO_INCREASE = 8
const PROCESS_BUDGET_WAIT_HIGH_MS = 5_000
const PROCESS_BUDGET_QUEUE_HIGH = 4
const PERSIST_QUEUE_HIGH_MS = 1_000

export class IngestAdmissionController {
  private readonly minConcurrency: number
  private readonly maxConcurrency: number
  private readonly enabled: boolean
  private currentConcurrency: number
  private reason: IngestAdmissionReason
  private stableSamples = 0
  private decreases = 0
  private increases = 0
  private lastChangedAtMs: number
  private lastDecreaseAtMs: number
  private lastIncreaseAtMs: number
  private lastPressureAtMs: number
  private previousPressure: IngestReplayPressure = {
    retries: 0,
    rateLimited429: 0,
    server5xx: 0,
    processBudgetWaitMs: 0,
    processBudgetQueuedCount: 0,
    processBudgetUsedBytes: 0,
    processBudgetLimitBytes: 0,
  }

  constructor(
    maxConcurrency: number,
    enabled: boolean,
    nowMs = Date.now(),
  ) {
    this.maxConcurrency = Number.isFinite(maxConcurrency)
      ? Math.max(1, Math.floor(maxConcurrency))
      : 1
    this.enabled = enabled
    this.minConcurrency = Math.min(this.maxConcurrency, 2)
    this.currentConcurrency = this.maxConcurrency
    this.reason = enabled ? 'startup' : 'disabled'
    this.lastChangedAtMs = nowMs
    this.lastDecreaseAtMs = nowMs - DECREASE_COOLDOWN_MS
    this.lastIncreaseAtMs = nowMs
    this.lastPressureAtMs = nowMs
  }

  concurrency(): number {
    return this.currentConcurrency
  }

  observeReplay(pressure: IngestReplayPressure, nowMs = Date.now()): void {
    if (!this.enabled) return
    const deltaRetries = positiveDelta(pressure.retries, this.previousPressure.retries)
    const delta429 = positiveDelta(pressure.rateLimited429, this.previousPressure.rateLimited429)
    const delta5xx = positiveDelta(pressure.server5xx, this.previousPressure.server5xx)
    const deltaBudgetWaitMs = positiveDelta(
      pressure.processBudgetWaitMs,
      this.previousPressure.processBudgetWaitMs,
    )
    this.previousPressure = { ...pressure }
    const networkPressure = (
      delta429 > 0
      || delta5xx > 0
      || deltaRetries >= Math.max(2, Math.ceil(this.currentConcurrency / 2))
    )
    const usedRatio = pressure.processBudgetLimitBytes > 0
      ? pressure.processBudgetUsedBytes / pressure.processBudgetLimitBytes
      : 0
    const memoryPressure = (
      deltaBudgetWaitMs >= PROCESS_BUDGET_WAIT_HIGH_MS
      || pressure.processBudgetQueuedCount >= PROCESS_BUDGET_QUEUE_HIGH
      || (pressure.processBudgetQueuedCount > 0 && usedRatio >= 0.9)
    )
    if (networkPressure || memoryPressure) {
      this.stableSamples = 0
      this.decrease(networkPressure ? 'network-pressure' : 'memory-pressure', nowMs)
      return
    }

    if (nowMs - this.lastPressureAtMs >= DECREASE_COOLDOWN_MS) {
      this.reason = 'stable'
    }
    this.stableSamples += 1
    if (
      this.currentConcurrency < this.maxConcurrency
      && this.stableSamples >= STABLE_SAMPLES_TO_INCREASE
      && nowMs - this.lastPressureAtMs >= INCREASE_INTERVAL_MS
      && nowMs - this.lastIncreaseAtMs >= INCREASE_INTERVAL_MS
    ) {
      this.currentConcurrency += 1
      this.increases += 1
      this.stableSamples = 0
      this.lastChangedAtMs = nowMs
      this.lastIncreaseAtMs = nowMs
    }
  }

  observePersist(queueMs: number, nowMs = Date.now()): void {
    if (!this.enabled || queueMs < PERSIST_QUEUE_HIGH_MS) return
    this.stableSamples = 0
    this.decrease('persist-pressure', nowMs)
  }

  snapshot(): IngestAdmissionSnapshot {
    return {
      enabled: this.enabled,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      currentConcurrency: this.currentConcurrency,
      reason: this.reason,
      stableSamples: this.stableSamples,
      decreases: this.decreases,
      increases: this.increases,
      lastChangedAtMs: this.lastChangedAtMs,
      lastPressureAtMs: this.lastPressureAtMs,
    }
  }

  private decrease(reason: IngestAdmissionReason, nowMs: number): void {
    this.reason = reason
    this.lastPressureAtMs = nowMs
    if (
      this.currentConcurrency <= this.minConcurrency
      || nowMs - this.lastDecreaseAtMs < DECREASE_COOLDOWN_MS
    ) {
      return
    }
    this.currentConcurrency = Math.max(this.minConcurrency, Math.ceil(this.currentConcurrency / 2))
    this.decreases += 1
    this.lastChangedAtMs = nowMs
    this.lastDecreaseAtMs = nowMs
  }
}

function positiveDelta(current: number, previous: number): number {
  return Math.max(0, current - previous)
}
