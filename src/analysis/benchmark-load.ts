import { performance } from 'node:perf_hooks'

export const MAX_BENCHMARK_RUNS = 10_000

export type BenchmarkLoadMode =
  | 'closed-loop-count'
  | 'closed-loop-duration'
  | 'open-loop'

export interface BenchmarkLoadOptions {
  concurrency: number
  maxRuns: number | null
  durationMs: number | null
  arrivalRatePerSecond: number | null
}

export interface BenchmarkLoadSample<T> {
  index: number
  scheduledOffsetMs: number
  startedOffsetMs: number
  completedOffsetMs: number
  startDelayMs: number
  value: T
}

export interface BenchmarkLoadResult<T> {
  mode: BenchmarkLoadMode
  requestedRuns: number | null
  requestedDurationMs: number | null
  requestedArrivalRatePerSecond: number | null
  offeredRuns: number
  completedRuns: number
  maxInFlight: number
  lastAdmissionOffsetMs: number
  elapsedMs: number
  durationReached: boolean
  runLimitReached: boolean
  safetyLimitReached: boolean
  runs: BenchmarkLoadSample<T>[]
}

interface LoadState<T> {
  startedAt: number
  inFlight: number
  maxInFlight: number
  lastAdmissionOffsetMs: number
  failed: boolean
  failure: unknown
  runs: BenchmarkLoadSample<T>[]
}

export async function runBenchmarkLoad<T>(
  options: BenchmarkLoadOptions,
  work: (index: number) => Promise<T>,
): Promise<BenchmarkLoadResult<T>> {
  validateOptions(options)
  const mode: BenchmarkLoadMode = options.arrivalRatePerSecond !== null
    ? 'open-loop'
    : options.durationMs !== null
      ? 'closed-loop-duration'
      : 'closed-loop-count'
  const state: LoadState<T> = {
    startedAt: performance.now(),
    inFlight: 0,
    maxInFlight: 0,
    lastAdmissionOffsetMs: 0,
    failed: false,
    failure: null,
    runs: [],
  }

  const limits = mode === 'open-loop'
    ? await runOpenLoop(options, state, work)
    : await runClosedLoop(options, state, work)
  if (state.failed) throw state.failure

  return {
    mode,
    requestedRuns: options.maxRuns,
    requestedDurationMs: options.durationMs,
    requestedArrivalRatePerSecond: options.arrivalRatePerSecond,
    offeredRuns: limits.offeredRuns,
    completedRuns: state.runs.length,
    maxInFlight: state.maxInFlight,
    lastAdmissionOffsetMs: state.lastAdmissionOffsetMs,
    elapsedMs: performance.now() - state.startedAt,
    durationReached: limits.durationReached,
    runLimitReached: limits.runLimitReached,
    safetyLimitReached: limits.safetyLimitReached,
    runs: state.runs.sort((left, right) => left.index - right.index),
  }
}

async function runClosedLoop<T>(
  options: BenchmarkLoadOptions,
  state: LoadState<T>,
  work: (index: number) => Promise<T>,
): Promise<{
  offeredRuns: number
  durationReached: boolean
  runLimitReached: boolean
  safetyLimitReached: boolean
}> {
  const effectiveRunLimit = options.maxRuns ?? MAX_BENCHMARK_RUNS
  let nextIndex = 0
  let durationReached = false
  let runLimitReached = false
  let safetyLimitReached = false

  const takeIndex = (): number | null => {
    const elapsedMs = performance.now() - state.startedAt
    if (options.durationMs !== null && nextIndex > 0 && elapsedMs >= options.durationMs) {
      durationReached = true
      return null
    }
    if (nextIndex >= effectiveRunLimit) {
      if (options.maxRuns === null) safetyLimitReached = true
      else runLimitReached = true
      return null
    }
    const index = nextIndex++
    state.lastAdmissionOffsetMs = elapsedMs
    return index
  }

  const runner = async (): Promise<void> => {
    while (!state.failed) {
      const index = takeIndex()
      if (index === null) return
      await executeSample(index, performance.now() - state.startedAt, state, work)
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, () => runner()))
  return {
    offeredRuns: nextIndex,
    durationReached,
    runLimitReached,
    safetyLimitReached,
  }
}

