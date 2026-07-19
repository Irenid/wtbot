import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, WrplHeader } from './replay.js'
import type { MapImageViewport } from './battle-assets.js'
import { clanDisplayName, stripClanDecorators } from './render-battle.js'
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

function renderAt(
  x: number,
  z: number,
  renderScale: 1 | 2 = 1,
  tacticalMap: string | null = null,
  fallbackMap: string | null = null,
  fallbackMapViewport?: MapImageViewport,
  mapIconFont = false,
  withMission = true,
  capturedMapRendering = true,
  pathEndTime = 180_000,
): string {
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
          { t: pathEndTime, x: x + 10, y: 0, z: z + 10 },
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
    mission: withMission
      ? { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [{ letter: 'A', x: 0, z: 0 }] }
      : null,
    mode: 'ground',
    renderScale,
  }, false, tacticalMap, fallbackMap, fallbackMapViewport, mapIconFont, capturedMapRendering)
}

test('heatmap сохраняет старый макет и новые текстовые подписи', () => {
  const svg = renderAt(-800, 0)

  assert.match(svg, /<svg width="1880" height="1400"/)
  assert.ok(svg.includes('shape-rendering="geometricPrecision"'))
  assert.ok(!svg.includes('ТАКТИЧЕСКАЯ КАРТА'))
  assert.ok(svg.includes('Длительность: 3:00'))
  assert.ok(svg.includes('500 очк. · '))
  assert.ok(svg.includes('погиб 2:00'))
  assert.ok(svg.includes('fill="#f2c811">AAA</text>'))
  assert.ok(svg.includes('>победа</text>'))
  assert.ok(svg.includes('data-capture-zone="A"'))
  assert.ok(svg.includes('data-team-spawn="0"'))
})

test('режим 2× повышает резкость только растровой подложки', () => {
  const map = 'data:image/png;base64,AA=='
  const standard = renderAt(-800, 0, 1, map)
  const hd = renderAt(-800, 0, 2, map)

  assert.ok(!standard.includes('hd-map-sharpen'))
  assert.ok(hd.includes('<filter id="hd-map-sharpen"'))
  assert.ok(hd.includes('image-rendering="optimizeQuality" filter="url(#hd-map-sharpen)"'))
})

test('полный map.img обрезается и получает игровую координатную сетку', () => {
  const viewport = {
    x: 0.25,
    y: 0.2,
    width: 0.5,
    height: 0.4,
    gridStepX: 0.25,
    gridStepY: 0.25,
    gridStepMeters: 225,
    captureZones: [{ letter: 'Z', x: 0.75, y: 0.25 }],
    groundSpawns: [{ x: 0.1, y: 0.9 }],
  }
  const svg = renderAt(-800, 0, 1, null, 'data:image/jpeg;base64,AA==', viewport)

  assert.ok(svg.includes('<clipPath id="fallback-map-viewport"><rect x="0" y="0" width="1400" height="1400"/></clipPath>'))
  assert.ok(svg.includes('data-map-viewport="0.3 0.2 0.5 0.4"'))
  assert.ok(svg.includes('x="-700" y="-700" width="2800" height="3500"'))
  assert.ok(svg.includes('clip-path="url(#fallback-map-viewport)"'))
  assert.ok(svg.includes('<g data-map-layer="05-coordinate-grid">'))
  assert.ok(svg.includes('data-grid-column="1"'))
  assert.ok(svg.includes('data-grid-row="a"'))
  assert.ok(svg.includes('data-grid-scale="225"'))
  assert.ok(svg.includes('<g data-capture-zone="Z" transform="translate(1050 350)">'))
  assert.ok(svg.includes('<g data-team-spawn="0" transform="translate(140 1260)">'))
})

test('viewport работает без mission area и использует игровой шрифт значков', () => {
  const viewport = {
    x: 0.25,
    y: 0.2,
    width: 0.5,
    height: 0.4,
    gridStepX: 0.25,
    gridStepY: 0.25,
    gridStepMeters: 225,
    captureZones: [{ letter: 'A', x: 0.5, y: 0.5 }],
    groundSpawns: [{ x: 0.2, y: 0.2 }],
  }
  const svg = renderAt(-800, 0, 1, null, 'data:image/jpeg;base64,AA==', viewport, true, false)

  assert.ok(svg.includes('x="-700" y="-700" width="2800" height="3500"'))
  assert.ok(svg.includes('<g data-map-layer="05-coordinate-grid">'))
  assert.ok(svg.includes('font-family="indicators"'))
  assert.ok(svg.includes('>7</text>'))
  assert.ok(svg.includes('>0</text>'))
})

