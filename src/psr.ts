// PSR (personal squadron rating) rule of the guides, frontend/src/lib/psr.ts:
// Elo against the enemy team's average PSR, never below 1500, the change
// applied once per squadron battle. The bot's copy draws the battle image;
// psr.test.ts checks that both files give the same numbers, so a change goes
// into both.

/** Points at stake in one battle. */
export const PSR_K = 32
/** The weakest opponent a battle is scored against: an enemy team averaging less counts as this. */
export const PSR_REFERENCE = 1500
/** Logistic scale: PSR points per tenfold change of the odds. */
export const PSR_SCALE = 400
/** A loss never costs less; PSR never goes below 0. */
export const PSR_MIN_LOSS = 1

/**
 * E: the win share at which PSR stays put (above the PSR_MIN_LOSS range)
 * against an enemy team whose average PSR before the battle is `enemyPsr`.
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

/** PSR after one battle, unrounded. */
export function psrAfterBattle(psr: number, won: boolean, enemyPsr = PSR_REFERENCE): number {
  return won ? psr + winPoints(psr, enemyPsr) : Math.max(0, psr - lossPoints(psr, enemyPsr))
}

/**
 * PSR before a battle that left `after`: the inverse of psrAfterBattle, which
 * grows with PSR (its slope is at least 1 − PSR_K·ln10/(4·PSR_SCALE) ≈ 0.95).
 * A loss that ended at 0 gives 0: any PSR up to PSR_MIN_LOSS ends there.
 */
export function psrBeforeBattle(after: number, won: boolean, enemyPsr = PSR_REFERENCE): number {
  if (!won && after <= 0) return 0
  // A battle moves PSR by at most PSR_K.
  let lo = Math.max(0, after - PSR_K)
  let hi = after + PSR_K
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2
    if (psrAfterBattle(mid, won, enemyPsr) < after) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
