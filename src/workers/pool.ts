import { Worker, type Transferable } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { workerResourcePlan } from '../runtime-options.js'
import type {
  AnyWorkerTask,
  WorkerMessage,
  WorkerRequest,
  WorkerTaskKind,
  WorkerTaskResult,
  WorkerTransportTiming,
} from './protocol.js'

export type WorkerPriority = 'interactive' | 'normal' | 'background'

export interface WorkerRunOptions {
  priority?: WorkerPriority | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  transferList?: readonly Transferable[] | undefined
  onControl?: ((control: WorkerTaskControl) => void) | undefined
  onTiming?: ((timing: WorkerTaskTiming) => void) | undefined
}

export interface WorkerTaskTiming {
  kind: WorkerTaskKind
  priority: WorkerPriority
  outcome: 'success' | 'error'
  stage: 'queue' | 'execution'
  coldWorker: boolean
  queueMs: number
  schedulerWaitMs: number
  workerStartupMs: number
  inputTransferMs: number | null
  executionMs: number | null
  resultTransferMs: number | null
  totalMs: number
}

export interface CpuWorkerPoolOptions {
  size?: number | undefined
  backgroundReserveSlots?: number | undefined
}

export interface WorkerTaskControl {
  /** Повышает приоритет queued/running shared job; понижение игнорируется. */
  promote(priority: WorkerPriority): void
}

interface Job {
  id: number
  task: AnyWorkerTask
  priority: WorkerPriority
  timeoutMs: number
  queuedAt: number
  dispatchedAt: number | null
  workerStartupMs: number
  coldWorker: boolean
  workerTiming: WorkerTransportTiming | null
  resultReceivedAt: number | null
  transferList: readonly Transferable[]
  signal: AbortSignal | undefined
  abortHandler: (() => void) | null
  timer: NodeJS.Timeout | null
  onTiming: ((timing: WorkerTaskTiming) => void) | undefined
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  finished: Promise<void>
  finish: () => void
  settled: boolean
}

interface WorkerSlot {
  worker: Worker
  ready: boolean
  retiring: boolean
  job: Job | null
  startupTimer: NodeJS.Timeout
  renderJobsCompleted: number
  tasksCompleted: number
  spawnedAt: number
  readyAt: number | null
}

const PRIORITIES: WorkerPriority[] = ['interactive', 'normal', 'background']
const DEFAULT_TIMEOUT_MS: Record<WorkerPriority, number> = {
  interactive: 45_000,
  normal: 90_000,
  background: 180_000,
}
const MAX_QUEUE = 32
const MAX_QUEUED_TRANSFER_BYTES = 768 * 1024 * 1024
const STARTUP_TIMEOUT_MS = 30_000
const MAX_STARTUP_FAILURES = 3
const MAX_STARTUP_BACKOFF_MS = 5_000
const MAX_RENDER_JOBS_PER_WORKER = 12
const BACKGROUND_MAX_WAIT_MS = 10_000
const WORKER_RESOURCES = workerResourcePlan()
const MAX_CONFIGURABLE_WORKERS = 8

export type WorkerPoolErrorCode =
  | 'POOL_CLOSED'
  | 'QUEUE_FULL'
  | 'QUEUE_MEMORY'
  | 'QUEUE_TIMEOUT'
  | 'STARTUP_FAILED'
  | 'TASK_TOO_LARGE'

export class WorkerPoolError extends Error {
  constructor(
    message: string,
    readonly code: WorkerPoolErrorCode,
  ) {
    super(message)
    this.name = 'WorkerPoolError'
  }
}

