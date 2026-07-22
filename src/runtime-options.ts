import { availableParallelism, freemem, totalmem } from 'node:os'

const BYTES_PER_MB = 1024 * 1024

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
  maxOldGenerationSizeMb: number
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
  const totalMemoryMb = Math.max(
    256,
    Math.floor(options.totalMemoryMb ?? totalmem() / BYTES_PER_MB),
  )
  const freeMemoryMb = Math.max(
    0,
    Math.min(
      totalMemoryMb,
      Math.floor(
        options.freeMemoryMb ??
          (options.totalMemoryMb === undefined ? freemem() / BYTES_PER_MB : totalMemoryMb),
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
    640,
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
  const memoryLimitedThreads = Math.max(
    1,
    Math.floor(
      Math.max(
        estimatedWorkerMemoryMb,
        Math.min(totalMemoryMb - reservedMemoryMb, freeMemoryMb - reservedMemoryMb),
      ) / estimatedWorkerMemoryMb,
    ),
  )

  const rawThreads = env['WT_WORKER_THREADS']?.trim().toLowerCase()
  const explicitWorkerThreads = rawThreads !== undefined && rawThreads !== '' && rawThreads !== 'auto'
  const automaticThreads = Math.max(1, Math.min(cpuLimitedThreads, memoryLimitedThreads))
  const workerThreads = explicitWorkerThreads
    ? integerSetting(env, 'WT_WORKER_THREADS', automaticThreads, 1, availableCpus)
    : automaticThreads
  const backgroundReserveSlots = workerThreads > 1
    ? integerSetting(env, 'WT_WORKER_BACKGROUND_RESERVE', 1, 0, workerThreads - 1)
    : 0
  const backgroundWorkerThreads = Math.max(1, workerThreads - backgroundReserveSlots)
  const ingestConcurrency = Math.min(
    backgroundWorkerThreads,
    integerSetting(env, 'WT_INGEST_CONCURRENCY', backgroundWorkerThreads, 1, 1024),
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
