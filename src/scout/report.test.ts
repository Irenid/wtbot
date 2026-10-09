import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getScoutTeamRows,
  initDb,
  saveBattle,
  upsertClans,
  type BattleInput,
  type BattlePlayerInput,
  type ScoutTeamRow,
} from '../db/index.js'
import type { VehicleDict } from '../wrpl/vehicles.js'
import {
  SCOUT_COLOR_GUESS,
  SCOUT_COLOR_SESSION,
  compositionText,
  flagName,
  formatScoutImageReport,
  formatScoutReport,
  percent,
  plainVehicleName,
  squadronLabel,
} from './format.js'
import { predictScout, setupFromPlayers, type KnownTeamPrediction, type ScoutBattle } from './model.js'
import { IN_VEHICLE_WITH_ICON, IN_VEHICLE_WITHOUT_ICON } from './flag-evidence.js'
import { allyAir, enemySeats, findSquadrons, nickKey, recentNicks, scoutBattlesFromRows, scoutPredictionRecord, type ScoutImageReport, type ScoutReport } from './report.js'

function player(userId: string, nick: string, team: number, clanTag: string, vehicles: string[]): BattlePlayerInput {
  return {
    userId, nick, clanTag, team,
    kills: 0, groundKills: 0, navalKills: 0, aiKills: 0, aiGroundKills: 0, assists: 0, deaths: 0,
    captureZone: 0, damageZone: 0, score: 0, awardDamage: 0, teamKills: 0, squadId: 4095 + team,
    vehicle: vehicles[0] ?? null, vehicles, disconnected: false, slot: null, title: null, autoSquad: null,
  }
}

function battle(sessionId: string, startTime: number, players: BattlePlayerInput[]): BattleInput {
  return {
    sessionId, sessionHex: sessionId.padStart(16, '0'), missionName: 'm', level: 'l', gameMode: null, battleType: null,
    environment: null, status: null, startTime, durationSec: 300, endTimeMs: 0, teamWon: 1, gameVersion: null,
    missionSettings: null, players, kills: [], chat: [], eventsBlob: Buffer.from('x'),
  }
}

test('squadron lookup by tag or name, decorations ignored; the history reader returns its rows', () => {
  initDb(':memory:')
  try {
    upsertClans([{ tag: '=WLILY=', name: 'White Lily' }, { tag: '[WLX]', name: 'Other' }])
    const squad = (team: number, tag: string, prefix: string) =>
      Array.from({ length: 5 }, (_, i) => player(`${prefix}${i}`, `${prefix}nick${i}`, team, tag, ['tank_a', 'plane_b']))
    saveBattle(battle('100', 1_000_000, [...squad(1, '╀WLILY╀', 'w'), ...squad(2, '[ENEMY]', 'e')]))
    assert.deepEqual(findSquadrons('wlily').map((s) => s.core), ['wlily'])
    const [wlily] = findSquadrons('WLILY')
    assert.ok(wlily)
    assert.equal(wlily.displayTag, '=WLILY=')
    assert.equal(wlily.inReplays, true)
    assert.deepEqual([...wlily.tags].sort(), ['=WLILY=', '╀WLILY╀'])
    assert.equal(findSquadrons('white li')[0]?.core, 'wlily')
    assert.deepEqual(findSquadrons('wl').map((s) => s.core), ['wlily', 'wlx'])
    assert.equal(findSquadrons('enemy')[0]?.inReplays, true)
    assert.deepEqual(findSquadrons('zzz'), [])
    const rows = getScoutTeamRows(wlily.tags, 999_000, 1_001_000)
    assert.equal(rows.length, 5)
    assert.equal(rows[0]!.vehicle, 'tank_a')
    assert.throws(() => getScoutTeamRows(wlily.tags, 5, 5), RangeError)
  } finally {
    closeDb()
  }
})

const row = (sessionId: string, team: number, userId: string, startTime: number, vehicle: string | null): ScoutTeamRow => ({
  sessionId, team, userId, nick: `n${userId}`, vehicle, vehicles: JSON.stringify(['a', 'b']), startTime, durationSec: 300, ingestedAt: startTime + 330,
})

