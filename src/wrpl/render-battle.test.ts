import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBattleSvg } from './render-battle.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'

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

test('метка победы следует за клановым тегом в одной SVG-строке', () => {
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [player] }
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: {}, winnerTeam: 1 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  const clanMatch = /<text x="42" y="262"[^>]*>»xGAFx«<\/text>/.exec(svg)
  const victoryMatch =
    /<text x="42" y="262"[^>]*><tspan fill-opacity="0">»xGAFx«<\/tspan><tspan dx="18" dy="-4"[^>]*>Победа<\/tspan><\/text>/.exec(svg)
  assert.ok(clanMatch)
  assert.ok(victoryMatch)
  assert.match(svg, /<text x="42" y="304"[^>]*>\(/)
  assert.doesNotMatch(svg, /<text x="42" y="304"[^>]*>Победа<\/text>/)
})

test('метка победы не накладывается на длинный клановый тег', () => {
  const longClanPlayer = { ...player, clanTag: '╔VeryLongClanName╕' }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [longClanPlayer] }
  const svg = buildBattleSvg(
    { missionName: '[Domination] Test', header, results, dict: {}, winnerTeam: 1 },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(
    svg,
    /<text x="42" y="262"[^>]*><tspan fill-opacity="0">»VeryLongClanName«<\/tspan><tspan dx="18" dy="-4"[^>]*>Победа<\/tspan><\/text>/,
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

test('длинный ник обрезается до колонки ПКР', () => {
  const longName = 'КРЫМСКИЙПОДПИВАС'
  const longPlayer = { ...player, name: longName, vehicles: ['test_tank'] }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [longPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' } },
      ratings: new Map([[longName, { rating: 1658, delta: null }]]),
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(svg, /<text x="144" y="376"[^>]*>КРЫМСКИЙПОДПИ…<\/text>/)
  assert.doesNotMatch(svg, /<text x="144" y="376"[^>]*>КРЫМСКИЙПОДПИВАС<\/text>/)
  assert.match(svg, /<text x="522" y="396"[^>]*>1658<\/text>/)
  assert.match(svg, /clip-path="url\(#player-name-0-0\)"/)
})

test('до передачи рейтингов в таблице стоят прочерки', () => {
  const ratedPlayer = { ...player, vehicles: ['test_tank'] }
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [ratedPlayer] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'usa' } },
      ratings: new Map(),
      winnerTeam: 1,
    },
    { unitIcons: new Map(), mapImage: null, gameFont: false },
  )

  assert.match(svg, /<text x="522" y="388"[^>]*>—<\/text>/)
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
