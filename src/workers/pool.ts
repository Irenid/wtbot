import { Worker, type Transferable } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { MAX_CONFIGURABLE_WORKERS, workerResourcePlan } from '../runtime-options.js'
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
  reason: string
  coldWorker: boolean
  inputTransferBytes: number
  outputTransferBytes: number
  queueMs: number
  schedulerWaitMs: number
  workerStartupMs: number
  inputTransferMs: number | null
  executionMs: number | null
  resultTransferMs: number | null
  totalMs: number
}

export interface WorkerPoolCompletedMetrics {
  submitted: number
  completed: number
  succeeded: number
  failed: number
  rejected: number
  inputTransferBytes: number
  outputTransferBytes: number
  queueMsTotal: number
  queueMsMax: number
  executionSamples: number
  executionMsTotal: number
  executionMsMax: number
  reasons: Record<string, number>
}

export interface WorkerPoolWorkloadSnapshot extends WorkerPoolCompletedMetrics {
  kind: WorkerTaskKind
  priority: WorkerPriority
  queued: number
  running: number
  queuedInputTransferBytes: number
  runningInputTransferBytes: number
  maxQueued: number
  maxRunning: number
  maxQueuedInputTransferBytes: number
  maxRunningInputTransferBytes: number
}

export interface WorkerPoolSnapshot {
  capturedAtMs: number
  configuredWorkers: number
  backgroundReserveSlots: number
  closing: boolean
  workers: {
    live: number
    ready: number
    starting: number
    busy: number
  }
  current: {
    queued: number
    running: number
    queuedInputTransferBytes: number
    runningInputTransferBytes: number
  }
  highWater: {
    queued: number
    running: number
    queuedInputTransferBytes: number
    runningInputTransferBytes: number
  }
  cumulative: WorkerPoolCompletedMetrics
  recycleReasons: Record<string, number>
  workloads: WorkerPoolWorkloadSnapshot[]
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
  inputTransferBytes: number
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

interface MutableCompletedMetrics extends Omit<WorkerPoolCompletedMetrics, 'reasons'> {
  reasons: Map<string, number>
}

interface MutableWorkloadMetrics extends MutableCompletedMetrics {
  kind: WorkerTaskKind
  priority: WorkerPriority
  maxQueued: number
  maxRunning: number
  maxQueuedInputTransferBytes: number
  maxRunningInputTransferBytes: number
}

interface CurrentWorkload {
  kind: WorkerTaskKind
  priority: WorkerPriority
  queued: number
  running: number
  queuedInputTransferBytes: number
  runningInputTransferBytes: number
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

export type WorkerPoolErrorCode =
  | 'POOL_CLOSED'
  | 'QUEUE_FULL'
  | 'QUEUE_MEMORY'
  | 'QUEUE_TIMEOUT'
  | 'EXEC_TIMEOUT'
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

function emptyCompletedMetrics(): MutableCompletedMetrics {
  return {
    submitted: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    inputTransferBytes: 0,
    outputTransferBytes: 0,
    queueMsTotal: 0,
    queueMsMax: 0,
    executionSamples: 0,
    executionMsTotal: 0,
    executionMsMax: 0,
    reasons: new Map(),
  }
}

function snapshotCompletedMetrics(metrics: MutableCompletedMetrics): WorkerPoolCompletedMetrics {
  return {
    submitted: metrics.submitted,
    completed: metrics.completed,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    rejected: metrics.rejected,
    inputTransferBytes: metrics.inputTransferBytes,
    outputTransferBytes: metrics.outputTransferBytes,
    queueMsTotal: metrics.queueMsTotal,
    queueMsMax: metrics.queueMsMax,
    executionSamples: metrics.executionSamples,
    executionMsTotal: metrics.executionMsTotal,
    executionMsMax: metrics.executionMsMax,
    reasons: Object.fromEntries([...metrics.reasons].sort(([left], [right]) => left.localeCompare(right))),
  }
}

function incrementReason(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
}

function taskReason(error: Error | null): string {
  if (!error) return 'COMPLETED'
  if (error instanceof WorkerPoolError) return error.code
  if (error.name === 'AbortError') return 'ABORTED'
  return 'TASK_ERROR'
}

function recycleReason(error: Error): string {
  if (error instanceof WorkerPoolError) return error.code
  if (error.name === 'AbortError') return 'ABORTED'
  if (error.message.includes('плановая ротация')) return 'RENDER_RECYCLE'
  if (error.message.includes('не запустился')) return 'STARTUP_TIMEOUT'
  if (error.message.includes('неизвестным id')) return 'PROTOCOL_ERROR'
  if (error.message.includes('отправить задачу')) return 'POST_MESSAGE_ERROR'
  if (error.message.includes('неожиданно завершился')) return 'WORKER_EXIT'
  if (error.message.includes('Ошибка сообщения')) return 'MESSAGE_ERROR'
  return 'WORKER_ERROR'
}

function workloadKey(kind: WorkerTaskKind, priority: WorkerPriority): string {
  return `${priority}\u0000${kind}`
}

export class CpuWorkerPool {
  private readonly size: number
  private readonly backgroundReserveSlots: number
  private readonly queues = new Map<WorkerPriority, Job[]>(PRIORITIES.map((p) => [p, []]))
  private readonly slots = new Set<WorkerSlot>()
  private readonly completedMetrics = emptyCompletedMetrics()
  private readonly workloadMetrics = new Map<string, MutableWorkloadMetrics>()
  private readonly recycleReasons = new Map<string, number>()
  private readonly highWater = {
    queued: 0,
    running: 0,
    queuedInputTransferBytes: 0,
    runningInputTransferBytes: 0,
  }
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

