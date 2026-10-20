import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBattleSvg, buildRosters, summarizeTeams } from './render-battle.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'
import type { VehicleDict } from './vehicles.js'

const header: WrplHeader = {
  version: 1,
  level: 'levels/test.bin',
  battleType: 'Domination',
  environment: 'day',
  visibility: 'good',
  resultsBlkOffset: 0,
  difficulty: 0,
  sessionId: '1',
  sessionIdHex: '0000000000000001',
  partNumber: 1,
  isServer: true,
  settingsBlkSize: 0,
  locName: 'Test',
  startTime: 1_700_000_000,
  timeLimit: 0,
  scoreLimit: 0,
  battleClass: '',
}

const player: ReplayPlayerResult = {
  userId: '1',
  name: 'Player',
  clanTag: '╔xGAFx╕',
  team: 1,
  kills: 0,
  groundKills: 0,
  navalKills: 0,
  aiKills: 0,
  aiGroundKills: 0,
  assists: 0,
  deaths: 0,
  captureZone: 0,
  damageZone: 0,
  score: 1,
  awardDamage: 0,
  teamKills: 0,
  squadId: 0,
  autoSquad: false,
  vehicles: [],
}

test('the victory label follows the clan tag in one SVG line', () => {
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [player] }
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: {}, winnerTeam: 1 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  const clanMatch = /<text x="42" y="262"[^>]*>»xGAFx«<\/text>/.exec(svg)
  const victoryMatch =
    /<text x="42" y="262"[^>]*><tspan fill-opacity="0">»xGAFx«<\/tspan><tspan dx="18" dy="-4"[^>]*>Victory<\/tspan><\/text>/.exec(svg)
  assert.ok(clanMatch)
  assert.ok(victoryMatch)
  assert.match(svg, /<text x="42" y="304"[^>]*>\(/)
  assert.doesNotMatch(svg, /<text x="42" y="304"[^>]*>Victory<\/text>/)
})

test('the victory label does not overlap a long clan tag', () => {
  const longClanPlayer = { ...player, clanTag: '╔VeryLongClanName╕' }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [longClanPlayer] }
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: {}, winnerTeam: 1 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(
    svg,
    /<text x="42" y="262"[^>]*><tspan fill-opacity="0">»VeryLongClanName«<\/tspan><tspan dx="18" dy="-4"[^>]*>Victory<\/tspan><\/text>/,
  )
})

