// The site's guides have a copy of this formula in frontend/src/lib/psr.ts.
// If you change one, change the other too: psr.test.ts checks they match.

export const PSR_K = 32
export const PSR_REFERENCE = 1500
export const PSR_SCALE = 400
export const PSR_MIN_LOSS = 1

export function holdWinRate(psr: number, enemyPsr = PSR_REFERENCE): number {
  const enemy = Math.max(PSR_REFERENCE, enemyPsr)
  return 1 / (1 + 10 ** ((enemy - psr) / PSR_SCALE))
}

export function winPoints(psr: number, enemyPsr = PSR_REFERENCE): number {
  return PSR_K * (1 - holdWinRate(psr, enemyPsr))
}

export function lossPoints(psr: number, enemyPsr = PSR_REFERENCE): number {
  return Math.max(PSR_MIN_LOSS, PSR_K * holdWinRate(psr, enemyPsr))
}

export function psrAfterBattle(psr: number, won: boolean, enemyPsr = PSR_REFERENCE): number {
  if (won) {
    return psr + winPoints(psr, enemyPsr)
  }
  return Math.max(0, psr - lossPoints(psr, enemyPsr))
}

export function psrBeforeBattle(after: number, won: boolean, enemyPsr = PSR_REFERENCE): number {
  if (!won && after <= 0) {
    return 0
  }

  let low = Math.max(0, after - PSR_K)
  let high = after + PSR_K

  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (psrAfterBattle(mid, won, enemyPsr) < after) {
      low = mid
    } else {
      high = mid
    }
  }

  return (low + high) / 2
}
