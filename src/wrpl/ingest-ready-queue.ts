interface ReadyQueueEntry<T> {
  value: T
  bytes: number
}

export class IngestReadyQueue<T> {
  private readonly items: ReadyQueueEntry<T>[] = []
  private readonly itemWaiters = new Set<() => void>()
  private readonly capacityWaiters = new Set<() => void>()
  private queuedBytes = 0
  private producersRemaining: number

  constructor(
    producers: number,
    private readonly highCount: number,
    private readonly lowCount: number,
    private readonly highBytes: number,
    private readonly lowBytes: number,
  ) {
    this.producersRemaining = producers
  }

  async enqueue(value: T, bytes: number, signal: AbortSignal): Promise<boolean> {
    const normalizedBytes = Math.max(0, Math.floor(bytes))
    while (!signal.aborted && this.isFull(normalizedBytes)) {
      await waitForWake(this.capacityWaiters, signal)
    }
    if (signal.aborted) return false
    this.items.push({ value, bytes: normalizedBytes })
    this.queuedBytes += normalizedBytes
    wake(this.itemWaiters)
    return true
  }

  async take(signal: AbortSignal): Promise<T | null> {
    for (;;) {
      const entry = this.items.shift()
      if (entry) {
        this.queuedBytes -= entry.bytes
        if (this.items.length <= this.lowCount || this.queuedBytes <= this.lowBytes) {
          wake(this.capacityWaiters)
        }
        return entry.value
      }
      if (signal.aborted || this.producersRemaining === 0) return null
      await waitForWake(this.itemWaiters, signal)
    }
  }

  producerDone(): void {
    this.producersRemaining = Math.max(0, this.producersRemaining - 1)
    wake(this.itemWaiters)
  }

  abortWaiters(): void {
    wake(this.itemWaiters)
    wake(this.capacityWaiters)
  }

  drain(): T[] {
    const values = this.items.map((entry) => entry.value)
    this.items.length = 0
    this.queuedBytes = 0
    wake(this.capacityWaiters)
    return values
  }

  private isFull(nextBytes: number): boolean {
    return (
      this.items.length >= this.highCount ||
      (this.items.length > 0 && this.queuedBytes + nextBytes > this.highBytes)
    )
  }
}

function wake(waiters: Set<() => void>): void {
  for (const resolve of waiters) resolve()
  waiters.clear()
}

function waitForWake(waiters: Set<() => void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      waiters.delete(done)
      resolve()
    }
    waiters.add(done)
    signal.addEventListener('abort', done, { once: true })
  })
}