test('таблицы имеют симметричные поля и центрированный разделитель', () => {
  const activePlayer = { ...player, vehicles: ['test_tank'] }
  const secondPlayer = { ...activePlayer, userId: '2', name: 'Player 2', team: 2 }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [activePlayer, secondPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' } },
      winnerTeam: 1,
    },
    {
      unitIcons: new Map(),
      mapImage: null,
      gameFlags: new Map([['ussr', '<svg width="100" height="66" viewBox="0 0 100 66"><rect width="100" height="66" fill="#bc0000"/></svg>']]),
      gameFont: false,
    },
  )

  assert.match(svg, /<rect x="959" y="220" width="2"/)
  assert.match(svg, /<text x="42" y="262"[^>]*>»xGAFx«<\/text>/)
  assert.match(svg, /<text x="1002" y="262"[^>]*>»xGAFx«<\/text>/)
  assert.match(svg, /<g transform="translate\(876 232\)">/)
  assert.match(svg, /<g transform="translate\(1836 232\)">/)
  assert.match(svg, /<g transform="translate\(508 278\) scale\(/)
  assert.match(svg, /<g transform="translate\(1468 278\) scale\(/)
  assert.match(svg, /<image width="38" height="24" preserveAspectRatio="xMidYMid meet" href="data:image\/svg\+xml;base64,/)
  assert.match(svg, /<text x="42" y="304"[^>]*>\(/)
  assert.match(svg, /<text x="1002" y="304"[^>]*>\(/)
})

test('значок платформы не сдвигает колонку техники', () => {
  const platformPlayer = { ...player, name: 'Pilot@psn', vehicles: ['test_tank'] }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [platformPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'usa' } },
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(svg, /<g transform="translate\(144 352\) scale\(/)
  assert.match(svg, /<text x="180" y="376"[^>]*>Pilot<\/text>/)
  assert.match(svg, /<text x="144" y="410"[^>]*>Test Tank<\/text>/)
  assert.doesNotMatch(svg, /<text x="180" y="410"/)
})

test('a long nickname is cut before the PSR column', () => {
  const longName = 'КРЫМСКИЙПОДПИВАС'
  const longPlayer = { ...player, name: longName, vehicles: ['test_tank'] }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [longPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' } },
      psr: new Map([['1', { psr: 1658, change: null }]]),
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(svg, /<text x="144" y="376"[^>]*>КРЫМСКИЙПОДПИ…<\/text>/)
  assert.doesNotMatch(svg, /<text x="144" y="376"[^>]*>КРЫМСКИЙПОДПИВАС<\/text>/)
  assert.match(svg, /<text x="522" y="396"[^>]*>1658<\/text>/)
  assert.match(svg, /clip-path="url\(#player-name-0-0\)"/)
})

test('the PSR column shows dashes until the squadron pages are read', () => {
  const ratedPlayer = { ...player, vehicles: ['test_tank'] }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [ratedPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'usa' } },
      psr: new Map(),
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(svg, /<text x="522" y="388"[^>]*>—<\/text>/)
})

test('the PSR column shows the battle\'s points above the PSR after it', () => {
  const results: ReplayResults = {
    status: 'success',
    timePlayed: 60,
    players: [
      { ...player, userId: 'winner', name: 'Winner', team: 1, score: 3 },
      { ...player, userId: 'pending', name: 'Pending', team: 1, score: 2 },
      { ...player, userId: 'floor', name: 'Floor', team: 1, score: 1 },
      { ...player, userId: 'loser', name: 'Loser', team: 2 },
    ],
  }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: {},
      psr: new Map([
        ['winner', { psr: 1516.4, change: 16 }],
        ['pending', { psr: 1499.6, change: null }],
        ['floor', { psr: 0, change: -0.4 }],
        ['loser', { psr: 1483.6, change: -16.5 }],
      ]),
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  // Rows are 88 px apart from y 340; the column is at x 522 (left team) and 1482 (right team).
  assert.match(svg, /<text x="522" y="364"[^>]*fill="#7ee787"[^>]*>\+16<\/text>/)
  assert.match(svg, /<text x="522" y="396"[^>]*>1516<\/text>/)
  assert.doesNotMatch(svg, /<text x="522" y="452"/)
  assert.match(svg, /<text x="522" y="484"[^>]*>1500<\/text>/)
  assert.doesNotMatch(svg, /<text x="522" y="540"/)
  assert.match(svg, /<text x="522" y="572"[^>]*>0<\/text>/)
  assert.match(svg, /<text x="1482" y="364"[^>]*fill="#ff7b72"[^>]*>−17<\/text>/)
  assert.match(svg, /<text x="1482" y="396"[^>]*>1484<\/text>/)
})

test('SVG сохраняет оригинальные Unicode-символы в никах игроков', () => {
  const results: ReplayResults = {
    status: 'success',
    timePlayed: 60,
    players: [
      { ...player, userId: 'harald', name: 'Haraldツ', team: 1 },
      { ...player, userId: 'maniac', name: '스트레이 키즈 Maniac', team: 2 },
    ],
  }
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: {}, winnerTeam: 1 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.ok(svg.includes('>Haraldツ</text>'))
  assert.ok(svg.includes('>스트레이 키즈 Maniac</text>'))
})

const vehicleDict: VehicleDict = {
  lineup_tank: { name: 'Lineup Tank', cls: 'T', country: 'ussr' },
  test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' },
  test_plane: { name: 'Test Plane', cls: 'F', country: 'ussr' },
}

function renderPlayers(players: ReplayPlayerResult[]): string {
  return buildBattleSvg(
    { missionName: '[Domination] Test', header, results: { status: 'success', timePlayed: 60, players }, dict: vehicleDict },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )
}

test('a row shows the driven vehicles, not the lineup', () => {
  const svg = renderPlayers([{ ...player, vehicles: ['lineup_tank'], playedVehicles: ['test_plane', 'test_tank'] }])

  assert.match(svg, /<text x="144" y="410"[^>]*>Test Plane \+1<\/text>/)
  assert.doesNotMatch(svg, /Lineup Tank/)
  assert.match(svg, /<tspan fill="#79c0ff">1F<\/tspan>/)
})

test('a slot played by a bot shows its vehicle with a bot mark instead of a disconnect', () => {
  const svg = renderPlayers([{ ...player, vehicles: [], playedVehicles: ['test_tank'], botUserId: '-7' }])

  assert.match(svg, /<text x="144" y="410"[^>]*>Test Tank<tspan fill="#9aa2b1">&#160;· bot<\/tspan><\/text>/)
  assert.doesNotMatch(svg, /Disconnected/)
})

test('a player who never spawned gets a dash, a missing lineup stays a disconnect', () => {
  const idle = renderPlayers([{ ...player, vehicles: ['lineup_tank'], playedVehicles: [] }])
  assert.match(idle, /<text x="144" y="410"[^>]*>—<\/text>/)
  assert.doesNotMatch(idle, /Lineup Tank|Disconnected/)

  const absent = renderPlayers([{ ...player, vehicles: [], playedVehicles: [] }])
  assert.match(absent, /<text x="144" y="410"[^>]*>Disconnected<\/text>/)
})

test('team 0 makes no roster of its own: it joins the smaller team or is dropped', () => {
  const p = (userId: string, team: number): ReplayPlayerResult => ({ ...player, userId, name: userId, team })
  const teamsOf = (players: ReplayPlayerResult[]): string[][] =>
    buildRosters({ status: 'success', timePlayed: 60, players }).map((roster) => roster.map((r) => r.userId).sort())

  assert.deepEqual(teamsOf([p('a', 1), p('b', 1), p('c', 2), p('lost', 0)]), [['a', 'b'], ['c', 'lost']])
  assert.deepEqual(teamsOf([p('a', 1), p('c', 2), p('lost', 0)]), [['a'], ['c']])
})

test('a player slot the AI drove shows the player\'s nick with a bot mark; a bot that never spawned leaves a disconnect', () => {
  // Results name the row after the bot on the player's own id; the ECS slot keeps the nick
  const ai = { ...player, userId: '159429413', name: 'coop/Bot284', slotNick: 'Самый Пивной', vehicles: ['lineup_tank'] }
  const driven = renderPlayers([{ ...ai, playedVehicles: ['test_tank'] }])
  assert.match(driven, />Самый Пивной<\/text>/)
  assert.doesNotMatch(driven, /coop\/Bot284/)
  assert.match(driven, /<text x="144" y="410"[^>]*>Test Tank<tspan fill="#9aa2b1">&#160;· bot<\/tspan><\/text>/)

  const idle = renderPlayers([{ ...ai, playedVehicles: [] }])
  assert.match(idle, />Самый Пивной<\/text>/)
  assert.match(idle, /<text x="144" y="410"[^>]*>Disconnected<\/text>/)

  const pairedIdle = renderPlayers([{ ...player, vehicles: [], playedVehicles: [], botUserId: '-7' }])
  assert.match(pairedIdle, /<text x="144" y="410"[^>]*>Disconnected<\/text>/)
})

test('every slot gets a row: slots the AI drove and a bot that filled an empty place, not a bot standing in for a listed player', () => {
  const p = (userId: string, team: number, extra: Partial<ReplayPlayerResult> = {}): ReplayPlayerResult =>
    ({ ...player, userId, name: userId, team, slot: 0, ...extra })
  const players = [
    // Team 1 came with 7: the game filled the 8th place with a bot
    p('a', 1, { score: 500 }),
    p('ai', 1, { name: 'coop/Bot1', slotNick: 'Real Nick', score: 0 }),
    p('-1', 1, { name: 'coop/Bot2', score: 0, playedVehicles: ['test_tank'] }),
    // Team 2: a player who never loaded in (no ECS slot) with the bot paired to them,
    // and one more whose bot stays unpaired (two slotless players)
    p('b', 2, { score: 100 }),
    p('absent', 2, { slot: null, botUserId: '-2' }),
    p('-2', 2, { name: 'coop/Bot3' }),
    p('gone', 2, { slot: null }),
    p('-3', 2, { name: 'coop/Bot4' }),
  ]
  const results: ReplayResults = { status: 'success', timePlayed: 60, players }
  assert.deepEqual(
    buildRosters(results).map((roster) => roster.map((r) => r.userId).sort()),
    [['-1', 'a', 'ai'], ['absent', 'b', 'gone']],
  )
  assert.deepEqual(summarizeTeams(results, vehicleDict).map((team) => team.players), [['a', 'Real Nick'], ['b', 'absent', 'gone']])

  const svg = renderPlayers(players)
  assert.match(svg, /fill="#9aa2b1"[^>]*>Bot<\/text>/)
  assert.match(svg, />Real Nick<\/text>/)

  // results-BLK alone (no ECS slots read): no bot rows, the AI's slot stays with its results name
  const resultsOnly = players.map(({ slot: _slot, slotNick: _slotNick, botUserId: _botUserId, ...rest }) => rest)
  assert.deepEqual(
    buildRosters({ status: 'success', timePlayed: 60, players: resultsOnly }).map((roster) => roster.map((r) => r.userId).sort()),
    [['a', 'ai'], ['absent', 'b', 'gone']],
  )
})

test('a 16-vs-16 battle: rows by score, the stronger team first, every value drawn inside the image', () => {
  const players: ReplayPlayerResult[] = []
  for (let i = 0; i < 16; i += 1) {
    players.push({
      ...player,
      userId: String(1_000 + i),
      name: i === 3 ? `Console${i}@psn` : `Alpha${i}`,
      clanTag: '╔xGAFx╕',
      team: 1,
      kills: i % 4,
      groundKills: (i % 5) + 1,
      assists: i % 3,
      captureZone: i % 2,
      deaths: 1 + (i % 3),
      score: 100 + ((i * 37) % 500),
      vehicles: [i % 4 === 0 ? 'test_plane' : 'test_tank'],
    })
    // Team 2 scores more in total, so its roster comes first.
    players.push({
      ...player,
      userId: String(2_000 + i),
      name: `Bravo${i}`,
      clanTag: '-TWO-',
      team: 2,
      kills: (i % 3) + 1,
      groundKills: i % 4,
      assists: (i % 2) + 1,
      captureZone: (i + 1) % 2,
      deaths: i % 4,
      score: 400 + ((i * 53) % 400),
      vehicles: ['test_tank'],
    })
  }
  const results: ReplayResults = { status: 'success', timePlayed: 1_200, players }

  const rosters = buildRosters(results)
  assert.deepEqual(rosters.map((roster) => [roster.length, roster[0]!.team]), [[16, 2], [16, 1]])
  for (const roster of rosters) {
    assert.deepEqual(roster.map((row) => row.score), roster.map((row) => row.score).sort((a, b) => b - a))
  }

  const teams = summarizeTeams(results, vehicleDict)
  assert.deepEqual(teams.map((team) => team.rawTag), ['-TWO-', '╔xGAFx╕'])
  assert.equal(teams[0]!.composition, '16T')
  assert.match(teams[1]!.composition, /^(4F\/12T|12T\/4F)$/)
  assert.equal(teams[1]!.players.length, 16)
  assert.ok(teams[1]!.players.includes('Console3'), 'the platform suffix is not part of the name')

  const psr = new Map(players.map((row, index) => [row.userId, { psr: 1_000 + index * 10, change: index % 2 === 0 ? 16 : -16 }]))
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: vehicleDict, psr, winnerTeam: 2 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )
  for (const row of players) assert.ok(svg.includes(row.name.replace(/@psn$/, '')), `${row.name} is drawn`)
  for (const entry of psr.values()) assert.ok(svg.includes(`>${entry.psr}<`), `PSR ${entry.psr} is drawn`)
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/)
  const height = Number(/<svg[^>]*\bheight="(\d+)"/.exec(svg)?.[1])
  assert.ok(height > 16 * 88, `the image holds 16 rows (height ${height})`)
  const ys = [...svg.matchAll(/\by="(-?[\d.]+)"/g)].map((match) => Number(match[1]))
  assert.ok(ys.length > 32 * 4)
  assert.ok(Math.max(...ys) < height, `every element starts inside the image (max y ${Math.max(...ys)} of ${height})`)
})
