export interface ByteBudgetAcquireOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ByteBudgetSnapshot {
  limitBytes: number
  usedBytes: number
  availableBytes: number
  queuedCount: number
  queuedBytes: number
  highWaterUsedBytes: number
  highWaterQueuedCount: number
  highWaterQueuedBytes: number
  granted: number
  released: number
  aborted: number
  timedOut: number
  waitMs: {
    count: number
    total: number
    max: number
  }
}

interface Waiter {
  bytes: number
  queuedAt: number
  resolve: (reservation: ByteBudgetReservation) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
  abortListener: (() => void) | null
  timer: NodeJS.Timeout | null
}

export class ByteBudgetTimeoutError extends Error {
  readonly code = 'BYTE_BUDGET_TIMEOUT'

  constructor(readonly requestedBytes: number, readonly limitBytes: number) {
    super(
      `process byte budget: ожидание ${formatMiB(requestedBytes)} превысило timeout ` +
      `(лимит ${formatMiB(limitBytes)})`,
    )
    this.name = 'ByteBudgetTimeoutError'
  }
}

export class ByteBudgetOversizeError extends Error {
  readonly code = 'BYTE_BUDGET_OVERSIZE'

  constructor(readonly requestedBytes: number, readonly limitBytes: number) {
    super(
      `process byte budget: задача ${formatMiB(requestedBytes)} больше лимита ` +
      `${formatMiB(limitBytes)}`,
    )
    this.name = 'ByteBudgetOversizeError'
  }
}

export class ByteBudgetReservation {
  private released = false

  constructor(
    private readonly owner: AsyncByteBudget,
    private retainedBytes: number,
  ) {}

  get bytes(): number {
    return this.released ? 0 : this.retainedBytes
  }

  shrinkTo(bytes: number): void {
    if (this.released) return
    const normalized = normalizeBytes(bytes)
    if (normalized > this.retainedBytes) {
      throw new Error(
        `process byte budget: нельзя увеличить reservation ` +
        `${formatMiB(this.retainedBytes)} → ${formatMiB(normalized)}`,
      )
    }
    const releasedBytes = this.retainedBytes - normalized
    this.retainedBytes = normalized
    if (releasedBytes > 0) this.owner.releaseBytes(releasedBytes, false)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.owner.releaseBytes(this.retainedBytes, true)
    this.retainedBytes = 0
  }
}

export class AsyncByteBudget {
  readonly limitBytes: number
  private usedBytes = 0
  private highWaterUsedBytes = 0
  private highWaterQueuedCount = 0
  private highWaterQueuedBytes = 0
  private granted = 0
  private released = 0
  private aborted = 0
  private timedOut = 0
  private waitCount = 0
  private waitTotalMs = 0
  private waitMaxMs = 0
  private readonly waiters: Waiter[] = []

  constructor(limitBytes: number) {
    const normalized = normalizeBytes(limitBytes)
    if (normalized <= 0) throw new Error('process byte budget должен быть положительным')
    this.limitBytes = normalized
  }

  acquire(
    bytes: number,
    options: ByteBudgetAcquireOptions = {},
  ): Promise<ByteBudgetReservation> {
    const normalized = normalizeBytes(bytes)
    if (normalized <= 0) return Promise.resolve(new ByteBudgetReservation(this, 0))
    if (normalized > this.limitBytes) {
      return Promise.reject(new ByteBudgetOversizeError(normalized, this.limitBytes))
    }
    if (options.signal?.aborted) return Promise.reject(abortError())
    if (this.waiters.length === 0 && normalized <= this.availableBytes()) {
      return Promise.resolve(this.grant(normalized, 0))
    }

    return new Promise<ByteBudgetReservation>((resolve, reject) => {
      const waiter: Waiter = {
        bytes: normalized,
        queuedAt: performance.now(),
        resolve,
        reject,
        signal: options.signal,
        abortListener: null,
        timer: null,
      }
      if (options.signal) {
        waiter.abortListener = () => {
          if (!this.removeWaiter(waiter)) return
          this.aborted += 1
          reject(abortError())
          this.drain()
        }
        options.signal.addEventListener('abort', waiter.abortListener, { once: true })
      }
      if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
        const timeoutMs = Math.max(0, options.timeoutMs)
        waiter.timer = setTimeout(() => {
          if (!this.removeWaiter(waiter)) return
          this.timedOut += 1
          reject(new ByteBudgetTimeoutError(normalized, this.limitBytes))
          this.drain()
        }, timeoutMs)
        waiter.timer.unref()
      }
      this.waiters.push(waiter)
      this.observeQueueHighWater()
      this.drain()
    })
  }

  snapshot(): ByteBudgetSnapshot {
    return {
      limitBytes: this.limitBytes,
      usedBytes: this.usedBytes,
      availableBytes: this.availableBytes(),
      queuedCount: this.waiters.length,
      queuedBytes: this.queuedBytes(),
      highWaterUsedBytes: this.highWaterUsedBytes,
      highWaterQueuedCount: this.highWaterQueuedCount,
      highWaterQueuedBytes: this.highWaterQueuedBytes,
      granted: this.granted,
      released: this.released,
      aborted: this.aborted,
      timedOut: this.timedOut,
      waitMs: {
        count: this.waitCount,
        total: this.waitTotalMs,
        max: this.waitMaxMs,
      },
    }
  }

  releaseBytes(bytes: number, completedReservation: boolean): void {
    this.usedBytes = Math.max(0, this.usedBytes - normalizeBytes(bytes))
    if (completedReservation) this.released += 1
    this.drain()
  }

  private availableBytes(): number {
    return Math.max(0, this.limitBytes - this.usedBytes)
  }

  private drain(): void {
    for (;;) {
      const waiter = this.waiters[0]
      if (!waiter || waiter.bytes > this.availableBytes()) return
      this.waiters.shift()
      this.cleanupWaiter(waiter)
      const waitMs = performance.now() - waiter.queuedAt
      waiter.resolve(this.grant(waiter.bytes, waitMs))
    }
  }

  private grant(bytes: number, waitMs: number): ByteBudgetReservation {
    this.usedBytes += bytes
    this.highWaterUsedBytes = Math.max(this.highWaterUsedBytes, this.usedBytes)
    this.granted += 1
    this.waitCount += 1
    this.waitTotalMs += Math.max(0, waitMs)
    this.waitMaxMs = Math.max(this.waitMaxMs, waitMs)
    return new ByteBudgetReservation(this, bytes)
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter)
    if (index < 0) return false
    this.waiters.splice(index, 1)
    this.cleanupWaiter(waiter)
    return true
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener)
    }
    waiter.timer = null
    waiter.abortListener = null
  }

  private observeQueueHighWater(): void {
    this.highWaterQueuedCount = Math.max(this.highWaterQueuedCount, this.waiters.length)
    this.highWaterQueuedBytes = Math.max(this.highWaterQueuedBytes, this.queuedBytes())
  }

  private queuedBytes(): number {
    return this.waiters.reduce((sum, waiter) => sum + waiter.bytes, 0)
  }
}

function normalizeBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function abortError(): Error {
  const error = new Error('process byte budget: операция отменена')
  error.name = 'AbortError'
  return error
}

function formatMiB(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} МиБ`
}