test('готовый игровой скриншот сохраняет мировую привязку при отключённой новой прорисовке', () => {
  const viewport: MapImageViewport = {
    x: 0.28163814544677734,
    y: 0.2985180616378784,
    width: 0.4150391221046448,
    height: 0.4150390625,
    worldBounds: {
      x0: 1153.58984375,
      z0: 1173.27001953125,
      x1: 2853.590087890625,
      z1: 2873.27001953125,
    },
  }
  const svg = renderAt(
    2400,
    1330,
    1,
    null,
    'data:image/png;base64,AA==',
    viewport,
    false,
    false,
    false,
    60_000,
  )

  assert.ok(svg.includes('d="M1026.5 1270.9L1034.7 1262.7'))
  assert.ok(!svg.includes('data-map-viewport='))
  assert.ok(!svg.includes('coordinate-grid'))
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

test('слои карты имеют строгий уникальный порядок важности', () => {
  const svg = renderAt(-800, 0)
  const layers = [...svg.matchAll(/data-map-layer="(\d+)-([^"]+)"/g)].map((match) => ({
    level: Number(match[1]),
    name: match[2]!,
  }))

  assert.ok(layers.length >= 4)
  assert.deepEqual(
    layers.map((layer) => layer.level),
    [...layers].map((layer) => layer.level).sort((a, b) => a - b),
  )
  assert.equal(new Set(layers.map((layer) => layer.level)).size, layers.length)
  assert.equal(new Set(layers.map((layer) => layer.name)).size, layers.length)
})

test('поздний проезд рисуется выше раннего независимо от порядка составов', () => {
  const early: ReplayPlayerResult = { ...player, userId: '2', name: 'Early', clanTag: 'BBB', team: 2 }
  const events: ReplayEvents = {
    teamWon: 1,
    players: [],
    kills: [],
    damage: [],
    chat: [],
    units: [
      {
        userId: player.userId,
        model: 'test_tank',
        source: 'ground',
        path: [
          { t: 0, x: -500, y: 0, z: -500 },
          { t: 50_000, x: -350, y: 0, z: -350 },
          { t: 100_000, x: -150, y: 0, z: -150 },
          { t: 150_000, x: 0, y: 0, z: 0 },
          { t: 180_000, x: 250, y: 0, z: 250 },
        ],
      },
      {
        userId: early.userId,
        model: 'test_tank',
        source: 'ground',
        path: [
          { t: 60_000, x: -250, y: 0, z: 250 },
          { t: 90_000, x: 0, y: 0, z: 0 },
          { t: 120_000, x: 250, y: 0, z: -250 },
        ],
      },
    ],
    zones: [],
    endTime: 180_000,
    errors: [],
  }
  const svg = buildHeatmapSvg({
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 180, players: [player, early] },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground',
  })
  const routeStart = svg.indexOf('<g data-map-layer="13-routes">')
  const routeEnd = svg.indexOf('<g data-map-layer="', routeStart + 1)
  const routeLayer = routeStart >= 0 ? svg.slice(routeStart, routeEnd >= 0 ? routeEnd : undefined) : ''

  assert.ok(routeLayer)
  assert.equal(routeLayer.match(/data-route-layer="outline"/g)?.length, 2)
  assert.equal(routeLayer.match(/data-route-layer="color"/g)?.length, 2)
  assert.ok(routeLayer.indexOf('data-route-player="1" data-route-start-time="0"') < routeLayer.indexOf('data-route-player="2" data-route-start-time="60000"'))
  assert.match(routeLayer, /data-route-crossing="1" data-route-player="1" data-crossing-time="150000"/)
  assert.ok(routeLayer.lastIndexOf('data-route-layer="outline"') < routeLayer.indexOf('data-route-layer="color"'))
  assert.ok(!routeLayer.includes('data-route-crossing-layer="outline"'))
  assert.equal(routeLayer.match(/data-route-crossing-layer="color"/g)?.length, 1)
  assert.ok(!routeLayer.includes('data-route-time='))
})

