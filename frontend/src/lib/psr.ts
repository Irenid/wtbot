// PSR (personal squadron rating) rule, measured from public warthunder.com data
// (method and accuracy: guide "method", numbers in guides/measurements.ts):
// Elo against the enemy team's average PSR, never below 1500 (OPPONENT), the
// change applied once per squadron battle. Guide tables are computed from these
// functions for an enemy team at or below PSR_REFERENCE (the default), but the
// prose of i18n/guide/*.ts quotes their results (780, 903, the ceilings, the
// examples): a new constant means rewriting those sentences in all five locales.

/** Points at stake in one battle. */
export const PSR_K = 32
/** The weakest opponent a battle is scored against: an enemy team averaging less counts as this. */
export const PSR_REFERENCE = 1500
/** Logistic scale: PSR points per tenfold change of the odds. */
export const PSR_SCALE = 400
/** A loss never costs less; PSR never goes below 0. */
export const PSR_MIN_LOSS = 1

/** Squadron rating = full PSR of the best members + a share of the rest (as `totalSquadronRating` in src/web/routes/site.ts). */
export const SQUADRON_TOP = 20
export const SQUADRON_REST_SHARE = 0.05

/**
 * E: the win share at which PSR stays put (above MIN_LOSS_BELOW) against an
 * enemy team whose average PSR before the battle is `enemyPsr`.
 */
export function holdWinRate(psr: number, enemyPsr = PSR_REFERENCE): number {
  return 1 / (1 + 10 ** ((Math.max(PSR_REFERENCE, enemyPsr) - psr) / PSR_SCALE))
}

/** Points for a win, unrounded (the server keeps decimals, the site shows a rounded PSR). */
export function winPoints(psr: number, enemyPsr = PSR_REFERENCE): number {
  return PSR_K * (1 - holdWinRate(psr, enemyPsr))
}

/** Points lost for a defeat, as a positive number. */
export function lossPoints(psr: number, enemyPsr = PSR_REFERENCE): number {
  return Math.max(PSR_MIN_LOSS, PSR_K * holdWinRate(psr, enemyPsr))
}

/** Below this PSR (≈903.5) a loss costs exactly PSR_MIN_LOSS. */
export const MIN_LOSS_BELOW = PSR_REFERENCE - PSR_SCALE * Math.log10(PSR_K / PSR_MIN_LOSS - 1)

/** Win share above which PSR grows on average; equals E above MIN_LOSS_BELOW. */
export function breakEvenWinRate(psr: number): number {
  const win = winPoints(psr)
  const loss = lossPoints(psr)
  return loss / (win + loss)
}

/** Average change per battle at a win share. */
export function expectedChange(psr: number, winRate: number): number {
  return winRate * winPoints(psr) - (1 - winRate) * lossPoints(psr)
}

/** PSR where the average change is zero; Infinity at 100% wins, 0 when even a fresh player loses points. */
export function psrCeiling(winRate: number): number {
  if (winRate >= 1) return Infinity
  if (expectedChange(0, winRate) <= 0) return 0
  let lo = 0
  let hi = 5000
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2
    if (expectedChange(mid, winRate) > 0) lo = mid
    else hi = mid
  }
  return lo
}

/** PSR after `battles` battles on the average path (wins and losses mixed at `winRate`). */
export function psrAfter(from: number, battles: number, winRate: number): number {
  let psr = from
  for (let battle = 0; battle < battles; battle += 1) psr = Math.max(0, psr + expectedChange(psr, winRate))
  return psr
}

/** Battles on the average path until PSR reaches `target`; null when it is not reached within `limit`. */
export function battlesToReach(from: number, target: number, winRate: number, limit = 10_000): number | null {
  let psr = from
  for (let battle = 0; battle <= limit; battle += 1) {
    if (psr >= target) return battle
    psr = Math.max(0, psr + expectedChange(psr, winRate))
  }
  return null
}

/** Wins in a row needed to climb from one PSR to another. */
export function winsInARow(from: number, to: number, limit = 100_000): number | null {
  let psr = from
  for (let win = 0; win <= limit; win += 1) {
    if (psr >= to) return win
    psr += winPoints(psr)
  }
  return null
}

/** Highest whole PSR whose win still shows as the full +K. */
export function fullWinBelow(): number {
  let psr = 0
  while (Math.round(winPoints(psr + 1)) === PSR_K) psr += 1
  return psr
}

/** Elo win chance of a side stronger by `diff` if PSR measured strength exactly. */
export function eloWinChance(diff: number): number {
  return 1 / (1 + 10 ** (-diff / PSR_SCALE))
}
