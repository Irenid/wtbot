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

  const clanMatch = /<text x="70" y="262"[^>]*>»xGAFx«<\/text>/.exec(svg)
  const victoryMatch =
    /<text x="70" y="262"[^>]*><tspan fill-opacity="0">»xGAFx«<\/tspan><tspan dx="18"[^>]*>Победа<\/tspan><\/text>/.exec(svg)
  assert.ok(clanMatch)
  assert.ok(victoryMatch)
  assert.match(svg, /<text x="70" y="304"[^>]*>\(/)
  assert.doesNotMatch(svg, /<text x="70" y="304"[^>]*>Победа<\/text>/)
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
    /<text x="70" y="262"[^>]*><tspan fill-opacity="0">»VeryLongClanName«<\/tspan><tspan dx="18"[^>]*>Победа<\/tspan><\/text>/,
  )
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
