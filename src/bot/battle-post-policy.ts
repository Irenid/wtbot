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

/**
 * A post waits for its stored rows while the battle is not stored: the media
 * meta of an unstored battle (drawn from its replay, never stored) may give
 * the first winner, but ingest's commit replaces it.
 */
export function shouldQueueWinnerUpdate(hasBattleSummary: boolean): boolean {
  return !hasBattleSummary
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
