export const MAX_WINNER_UPDATES = 16
export const MAX_WINNER_UPDATE_BYTES = 8 * 1024 * 1024

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
