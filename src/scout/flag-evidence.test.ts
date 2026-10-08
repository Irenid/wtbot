import assert from 'node:assert/strict'
import test from 'node:test'
import type { VehicleDict } from '../wrpl/vehicles.js'
import {
  conditionOnFlags,
  dictionaryFlagIcons,
  dictionaryFlags,
  IN_VEHICLE_WITH_ICON,
  IN_VEHICLE_WITHOUT_ICON,
  type FlagPosterior,
  type FlagRow,
  type FlagSeat,
} from './flag-evidence.js'

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
/** Rows in the game's order, all in a vehicle (no icon in any row). */
const inOrder = (count: number): FlagSeat[] => Array.from({ length: count }, (_, place) => ({ place, inVehicle: IN_VEHICLE_WITHOUT_ICON }))
const chance = (posterior: FlagPosterior, row: number, vehicleId: string) =>
  posterior.players[row]!.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId)?.chance ?? 0
const between = (us: number): FlagRow => ({ vehicles: [{ vehicleId: 'us_tank', chance: us }, { vehicleId: 'de_tank', chance: 0.95 - us }], unseen: 0.05 })

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

test('the line follows the game\'s order: its first flag is the first player\'s in a vehicle', () => {
  // Both lean to the USA; the line opens with Germany's flag, so the first in order drives the German tank.
  const players = [between(0.6), between(0.6)]
  const flags = certain('germany_modern', 'usa')
  const first = conditionOnFlags(players, { flags, seats: inOrder(2), flagsOf })
  assert.ok(first)
  assertRowsSumToOne(first)
  assert.ok(chance(first, 0, 'de_tank') > 0.9, `first de_tank ${chance(first, 0, 'de_tank')}`)
  assert.ok(chance(first, 1, 'us_tank') > 0.9, `second us_tank ${chance(first, 1, 'us_tank')}`)
  // The same rows the other way round in the game's order.
  const swapped = conditionOnFlags(players, { flags, seats: [{ place: 1, inVehicle: IN_VEHICLE_WITHOUT_ICON }, { place: 0, inVehicle: IN_VEHICLE_WITHOUT_ICON }], flagsOf })
  assert.ok(swapped && chance(swapped, 0, 'us_tank') > 0.9 && chance(swapped, 1, 'de_tank') > 0.9)
  // germany_modern is an operator flag: only the operator setting shows it for de_tank.
  assert.ok(first.operatorChance > 0.9)
})

test('a player with an icon in the row shows no flag: their chances stay as they were', () => {
  const players = [between(0.6), between(0.6)]
  const seats: FlagSeat[] = [{ place: 0, inVehicle: IN_VEHICLE_WITH_ICON }, { place: 1, inVehicle: IN_VEHICLE_WITHOUT_ICON }]
  const posterior = conditionOnFlags(players, { flags: certain('germany_modern'), seats, flagsOf })
  assert.ok(posterior)
  assertRowsSumToOne(posterior)
  assert.ok(Math.abs(chance(posterior, 0, 'us_tank') - 0.6) < 0.02, `with an icon ${chance(posterior, 0, 'us_tank')}`)
  assert.ok(chance(posterior, 1, 'de_tank') > 0.9)
})

test('icons not seen: a short line need not hold everyone, as late in a battle', () => {
  const players = [between(0.5), between(0.5), between(0.5), between(0.5)]
  const flags = certain('germany_modern')
  const seen = conditionOnFlags(players, { flags, seats: inOrder(4), flagsOf })!
  const unseen = conditionOnFlags(players, { flags, seats: inOrder(4).map((seat) => ({ ...seat, inVehicle: null })), flagsOf })!
  assertRowsSumToOne(unseen)
  // Everyone in a vehicle: all four drive German tanks; unseen, some may be out of one.
  assert.ok(chance(seen, 3, 'de_tank') > 0.9)
  assert.ok(chance(unseen, 3, 'de_tank') < chance(seen, 3, 'de_tank') - 0.1, `unseen ${chance(unseen, 3, 'de_tank')}`)
  assert.ok(chance(unseen, 0, 'de_tank') > 0.5)
})

