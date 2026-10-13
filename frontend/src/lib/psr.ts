// The bot has a copy of this formula in src/psr.ts.
// If you change one, change the other too: src/psr.test.ts checks they match.
// The guide texts (i18n/guide/*.ts) quote numbers from these functions, like 780 and 903,
// so after changing a constant those texts have to be rewritten in all five languages.

export const PSR_K = 32
export const PSR_REFERENCE = 1500
export const PSR_SCALE = 400
export const PSR_MIN_LOSS = 1

// Same rule as totalSquadronRating in src/web/routes/site.ts.
export const SQUADRON_TOP = 20
export const SQUADRON_REST_SHARE = 0.05

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

export const MIN_LOSS_BELOW = PSR_REFERENCE - PSR_SCALE * Math.log10(PSR_K / PSR_MIN_LOSS - 1)

export function breakEvenWinRate(psr: number): number {
  const win = winPoints(psr)
  const loss = lossPoints(psr)
  return loss / (win + loss)
}

export function expectedChange(psr: number, winRate: number): number {
  return winRate * winPoints(psr) - (1 - winRate) * lossPoints(psr)
}

export function psrCeiling(winRate: number): number {
  if (winRate >= 1) {
    return Infinity
  }
  if (expectedChange(0, winRate) <= 0) {
    return 0
  }

  let low = 0
  let high = 5000

  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (expectedChange(mid, winRate) > 0) {
      low = mid
    } else {
      high = mid
    }
  }

  return low
}

export function psrAfter(from: number, battles: number, winRate: number): number {
  let psr = from
  for (let i = 0; i < battles; i++) {
    psr = Math.max(0, psr + expectedChange(psr, winRate))
  }
  return psr
}

export function battlesToReach(from: number, target: number, winRate: number, limit = 10_000): number | null {
  let psr = from
  for (let battles = 0; battles <= limit; battles++) {
    if (psr >= target) {
      return battles
    }
    psr = Math.max(0, psr + expectedChange(psr, winRate))
  }
  return null
}

export function winsInARow(from: number, to: number, limit = 100_000): number | null {
  let psr = from
  for (let wins = 0; wins <= limit; wins++) {
    if (psr >= to) {
      return wins
    }
    psr += winPoints(psr)
  }
  return null
}

export function fullWinBelow(): number {
  let psr = 0
  while (Math.round(winPoints(psr + 1)) === PSR_K) {
    psr++
  }
  return psr
}

export function eloWinChance(diff: number): number {
  return 1 / (1 + 10 ** (-diff / PSR_SCALE))
}
