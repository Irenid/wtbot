import assert from 'node:assert/strict'
import test from 'node:test'
import type { VehicleClass } from '../wrpl/vehicles.js'
import {
  SESSION_GAP_SEC,
  STAGE_SWITCH_DELAY_SEC,
  predictScout,
  setupFromPlayers,
  stageAt,
  vehicleChances,
  vehicleChoiceFeatures,
  type ScoutBattle,
  type ScoutStage,
} from './model.js'

const DAY = 86_400
const STAGE_START = 1_791_244_800 // 2026-10-06 00:00 UTC
const stages: ScoutStage[] = [
  { startsAt: STAGE_START - 7 * DAY, endsAt: STAGE_START, maxBr: 9 },
  { startsAt: STAGE_START, endsAt: STAGE_START + 7 * DAY, maxBr: 8 },
]
const classes: Record<string, VehicleClass> = { plane: 'F', heli: 'H', mbt: 'T', light: 'L', spaa: 'AA', mbt2: 'T' }
const classOf = (id: string): VehicleClass => classes[id] ?? '?'

/** A battle of eight players p1…p8 (or `ids`), each spawning `vehicles[i]` from a lineup of all six test vehicles. */
function battle(id: string, startTime: number, vehicles: readonly string[], ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']): ScoutBattle {
  return {
    sessionId: id,
    startTime,
    endTime: startTime + 300,
    availableAt: startTime + 330,
    players: ids.map((userId, index) => ({
      userId,
      nick: `nick-${userId}`,
      vehicle: vehicles[index % vehicles.length]!,
      lineup: ['plane', 'mbt', 'spaa', 'light', 'heli', 'mbt2'],
    })),
  }
}

test('the cap switches 10 hours after the schedule: the first night window plays the previous cap', () => {
  assert.equal(stageAt(stages, STAGE_START + 3 * 3600)?.maxBr, 9)
  assert.equal(stageAt(stages, STAGE_START + STAGE_SWITCH_DELAY_SEC)?.maxBr, 8)
  assert.equal(stageAt(stages, STAGE_START + 15 * 3600)?.maxBr, 8)
})

test('a player repeating one vehicle gets it as the most likely; probabilities sum to one', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ endTime: 1000 + i * 400, vehicle: 'mbt', lineup: ['mbt', 'spaa'] }))
  const features = vehicleChoiceFeatures(history, 3000)
  assert.ok(features)
  const { vehicles, unseen } = vehicleChances(features)
  assert.equal(vehicles[0]!.vehicleId, 'mbt')
  assert.ok(vehicles[0]!.chance > 0.8)
  assert.ok(Math.abs(vehicles.reduce((sum, v) => sum + v.chance, unseen) - 1) < 1e-9)
  assert.equal(vehicleChoiceFeatures([], 3000), null)
})

test('a break lowers the weight of the last spawn', () => {
  const history = [
    ...Array.from({ length: 4 }, (_, i) => ({ endTime: 1000 + i * 400, vehicle: 'spaa', lineup: ['mbt', 'spaa'] })),
    { endTime: 3000, vehicle: 'mbt', lineup: ['mbt', 'spaa'] },
  ]
  const soon = vehicleChances(vehicleChoiceFeatures(history, 3000 + 60)!)
  const later = vehicleChances(vehicleChoiceFeatures(history, 3000 + SESSION_GAP_SEC + 3600)!)
  const chance = (result: typeof soon, id: string) => result.vehicles.find((v) => v.vehicleId === id)!.chance
  assert.ok(chance(soon, 'mbt') > chance(later, 'mbt'))
})

