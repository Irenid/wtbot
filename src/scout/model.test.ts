import assert from 'node:assert/strict'
import test from 'node:test'
import type { VehicleClass } from '../wrpl/vehicles.js'
import { dictionaryFlags, IN_VEHICLE_WITHOUT_ICON } from './flag-evidence.js'
import {
  KILL_MOMENTS,
  NEW_VEHICLE_FEATURES,
  OPPONENT_AIR_MEAN,
  SESSION_GAP_SEC,
  STAGE_SWITCH_DELAY_SEC,
  killLikelihood,
  newVehicleChances,
  newVehicleFeatures,
  opponentAir,
  playerBackground,
  predictKnownTeam,
  predictScout,
  setupFromPlayers,
  stageAt,
  vehicleChances,
  vehicleChoiceFeatures,
  weighOpponentAir,
  type KillTable,
  type ScoutBattle,
  type ScoutPlayerPrediction,
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

const nations: Record<string, string> = { plane: 'ussr', heli: 'ussr', mbt: 'ussr', light: 'germany', spaa: 'china', mbt2: 'germany' }
const info = (id: string) => ({ nation: nations[id] ?? '?', cls: classOf(id) })
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

test('a new vehicle is guessed from the cap\'s spawns, the player\'s nations and classes, what they were seen with and StatShark', () => {
  const capSpawns = new Map([['mbt', 50], ['mbt2', 40], ['spaa', 30], ['plane', 5]])
  // Nobody known: the most spawned leads; every chance and the "other" option sum to one.
  const plain = newVehicleChances(newVehicleFeatures(capSpawns, null, new Set(), info))
  assert.equal(plain.vehicles[0]!.vehicleId, 'mbt')
  assert.ok(Math.abs(sum(plain.vehicles.map((v) => v.chance)) + plain.other - 1) < 1e-9)
  // A German tanker (two battles in mbt2 at another cap) leans to mbt2; a vehicle of theirs at this cap is left out.
  const german = playerBackground([{ vehicle: 'mbt2', lineup: ['mbt2'] }, { vehicle: 'light', lineup: ['light', 'mbt2'] }], info)
  const guess = newVehicleChances(newVehicleFeatures(capSpawns, german, new Set(['light']), info))
  assert.equal(guess.vehicles[0]!.vehicleId, 'mbt2')
  assert.ok(!guess.vehicles.some((v) => v.vehicleId === 'light'))
  // StatShark: hundreds of battles in the SPAA, none in the tanks, outweigh the cap's popularity.
  const shark = playerBackground([], info, new Map([['spaa', 400]]))
  assert.equal(newVehicleChances(newVehicleFeatures(capSpawns, shark, new Set(), info)).vehicles[0]!.vehicleId, 'spaa')
  // A stale snapshot keeps its battle counts, but a vehicle missing from it no longer counts as never played.
  const column = (name: string) => NEW_VEHICLE_FEATURES.indexOf(name as (typeof NEW_VEHICLE_FEATURES)[number])
  const fresh = newVehicleFeatures(capSpawns, shark, new Set(), info)
  const stale = newVehicleFeatures(capSpawns, playerBackground([], info, new Map([['spaa', 400]]), false), new Set(), info)
  const mbt = fresh.vehicles.indexOf('mbt')
  const spaa = fresh.vehicles.indexOf('spaa')
  assert.equal(fresh.rows[mbt]![column('notPlayed')], 1)
  assert.equal(stale.rows[mbt]![column('notPlayed')], 0)
  assert.equal(stale.rows[spaa]![column('logBattles')], Math.log1p(400))
})

test('a player without battles at this BR gets the cap\'s vehicles; the flags pick the one their flag shows', () => {
  const now = STAGE_START + 2 * DAY
  // p1 played mbt at this cap; p2 never did. The cap's spawns lean to mbt, then spaa (China).
  const battles = [battle('b1', now - 3600, ['mbt'], ['p1'])]
  const capSpawns = new Map([['mbt', 60], ['spaa', 40], ['mbt2', 10]])
  const players = [{ userId: 'p1', nick: 'one' }, { userId: 'p2', nick: 'two' }]
  const base = { players, unknownPlayers: 0, battles, now, stages, classOf, capSpawns, nationOf: (id: string) => nations[id] ?? '?' }
  const blind = predictKnownTeam(base)
  const cold = blind.players.find((p) => p.userId === 'p2')!
  assert.equal(cold.battlesAtCap, 0)
  assert.equal(cold.newVehicles[0]!.vehicleId, 'mbt')
  assert.ok(Math.abs(cold.unseenChance - 1) < 1e-9)
  // The line shows the USSR (p1's mbt) and China: China's flag can only be p2's SPAA.
  const dict = Object.fromEntries(Object.keys(nations).map((id) => [id, { name: id, cls: classOf(id), country: nations[id]! }]))
  const flagged = predictKnownTeam({
    ...base,
    flags: {
      flags: [[{ icon: 'ussr', likelihood: 1 }], [{ icon: 'china', likelihood: 1 }]],
      seats: [{ place: 0, inVehicle: IN_VEHICLE_WITHOUT_ICON }, { place: 1, inVehicle: IN_VEHICLE_WITHOUT_ICON }],
      flagsOf: dictionaryFlags(dict),
    },
  })
  const named = flagged.players.find((p) => p.userId === 'p2')!
  assert.equal(named.newVehicles[0]!.vehicleId, 'spaa')
  assert.ok(named.newVehicles[0]!.chance > 0.8, `spaa ${named.newVehicles[0]!.chance}`)
})

test('an opponent that flies moves chances to anti-aircraft; its habit is the mean of its latest battles', () => {
  const player: ScoutPlayerPrediction = {
    userId: 'p1', nick: 'one', playChance: 1, battlesAtCap: 5,
    vehicles: [{ vehicleId: 'mbt', chance: 0.6 }, { vehicleId: 'spaa', chance: 0.3 }],
    unseenChance: 0.1, newVehicles: [], lineup: [],
  }
  weighOpponentAir(player, 4 - OPPONENT_AIR_MEAN, { AA: 0.4, T: -0.1 }, classOf)
  const chance = (id: string) => player.vehicles.find((v) => v.vehicleId === id)!.chance
  assert.ok(chance('spaa') > 0.3 && chance('mbt') < 0.6)
  assert.ok(Math.abs(sum(player.vehicles.map((v) => v.chance)) + player.unseenChance - 1) < 1e-9)
  assert.equal(opponentAir([{ endTime: 1, air: 2 }, { endTime: 2, air: 4 }]), null)
  const teams = Array.from({ length: 25 }, (_, i) => ({ endTime: i, air: i < 5 ? 9 : 2 }))
  assert.equal(opponentAir(teams), 2) // the latest 20 only
})

test('the last battle together is the latest a group of them played, not an older one with more of them', () => {
  const now = STAGE_START + 2 * DAY
  const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((userId) => ({ userId, nick: userId }))
  const base = { players, unknownPlayers: 0, now, stages, classOf }
  // Six of them two days ago, four of them an hour ago: the hour-old group.
  const older = battle('six', now - 2 * DAY, ['mbt'], ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  const group = battle('four', now - 3600, ['plane'], ['p1', 'p2', 'p3', 'p4'])
  const known = predictKnownTeam({ ...base, battles: [older, group] })
  assert.deepEqual(known.lastTogether, { endTime: group.endTime, players: 4 })
  assert.equal(known.lastHadAir, true)
  // No battle of four: the one with the most of them, as before.
  const pairs = predictKnownTeam({ ...base, battles: [battle('three', now - DAY, ['mbt'], ['p1', 'p2', 'p3']), battle('two', now - 3600, ['mbt'], ['p1', 'p2'])] })
  assert.equal(pairs.lastTogether?.players, 3)
})

// Kill patterns (none, air, ground, both) at every moment: anti-air shows air kills, tanks ground kills.
const killTable: KillTable = {
  F: KILL_MOMENTS.map(() => [0.6, 0.13, 0.25, 0.02]),
  H: KILL_MOMENTS.map(() => [0.62, 0.11, 0.25, 0.02]),
  T: KILL_MOMENTS.map(() => [0.69, 0.01, 0.29, 0.01]),
  L: KILL_MOMENTS.map(() => [0.72, 0.07, 0.19, 0.02]),
  AA: KILL_MOMENTS.map(() => [0.5, 0.45, 0.03, 0.02]),
}

test('kill columns: an air kill points to anti-air, a capture rules out aircraft, no kill without the timer says nothing', () => {
  const air = killLikelihood({ air: 1, ground: 0, captures: null }, 180, killTable)
  assert.equal(air.AA, 0.45)
  assert.equal(air.T, 0.01)
  assert.deepEqual(killLikelihood({ air: 0, ground: 0, captures: null }, null, killTable), { F: 1, H: 1, T: 1, L: 1, AA: 1 })
  assert.equal(killLikelihood({ air: 0, ground: 0, captures: null }, 180, killTable).AA, 0.5)
  // A shown kill counts without the timer too.
  assert.equal(killLikelihood({ air: 1, ground: 0, captures: null }, null, killTable).AA, 0.45)
  const captured = killLikelihood({ air: null, ground: null, captures: 1 }, null, killTable)
  assert.ok(captured.F < 0.05 && captured.T === 1)
})

test('an air kill moves a tanker who also plays anti-air to the anti-air; no columns change nothing', () => {
  const now = STAGE_START + 2 * DAY
  // p1 played the tank three times, the SPAA once.
  const battles = [
    battle('k1', now - 4000, ['spaa'], ['p1']),
    battle('k2', now - 3000, ['mbt'], ['p1']),
    battle('k3', now - 2000, ['mbt'], ['p1']),
    battle('k4', now - 1000, ['mbt'], ['p1']),
  ]
  const base = { players: [{ userId: 'p1', nick: 'one' }], unknownPlayers: 0, battles, now, stages, classOf }
  const plain = predictKnownTeam(base)
  assert.equal(plain.players[0]!.vehicles[0]!.vehicleId, 'mbt')
  assert.deepEqual(predictKnownTeam({ ...base, kills: [null], killMoment: 180, weights: { kills: killTable } }).players, plain.players)
  const shot = predictKnownTeam({ ...base, kills: [{ air: 1, ground: 0, captures: null }], killMoment: 180, weights: { kills: killTable } })
  assert.equal(shot.players[0]!.vehicles[0]!.vehicleId, 'spaa')
  const total = shot.players[0]!.vehicles.reduce((sum, v) => sum + v.chance, 0) + shot.players[0]!.unseenChance
  assert.ok(Math.abs(total - 1) < 1e-9)
})

test('a capture on a player with no battles at this BR takes aircraft out of their share of the setup', () => {
  const now = STAGE_START + 2 * DAY
  // p1 flies at this cap; p2 has no battles at it, so their whole chance is the unnamed share.
  const battles = [battle('c1', now - 2000, ['plane'], ['p1'])]
  const base = { players: [{ userId: 'p1', nick: 'one' }, { userId: 'p2', nick: 'two' }], unknownPlayers: 0, battles, now, stages, classOf }
  const plain = predictKnownTeam(base)
  const captured = predictKnownTeam({ ...base, kills: [null, { air: null, ground: null, captures: 1 }] })
  // p2's aircraft share (the team's class shares, ~0.27) goes; p1's plane stays.
  assert.ok(plain.setup.expected.F - captured.setup.expected.F > 0.2, `F ${plain.setup.expected.F} → ${captured.setup.expected.F}`)
  assert.ok(captured.setup.expected.F > 0.7, `F ${captured.setup.expected.F}`)
})
