import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getScoutAnonymousPlayers,
  getScoutFakeNames,
  getScoutRecentPlayers,
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

test('screenshot candidates keep the player\'s nick when the AI drove his last slot', () => {
  initDb(':memory:')
  try {
    saveBattle(battle('1', 1_000_000, [player('7', 'Jerrykuk', 2, '-BLOB1-', ['tank_a'])]))
    saveBattle(battle('2', 1_000_600, [
      { ...player('7', 'coop/Bot191', 2, '-BLOB1-', ['tank_a']), slotNick: 'Jerrykuk' },
      player('8', 'Other', 2, '-BLOB1-', ['tank_a']),
    ]))
    saveBattle(battle('3', 1_001_200, [player('8', 'coop/Bot5', 2, '-BLOB1-', ['tank_a'])]))
    const nicks = new Map(getScoutRecentPlayers(999_000).map((p) => [p.userId, p.nick]))
    assert.deepEqual(Object.fromEntries(nicks), { '7': 'Jerrykuk', '8': 'Other' })
  } finally {
    closeDb()
  }
})

test('anonymous players: a squadron\'s players stored with a fake name, their latest real nick and start', () => {
  initDb(':memory:')
  try {
    saveBattle(battle('1', 1_000_000, [
      { ...player('7', 'Otamanchikk', 2, '-BLOB1-', ['tank_a']), fakeName: 'Abraham5625' },
      player('8', 'Plain', 2, '-BLOB1-', ['tank_a']),
      { ...player('9', 'Elsewhere', 1, '=OTHER=', ['tank_a']), fakeName: 'Cassidy35' },
    ]))
    saveBattle(battle('2', 1_000_600, [{ ...player('7', 'Otamanchikk', 2, '-BLOB1-', ['tank_a']), fakeName: 'Kodey9559' }]))
    assert.deepEqual(getScoutAnonymousPlayers(['-BLOB1-'], 999_000), [{ userId: '7', nick: 'Otamanchikk', lastSeen: 1_000_600 }])
    assert.deepEqual(getScoutAnonymousPlayers(['-BLOB1-'], 1_000_601), [])
    assert.deepEqual(getScoutAnonymousPlayers([], 0), [])
    assert.deepEqual(getScoutFakeNames().sort(), ['Abraham5625', 'Cassidy35', 'Kodey9559'])
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

test('the reply names the air chance and every likely player; percents never claim certainty', () => {
  assert.equal(percent(0.004), '<1%')
  assert.equal(percent(0.996), '>99%')
  assert.equal(percent(0.5), '50%')
  assert.equal(squadronLabel('╍Nrst╎', 'North_Steel'), 'Nrst North_Steel')
  assert.equal(squadronLabel('[QUEUE]', 'Queue'), 'QUEUE')
  assert.equal(squadronLabel('=ABC=', null), 'ABC')
  // A name that starts with the tag stands alone; a longer word that only begins with it does not.
  assert.equal(squadronLabel('-BLOB1-', 'BLOB1 CZ-SK comunity'), 'BLOB1 CZ-SK comunity')
  assert.equal(squadronLabel('=ABC=', 'abc-Team'), 'abc-Team')
  assert.equal(squadronLabel('=ABC=', 'ABCdef'), 'ABC ABCdef')
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
  assert.match(text.description, /\n\n\*\*Air:\*\* at least one aircraft or helicopter — \S+%$/)
  assert.doesNotMatch(text.description, /setup|expected/)
  assert.match(text.description, /\*\*ghost\*\* is not in their recent battles/)
  assert.deepEqual(text.fields.map((field) => field.name), ['Aircraft · 3', 'Tanks · 5'])
  assert.match(text.fields[0]!.value, /^\\_under\\_score\\_ — \*\*Vautour IIN\*\* \(\d+%\)/m)
  assert.match(text.fields[1]!.value, /^p3 — \*\*Leopard 1\*\* \(\d+%\)/m)
  assert.equal(text.fields[1]!.value.split('\n').length, 5)
  const empty = formatScoutReport({ ...report, prediction: predictScout({ battles: [], now, stages: [], classOf: () => '?' }) })
  assert.match(empty.description, /No battles stored/)
  assert.equal(empty.color, SCOUT_COLOR_GUESS)
})

test('a screenshot reply keeps the method out: a tip for a later screenshot only when no flags were read', () => {
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
    squadron: null, allySquadron: null, prediction, recognised: 1, anonymous: null, unread: ['Unknown'], enemyFlags: { read: 4, rowsWithout: 0 }, statShark: { players: 0, pending: false }, vehicles, now: 0,
  }
  const air = '**Air:** at least one aircraft or helicopter — <1%'
  const used = formatScoutImageReport(report)
  assert.equal(used.title, 'Enemy team')
  assert.equal(used.description, air)
  assert.deepEqual(used.fields, [{ name: 'Tanks · 1', value: 'A — **Leopard 2K** (90%)' }, { name: 'Not recognised · 1', value: '"Unknown"' }])
  assert.equal(formatScoutImageReport({ ...report, enemyFlags: { read: 4, rowsWithout: 1 } }).description, air)
  const none = { ...report, prediction: { ...prediction, flags: null } }
  assert.equal(formatScoutImageReport({ ...none, enemyFlags: { read: 3, rowsWithout: 0 } }).description, air)
  const nobodyIn = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: 2 } }).description
  assert.equal(nobodyIn, `${air}\nNo enemy is in a vehicle yet: a screenshot after they spawn sharpens the guess.`)
  const lineMissed = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: 1 } }).description
  assert.equal(lineMissed, `${air}\nThe flags above the enemy team were not read: a screenshot showing them sharpens the guess.`)
  const before = formatScoutImageReport({ ...none, enemyFlags: { read: 0, rowsWithout: null } }).description
  assert.equal(before, `${air}\nA screenshot after the enemies spawn sharpens the guess.`)
  // A player guessed behind a fake name: counted as read, marked in their line.
  const hidden = formatScoutImageReport({ ...none, recognised: 0, enemyFlags: { read: 0, rowsWithout: 2 }, anonymous: { userId: 'a', nick: 'A', fakeName: 'Abraham5625' } })
  assert.match(hidden.description, /No enemy is in a vehicle yet/)
  assert.match(hidden.fields.map((field) => field.value).join('\n'), /^A \(probably: hidden as Abraham5625\) — \*\*Leopard 2K\*\* \(90%\)$/m)
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

