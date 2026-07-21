import { availableParallelism } from 'node:os'

export function workerThreadCount(
  envValue = process.env['WT_WORKER_THREADS'],
): number {
  const available = availableParallelism()
  const fallback = Math.max(1, available - 1)
  const parsed = Number(envValue ?? fallback)

  return Number.isInteger(parsed)
    ? Math.max(1, Math.min(available, parsed))
    : fallback
}