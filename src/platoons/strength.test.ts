import assert from 'node:assert/strict'
import test from 'node:test'
import { STAGE_SWITCH_DELAY_SEC } from '../clan-season.js'
import { STRENGTH, likelyVehicle, playerStrength, type StrengthRow } from './strength.js'

const WEEK = 7 * 86_400
const START = 1_790_000_000
const stages = [
  { startsAt: START, endsAt: START + WEEK, maxBr: 7.0 },
  { startsAt: START + WEEK, endsAt: START + 2 * WEEK, maxBr: 6.0 },
]
const NOW = START + WEEK + STAGE_SWITCH_DELAY_SEC + 3600

function rows(count: number, at: number, values: Partial<StrengthRow> = {}): StrengthRow[] {
  return Array.from({ length: count }, (_, index) => ({
    startTime: at - index * 600, won: true, kills: 1, deaths: 1, assists: 0, vehicle: 'ussr_t_54_1947', lineup: ['ussr_t_54_1947'], ...values,
  }))
}

test('a player without battles sits at the prior; better rates raise the value', () => {
  const nobody = playerStrength([], stages, 6.0, null)
  const { priors, weights } = STRENGTH
  const prior = weights.win * priors.win + weights.kills * priors.kills + weights.deaths * priors.deaths + weights.assists * priors.assists
  assert.ok(Math.abs(nobody.value - (prior - STRENGTH.penalties.fewBattles)) < 1e-12)
  const strong = playerStrength(rows(5, NOW - 100, { kills: 2, deaths: 0.5 }), stages, 6.0, null)
  const weak = playerStrength(rows(5, NOW - 100, { won: false, kills: 0, deaths: 1 }), stages, 6.0, null)
  assert.ok(strong.value > nobody.value && nobody.value > weak.value)
  assert.equal(strong.capBattles, 5, 'all five within the hour since the new cap began to play')
})

test('battles at the current cap count, older caps through the overall rate only', () => {
  const atCap = playerStrength(rows(5, NOW - 100), stages, 6.0, null)
  const elsewhere = playerStrength(rows(5, START + 86_400), stages, 6.0, null)
  assert.equal(elsewhere.capBattles, 0)
  assert.equal(atCap.battles, 5)
  assert.ok(atCap.value > elsewhere.value, 'the same record counts more at the cap')
})

test('a regular new to the cap loses a little, a newcomer to squadron battles more', () => {
  const regular = rows(30, START + 86_400)
  const atCap = (count: number) => [...rows(count, NOW - 100), ...regular]
  const none = playerStrength(atCap(0), stages, 6.0, null).value
  const two = playerStrength(atCap(2), stages, 6.0, null).value
  const three = playerStrength(atCap(3), stages, 6.0, null).value
  assert.ok(two - none > 0.019 && three - two > 0.019)
  assert.ok(playerStrength(rows(9, NOW - 100), stages, 6.0, null).value < playerStrength(rows(10, NOW - 100), stages, 6.0, null).value - 0.07)
})

test('undecided battles are left out; the PSR adds above 1400 more', () => {
  assert.equal(playerStrength(rows(5, NOW, { won: null }), stages, 6.0, null).battles, 0)
  const low = playerStrength([], stages, 6.0, 1000).value
  const mid = playerStrength([], stages, 6.0, 1400).value
  const high = playerStrength([], stages, 6.0, 1800).value
  assert.ok(high - mid > mid - low)
})

test('the likely vehicle comes from the battles at the cap only', () => {
  const history = [...rows(3, NOW - 100), ...rows(3, START + 86_400, { vehicle: 'germ_leopard_1', lineup: ['germ_leopard_1'] })]
  assert.equal(likelyVehicle(history, stages, 6.0, NOW)?.vehicleId, 'ussr_t_54_1947')
  assert.equal(likelyVehicle(rows(3, START + 86_400), stages, 6.0, NOW), null)
})