  snapshot(): WorkerPoolSnapshot {
    const currentByWorkload = this.currentWorkloads()
    const currentValues = [...currentByWorkload.values()]
    const current = currentValues.reduce(
      (total, workload) => ({
        queued: total.queued + workload.queued,
        running: total.running + workload.running,
        queuedInputTransferBytes:
          total.queuedInputTransferBytes + workload.queuedInputTransferBytes,
        runningInputTransferBytes:
          total.runningInputTransferBytes + workload.runningInputTransferBytes,
      }),
      {
        queued: 0,
        running: 0,
        queuedInputTransferBytes: 0,
        runningInputTransferBytes: 0,
      },
    )
    const workloadKeys = new Set([
      ...this.workloadMetrics.keys(),
      ...currentByWorkload.keys(),
    ])
    const workloads = [...workloadKeys].map((key): WorkerPoolWorkloadSnapshot => {
      const metrics = this.workloadMetrics.get(key)
      const live = currentByWorkload.get(key)
      if (!metrics && !live) throw new Error('Некорректный workload CPU pool')
      const kind = metrics?.kind ?? live!.kind
      const priority = metrics?.priority ?? live!.priority
      return {
        kind,
        priority,
        queued: live?.queued ?? 0,
        running: live?.running ?? 0,
        queuedInputTransferBytes: live?.queuedInputTransferBytes ?? 0,
        runningInputTransferBytes: live?.runningInputTransferBytes ?? 0,
        maxQueued: metrics?.maxQueued ?? live?.queued ?? 0,
        maxRunning: metrics?.maxRunning ?? live?.running ?? 0,
        maxQueuedInputTransferBytes:
          metrics?.maxQueuedInputTransferBytes ?? live?.queuedInputTransferBytes ?? 0,
        maxRunningInputTransferBytes:
          metrics?.maxRunningInputTransferBytes ?? live?.runningInputTransferBytes ?? 0,
        ...snapshotCompletedMetrics(metrics ?? emptyCompletedMetrics()),
      }
    }).sort((left, right) => {
      const priorityOrder = PRIORITIES.indexOf(left.priority) - PRIORITIES.indexOf(right.priority)
      return priorityOrder || left.kind.localeCompare(right.kind)
    })
    const slots = [...this.slots]
    return {
      capturedAtMs: Date.now(),
      configuredWorkers: this.size,
      backgroundReserveSlots: this.backgroundReserveSlots,
      closing: this.closing,
      workers: {
        live: slots.length,
        ready: slots.filter((slot) => slot.ready && !slot.retiring).length,
        starting: slots.filter((slot) => !slot.ready && !slot.retiring).length,
        busy: slots.filter((slot) => slot.job !== null).length,
      },
      current,
      highWater: { ...this.highWater },
      cumulative: snapshotCompletedMetrics(this.completedMetrics),
      recycleReasons: Object.fromEntries(
        [...this.recycleReasons].sort(([left], [right]) => left.localeCompare(right)),
      ),
      workloads,
    }
  }