test('длинный маршрут упрощается и остаётся одним SVG-объектом без нарезки на рёбра', () => {
  const points = Array.from({ length: 101 }, (_, index) => ({
    t: index * 1_000,
    x: -500 + index * 10,
    y: 0,
    z: Math.sin(index / 8) * 80,
  }))
  const events: ReplayEvents = {
    teamWon: 1,
    players: [],
    kills: [],
    damage: [],
    chat: [],
    units: [{ userId: player.userId, model: 'test_tank', source: 'ground', path: points }],
    zones: [],
    endTime: 100_000,
    errors: [],
  }
  const svg = buildHeatmapSvg({
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 100, players: [player] },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground',
  })
  const routeStart = svg.indexOf('<g data-map-layer="13-routes">')
  const routeEnd = svg.indexOf('<g data-map-layer="', routeStart + 1)
  const routeLayer = svg.slice(routeStart, routeEnd >= 0 ? routeEnd : undefined)

  assert.equal(routeLayer.match(/data-route-layer="outline"/g)?.length, 1)
  assert.equal(routeLayer.match(/data-route-layer="color"/g)?.length, 1)
  const counts = /data-route-points="(\d+)" data-route-source-points="(\d+)"/.exec(routeLayer)
  assert.ok(counts)
  assert.equal(Number(counts[2]), 101)
  assert.ok(Number(counts[1]) >= 2 && Number(counts[1]) < 101)
  assert.ok(!routeLayer.includes('data-route-crossing='))
})

test('карта клана сохраняет цвет общей карты и скрывает чужой маршрут', () => {
  const clanPlayer: ReplayPlayerResult = { ...player, clanTag: '=AAA=' }
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
      {
        time: 31_000,
        killerId: '1',
        killerModel: 'test_tank',
        killerPos: { t: 31_000, x: -640, y: 0, z: 0 },
        victimId: '2',
        victimModel: 'test_tank',
        victimPos: { t: 31_000, x: 650, y: 0, z: 0 },
        weapon: 'test_shell',
      },
    ],
    damage: [],
    chat: [],
    units: [
      { userId: '1', model: 'test_tank', source: 'ground', path: [{ t: 0, x: -800, y: 0, z: 0 }, { t: 60_000, x: -500, y: 0, z: 0 }] },
      { userId: '1', model: 'test_tank', source: 'ground', path: [{ t: 65_000, x: 0, y: 0, z: -800 }, { t: 125_000, x: 0, y: 0, z: -450 }] },
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
    results: { status: 'ok', timePlayed: 60, players: [clanPlayer, enemy] },
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
  assert.ok(clan.includes('маршруты: AAA'))
  assert.ok(!clan.includes('маршруты: =AAA='))
  assert.match(clan, /data-spawn-label="0"[^>]*>AAA<\/text>/)
  assert.ok(!clan.includes('data-selected-team='))
  assert.ok(clan.includes('1 игрок · 2 фрага · 1 выжил'))
  assert.equal(clan.match(/data-spawn-label="0"/g)?.length, 4)
  assert.ok(clan.includes('data-route-layer="outline"'))
  assert.ok(clan.includes('data-route-layer="color"'))
  assert.match(clan, /data-direction-arrows="[1-9]/)
  assert.ok(clan.includes('stroke="#10130d" stroke-opacity="0.55" stroke-width="5.4"'))
  assert.ok(clan.includes('stroke="#f04a50" stroke-width="3"'))
  assert.ok(!clan.includes('stroke="#f04a50" stroke-opacity="0.72"'))
  const outline = /<path data-route-layer="outline" data-direction-arrows="([1-9]\d*)" d="([^"]+)"/.exec(clan)
  const color = /<path data-route-layer="color" data-direction-arrows="([1-9]\d*)" d="([^"]+)"/.exec(clan)
  assert.ok(outline && color)
  assert.equal(outline[1], color[1])
  assert.equal(outline[2], color[2])
  assert.ok((outline[2]!.match(/M/g)?.length ?? 0) > 1)
  assert.ok(clan.lastIndexOf('data-spawn-label=') < clan.indexOf('data-route-layer="outline"'))
  assert.ok(clan.includes('data-marker-leader="1"'))
  assert.ok(clan.includes('fill="#f2c811" stroke="#15181c"'))
  assert.ok(clan.includes('stroke="#f04a50" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"'))
  assert.ok(!clan.includes('цель: техника'))
  assert.ok(overviewAir.includes('stroke="#f04a50"'))
  assert.ok(clanAir.includes('stroke="#f04a50"'))
  assert.ok(overviewAir.includes('stroke="#f2c811"'))
  assert.ok(!clanAir.includes('stroke="#f2c811"'))
})

