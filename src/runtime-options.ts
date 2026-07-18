import { availableParallelism } from 'node:os'

/** Число CPU workers: по умолчанию 1–2, чтобы не раздувать память Resvg/WRPL. */
export function workerThreadCount(envValue = process.env['WT_WORKER_THREADS']): number {
  const fallback = Math.max(1, Math.min(2, availableParallelism() - 1))
  const parsed = Number(envValue ?? fallback)
  return Number.isInteger(parsed) ? Math.max(1, Math.min(8, parsed)) : fallback
}