  run<K extends WorkerTaskKind>(
    task: Extract<AnyWorkerTask, { kind: K }>,
    options: WorkerRunOptions = {},
  ): Promise<WorkerTaskResult<K>> {
    const priority = options.priority ?? 'normal'
    const transferList = options.transferList ?? []
    const taskBytes = transferList.reduce(
      (sum, item) => sum + (item instanceof ArrayBuffer ? item.byteLength : 0),
      0,
    )
    if (this.closing) {
      const error = new WorkerPoolError('Пул CPU workers уже остановлен', 'POOL_CLOSED')
      this.recordRejected(task.kind, priority, error.code)
      return Promise.reject(error)
    }
    if (options.signal?.aborted) {
      const error = abortError()
      this.recordRejected(task.kind, priority, 'ABORTED')
      return Promise.reject(error)
    }
    if (this.queuedCount() >= MAX_QUEUE) {
      const error = new WorkerPoolError(`Очередь CPU workers переполнена (${MAX_QUEUE} задач)`, 'QUEUE_FULL')
      this.recordRejected(task.kind, priority, error.code)
      return Promise.reject(error)
    }
    const queuedBytes = this.queuedTransferBytes()
    if (taskBytes > MAX_QUEUED_TRANSFER_BYTES) {
      const error = new WorkerPoolError(
        `CPU-задача передаёт больше допустимого объёма (${Math.ceil(taskBytes / 1024 / 1024)} МБ)`,
        'TASK_TOO_LARGE',
      )
      this.recordRejected(task.kind, priority, error.code)
      return Promise.reject(error)
    }
    if (queuedBytes + taskBytes > MAX_QUEUED_TRANSFER_BYTES) {
      const error = new WorkerPoolError(
        `Очередь CPU workers удерживает слишком много данных (${Math.ceil((queuedBytes + taskBytes) / 1024 / 1024)} МБ)`,
        'QUEUE_MEMORY',
      )
      this.recordRejected(task.kind, priority, error.code)
      return Promise.reject(error)
    }

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
        inputTransferBytes: taskBytes,
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
      this.recordSubmission(job)
      this.observeHighWater()
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
      this.recordRecycleReason('STARTUP_FAILURE')
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
    this.observeHighWater()
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
        this.recordPromotion(job, priority)
        job.priority = priority
        this.queues.get(priority)!.unshift(job)
        this.observeHighWater()
        this.dispatch()
        return
      }
    }
    // Уже выполняющийся job нельзя прервать без потери transferred buffers,
    // но новая классификация корректирует reservation/fairness пула.
    if ([...this.slots].some((slot) => slot.job === job)) {
      this.recordPromotion(job, priority)
      job.priority = priority
      this.observeHighWater()
    }
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
    if (slot) {
      this.retire(
        slot,
        new WorkerPoolError(`CPU worker превысил таймаут выполнения ${job.timeoutMs} мс`, 'EXEC_TIMEOUT'),
      )
    }
  }

  private retire(slot: WorkerSlot, error: Error): void {
    if (slot.retiring) return
    this.recordRecycleReason(recycleReason(error))
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
    const timing: WorkerTaskTiming = {
      kind: job.task.kind,
      priority: job.priority,
      outcome: error ? 'error' : 'success',
      stage: job.dispatchedAt === null ? 'queue' : 'execution',
      reason: taskReason(error),
      coldWorker: job.coldWorker,
      inputTransferBytes: job.inputTransferBytes,
      outputTransferBytes: job.workerTiming?.outputTransferBytes ?? 0,
      queueMs,
      schedulerWaitMs: Math.max(0, queueMs - workerStartupMs),
      workerStartupMs,
      inputTransferMs,
      executionMs,
      resultTransferMs,
      totalMs: Math.max(0, completedAt - job.queuedAt),
    }
    this.recordCompletion(timing)
    if (job.onTiming) {
      try {
        job.onTiming(timing)
      } catch (timingError) {
        console.error(`[workers] ошибка обработчика timing: ${String(timingError)}`)
      }
    }
    if (error) job.reject(error)
    else job.resolve(value)
    job.finish()
  }

  private recordSubmission(job: Job): void {
    this.completedMetrics.submitted++
    this.workloadMetric(job.task.kind, job.priority).submitted++
  }

  private recordPromotion(job: Job, priority: WorkerPriority): void {
    const previous = this.workloadMetric(job.task.kind, job.priority)
    previous.submitted = Math.max(0, previous.submitted - 1)
    this.workloadMetric(job.task.kind, priority).submitted++
  }

  private recordRejected(kind: WorkerTaskKind, priority: WorkerPriority, reason: string): void {
    this.completedMetrics.rejected++
    incrementReason(this.completedMetrics.reasons, reason)
    const metrics = this.workloadMetric(kind, priority)
    metrics.rejected++
    incrementReason(metrics.reasons, reason)
  }