async function runOpenLoop<T>(
  options: BenchmarkLoadOptions,
  state: LoadState<T>,
  work: (index: number) => Promise<T>,
): Promise<{
  offeredRuns: number
  durationReached: boolean
  runLimitReached: boolean
  safetyLimitReached: boolean
}> {
  const arrivalRate = options.arrivalRatePerSecond!
  const intervalMs = 1000 / arrivalRate
  const durationRuns = options.durationMs === null
    ? Number.POSITIVE_INFINITY
    : Math.ceil(options.durationMs / intervalMs)
  const requestedRuns = options.maxRuns ?? Number.POSITIVE_INFINITY
  const plannedRuns = Math.min(durationRuns, requestedRuns)
  if (!Number.isFinite(plannedRuns)) {
    throw new Error('Open-loop benchmark требует --duration или положительный лимит запусков')
  }
  if (plannedRuns > MAX_BENCHMARK_RUNS) {
    throw new Error(
      `Open-loop benchmark планирует ${plannedRuns} запусков; максимум ${MAX_BENCHMARK_RUNS}`,
    )
  }

  let available = options.concurrency
  const waiters: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (available > 0) {
      available--
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next) next()
    else available++
  }

  const scheduled: Array<Promise<void>> = []
  for (let index = 0; index < plannedRuns && !state.failed; index++) {
    const scheduledOffsetMs = index * intervalMs
    await waitUntil(state.startedAt + scheduledOffsetMs)
    if (state.failed) break
    state.lastAdmissionOffsetMs = performance.now() - state.startedAt
    scheduled.push((async () => {
      await acquire()
      try {
        if (!state.failed) {
          await executeSample(index, scheduledOffsetMs, state, work)
        }
      } finally {
        release()
      }
    })())
  }
  await Promise.all(scheduled)

  return {
    offeredRuns: scheduled.length,
    durationReached: options.durationMs !== null && durationRuns <= requestedRuns,
    runLimitReached: options.maxRuns !== null && requestedRuns <= durationRuns,
    safetyLimitReached: false,
  }
}

async function executeSample<T>(
  index: number,
  scheduledOffsetMs: number,
  state: LoadState<T>,
  work: (index: number) => Promise<T>,
): Promise<void> {
  const startedOffsetMs = performance.now() - state.startedAt
  state.inFlight++
  state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
  try {
    const value = await work(index)
    const completedOffsetMs = performance.now() - state.startedAt
    state.runs.push({
      index,
      scheduledOffsetMs,
      startedOffsetMs,
      completedOffsetMs,
      startDelayMs: Math.max(0, startedOffsetMs - scheduledOffsetMs),
      value,
    })
  } catch (error) {
    if (!state.failed) {
      state.failed = true
      state.failure = error
    }
  } finally {
    state.inFlight--
  }
}

async function waitUntil(deadline: number): Promise<void> {
  for (;;) {
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
  }
}

function validateOptions(options: BenchmarkLoadOptions): void {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Параллельность benchmark должна быть положительным целым числом')
  }
  if (
    options.maxRuns !== null &&
    (!Number.isInteger(options.maxRuns) || options.maxRuns < 0 || options.maxRuns > MAX_BENCHMARK_RUNS)
  ) {
    throw new Error(`Лимит benchmark-запусков должен быть целым от 0 до ${MAX_BENCHMARK_RUNS}`)
  }
  if (
    options.durationMs !== null &&
    (!Number.isFinite(options.durationMs) || options.durationMs <= 0)
  ) {
    throw new Error('Длительность benchmark должна быть положительным числом')
  }
  if (
    options.arrivalRatePerSecond !== null &&
    (!Number.isFinite(options.arrivalRatePerSecond) || options.arrivalRatePerSecond <= 0)
  ) {
    throw new Error('Arrival rate benchmark должен быть положительным числом')
  }
  if (
    options.arrivalRatePerSecond !== null &&
    options.durationMs === null &&
    (options.maxRuns === null || options.maxRuns === 0)
  ) {
    throw new Error('Open-loop benchmark требует --duration или положительный лимит запусков')
  }
}
