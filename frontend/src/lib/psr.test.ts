import { describe, expect, it } from 'vitest'
import de from '../i18n/guide/de.ts?raw'
import en from '../i18n/guide/en.ts?raw'
import es from '../i18n/guide/es.ts?raw'
import fr from '../i18n/guide/fr.ts?raw'
import ru from '../i18n/guide/ru.ts?raw'
import {
  MIN_LOSS_BELOW,
  battlesToReach,
  breakEvenWinRate,
  expectedChange,
  fullWinBelow,
  holdWinRate,
  lossPoints,
  psrAfter,
  psrCeiling,
  winPoints,
} from './psr'

// The guide prose quotes these results of the rule in every language
// (frontend/src/lib/psr.ts header); src/psr.test.ts checks only the
// per-battle points against the bot's copy.
const GUIDES = { en, ru, de, fr, es }

/** Each number as the prose writes it, and the rule's value it stands for. */
const QUOTED: readonly { text: string; value: number; tolerance: number; what: string }[] = [
  { text: '780', value: fullWinBelow(), tolerance: 0, what: 'a win gives the full 32 up to' },
  { text: '903', value: MIN_LOSS_BELOW, tolerance: 0.5, what: 'a loss costs more than 1 from' },
  { text: '1650', value: psrCeiling(0.7), tolerance: 5, what: 'the level 70% wins reach' },
  { text: '1880', value: psrCeiling(0.9), tolerance: 5, what: 'the level 90% wins reach' },
  { text: '1570', value: psrCeiling(0.6), tolerance: 1, what: 'the level 60% wins reach' },
  { text: '1170', value: psrAfter(0, 100, 0.4), tolerance: 5, what: '100 battles at 40% wins' },
  { text: '510', value: psrAfter(0, 20, 0.8), tolerance: 5, what: '20 battles at 80% wins' },
  { text: '155', value: 5 * winPoints(0) - 5 * lossPoints(0), tolerance: 0.5, what: '5 wins and 5 losses at PSR 0' },
  { text: '143', value: -(5 * winPoints(2000) - 5 * lossPoints(2000)), tolerance: 0.5, what: 'the same record at 2000' },
  { text: '42', value: battlesToReach(0, MIN_LOSS_BELOW, 0.7) ?? NaN, tolerance: 0, what: 'battles to 903 at 70% wins' },
  { text: '59', value: battlesToReach(0, MIN_LOSS_BELOW, 0.5) ?? NaN, tolerance: 0, what: 'battles to 903 at 50% wins' },
  { text: '103', value: battlesToReach(0, MIN_LOSS_BELOW, 0.3) ?? NaN, tolerance: 0, what: 'battles to 903 at 30% wins' },
]

describe('the PSR guide quotes the rule', () => {
  for (const { text, value, tolerance, what } of QUOTED) {
    it(`${what}: ${text}`, () => {
      expect(Math.abs(value - Number(text))).toBeLessThanOrEqual(tolerance)
      for (const [locale, guide] of Object.entries(GUIDES)) {
        expect(new RegExp(`(^|[^\\d])${text}([^\\d]|$)`).test(guide), `${locale} quotes ${text}`).toBe(true)
      }
    })
  }

  it('per-battle points the prose names', () => {
    expect([Math.round(winPoints(1500)), Math.round(lossPoints(1500))]).toEqual([16, 16])
    expect([Math.round(winPoints(2000)), Math.round(lossPoints(2000))]).toEqual([2, 30])
    expect([Math.round(winPoints(1800)), Math.round(lossPoints(1800))]).toEqual([5, 27])
    // Against a team averaging 1800 instead of 1500 or less.
    expect([Math.round(winPoints(1800, 1800)), Math.round(lossPoints(1800, 1800))]).toEqual([16, 16])
    // The worked example at 1300: E ≈ 0.24, +24, −8, and +11.5 a battle at 60% wins.
    expect(holdWinRate(1300)).toBeCloseTo(0.24, 2)
    expect([Math.round(winPoints(1300)), Math.round(lossPoints(1300))]).toEqual([24, 8])
    expect(expectedChange(1300, 0.6)).toBeCloseTo(11.5, 1)
    // One loss wipes out 5–6 wins at 1800 and about 18 at 2000.
    expect(lossPoints(1800) / winPoints(1800)).toBeGreaterThan(5)
    expect(lossPoints(1800) / winPoints(1800)).toBeLessThan(6)
    expect(Math.round(lossPoints(2000) / winPoints(2000))).toBe(18)
  })

  it('wins needed to grow: at least 25 in 100 at 1300, more than half at 1500, at least 85 at 1800', () => {
    expect(breakEvenWinRate(1300)).toBeGreaterThan(0.24)
    expect(breakEvenWinRate(1300)).toBeLessThan(0.25)
    expect(breakEvenWinRate(1500)).toBeCloseTo(0.5, 10)
    expect(breakEvenWinRate(1800)).toBeGreaterThan(0.84)
    expect(breakEvenWinRate(1800)).toBeLessThan(0.85)
  })

  it('below 903 just over 3% wins grow PSR, exactly 3% does not', () => {
    for (const psr of [0, 400, 900]) {
      expect(expectedChange(psr, 0.03)).toBeLessThan(0)
      expect(expectedChange(psr, 0.032)).toBeGreaterThan(0)
    }
  })

  it('50% wins hold PSR at 1500', () => {
    expect(psrCeiling(0.5)).toBeCloseTo(1500, 6)
    expect(psrCeiling(1)).toBe(Infinity)
    expect(psrCeiling(0.01)).toBe(0)
  })
})