test('a row nobody was recognised in may stand anywhere and bring any flag', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 0.9 }], unseen: 0.1 }]
  const seats: FlagSeat[] = [{ place: 0, inVehicle: IN_VEHICLE_WITHOUT_ICON }, { place: null, inVehicle: IN_VEHICLE_WITHOUT_ICON }]
  // China's flag comes first: the unrecognised row stands before the player.
  const posterior = conditionOnFlags(players, { flags: certain('china', 'usa'), seats, flagsOf })
  assert.ok(posterior)
  assertRowsSumToOne(posterior)
  assert.ok(chance(posterior, 0, 'us_tank') > 0.85)
})

test('nation flags keep a sub-tree vehicle; its operator flag settles the setting', () => {
  const players: FlagRow[] = [
    { vehicles: [{ vehicleId: 'no_spg', chance: 0.7 }, { vehicleId: 'sw_tank', chance: 0.25 }], unseen: 0.05 },
    { vehicles: [{ vehicleId: 'ru_jet', chance: 0.95 }], unseen: 0.05 },
  ]
  // ru_jet shows Russia with operator flags on: the USSR's flag says they are off.
  const nation = conditionOnFlags(players, { flags: certain('sweden', 'ussr'), seats: inOrder(2), flagsOf })
  assert.ok(nation)
  assertRowsSumToOne(nation)
  assert.ok(nation.operatorChance < 0.1, `operator ${nation.operatorChance}`)
  assert.ok(chance(nation, 0, 'no_spg') > 0.6, `no_spg ${chance(nation, 0, 'no_spg')}`)
  const operator = conditionOnFlags(players.slice(0, 1), { flags: certain('norway'), seats: inOrder(1), flagsOf })
  assert.ok(operator)
  assert.ok(chance(operator, 0, 'no_spg') > 0.9)
})

test('an uncertain reading weighs its candidates by how well each fits the players', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 0.5 }, { vehicleId: 'su_tank', chance: 0.45 }], unseen: 0.05 }]
  // Read as the USSR's flag, possibly the USA's: the reading's first candidate pulls harder.
  const posterior = conditionOnFlags(players, { flags: [[{ icon: 'ussr', likelihood: 1 }, { icon: 'usa', likelihood: 0.2 }]], seats: inOrder(1), flagsOf })
  assert.ok(posterior)
  assert.ok(chance(posterior, 0, 'su_tank') > 0.7)
  assert.ok(chance(posterior, 0, 'us_tank') > 0.1)
})

test('two flags read alike: one takes its next candidate, and the line names it', () => {
  // A small crop drew Israel like Argentina: both readings' first candidate is the same flag.
  const players: FlagRow[] = [
    { vehicles: [{ vehicleId: 'us_tank', chance: 0.9 }], unseen: 0.1 },
    { vehicles: [{ vehicleId: 'su_tank', chance: 0.9 }], unseen: 0.1 },
  ]
  const flags = [[{ icon: 'usa', likelihood: 1 }], [{ icon: 'usa', likelihood: 1 }, { icon: 'ussr', likelihood: 0.15 }]]
  const posterior = conditionOnFlags(players, { flags, seats: inOrder(2), flagsOf })
  assert.ok(posterior)
  assert.deepEqual(posterior.line, ['usa', 'ussr'])
  assert.ok(chance(posterior, 1, 'su_tank') > 0.85)
})

test('no flags, or more flags than rows: nothing to condition on', () => {
  const players: FlagRow[] = [{ vehicles: [{ vehicleId: 'us_tank', chance: 1 }], unseen: 0 }]
  assert.equal(conditionOnFlags(players, { flags: [], seats: inOrder(1), flagsOf }), null)
  assert.equal(conditionOnFlags(players, { flags: certain('usa', 'ussr'), seats: inOrder(1), flagsOf }), null)
})