test('легенда остаётся видимой при шестнадцати игроках', () => {
  const players = Array.from({ length: 16 }, (_, i): ReplayPlayerResult => ({
    ...player,
    userId: String(i + 1),
    name: `Player${i + 1}`,
    clanTag: i < 8 ? 'AAA' : 'BBB',
    team: i < 8 ? 1 : 2,
  }))
  const events: ReplayEvents = {
    teamWon: 1,
    players: [],
    kills: [],
    damage: [],
    chat: [],
    units: players.map((result, i) => ({
      userId: result.userId,
      model: 'test_tank',
      source: 'ground' as const,
      path: [
        { t: 0, x: i < 8 ? -800 : 800, y: 0, z: i * 20 },
        { t: 120_000, x: i < 8 ? -300 : 300, y: 0, z: i * 20 },
      ],
    })),
    zones: [],
    endTime: 120_000,
    errors: [],
  }
  const svg = buildHeatmapSvg({
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 120, players },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground',
  })

  assert.ok(svg.includes('data-panel-legend="1"'))
  assert.ok(svg.includes('>Обозначения</text>'))
  assert.ok(svg.includes('>Player16</text>'))
})

test('кнопка клана убирает игровые декораторы, но сохраняет дефисы', () => {
  assert.equal(stripClanDecorators('╔xGAFx╕'), 'xGAFx')
  assert.equal(stripClanDecorators('-UA4-'), '-UA4-')
})

test('подпись клана на карте убирает внешнюю рамку, но сохраняет внутренние знаки', () => {
  assert.equal(clanDisplayName('╊OEF╋'), 'OEF')
  assert.equal(clanDisplayName('=BARS='), 'BARS')
  assert.equal(clanDisplayName('+GFR-2S+'), 'GFR-2S')
})

test('БПЛА показывается только на наземной карте своего клана и использует цвет владельца', () => {
  const enemy: ReplayPlayerResult = { ...player, userId: '2', name: 'Enemy', clanTag: 'BBB', team: 2 }
  const events: ReplayEvents = {
    teamWon: 0,
    players: [],
    kills: [],
    damage: [],
    chat: [],
    units: [
      {
        userId: player.userId,
        model: 'test_tank',
        source: 'ground',
        path: [{ t: 0, x: -500, y: 0, z: 0 }, { t: 90_000, x: -300, y: 0, z: 0 }],
      },
      {
        userId: enemy.userId,
        model: 'test_tank',
        source: 'ground',
        path: [{ t: 0, x: 500, y: 0, z: 0 }, { t: 90_000, x: 300, y: 0, z: 0 }],
      },
      {
        userId: '',
        model: 'ucav_recon_micro_flir',
        source: 'air',
        path: [{ t: 30_000, x: -430, y: 70, z: 0 }, { t: 80_000, x: 0, y: 140, z: 300 }],
      },
    ],
    zones: [],
    endTime: 90_000,
    errors: [],
  }
  const input = {
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 90, players: [player, enemy] },
    events,
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground' as const,
  }
  const overview = buildHeatmapSvg(input)
  const ownClan = buildHeatmapSvg({ ...input, teamIndex: 0 })
  const enemyClan = buildHeatmapSvg({ ...input, teamIndex: 1 })
  const airClan = buildHeatmapSvg({ ...input, mode: 'air', teamIndex: 0 })

  assert.ok(!overview.includes('data-uav-route='))
  assert.ok(ownClan.includes('<g data-map-layer="10-uav-observation">'))
  assert.ok(ownClan.includes('<g data-map-layer="11-uav-routes">'))
  assert.ok(ownClan.includes('<g data-map-layer="12-uav-starts">'))
  assert.ok(ownClan.includes('data-uav-owner="1"'))
  assert.ok(ownClan.includes('stroke="#f04a50" stroke-width="2"'))
  assert.ok(ownClan.includes('data-uav-observation="1"'))
  assert.ok(!enemyClan.includes('data-uav-route='))
  assert.ok(!airClan.includes('data-uav-route='))
})
