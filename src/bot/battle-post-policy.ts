export const MAX_WINNER_UPDATES = 16
export const MAX_WINNER_UPDATE_BYTES = 8 * 1024 * 1024

export type BattleAnnouncementDecision = 'send' | 'skip' | 'wait'

export function battleAnnouncementDecision(
  winnerKnown: boolean,
  ingest: { status: 'ok' | 'error' | 'no_parts' | 'expired'; attempts: number } | null,
  maxAttempts: number,
): BattleAnnouncementDecision {
  if (winnerKnown) return 'send'
  if (
    ingest?.status === 'ok' ||
    ingest?.status === 'expired' ||
    ingest?.status === 'no_parts' ||
    (ingest?.status === 'error' && ingest.attempts >= maxAttempts)
  ) return 'skip'
  return 'wait'
}

/** Обновление нужно только пока нет ни durable summary, ни готовой media meta. */
export function shouldQueueWinnerUpdate(
  hasBattleSummary: boolean,
  hasMediaMeta: boolean,
): boolean {
  return !hasBattleSummary && !hasMediaMeta
}

export function canAdmitWinnerUpdate(
  currentCount: number,
  currentBytes: number,
  nextBytes: number,
): boolean {
  return currentCount < MAX_WINNER_UPDATES
    && nextBytes <= MAX_WINNER_UPDATE_BYTES
    && currentBytes <= MAX_WINNER_UPDATE_BYTES - nextBytes
}
