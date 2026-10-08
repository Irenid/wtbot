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
import { SCOUT_COLOR_GUESS, SCOUT_COLOR_SESSION, compositionText, formatScoutReport, percent, plainVehicleName, squadronLabel } from './format.js'
import { predictScout, type ScoutBattle } from './model.js'
import { findSquadrons, nickKey, recentNicks, scoutBattlesFromRows, type ScoutReport } from './report.js'

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