test('a screenshot reply names guessed vehicles like seen ones and says when StatShark updates it', () => {
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
      // No battles at this BR and only a weak guess: no class, no vehicle named.
      { userId: 'c', nick: 'Cold', playChance: 1, battlesAtCap: 0, vehicles: [], unseenChance: 1, newVehicles: [{ vehicleId: 'de_tank', chance: 0.05 }], lineup: [] },
    ],
    setup: setupFromPlayers([{ classChances: { F: 0, H: 0, T: 1, L: 0, AA: 0 } }]),
    flags: null,
  }
  const report: ScoutImageReport = {
    squadron: null, allySquadron: null, prediction, recognised: 2, anonymous: null, unread: [], enemyFlags: { read: 0, rowsWithout: null },
    statShark: { players: 0, pending: true }, vehicles, now: 0,
  }
  const text = formatScoutImageReport(report)
  assert.match(text.description, /\nChecking the players' battles on StatShark: this reply updates in a minute or two\.$/)
  assert.deepEqual(text.fields, [
    { name: 'Aircraft · 1', value: 'Regular — **Vautour IIN(C)** (50%) · Leopard I (35%)' },
    { name: 'Anti-air · 1', value: 'Fresh — **WZ305** (70%) · Leopard I (20%)' },
    { name: 'Unclear · 1', value: 'Cold — no battles at this BR yet' },
  ])
  const updated = formatScoutImageReport({ ...report, statShark: { players: 2, pending: false } }).description
  assert.doesNotMatch(updated, /StatShark/)
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