test('mid-session the last battle\'s players and spawns lead; the setup counts their classes', () => {
  const t0 = STAGE_START + 15 * 3600
  const spawns = ['plane', 'plane', 'plane', 'mbt', 'mbt', 'mbt', 'mbt', 'spaa']
  const battles = [battle('a', t0, spawns), battle('b', t0 + 360, spawns), battle('c', t0 + 720, spawns)]
  const now = t0 + 720 + 300 + 60
  const prediction = predictScout({ battles, now, stages, classOf })
  assert.equal(prediction.maxBr, 8)
  assert.equal(prediction.battlesAtCap, 3)
  const group = prediction.primary!
  assert.equal(group.regime, 'session')
  assert.equal(group.anchor.sessionId, 'c')
  assert.equal(group.players.length, 8)
  for (const player of group.players) assert.ok(player.playChance > 0.9, `${player.userId} ${player.playChance}`)
  assert.equal(group.players.find((p) => p.userId === 'p1')!.vehicles[0]!.vehicleId, 'plane')
  assert.deepEqual(group.setup.compositions[0]!.counts, { F: 3, H: 0, T: 4, L: 0, AA: 1 })
  assert.ok(group.setup.airChance > 0.9)
  assert.ok(Math.abs(group.setup.expected.F - 3) < 0.6)
})

test('a battle not stored yet at query time is not used', () => {
  const t0 = STAGE_START + 15 * 3600
  const first = battle('a', t0, ['mbt'])
  const second = { ...battle('b', t0 + 400, ['plane']), availableAt: t0 + 400 + 300 + 500 }
  const prediction = predictScout({ battles: [first, second], now: t0 + 400 + 300 + 30, stages, classOf })
  assert.equal(prediction.primary!.anchor.sessionId, 'a')
})

test('two groups at once: the latest leads, the other is listed, and a hint picks it', () => {
  const t0 = STAGE_START + 15 * 3600
  const groupA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
  const groupB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']
  const battles = [
    battle('a-1', t0, ['mbt'], groupA),
    battle('b-1', t0 + 60, ['plane'], groupB),
    battle('a-2', t0 + 400, ['mbt'], groupA),
    battle('b-2', t0 + 460, ['plane'], groupB),
  ]
  const now = t0 + 460 + 300 + 60
  const plain = predictScout({ battles, now, stages, classOf })
  assert.equal(plain.primary!.anchor.sessionId, 'b-2')
  assert.equal(plain.otherGroups.length, 1)
  assert.deepEqual(plain.otherGroups[0]!.nicks, groupA.map((id) => `nick-${id}`))
  const hinted = predictScout({ battles, now, stages, classOf, hintUserId: 'a3' })
  assert.equal(hinted.primary!.anchor.sessionId, 'a-2')
  assert.deepEqual(new Set(hinted.primary!.players.slice(0, 8).map((p) => p.userId)), new Set(groupA))
  assert.equal(hinted.otherGroups[0]!.nicks[0], 'nick-b1')
  assert.equal(predictScout({ battles, now, stages, classOf, hintUserId: 'nobody' }).hintUnknown, true)
})

test('after a break the regime says so; no battles gives no prediction', () => {
  const t0 = STAGE_START + 15 * 3600
  const prediction = predictScout({ battles: [battle('a', t0, ['mbt'])], now: t0 + 6 * 3600, stages, classOf })
  assert.equal(prediction.primary!.regime, 'break')
  const none = predictScout({ battles: [], now: t0, stages, classOf })
  assert.equal(none.primary, null)
  assert.equal(none.lastBattleEnd, null)
})

test('the setup convolution is exact for independent players', () => {
  const half = { F: 0.5, H: 0, T: 0.5, L: 0, AA: 0 }
  const setup = setupFromPlayers([{ classChances: half }, { classChances: half }], 3)
  assert.equal(setup.compositions.length, 3)
  assert.deepEqual(setup.compositions[0]!.counts, { F: 1, H: 0, T: 1, L: 0, AA: 0 })
  assert.ok(Math.abs(setup.compositions[0]!.chance - 0.5) < 1e-12)
  assert.ok(Math.abs(setup.airChance - 0.75) < 1e-12)
  assert.ok(Math.abs(setup.expected.F - 1) < 1e-12)
})
