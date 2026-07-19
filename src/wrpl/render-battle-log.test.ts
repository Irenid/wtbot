import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, WrplHeader } from './replay.js'
import { buildBattleLogSvg } from './render-battle-log.js'

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

function player(userId: string, clanTag: string, team: number): ReplayPlayerResult {
  return {
    userId,
    name: `Player ${userId}`,
    clanTag,
    team,
    kills: 0,
    groundKills: 0,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 0,
    deaths: 0,
    captureZone: 0,
    damageZone: 0,
    score: 0,
    awardDamage: 0,
    teamKills: 0,
    squadId: 0,
    autoSquad: false,
    vehicles: ['test_tank'],
  }
}

const events: ReplayEvents = {
  teamWon: 0,
  players: [],
  kills: [],
  damage: [],
  chat: [],
  units: [],
  zones: [],
  endTime: 0,
  errors: [],
}

test('battle log рисует клановые рамки тем же игровым шрифтом, что и heatmap', () => {
  const svg = buildBattleLogSvg({
    missionName: '[Domination] Test',
    header,
    results: {
      status: 'ok',
      timePlayed: 60,
      players: [player('1', '╊OEF╋', 1), player('2', '┾BriSs┿', 2)],
    },
    events,
    dict: {},
  }, true)

  assert.ok(svg.includes('<tspan font-family="symbols_skyquake">╊</tspan>OEF'))
  assert.ok(svg.includes('<tspan font-family="symbols_skyquake">┾</tspan>BriSs'))
  assert.ok(!svg.includes('≋OEF≋'))
  assert.ok(!svg.includes('⚑BriSs⚑'))
})