test('rows become one battle per team with at least four of the squadron; guests on other teams are dropped', () => {
  const rows = [
    ...['1', '2', '3', '4'].map((id) => row('s1', 1, id, 100, 'a')),
    ...['5', '6', '7'].map((id) => row('s1', 2, id, 100, 'b')),
    { ...row('s2', 1, '1', 900, 'a'), vehicles: 'not json' },
    ...['2', '3', '4'].map((id) => row('s2', 1, id, 900, 'b')),
  ]
  const battles = scoutBattlesFromRows(rows)
  assert.deepEqual(battles.map((b) => b.sessionId), ['s1', 's2'])
  assert.equal(battles[0]!.endTime, 400)
  assert.deepEqual(battles[1]!.players[0]!.lineup, [])
  assert.deepEqual(recentNicks(battles), ['n1', 'n2', 'n3', 'n4'])
})

test('nick keys ignore case, spaces and the platform suffix', () => {
  assert.equal(nickKey(' Ro2069@live '), nickKey('ro2069'))
  assert.notEqual(nickKey('ro2069'), nickKey('ro2068'))
})

test('the reply names the setup, chances and every likely player; percents never claim certainty', () => {
  assert.equal(percent(0.004), '<1%')
  assert.equal(percent(0.996), '>99%')
  assert.equal(percent(0.5), '50%')
  assert.equal(compositionText({ F: 1, H: 2, T: 0, L: 1, AA: 3 }), '1 aircraft · 2 helicopters · 1 light tank · 3 anti-air')
  assert.equal(squadronLabel('╍Nrst╎', 'North_Steel'), 'Nrst North_Steel')
  assert.equal(squadronLabel('[QUEUE]', 'Queue'), 'QUEUE')
  assert.equal(squadronLabel('=ABC=', null), 'ABC')
  assert.equal(plainVehicleName('▄M163'), 'M163')
  assert.equal(plainVehicleName('␗T-26'), 'T-26')
  assert.equal(plainVehicleName('AMX-30 (1972)'), 'AMX-30 (1972)')
  const vehicles: VehicleDict = {
    plane: { name: '▄Vautour IIN', cls: 'F', country: 'france' },
    tank: { name: 'Leopard 1', cls: 'T', country: 'germany' },
  }
  const start = 1_791_300_000
  const team = (id: string, t: number): ScoutBattle => ({
    sessionId: id, startTime: t, endTime: t + 300, availableAt: t + 330,
    players: Array.from({ length: 8 }, (_, i) => ({ userId: `${i}`, nick: i === 0 ? '_under_score_' : `p${i}`, vehicle: i < 3 ? 'plane' : 'tank', lineup: ['plane', 'tank'] })),
  })
  const now = start + 1000
  const prediction = predictScout({
    battles: [team('a', start), team('b', start + 400)],
    now,
    stages: [{ startsAt: start - 86_400, endsAt: start + 86_400, maxBr: 8 }],
    classOf: (id) => vehicles[id]?.cls ?? '?',
  })
  const report: ScoutReport = {
    squadron: { core: 'abc', tags: ['=ABC='], displayTag: '=ABC=', name: 'Alpha', position: 3, inReplays: true },
    prediction,
    battleCount: 2,
    hint: { nick: 'ghost', matched: false },
    vehicles,
    now,
  }
  const text = formatScoutReport(report)
  assert.equal(text.title, 'ABC Alpha')
  assert.equal(text.color, SCOUT_COLOR_SESSION)
  assert.match(text.description, /mid-session/)
  assert.match(text.description, /\*\*Most likely setup\*\*\n3 aircraft · 5 tanks — \d+%/)
  assert.match(text.description, /\*\*Air:\*\* \d\.\d expected, at least one \S+%/)
  assert.match(text.description, /\*\*ghost\*\* is not in their recent battles/)
  assert.deepEqual(text.fields.map((field) => field.name), ['Aircraft · 3', 'Tanks · 5'])
  assert.match(text.fields[0]!.value, /^\\_under\\_score\\_ — \*\*Vautour IIN \d+%\*\*/m)
  assert.match(text.fields[1]!.value, /^p3 — \*\*Leopard 1 \d+%\*\*/m)
  assert.equal(text.fields[1]!.value.split('\n').length, 5)
  const empty = formatScoutReport({ ...report, prediction: predictScout({ battles: [], now, stages: [], classOf: () => '?' }) })
  assert.match(empty.description, /No battles stored/)
  assert.equal(empty.color, SCOUT_COLOR_GUESS)
})