function abortError(message = 'Задача worker отменена'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function epochNow(): number {
  return performance.timeOrigin + performance.now()
}

export class CpuWorkerPool {
  private readonly size: number
  private readonly backgroundReserveSlots: number
  private readonly queues = new Map<WorkerPriority, Job[]>(PRIORITIES.map((p) => [p, []]))
  private readonly slots = new Set<WorkerSlot>()
  private nextId = 1
  private closing = false
  private startupFailures = 0
  private respawnTimer: NodeJS.Timeout | null = null

  constructor(options: CpuWorkerPoolOptions = {}) {
    const size = options.size ?? WORKER_RESOURCES.workerThreads
    const backgroundReserveSlots = options.backgroundReserveSlots ?? WORKER_RESOURCES.backgroundReserveSlots
    if (!Number.isInteger(size) || size < 1 || size > MAX_CONFIGURABLE_WORKERS) {
      throw new Error(`Число CPU workers должно быть целым от 1 до ${MAX_CONFIGURABLE_WORKERS}`)
    }
    if (!Number.isInteger(backgroundReserveSlots) || backgroundReserveSlots < 0) {
      throw new Error('Резерв CPU workers должен быть неотрицательным целым числом')
    }
    this.size = size
    this.backgroundReserveSlots = backgroundReserveSlots
  }

  run<K extends WorkerTaskKind>(
    task: Extract<AnyWorkerTask, { kind: K }>,
    options: WorkerRunOptions = {},
  ): Promise<WorkerTaskResult<K>> {
    if (this.closing) return Promise.reject(new WorkerPoolError('Пул CPU workers уже остановлен', 'POOL_CLOSED'))
    if (options.signal?.aborted) return Promise.reject(abortError())
    if (this.queuedCount() >= MAX_QUEUE) {
      return Promise.reject(new WorkerPoolError(`Очередь CPU workers переполнена (${MAX_QUEUE} задач)`, 'QUEUE_FULL'))
    }
    const transferList = options.transferList ?? []
    const queuedBytes = this.queuedTransferBytes()
    const taskBytes = transferList.reduce(
      (sum, item) => sum + (item instanceof ArrayBuffer ? item.byteLength : 0),
      0,
    )
    if (taskBytes > MAX_QUEUED_TRANSFER_BYTES) {
      return Promise.reject(
        new WorkerPoolError(
          `CPU-задача передаёт больше допустимого объёма (${Math.ceil(taskBytes / 1024 / 1024)} МБ)`,
          'TASK_TOO_LARGE',
        ),
      )
    }
    if (queuedBytes + taskBytes > MAX_QUEUED_TRANSFER_BYTES) {
      return Promise.reject(
        new WorkerPoolError(
          `Очередь CPU workers удерживает слишком много данных (${Math.ceil((queuedBytes + taskBytes) / 1024 / 1024)} МБ)`,
          'QUEUE_MEMORY',
        ),
      )
    }

    const priority = options.priority ?? 'normal'
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[priority]
    return new Promise<WorkerTaskResult<K>>((resolve, reject) => {
      let finish = (): void => undefined
      const finished = new Promise<void>((done) => {
        finish = done
      })
      const job: Job = {
        id: this.nextId++,
        task,
        priority,
        timeoutMs,
        queuedAt: epochNow(),
        dispatchedAt: null,
        workerStartupMs: 0,
        coldWorker: false,
        workerTiming: null,
        resultReceivedAt: null,
        transferList,
        signal: options.signal,
        abortHandler: null,
        timer: null,
        onTiming: options.onTiming,
        resolve: (value) => resolve(value as WorkerTaskResult<K>),
        reject,
        finished,
        finish,
        settled: false,
      }
      if (job.signal) {
        job.abortHandler = () => this.abortJob(job)
        job.signal.addEventListener('abort', job.abortHandler, { once: true })
      }
      this.queues.get(priority)!.push(job)
      // Таймаут охватывает и очередь, и выполнение. Иначе при сломанном entry
      // первый Discord job мог ждать запуска worker бесконечно.
      job.timer = setTimeout(() => this.timeoutJob(job), timeoutMs)
      if (options.onControl) {
        try {
          options.onControl({ promote: (nextPriority) => this.promoteJob(job, nextPriority) })
        } catch (error) {
          this.failControlledJob(job, error instanceof Error ? error : new Error(String(error)))
          return
        }
      }
      this.ensureWorkers()
      this.dispatch()
    })
  }

  async close(graceMs = 10_000): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    const closeError = new Error('Пул CPU workers остановлен')
    for (const queue of this.queues.values()) {
      for (const job of queue.splice(0)) this.settle(job, closeError)
    }

    const active = [...this.slots].flatMap((slot) => (slot.job ? [slot.job.finished] : []))
    if (active.length > 0 && graceMs > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs)
        }),
      ])
      if (timer) clearTimeout(timer)
    }

    const slots = [...this.slots]
    this.slots.clear()
    await Promise.all(
      slots.map(async (slot) => {
        slot.retiring = true
        clearTimeout(slot.startupTimer)
        if (slot.job) this.settle(slot.job, closeError)
        await slot.worker.terminate().catch(() => undefined)
      }),
    )
  }

  private ensureWorkers(): void {
    if (this.closing || this.queuedCount() === 0 || this.respawnTimer) return
    while (!this.closing && this.slots.size < this.size) {
      if (!this.spawnWorker()) break
    }
  }

  private spawnWorker(): boolean {
    const spawnedAt = epochNow()
    let worker: Worker
    try {
      const sourceRuntime = /\.[cm]?ts$/i.test(fileURLToPath(import.meta.url))
      const entryUrl = new URL(sourceRuntime ? './entry.ts' : './entry.js', import.meta.url)
      // В worker_threads обычный `--import tsx` умеет открыть entry.ts, но на
      // Node 24 не применяет TS-resolver к его ESM-импортам с расширением .js.
      // Программная регистрация tsx внутри самого worker покрывает и entry, и
      // весь его граф импортов. Dist по-прежнему запускает готовый entry.js.
      const workerUrl = sourceRuntime
        ? new URL(
            `data:text/javascript,${encodeURIComponent(
              `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};` +
              `register();await import(${JSON.stringify(entryUrl.href)})`,
            )}`,
          )
        : entryUrl
      worker = new Worker(workerUrl, {
        name: `wtbot-cpu-${this.slots.size + 1}`,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: WORKER_RESOURCES.maxOldGenerationSizeMb },
      })
    } catch (error) {
      this.onStartupFailure(error instanceof Error ? error : new Error(String(error)))
      return false
    }
    const slot: WorkerSlot = {
      worker,
      ready: false,
      retiring: false,
      job: null,
      startupTimer: setTimeout(() => this.retire(slot, new Error('CPU worker не запустился за 30 секунд')), STARTUP_TIMEOUT_MS),
      renderJobsCompleted: 0,
      tasksCompleted: 0,
      spawnedAt,
      readyAt: null,
    }
    slot.startupTimer.unref()
    this.slots.add(slot)
    worker.on('message', (message: WorkerMessage) => this.onMessage(slot, message))
    worker.on('messageerror', (err) => this.retire(slot, new Error(`Ошибка сообщения CPU worker: ${String(err)}`)))
    worker.on('error', (err) => this.retire(slot, err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', (code) => {
      if (!slot.retiring && !this.closing) {
        this.retire(slot, new Error(`CPU worker неожиданно завершился с кодом ${code}`))
      }
    })
    worker.unref()
    return true
  }

  private onMessage(slot: WorkerSlot, message: WorkerMessage): void {
    if (slot.retiring) return
    if (message.type === 'ready') {
      clearTimeout(slot.startupTimer)
      slot.ready = true
      slot.readyAt = epochNow()
      this.startupFailures = 0
      this.dispatch()
      if (!slot.job) slot.worker.unref()
      return
    }

    const job = slot.job
    if (!job || message.response.id !== job.id) {
      this.retire(slot, new Error('CPU worker вернул ответ с неизвестным id'))
      return
    }
    slot.job = null
    job.workerTiming = message.response.timing
    job.resultReceivedAt = epochNow()
    slot.tasksCompleted++
    if (
      job.task.kind === 'render-scoreboard' ||
      job.task.kind === 'render-media' ||
      job.task.kind === 'render-media-kind' ||
      job.task.kind === 'render-heatmap'
    ) slot.renderJobsCompleted++
    if (message.response.ok) this.settle(job, null, message.response.value)
    else {
      const err = new Error(message.response.error.message)
      err.name = message.response.error.name
      if (message.response.error.stack) err.stack = message.response.error.stack
      this.settle(job, err)
    }
    if (slot.renderJobsCompleted >= MAX_RENDER_JOBS_PER_WORKER) {
      // Resvg держит часть памяти в native allocator; периодический recycle
      // ограничивает рост RSS долгоживущего бота.
      this.retire(slot, new Error('плановая ротация CPU worker после native render jobs'))
    } else {
      slot.worker.unref()
      this.dispatch()
    }
  }

  private dispatch(): void {
    if (this.closing) return
    for (const slot of this.slots) {
      if (!slot.ready || slot.retiring || slot.job) continue
      const job = this.nextRunnableJob()
      if (!job) {
        slot.worker.unref()
        continue
      }
      slot.job = job
      slot.worker.ref()
      const sentAt = epochNow()
      job.dispatchedAt = sentAt
      job.coldWorker = slot.tasksCompleted === 0
      job.workerStartupMs = job.coldWorker ? Math.max(0, (slot.readyAt ?? sentAt) - slot.spawnedAt) : 0
      const request: WorkerRequest = { id: job.id, task: job.task, sentAtMs: sentAt }
      try {
        slot.worker.postMessage(request, job.transferList)
      } catch (err) {
        slot.job = null
        this.settle(job, err instanceof Error ? err : new Error(String(err)))
        this.retire(slot, new Error('Не удалось отправить задачу CPU worker'))
      }
    }
  }

  private nextRunnableJob(): Job | null {
    for (;;) {
      const background = this.queues.get('background')!
      const activeBackground = [...this.slots].filter((slot) => slot.job?.priority === 'background').length
      // Во время запуска и плановой ротации из настроенного пула может временно
      // остаться один готовый слот. Резерв считаем по реальной ёмкости, чтобы
      // этот слот не ушёл в многосекундный ingest перед Discord-задачей.
      const readyCapacity = [...this.slots].filter((slot) => slot.ready && !slot.retiring).length
      const backgroundWaitedTooLong =
        readyCapacity <= 1 && background[0] !== undefined && Date.now() - background[0].queuedAt >= BACKGROUND_MAX_WAIT_MS
      // При 2+ workers гарантируем ingest один слот, если он ждёт; при одном
      // потоке aging не даёт бесконечно вытеснять его Discord-задачами.
      let job =
        background.length > 0 && ((readyCapacity > 1 && activeBackground === 0) || backgroundWaitedTooLong)
          ? background.shift()
          : undefined
      job ??= this.queues.get('interactive')!.shift() ?? this.queues.get('normal')!.shift()
      if (!job) {
        // Часть готовых slots не занимаем фоновыми разборами: Discord
        // interaction сможет начать CPU-задачу, не дожидаясь ingest.
        const backgroundLimit = Math.max(1, readyCapacity - this.backgroundReserveSlots)
        if (activeBackground < backgroundLimit) job = this.queues.get('background')!.shift()
      }
      if (!job) return null
      if (job.signal?.aborted) {
        this.settle(job, abortError())
        continue
      }
      return job
    }
  }

  private abortJob(job: Job): void {
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
        this.settle(job, abortError())
        return
      }
    }
    const slot = [...this.slots].find((candidate) => candidate.job === job)
    if (slot) this.retire(slot, abortError())
  }

  private promoteJob(job: Job, priority: WorkerPriority): void {
    if (job.settled || PRIORITIES.indexOf(priority) >= PRIORITIES.indexOf(job.priority)) return
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
        job.priority = priority
        this.queues.get(priority)!.unshift(job)
        this.dispatch()
        return
      }
    }
    // Уже выполняющийся job нельзя прервать без потери transferred buffers,
    // но новая классификация корректирует reservation/fairness пула.
    if ([...this.slots].some((slot) => slot.job === job)) job.priority = priority
  }

  private failControlledJob(job: Job, error: Error): void {
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
        this.settle(job, error)
        return
      }
    }
    const slot = [...this.slots].find((candidate) => candidate.job === job)
    if (slot) this.retire(slot, error)
    else this.settle(job, error)
  }

  private timeoutJob(job: Job): void {
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(job)
      if (index >= 0) {
        queue.splice(index, 1)
        this.settle(
          job,
          new WorkerPoolError(`таймаут очереди CPU-задачи: слот не получен за ${job.timeoutMs} мс`, 'QUEUE_TIMEOUT'),
        )
        return
      }
    }
    const slot = [...this.slots].find((candidate) => candidate.job === job)
    if (slot) this.retire(slot, new Error(`CPU worker превысил таймаут выполнения ${job.timeoutMs} мс`))
  }

  private retire(slot: WorkerSlot, error: Error): void {
    if (slot.retiring) return
    const failedDuringStartup = !slot.ready
    slot.retiring = true
    clearTimeout(slot.startupTimer)
    this.slots.delete(slot)
    if (slot.job) {
      const job = slot.job
      slot.job = null
      this.settle(job, error)
    }
    void slot.worker.terminate().catch(() => undefined).finally(() => {
      if (this.closing) return
      if (failedDuringStartup) this.onStartupFailure(error)
      else this.scheduleWorkers(0)
    })
  }

  private onStartupFailure(error: Error): void {
    if (this.closing || this.queuedCount() === 0) return
    this.startupFailures++
    if (this.startupFailures >= MAX_STARTUP_FAILURES) {
      const poolError = new WorkerPoolError(
        `Не удалось запустить CPU worker после ${MAX_STARTUP_FAILURES} попыток: ${error.message}`,
        'STARTUP_FAILED',
      )
      for (const queue of this.queues.values()) {
        for (const job of queue.splice(0)) this.settle(job, poolError)
      }
      this.startupFailures = 0
      return
    }
    const delay = Math.min(100 * 2 ** (this.startupFailures - 1), MAX_STARTUP_BACKOFF_MS)
    this.scheduleWorkers(delay)
  }

  private scheduleWorkers(delayMs: number): void {
    if (this.closing || this.queuedCount() === 0 || this.respawnTimer) return
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.ensureWorkers()
      this.dispatch()
    }, delayMs)
  }

  private settle(job: Job, error: Error | null, value?: unknown): void {
    if (job.settled) return
    job.settled = true
    if (job.timer) clearTimeout(job.timer)
    if (job.abortHandler && job.signal) job.signal.removeEventListener('abort', job.abortHandler)
    const completedAt = job.resultReceivedAt ?? epochNow()
    const queueEndedAt = job.dispatchedAt ?? completedAt
    const queueMs = Math.max(0, queueEndedAt - job.queuedAt)
    const workerStartupMs = Math.min(queueMs, job.workerStartupMs)
    const inputTransferMs = job.workerTiming && job.dispatchedAt !== null
      ? Math.max(0, job.workerTiming.receivedAtMs - job.dispatchedAt)
      : null
    const executionMs = job.workerTiming
      ? Math.max(0, job.workerTiming.completedAtMs - job.workerTiming.receivedAtMs)
      : null
    const resultTransferMs = job.workerTiming
      ? Math.max(0, completedAt - job.workerTiming.completedAtMs)
      : null
    if (job.onTiming) {
      try {
        job.onTiming({
          kind: job.task.kind,
          priority: job.priority,
          outcome: error ? 'error' : 'success',
          stage: job.dispatchedAt === null ? 'queue' : 'execution',
          coldWorker: job.coldWorker,
          queueMs,
          schedulerWaitMs: Math.max(0, queueMs - workerStartupMs),
          workerStartupMs,
          inputTransferMs,
          executionMs,
          resultTransferMs,
          totalMs: Math.max(0, completedAt - job.queuedAt),
        })
      } catch (timingError) {
        console.error(`[workers] ошибка обработчика timing: ${String(timingError)}`)
      }
    }
    if (error) job.reject(error)
    else job.resolve(value)
    job.finish()
  }

  private queuedCount(): number {
    let count = 0
    for (const queue of this.queues.values()) count += queue.length
    return count
  }

  private queuedTransferBytes(): number {
    let bytes = 0
    for (const queue of this.queues.values()) {
      for (const job of queue) {
        for (const item of job.transferList) {
          if (item instanceof ArrayBuffer) bytes += item.byteLength
        }
      }
    }
    return bytes
  }
}

const pool = new CpuWorkerPool()

export function runWorkerTask<K extends WorkerTaskKind>(
  task: Extract<AnyWorkerTask, { kind: K }>,
  options?: WorkerRunOptions,
): Promise<WorkerTaskResult<K>> {
  return pool.run(task, options)
}

export function closeWorkerPool(graceMs?: number): Promise<void> {
  return pool.close(graceMs)
}

export function isWorkerPoolSchedulingError(error: unknown): error is WorkerPoolError {
  return (
    error instanceof WorkerPoolError &&
    (error.code === 'POOL_CLOSED' ||
      error.code === 'QUEUE_FULL' ||
      error.code === 'QUEUE_MEMORY' ||
      error.code === 'QUEUE_TIMEOUT' ||
      error.code === 'STARTUP_FAILED')
  )
}

/** Забирает целый ArrayBuffer без memcpy; для среза общего slab делает точную копию. */
export function transferableBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data.buffer
  }
  return transferableCopy(data)
}

/** Всегда создаёт owned backing store: для данных из shared inflight cache. */
export function transferableCopy(data: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(data.byteLength)
  owned.set(data)
  return owned.buffer
}
