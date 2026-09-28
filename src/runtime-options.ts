import { availableParallelism, freemem, totalmem } from 'node:os'

const BYTES_PER_MB = 1024 * 1024
export const MAX_CONFIGURABLE_WORKERS = 8
export const MAX_INGEST_CONCURRENCY = MAX_CONFIGURABLE_WORKERS * 4

type WorkerResourceEnvironment = Readonly<Record<string, string | undefined>>
let cachedDefaultPlan: WorkerResourcePlan | undefined

export interface WorkerResourcePlanOptions {
  /** Подмена окружения и характеристик машины для smoke-тестов. */
  env?: WorkerResourceEnvironment
  availableCpus?: number
  totalMemoryMb?: number
  freeMemoryMb?: number
}

export interface WorkerResourcePlan {
  availableCpus: number
  totalMemoryMb: number
  freeMemoryMb: number
  reservedCpus: number
  reservedMemoryMb: number
  estimatedWorkerMemoryMb: number
  cpuLimitedThreads: number
  memoryLimitedThreads: number
  workerThreads: number
  explicitWorkerThreads: boolean
  backgroundReserveSlots: number
  backgroundWorkerThreads: number
  ingestConcurrency: number
  replayProcessByteBudgetMb: number
  maxOldGenerationSizeMb: number
}

export interface MemoryProbe {
  totalBytes: number
  freeBytes: number
  /** process.constrainedMemory(): лимит cgroup; 0 или огромное значение — лимита нет. */
  constrainedBytes: number
  /** process.availableMemory(): свободная память с учётом лимита. */
  availableBytes: number
}

/**
 * Память, которую реально может занять процесс. В Docker os.totalmem() и
 * os.freemem() показывают память хоста: без учёта cgroup-лимита авто-план на
 * хосте с 32 ГБ и лимитом контейнера 2 ГБ выбрал бы слишком много workers,
 * и ядро убило бы контейнер по OOM.
 */
export function containerAwareMemory(probe: MemoryProbe): { totalBytes: number; freeBytes: number } {
  const limited = probe.constrainedBytes > 0 && probe.constrainedBytes < probe.totalBytes
  const totalBytes = limited ? probe.constrainedBytes : probe.totalBytes
  const availableBytes = probe.availableBytes > 0 ? probe.availableBytes : probe.freeBytes
  return { totalBytes, freeBytes: Math.min(totalBytes, probe.freeBytes, availableBytes) }
}

function systemMemory(): { totalBytes: number; freeBytes: number } {
  return containerAwareMemory({
    totalBytes: totalmem(),
    freeBytes: freemem(),
    constrainedBytes: process.constrainedMemory(),
    availableBytes: process.availableMemory(),
  })
}

