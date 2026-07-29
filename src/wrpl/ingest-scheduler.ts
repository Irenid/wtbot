export type IngestOutcome =
  | 'ok'
  | 'no_parts'
  | 'expired'
  | 'error'
  | 'cancelled'
  | 'deferred'

/**
 * Полный выбранный batch означает, что за ним, вероятно, остался backlog.
 * Немедленно продолжаем только после реального прогресса: deferred/cancelled
 * не должны превращать занятый CPU pool или shutdown в busy loop.
 */
export function shouldContinueIngestImmediately(
  selectedCount: number,
  selectionLimit: number,
  outcomes: readonly IngestOutcome[],
  stopping: boolean,
): boolean {
  if (stopping || selectedCount < selectionLimit || outcomes.length === 0) return false
  return outcomes.some((outcome) => outcome !== 'deferred' && outcome !== 'cancelled')
}