test('a screenshot reply names the flags it used and who shows none, or asks for one taken after the spawn', () => {
  const vehicles: VehicleDict = { de_tank: { name: 'Leopard 2K', cls: 'T', country: 'germany', operator: 'germany_modern' } }
  const prediction: KnownTeamPrediction = {
    maxBr: 8,
    lastTogether: null,
    lastHadAir: false,
    players: [{ userId: 'a', nick: 'A', playChance: 1, battlesAtCap: 3, vehicles: [{ vehicleId: 'de_tank', chance: 0.9 }], unseenChance: 0.1, newVehicles: [], lineup: ['de_tank'] }],
    setup: setupFromPlayers([{ classChances: { F: 0, H: 0, T: 1, L: 0, AA: 0 } }]),
    flags: { icons: ['germany_modern', 'usa', 'usa_modern', 'south_africa'], operatorChance: 1 },
  }
  const report: ScoutImageReport = {
    squadron: null, allySquadron: null, prediction, recognised: 1, unread: ['Unknown'], enemyFlags: { read: 4, rowsWithout: 0 }, statShark: { players: 0, pending: false }, vehicles, now: 0,
  }
  const used = formatScoutImageReport(report).description
  assert.match(used, /battles at BR 8\.0 and the flags above their team: Germany, USA, South Africa\./)
  assert.doesNotMatch(used, /no flag/)
  const someOut = formatScoutImageReport({ ...report, enemyFlags: { read: 4, rowsWithout: 1 } }).description
  assert.match(someOut, /1 enemy shows no flag \(not spawned yet or destroyed\): their chances rest on their battles alone\./)
  const none = { ...report, prediction: { ...prediction, flags: null } }
  const nobodyIn = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: 2 } }).description
  assert.match(nobodyIn, /No enemy is in a vehicle yet: a screenshot after they spawn shows their flags and sharpens the guess\./)
  const lineMissed = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: 1 } }).description
  assert.match(lineMissed, /The flags above their team were not read/)
  const before = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: null } }).description
  assert.match(before, /A screenshot after they spawn shows their flags and sharpens the guess\./)
  assert.equal(flagName('republic_china'), 'Republic of China')
  assert.equal(flagName('italy_kingdom'), 'Italy')
  assert.equal(flagName('new_zealand'), 'New Zealand')
})

test('enemy rows as flag seats: the game\'s order is the user ids as text, the screen\'s while scores tie', () => {
  // On screen in id order (scores tie): every row keeps its place, the unrecognised one too.
  const tied = enemySeats([{ userId: '120', row: 0 }, { userId: '87', row: 2 }], [1], ['parachute', null, null])
  assert.deepEqual(tied, [
    { place: 0, inVehicle: IN_VEHICLE_WITH_ICON },
    { place: 2, inVehicle: IN_VEHICLE_WITHOUT_ICON },
    { place: 1, inVehicle: IN_VEHICLE_WITHOUT_ICON },
  ])
  // A score moved '87' up: the ids give the order, the unrecognised row stands anywhere; no icon column, nothing known.
  const scored = enemySeats([{ userId: '87', row: 0 }, { userId: '120', row: 1 }], [2], null)
  assert.deepEqual(scored, [{ place: 1, inVehicle: null }, { place: 0, inVehicle: null }, { place: null, inVehicle: null }])
})

