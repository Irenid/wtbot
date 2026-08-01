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
  sessionId: 'icons',
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
  name: 'Pilot',
  clanTag: '',
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
  vehicles: ['test_tank'],
}

test('табличные значки используют точные игровые глифы', () => {
  const results: ReplayResults = { status: 'success', timePlayed: 60, players: [player] }
  const svg = buildBattleSvg(
    {
      missionName: '[Domination] Test',
      header,
      results,
      dict: { test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' } },
    },
    { unitIcons: new Map(), mapImage: null, gameFont: true },
  )

  const glyphs = [...svg.matchAll(/font-family="symbols_skyquake"[^>]*>([^<]+)<\/text>/g)]
    .map((match) => match[1])
    .slice(0, 5)
  assert.deepEqual(glyphs, ['\u25ad', '\u25ae', '\u25b1', '\u25b3', '\u258a'])
})
