import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, WrplHeader } from './replay.js'
import { stripClanDecorators } from './render-battle.js'
import { buildHeatmapSvg } from './render-heatmap.js'

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
  clanTag: 'AAA',
  team: 1,
  kills: 0,
  groundKills: 0,
  navalKills: 0,
  aiKills: 0,
  aiGroundKills: 0,
  assists: 0,
  deaths: 1,
  captureZone: 0,
  damageZone: 0,
  score: 500,
  awardDamage: 0,
  teamKills: 0,
  squadId: 0,
  autoSquad: false,
  vehicles: ['test_tank'],
}

function renderAt(x: number, z: number): string {
  const events: ReplayEvents = {
    teamWon: 1,
    players: [],
    kills: [
      {
        time: 120_000,
        killerId: '',
        killerModel: '',
        killerPos: null,
        victimId: player.userId,
        victimModel: 'test_tank',
        victimPos: null,
        weapon: '',
      },
    ],
    damage: [],
    chat: [],
    units: [
      {
        userId: player.userId,
        model: 'test_tank',
        source: 'ground',
        path: [
          { t: 0, x, y: 0, z },
          { t: 180_000, x: x + 10, y: 0, z: z + 10 },
        ],
      },
    ],
    zones: [],
    endTime: 180_000,
    errors: [],
  }
  return buildHeatmapSvg({
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 180, players: [player] },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground',
  })
}

test('heatmap сохраняет старый макет и новые текстовые подписи', () => {
  const svg = renderAt(-800, 0)

  assert.match(svg, /<svg width="1880" height="1400"/)
  assert.ok(!svg.includes('ТАКТИЧЕСКАЯ КАРТА'))
  assert.ok(svg.includes('Длительность: 3:00'))
  assert.ok(svg.includes('500 очк. · '))
  assert.ok(svg.includes('погиб 2:00'))
  assert.ok(svg.includes('fill="#f2c811">AAA</text>'))
  assert.ok(svg.includes('>победа</text>'))
})

test('heatmap определяет восемь направлений спавна', () => {
  const cases: [number, number, string][] = [
    [800, 0, 'спавн справа'],
    [700, 700, 'спавн сверху справа'],
    [0, 800, 'спавн сверху'],
    [-700, 700, 'спавн сверху слева'],
    [-800, 0, 'спавн слева'],
    [-700, -700, 'спавн снизу слева'],
    [0, -800, 'спавн снизу'],
    [700, -700, 'спавн снизу справа'],
  ]

  for (const [x, z, label] of cases) assert.ok(renderAt(x, z).includes(`>${label}</text>`), label)
})

test('карта клана сохраняет цвет общей карты и скрывает чужой маршрут', () => {
  const enemy: ReplayPlayerResult = { ...player, userId: '2', name: 'Enemy', clanTag: 'BBB', team: 2, score: 400 }
  const events: ReplayEvents = {
    teamWon: 0,
    players: [],
    kills: [
      {
        time: 30_000,
        killerId: '1',
        killerModel: 'test_tank',
        killerPos: { t: 30_000, x: -650, y: 0, z: 0 },
        victimId: '2',
        victimModel: 'test_tank',
        victimPos: { t: 30_000, x: 650, y: 0, z: 0 },
        weapon: 'test_shell',
      },
    ],
    damage: [],
    chat: [],
    units: [
      { userId: '1', model: 'test_tank', source: 'ground', path: [{ t: 0, x: -800, y: 0, z: 0 }, { t: 60_000, x: -500, y: 0, z: 0 }] },
      { userId: '2', model: 'test_tank', source: 'ground', path: [{ t: 0, x: 800, y: 0, z: 0 }, { t: 60_000, x: 500, y: 0, z: 0 }] },
      { userId: '1', model: 'test_plane', source: 'air', path: [{ t: 70_000, x: -700, y: 100, z: 0 }, { t: 130_000, x: -400, y: 200, z: 0 }] },
      { userId: '2', model: 'test_plane', source: 'air', path: [{ t: 70_000, x: 700, y: 100, z: 0 }, { t: 130_000, x: 400, y: 200, z: 0 }] },
    ],
    zones: [],
    endTime: 130_000,
    errors: [],
  }
  const input = {
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 60, players: [player, enemy] },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground' as const,
  }
  const overview = buildHeatmapSvg(input)
  const clan = buildHeatmapSvg({ ...input, teamIndex: 0 })
  const overviewAir = buildHeatmapSvg({ ...input, mode: 'air' })
  const clanAir = buildHeatmapSvg({ ...input, mode: 'air', teamIndex: 0 })

  assert.ok(overview.includes('stroke="#f04a50"'))
  assert.ok(clan.includes('stroke="#f04a50"'))
  assert.ok(overview.includes('stroke="#f2c811"'))
  assert.ok(!clan.includes('stroke="#f2c811"'))
  assert.ok(clan.includes('>Player</text>'))
  assert.ok(clan.includes('>Enemy</text>'))
  assert.ok(clan.includes('fill="#f2c811" stroke="#15181c"'))
  assert.ok(clan.includes('stroke="#f04a50" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"'))
  assert.ok(!clan.includes('цель: техника'))
  assert.ok(overviewAir.includes('stroke="#f04a50"'))
  assert.ok(clanAir.includes('stroke="#f04a50"'))
  assert.ok(overviewAir.includes('stroke="#f2c811"'))
  assert.ok(!clanAir.includes('stroke="#f2c811"'))
})

test('кнопка клана убирает игровые декораторы, но сохраняет дефисы', () => {
  assert.equal(stripClanDecorators('╔xGAFx╕'), 'xGAFx')
  assert.equal(stripClanDecorators('-UA4-'), '-UA4-')
})