test('a screenshot reply names a new player\'s likely vehicle, marks new ones and says when StatShark updates it', () => {
  const vehicles: VehicleDict = {
    de_tank: { name: 'Leopard I', cls: 'T', country: 'germany' },
    cn_spaa: { name: 'WZ305', cls: 'AA', country: 'china' },
    fr_jet: { name: 'Vautour IIN(C)', cls: 'F', country: 'france' },
  }
  const prediction: KnownTeamPrediction = {
    maxBr: 8,
    lastTogether: null,
    lastHadAir: false,
    players: [
      // No battles at this BR: the guesses agree on anti-air 70% of the time.
      { userId: 'a', nick: 'Fresh', playChance: 1, battlesAtCap: 0, vehicles: [], unseenChance: 1, newVehicles: [{ vehicleId: 'cn_spaa', chance: 0.7 }, { vehicleId: 'de_tank', chance: 0.2 }], lineup: [] },
      // A regular whose new jet is likelier than their tank.
      { userId: 'b', nick: 'Regular', playChance: 1, battlesAtCap: 9, vehicles: [{ vehicleId: 'de_tank', chance: 0.35 }], unseenChance: 0.65, newVehicles: [{ vehicleId: 'fr_jet', chance: 0.5 }], lineup: [] },
    ],
    setup: setupFromPlayers([{ classChances: { F: 0, H: 0, T: 1, L: 0, AA: 0 } }]),
    flags: null,
  }
  const report: ScoutImageReport = {
    squadron: null, allySquadron: null, prediction, recognised: 2, unread: [], enemyFlags: { read: 0, rowsWithout: null },
    statShark: { players: 0, pending: true }, vehicles, now: 0,
  }
  const text = formatScoutImageReport(report)
  assert.match(text.description, /A vehicle not seen from a player at this BR \(new\) is guessed from what squadrons take at it\./)
  assert.match(text.description, /Checking their battles on StatShark: this reply updates in a minute or two\./)
  const antiAir = text.fields.find((field) => field.name.startsWith('Anti-air'))!
  assert.match(antiAir.value, /^Fresh — no battles at this BR yet, likely \*\*WZ305 70%\*\* · Leopard I 20%$/m)
  const air = text.fields.find((field) => field.name.startsWith('Aircraft'))!
  assert.match(air.value, /^Regular — \*\*Vautour IIN\(C\) \(new\) 50%\*\* · Leopard I 35% · other new vehicle 15%$/m)
  const updated = formatScoutImageReport({ ...report, statShark: { players: 2, pending: false } }).description
  assert.match(updated, /and their battles on StatShark \(2 players\)\./)
  assert.doesNotMatch(updated, /Checking/)
  // The record keeps each player's three likeliest, new ones marked, for scoring against the battle later.
  const record = scoutPredictionRecord(report) as { model: string; players: { userId: string; options: { vehicleId: string; chance: number; new: boolean }[] }[] }
  assert.match(record.model, /^[0-9a-f]{12}$/)
  assert.deepEqual(record.players.find((player) => player.userId === 'b')!.options, [
    { vehicleId: 'fr_jet', chance: 0.5, new: true },
    { vehicleId: 'de_tank', chance: 0.35, new: false },
  ])
})

test('the own squadron\'s air habit: aircraft and helicopters a battle over its teams of six or more', () => {
  const vehicles: VehicleDict = { jet: { name: 'Jet', cls: 'F', country: 'usa' }, tank: { name: 'Tank', cls: 'T', country: 'usa' } }
  const row = (sessionId: string, index: number, vehicle: string): ScoutTeamRow => ({
    sessionId, team: 1, userId: `${sessionId}-${index}`, nick: `n${index}`, vehicle, vehicles: '[]', startTime: Number(sessionId.slice(1)) * 1000, durationSec: 300, ingestedAt: 0,
  })
  const rows: ScoutTeamRow[] = []
  for (let battle = 1; battle <= 6; battle += 1) {
    for (let index = 0; index < 8; index += 1) rows.push(row(`s${battle}`, index, index < (battle % 2 === 0 ? 3 : 1) ? 'jet' : 'tank'))
  }
  rows.push(row('s99', 0, 'jet'), row('s99', 1, 'jet')) // two guests' rows: not a team of the squadron
  assert.equal(allyAir(rows, vehicles), 2)
  assert.equal(allyAir(rows.slice(0, 16), vehicles), null)
})
