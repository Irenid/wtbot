// PSR (personal squadron rating) rule of the guides, frontend/src/lib/psr.ts:
// Elo against a fixed 1500 opponent, the change applied once per squadron
// battle. The bot's copy draws the battle image; psr.test.ts checks that both
// files give the same numbers, so a change goes into both.

/** Points at stake in one battle. */
export const PSR_K = 32
/** Fixed reference: a player at this PSR gains and loses the same. */
export const PSR_REFERENCE = 1500
/** Logistic scale: PSR points per tenfold change of the odds. */
export const PSR_SCALE = 400
/** A loss never costs less; PSR never goes below 0. */
export const PSR_MIN_LOSS = 1

/** E: the win share at which PSR stays put (above the PSR_MIN_LOSS range). */
export function holdWinRate(psr: number): number {
  return 1 / (1 + 10 ** ((PSR_REFERENCE - psr) / PSR_SCALE))
}

/** Points for a win, unrounded (the server keeps decimals, the site shows a rounded PSR). */
export function winPoints(psr: number): number {
  return PSR_K * (1 - holdWinRate(psr))
}

/** Points lost for a defeat, as a positive number. */
export function lossPoints(psr: number): number {
  return Math.max(PSR_MIN_LOSS, PSR_K * holdWinRate(psr))
}

/** PSR after one battle, unrounded. */
export function psrAfterBattle(psr: number, won: boolean): number {
  return won ? psr + winPoints(psr) : Math.max(0, psr - lossPoints(psr))
}

/**
 * PSR before a battle that left `after`: the inverse of psrAfterBattle, which
 * grows with PSR (its slope is at least 1 − PSR_K·ln10/(4·PSR_SCALE) ≈ 0.95).
 * A loss that ended at 0 gives 0: any PSR up to PSR_MIN_LOSS ends there.
 */
export function psrBeforeBattle(after: number, won: boolean): number {
  if (!won && after <= 0) return 0
  // A battle moves PSR by at most PSR_K.
  let lo = Math.max(0, after - PSR_K)
  let hi = after + PSR_K
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2
    if (psrAfterBattle(mid, won) < after) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