function integerSetting(
  env: WorkerResourceEnvironment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Переменная ${name} должна быть целым числом от ${min} до ${max}`)
  }
  return parsed
}

/**
 * Рассчитывает безопасную верхнюю границу CPU workers.
 *
 * Автоматический режим оставляет CPU основному Node-потоку/ОС и часть RAM,
 * после чего выбирает более строгий из CPU- и memory-лимитов. Явный
 * WT_WORKER_THREADS переопределяет авторасчёт, но всё равно ограничен числом
 * доступных логических CPU.
 */
export function workerResourcePlan(options: WorkerResourcePlanOptions = {}): WorkerResourcePlan {
  const useCachedDefault =
    options.env === undefined &&
    options.availableCpus === undefined &&
    options.totalMemoryMb === undefined &&
    options.freeMemoryMb === undefined
  if (useCachedDefault && cachedDefaultPlan) return cachedDefaultPlan

  const env = options.env ?? process.env
  const availableCpus = Math.max(1, Math.floor(options.availableCpus ?? availableParallelism()))
  let probed: { totalBytes: number; freeBytes: number } | undefined
  const measured = () => (probed ??= systemMemory())
  const totalMemoryMb = Math.max(
    256,
    Math.floor(options.totalMemoryMb ?? measured().totalBytes / BYTES_PER_MB),
  )
  const freeMemoryMb = Math.max(
    0,
    Math.min(
      totalMemoryMb,
      Math.floor(
        options.freeMemoryMb ??
          (options.totalMemoryMb === undefined ? measured().freeBytes / BYTES_PER_MB : totalMemoryMb),
      ),
    ),
  )

  const defaultReservedCpus = availableCpus > 1 ? 1 : 0
  const reservedCpus = integerSetting(
    env,
    'WT_WORKER_RESERVE_CPUS',
    defaultReservedCpus,
    0,
    Math.max(0, availableCpus - 1),
  )
  const cpuLimitedThreads = Math.max(1, availableCpus - reservedCpus)

  const estimatedWorkerMemoryMb = integerSetting(
    env,
    'WT_WORKER_ESTIMATED_MB',
    320,
    128,
    4096,
  )
  const defaultMemoryReserveMb = Math.min(
    Math.max(512, Math.floor(totalMemoryMb * 0.15)),
    Math.max(0, totalMemoryMb - 256),
  )
  const reservedMemoryMb = integerSetting(
    env,
    'WT_WORKER_MEMORY_RESERVE_MB',
    defaultMemoryReserveMb,
    0,
    Math.max(0, totalMemoryMb - 256),
  )
  const workerAndReplayMemoryMb = Math.max(
    estimatedWorkerMemoryMb,
    Math.min(totalMemoryMb - reservedMemoryMb, freeMemoryMb - reservedMemoryMb),
  )
  // Два параллельных боя должны иметь место для двух worst-case WRPL-частей
  // каждый (4 × 96 МиБ). На малой машине floor плавно уменьшается, но остаётся
  // не ниже 128 МиБ. Резерв вычитается до выбора auto worker count, чтобы CPU
  // workers и replay pipeline не планировали одну и ту же память дважды.
  const minimumReplayProcessBudgetMb = Math.max(
    128,
    Math.min(384, workerAndReplayMemoryMb - estimatedWorkerMemoryMb),
  )
  const memoryLimitedThreads = Math.max(
    1,
    Math.floor(
      Math.max(
        estimatedWorkerMemoryMb,
        workerAndReplayMemoryMb - minimumReplayProcessBudgetMb,
      ) / estimatedWorkerMemoryMb,
    ),
  )

  const rawThreads = env['WT_WORKER_THREADS']?.trim().toLowerCase()
  const explicitWorkerThreads = rawThreads !== undefined && rawThreads !== '' && rawThreads !== 'auto'
  const automaticThreads = Math.max(
    1,
    Math.min(cpuLimitedThreads, memoryLimitedThreads, MAX_CONFIGURABLE_WORKERS),
  )
  const workerThreads = explicitWorkerThreads
    ? Math.min(
        integerSetting(env, 'WT_WORKER_THREADS', automaticThreads, 1, availableCpus),
        MAX_CONFIGURABLE_WORKERS,
      )
    : automaticThreads
  const backgroundReserveSlots = workerThreads > 1
    ? integerSetting(env, 'WT_WORKER_BACKGROUND_RESERVE', 1, 0, workerThreads - 1)
    : 0
  const backgroundWorkerThreads = Math.max(1, workerThreads - backgroundReserveSlots)
  // Ingest включает длительную загрузку частей с CDN, а не только CPU parse.
  // Без явной настройки сохраняем безопасное соотношение 1:1 с фоновыми
  // workers; явное значение может держать больше I/O-задач в полёте, пока
  // CPU-пул разбирает уже скачанные replay.
  const ingestConcurrency = Math.min(
    integerSetting(env, 'WT_INGEST_CONCURRENCY', backgroundWorkerThreads, 1, 1024),
    MAX_INGEST_CONCURRENCY,
  )
  const replayBudgetMemoryMb = Math.max(
    minimumReplayProcessBudgetMb,
    workerAndReplayMemoryMb - workerThreads * estimatedWorkerMemoryMb,
  )
  const defaultReplayProcessByteBudgetMb = Math.min(
    2048,
    Math.floor(replayBudgetMemoryMb),
  )
  const replayProcessByteBudgetMb = integerSetting(
    env,
    'WT_REPLAY_PROCESS_BUDGET_MB',
    defaultReplayProcessByteBudgetMb,
    128,
    8192,
  )
  const maxOldGenerationSizeMb = integerSetting(
    env,
    'WT_WORKER_MAX_OLD_SPACE_MB',
    768,
    128,
    4096,
  )

  const plan: WorkerResourcePlan = {
    availableCpus,
    totalMemoryMb,
    freeMemoryMb,
    reservedCpus,
    reservedMemoryMb,
    estimatedWorkerMemoryMb,
    cpuLimitedThreads,
    memoryLimitedThreads,
    workerThreads,
    explicitWorkerThreads,
    backgroundReserveSlots,
    backgroundWorkerThreads,
    ingestConcurrency,
    replayProcessByteBudgetMb,
    maxOldGenerationSizeMb,
  }
  if (useCachedDefault) cachedDefaultPlan = plan
  return plan
}

/** Совместимый короткий accessor для существующих импортов. */
export function workerThreadCount(envValue = process.env['WT_WORKER_THREADS']): number {
  return workerResourcePlan({
    env: { ...process.env, WT_WORKER_THREADS: envValue },
  }).workerThreads
}
