import assert from 'node:assert/strict'
import test from 'node:test'
import type { VehicleDict } from '../wrpl/vehicles.js'
import { conditionOnFlags, dictionaryFlagIcons, dictionaryFlags, type FlagPosterior, type FlagRow } from './flag-evidence.js'

const dict: VehicleDict = {
  us_tank: { name: 'US tank', cls: 'T', country: 'usa' },
  de_tank: { name: 'DE tank', cls: 'T', country: 'germany', operator: 'germany_modern' },
  sw_tank: { name: 'SW tank', cls: 'T', country: 'sweden' },
  no_spg: { name: 'NO SPG', cls: 'T', country: 'sweden', operator: 'norway' },
  su_tank: { name: 'SU tank', cls: 'T', country: 'ussr' },
  ru_jet: { name: 'RU jet', cls: 'F', country: 'ussr', operator: 'russia' },
}
const flagsOf = dictionaryFlags(dict)
const certain = (...icons: string[]) => icons.map((icon) => [{ icon, likelihood: 1 }])
const chance = (posterior: FlagPosterior, row: number, vehicleId: string) =>
  posterior.players[row]!.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId)?.chance ?? 0

function assertRowsSumToOne(posterior: FlagPosterior): void {
  for (const player of posterior.players) {
    const total = player.vehicles.reduce((sum, vehicle) => sum + vehicle.chance, player.unseen)
    assert.ok(Math.abs(total - 1) < 1e-9, `row sums to ${total}`)
  }
}

test('dictionary flags: the operator, else the nation; with operator flags off the nation or a pick of its operators', () => {
  const rounded = (id: string) => {
    const flags = flagsOf(id)
    return flags && { operator: flags.operator, tree: flags.tree.map(({ icon, share }) => [icon, Math.round(share * 100) / 100]) }
  }
  assert.deepEqual(rounded('no_spg'), { operator: 'norway', tree: [['sweden', 0.8], ['norway', 0.2]] })
  assert.deepEqual(rounded('su_tank'), { operator: 'ussr', tree: [['ussr', 0.8], ['russia', 0.2]] })
  assert.deepEqual(flagsOf('us_tank'), { operator: 'usa', tree: [{ icon: 'usa', share: 1 }] })
  assert.equal(flagsOf('unknown'), null)
  assert.deepEqual(dictionaryFlagIcons(dict), ['germany', 'germany_modern', 'norway', 'russia', 'sweden', 'usa', 'ussr'])
})

test('a player between two nations takes the one whose flag is up', () => {
  const players: FlagRow[] = [
    { vehicles: [{ vehicleId: 'us_tank', chance: 0.6 }, { vehicleId: 'de_tank', chance: 0.35 }], unseen: 0.05 },
    { vehicles: [{ vehicleId: 'su_tank', chance: 0.9 }], unseen: 0.1 },
  ]
  const posterior = conditionOnFlags(players, { flags: certain('germany_modern', 'ussr'), rows: 2, flagsOf })
  assert.ok(posterior)
  assertRowsSumToOne(posterior)
  assert.ok(chance(posterior, 0, 'de_tank') > 0.8, `de_tank ${chance(posterior, 0, 'de_tank')}`)
  assert.ok(chance(posterior, 1, 'su_tank') > 0.9)
  // germany_modern is an operator flag: only the operator setting shows it for de_tank.
  assert.ok(posterior.operatorChance > 0.9)
})

test('nation flags keep a sub-tree vehicle; its operator flag settles the setting', () => {
  const players: FlagRow[] = [
    { vehicles: [{ vehicleId: 'no_spg', chance: 0.7 }, { vehicleId: 'sw_tank', chance: 0.25 }], unseen: 0.05 },
    { vehicles: [{ vehicleId: 'ru_jet', chance: 0.95 }], unseen: 0.05 },
  ]
  // ru_jet shows Russia with operator flags on: the USSR's flag says they are off.
  const nation = conditionOnFlags(players, { flags: certain('sweden', 'ussr'), rows: 2, flagsOf })
  assert.ok(nation)
  assertRowsSumToOne(nation)
  assert.ok(nation.operatorChance < 0.1, `operator ${nation.operatorChance}`)
  assert.ok(chance(nation, 0, 'no_spg') > 0.6, `no_spg ${chance(nation, 0, 'no_spg')}`)
  // Sweden alone is weak evidence either way: with operator flags on it rules no_spg out.
  const alone = conditionOnFlags(players.slice(0, 1), { flags: certain('sweden'), rows: 1, flagsOf })
  assert.ok(alone && alone.operatorChance < 0.75)
  const operator = conditionOnFlags(players.slice(0, 1), { flags: certain('norway'), rows: 1, flagsOf })
  assert.ok(operator)
  assert.ok(chance(operator, 0, 'no_spg') > 0.9)
})

test('a flag only an unrecognised row can show leaves the known players as they were', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 0.9 }], unseen: 0.1 }]
  const posterior = conditionOnFlags(players, { flags: certain('usa', 'china'), rows: 2, flagsOf })
  assert.ok(posterior)
  assertRowsSumToOne(posterior)
  assert.ok(chance(posterior, 0, 'us_tank') > 0.85)
})

test('an uncertain reading weighs its candidates by how well each fits the players', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 0.5 }, { vehicleId: 'su_tank', chance: 0.45 }], unseen: 0.05 }]
  // Read as the USSR's flag, possibly the USA's: the reading's first candidate pulls harder.
  const posterior = conditionOnFlags(players, { flags: [[{ icon: 'ussr', likelihood: 1 }, { icon: 'usa', likelihood: 0.2 }]], rows: 1, flagsOf })
  assert.ok(posterior)
  assert.ok(chance(posterior, 0, 'su_tank') > 0.7)
  assert.ok(chance(posterior, 0, 'us_tank') > 0.1)
})

test('no flags, or more flags than rows: nothing to condition on', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 1 }], unseen: 0 }]
  assert.equal(conditionOnFlags(players, { flags: [], rows: 1, flagsOf }), null)
  assert.equal(conditionOnFlags(players, { flags: certain('usa', 'ussr'), rows: 1, flagsOf }), null)
})