  private recordCompletion(timing: WorkerTaskTiming): void {
    const metrics = [
      this.completedMetrics,
      this.workloadMetric(timing.kind, timing.priority),
    ]
    for (const metric of metrics) {
      metric.completed++
      if (timing.outcome === 'success') metric.succeeded++
      else metric.failed++
      metric.inputTransferBytes += timing.inputTransferBytes
      metric.outputTransferBytes += timing.outputTransferBytes
      metric.queueMsTotal += timing.queueMs
      metric.queueMsMax = Math.max(metric.queueMsMax, timing.queueMs)
      if (timing.executionMs !== null) {
        metric.executionSamples++
        metric.executionMsTotal += timing.executionMs
        metric.executionMsMax = Math.max(metric.executionMsMax, timing.executionMs)
      }
      incrementReason(metric.reasons, timing.reason)
    }
  }

  private recordRecycleReason(reason: string): void {
    incrementReason(this.recycleReasons, reason)
  }

  private workloadMetric(kind: WorkerTaskKind, priority: WorkerPriority): MutableWorkloadMetrics {
    const key = workloadKey(kind, priority)
    const existing = this.workloadMetrics.get(key)
    if (existing) return existing
    const created: MutableWorkloadMetrics = {
      kind,
      priority,
      ...emptyCompletedMetrics(),
      maxQueued: 0,
      maxRunning: 0,
      maxQueuedInputTransferBytes: 0,
      maxRunningInputTransferBytes: 0,
    }
    this.workloadMetrics.set(key, created)
    return created
  }

  private currentWorkloads(): Map<string, CurrentWorkload> {
    const current = new Map<string, CurrentWorkload>()
    const workload = (job: Job): CurrentWorkload => {
      const key = workloadKey(job.task.kind, job.priority)
      const existing = current.get(key)
      if (existing) return existing
      const created: CurrentWorkload = {
        kind: job.task.kind,
        priority: job.priority,
        queued: 0,
        running: 0,
        queuedInputTransferBytes: 0,
        runningInputTransferBytes: 0,
      }
      current.set(key, created)
      return created
    }
    for (const queue of this.queues.values()) {
      for (const job of queue) {
        const value = workload(job)
        value.queued++
        value.queuedInputTransferBytes += job.inputTransferBytes
      }
    }
    for (const slot of this.slots) {
      if (!slot.job) continue
      const value = workload(slot.job)
      value.running++
      value.runningInputTransferBytes += slot.job.inputTransferBytes
    }
    return current
  }

  private observeHighWater(): void {
    const workloads = [...this.currentWorkloads().values()]
    let queued = 0
    let running = 0
    let queuedInputTransferBytes = 0
    let runningInputTransferBytes = 0
    for (const workload of workloads) {
      queued += workload.queued
      running += workload.running
      queuedInputTransferBytes += workload.queuedInputTransferBytes
      runningInputTransferBytes += workload.runningInputTransferBytes
      const metrics = this.workloadMetric(workload.kind, workload.priority)
      metrics.maxQueued = Math.max(metrics.maxQueued, workload.queued)
      metrics.maxRunning = Math.max(metrics.maxRunning, workload.running)
      metrics.maxQueuedInputTransferBytes = Math.max(
        metrics.maxQueuedInputTransferBytes,
        workload.queuedInputTransferBytes,
      )
      metrics.maxRunningInputTransferBytes = Math.max(
        metrics.maxRunningInputTransferBytes,
        workload.runningInputTransferBytes,
      )
    }
    this.highWater.queued = Math.max(this.highWater.queued, queued)
    this.highWater.running = Math.max(this.highWater.running, running)
    this.highWater.queuedInputTransferBytes = Math.max(
      this.highWater.queuedInputTransferBytes,
      queuedInputTransferBytes,
    )
    this.highWater.runningInputTransferBytes = Math.max(
      this.highWater.runningInputTransferBytes,
      runningInputTransferBytes,
    )
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

export function workerPoolSnapshot(): WorkerPoolSnapshot {
  return pool.snapshot()
}

export function closeWorkerPool(graceMs?: number): Promise<void> {
  return pool.close(graceMs)
}

/** Задача начала выполняться и не уложилась в свой timeout (worker заменён). */
export function isWorkerExecutionTimeout(error: unknown): error is WorkerPoolError {
  return error instanceof WorkerPoolError && error.code === 'EXEC_TIMEOUT'
}

export function isWorkerPoolSchedulingError(error: unknown): error is WorkerPoolError {
  return (
    error instanceof WorkerPoolError &&
    (error.code === 'POOL_CLOSED' ||
      error.code === 'QUEUE_FULL' ||
      error.code === 'QUEUE_MEMORY' ||
      error.code === 'QUEUE_TIMEOUT' ||
      error.code === 'EXEC_TIMEOUT' ||
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
