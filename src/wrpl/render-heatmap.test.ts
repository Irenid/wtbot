import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, WrplHeader } from './replay.js'
import type { MapImageViewport } from './battle-assets.js'
import type { VehicleDict } from './vehicles.js'
import { clanDisplayName, stripClanDecorators } from './render-battle.js'
import { buildHeatmapSvg, prepareHeatmapScene, type HeatmapRenderOptions } from './render-heatmap.js'

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
  mode: 'ground' | 'air' = 'ground',
  heatmapOptions?: Partial<HeatmapRenderOptions>,
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
        source: mode,
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
    mode,
    renderScale,
    ...(heatmapOptions ? { heatmapOptions } : {}),
  }, false, tacticalMap, fallbackMap, fallbackMapViewport, mapIconFont, capturedMapRendering)
}

test('подготовка heatmap сохраняет оригинальные Unicode-символы в никах', () => {
  const harald = { ...player, userId: 'harald', name: 'Haraldツ', team: 1 }
  const maniac = { ...player, userId: 'maniac', name: '스트레이 키즈 Maniac', team: 2 }
  const scene = prepareHeatmapScene({
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 60, players: [harald, maniac] },
    events: {
      teamWon: 1,
      players: [],
      kills: [],
      damage: [],
      chat: [],
      units: [
        {
          userId: harald.userId,
          model: 'test_tank',
          source: 'ground',
          path: [{ t: 0, x: -100, y: 0, z: 0 }, { t: 60_000, x: -90, y: 0, z: 10 }],
        },
        {
          userId: maniac.userId,
          model: 'test_tank',
          source: 'ground',
          path: [{ t: 0, x: 100, y: 0, z: 0 }, { t: 60_000, x: 90, y: 0, z: 10 }],
        },
      ],
      zones: [],
      endTime: 60_000,
      errors: [],
    },
    dict: {},
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground',
  })

  assert.deepEqual(scene.allPlayers.map((entry) => entry.name), ['Haraldツ', '스트레이 키즈 Maniac'])
})

test('авиационная карта приближает маршруты и сохраняет наземную battleArea', () => {
  const viewport: MapImageViewport = {
    x: 0.4,
    y: 0.4,
    width: 0.2,
    height: 0.2,
    worldBounds: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 },
    imageWorldBounds: { x0: -5000, z0: -5000, x1: 5000, z1: 5000 },
    airfields: [{ sx: 0.46, sy: 0.47, ex: 0.54, ey: 0.53, color: '#17FFFF' }],
    airSpawns: [{ x: 0.5, y: 0.5, color: '#fa0000' }],
  }
  const svg = renderAt(
    -800,
    0,
    1,
    'data:image/png;base64,TACTICAL',
    'data:image/jpeg;base64,BACKGROUND',
    viewport,
    false,
    true,
    true,
    180_000,
    'air',
  )

  assert.ok(svg.includes('data-map-role="air-background" x="-2403.8" y="-2403.8" width="6207.5" height="6207.5"'))
  assert.ok(svg.includes('href="data:image/jpeg;base64,BACKGROUND"'))
  assert.ok(svg.includes('data-map-role="tactical-overlay" x="79.2" y="79.2" width="1241.5" height="1241.5"'))
  assert.ok(svg.includes('href="data:image/png;base64,TACTICAL"'))
  assert.ok(svg.includes('<g data-map-layer="05-air-objects">'))
  assert.ok(svg.includes('data-airfield="0"'))
  assert.ok(svg.includes('data-air-spawn="0" transform="translate(700 700)"'))
  assert.ok(svg.includes('<g data-map-layer="06-battle-area">'))
  assert.ok(!svg.includes('data-map-viewport='))
})

test('настройки авиационной карты отключают приближение и дополнительные объекты', () => {
  const viewport: MapImageViewport = {
    x: 0.4,
    y: 0.4,
    width: 0.2,
    height: 0.2,
    worldBounds: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 },
    imageWorldBounds: { x0: -5000, z0: -5000, x1: 5000, z1: 5000 },
    airfields: [{ sx: 0.46, sy: 0.47, ex: 0.54, ey: 0.53, color: '#17FFFF' }],
    airSpawns: [{ x: 0.5, y: 0.5, color: '#fa0000' }],
  }
  const svg = renderAt(
    -800,
    0,
    1,
    'data:image/png;base64,TACTICAL',
    'data:image/jpeg;base64,BACKGROUND',
    viewport,
    false,
    true,
    true,
    180_000,
    'air',
    {
      airAutoZoom: false,
      airShowGroundMap: false,
      airShowAirfields: false,
      airShowSpawns: false,
      airPaddingPercent: 20,
    },
  )

  assert.ok(svg.includes('data-map-role="air-background" x="0" y="0" width="1400" height="1400"'))
  assert.ok(!svg.includes('data-map-role="tactical-overlay"'))
  assert.ok(!svg.includes('data-airfield='))
  assert.ok(!svg.includes('data-air-spawn='))
  assert.ok(!svg.includes('06-battle-area'))
})

test('the heatmap keeps the old layout and the new text labels', () => {
  const svg = renderAt(-800, 0)

  assert.match(svg, /<svg width="1880" height="1400"/)
  assert.ok(svg.includes('shape-rendering="geometricPrecision"'))
  assert.ok(!svg.includes('TACTICAL MAP'))
  assert.ok(svg.includes('Duration: 3:00'))
  assert.ok(svg.includes('500 pts · '))
  assert.ok(svg.includes('died 2:00'))
  assert.ok(svg.includes('fill="#f2c811">AAA</text>'))
  assert.ok(svg.includes('>victory</text>'))
  assert.ok(svg.includes('data-capture-zone="A"'))
  assert.ok(svg.includes('data-team-spawn="0"'))
})

test('the raster map is muted at both scales and sharpened only at 2×', () => {
  const map = 'data:image/png;base64,AA=='
  const standard = renderAt(-800, 0, 1, map)
  const hd = renderAt(-800, 0, 2, map)

  for (const svg of [standard, hd]) {
    assert.ok(svg.includes('<filter id="map-tone"'))
    assert.ok(svg.includes('<feColorMatrix type="saturate" values="0.5"/>'))
    assert.ok(svg.includes(`filter="url(#map-tone)" href="${map}"`))
  }
  assert.ok(!standard.includes('feConvolveMatrix'))
  assert.ok(!standard.includes('image-rendering="optimizeQuality"'))
  assert.ok(hd.includes('<feConvolveMatrix '))
  assert.ok(hd.includes('image-rendering="optimizeQuality" filter="url(#map-tone)"'))
})

test('наземная heatmap предпочитает тактическую карту авиационной подложке', () => {
  const viewport: MapImageViewport = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    worldBounds: { x0: -32768, z0: -32768, x1: 32768, z1: 32768 },
    imageWorldBounds: { x0: -32768, z0: -32768, x1: 32768, z1: 32768 },
  }
  const svg = renderAt(
    -800,
    0,
    1,
    'data:image/png;base64,GROUND_TACTICAL',
    'data:image/jpeg;base64,AIR_FULL_MAP',
    viewport,
  )

  assert.ok(svg.includes('href="data:image/png;base64,GROUND_TACTICAL"'))
  assert.ok(!svg.includes('href="data:image/jpeg;base64,AIR_FULL_MAP"'))
  assert.ok(!svg.includes('data-map-viewport='))
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

test('the heatmap tells eight spawn directions', () => {
  const cases: [number, number, string][] = [
    [800, 0, 'spawn on the right'],
    [700, 700, 'spawn top right'],
    [0, 800, 'spawn at the top'],
    [-700, 700, 'spawn top left'],
    [-800, 0, 'spawn on the left'],
    [-700, -700, 'spawn bottom left'],
    [0, -800, 'spawn at the bottom'],
    [700, -700, 'spawn bottom right'],
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

test('a squadron map keeps the overview colours and hides the other team\'s routes', () => {
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
  const russian = buildHeatmapSvg({ ...input, teamIndex: 0, locale: 'ru' })

  assert.ok(overview.includes('stroke="#4C99F8"'))
  assert.ok(clan.includes('stroke="#4C99F8"'))
  assert.ok(overview.includes('stroke="#F56600"'))
  assert.ok(!clan.includes('stroke="#F56600"'))
  assert.ok(clan.includes('>Player</text>'))
  assert.ok(clan.includes('>Enemy</text>'))
  assert.ok(clan.includes('routes: AAA'))
  assert.ok(!clan.includes('routes: =AAA='))
  assert.match(clan, /data-spawn-label="0"[^>]*>AAA<\/text>/)
  assert.ok(!clan.includes('data-selected-team='))
  assert.ok(clan.includes('1 player · 2 kills · 1 survived'))
  assert.ok(russian.includes('маршруты: AAA'))
  assert.ok(russian.includes('1 игрок · 2 фрага · 1 выжил'))
  assert.equal(clan.match(/data-spawn-label="0"/g)?.length, 4)
  assert.ok(clan.includes('data-route-layer="outline"'))
  assert.ok(clan.includes('data-route-layer="color"'))
  assert.match(clan, /data-direction-arrows="[1-9]/)
  assert.ok(clan.includes('stroke="#10130d" stroke-opacity="0.55" stroke-width="5.4"'))
  assert.ok(clan.includes('stroke="#4C99F8" stroke-width="3"'))
  assert.ok(!clan.includes('stroke="#4C99F8" stroke-opacity="0.72"'))
  const outline = /<path data-route-layer="outline" data-direction-arrows="([1-9]\d*)" d="([^"]+)"/.exec(clan)
  const color = /<path data-route-layer="color" data-direction-arrows="([1-9]\d*)" d="([^"]+)"/.exec(clan)
  assert.ok(outline && color)
  assert.equal(outline[1], color[1])
  assert.equal(outline[2], color[2])
  assert.ok((outline[2]!.match(/M/g)?.length ?? 0) > 1)
  assert.ok(clan.lastIndexOf('data-spawn-label=') < clan.indexOf('data-route-layer="outline"'))
  assert.ok(clan.includes('data-marker-leader="1"'))
  assert.ok(clan.includes('fill="#F56600" stroke="#15181c"'))
  assert.ok(clan.includes('stroke="#4C99F8" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"'))
  assert.ok(!clan.includes('target: vehicles'))
  assert.ok(overviewAir.includes('stroke="#4C99F8"'))
  assert.ok(clanAir.includes('stroke="#4C99F8"'))
  assert.ok(overviewAir.includes('stroke="#F56600"'))
  assert.ok(!clanAir.includes('stroke="#F56600"'))
  // The other squadron's map draws that squadron cool, as the game draws its own spawn blue.
  const otherClan = buildHeatmapSvg({ ...input, teamIndex: 1 })
  assert.ok(otherClan.includes('stroke="#4C99F8" stroke-width="3"'))
  assert.ok(otherClan.includes('fill="#4C99F8" stroke="#15181c"'))
  assert.ok(otherClan.includes('stroke="#F56600" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"'))
})

test('each life\'s track is named, and the ground map badges only kills not made by a tank', () => {
  // The overview draws its first roster (the higher team score) cool.
  const enemy: ReplayPlayerResult = { ...player, userId: '2', name: 'Enemy', clanTag: 'BBB', team: 2, score: 200 }
  const pilot: ReplayPlayerResult = { ...player, userId: '3', name: 'LongNickname_1234567', clanTag: 'BBB', team: 2, score: 200 }
  const events: ReplayEvents = {
    teamWon: 2,
    players: [],
    kills: [
      {
        time: 30_000,
        killerId: '2',
        killerModel: 'test_tank',
        killerPos: { t: 30_000, x: 600, y: 0, z: 0 },
        victimId: '1',
        victimModel: 'test_tank',
        victimPos: { t: 30_000, x: -500, y: 0, z: 0 },
        weapon: 'test_shell',
      },
      {
        time: 90_000,
        killerId: '3',
        killerModel: 'test_plane',
        killerPos: { t: 90_000, x: -300, y: 300, z: 400 },
        victimId: '1',
        victimModel: 'test_tank',
        victimPos: { t: 90_000, x: -500, y: 0, z: 400 },
        weapon: 'test_bomb',
      },
    ],
    damage: [],
    chat: [],
    units: [
      { userId: '1', model: 'test_tank', source: 'ground', path: [{ t: 0, x: -800, y: 0, z: 0 }, { t: 30_000, x: -500, y: 0, z: 0 }] },
      { userId: '1', model: 'test_tank', source: 'ground', path: [{ t: 40_000, x: -800, y: 0, z: 400 }, { t: 90_000, x: -500, y: 0, z: 400 }] },
      { userId: '2', model: 'test_tank', source: 'ground', path: [{ t: 0, x: 800, y: 0, z: 0 }, { t: 50_000, x: 600, y: 0, z: 0 }] },
      {
        userId: '3',
        model: 'test_plane',
        source: 'air',
        path: Array.from({ length: 7 }, (_, i) => ({ t: 60_000 + i * 5_000, x: 0, y: 300, z: -900 + i * 300 })),
      },
    ],
    zones: [],
    endTime: 120_000,
    errors: [],
  }
  const input = {
    missionName: '[Domination] Test map',
    header,
    results: { status: 'ok', timePlayed: 120, players: [player, enemy, pilot] },
    events,
    dict: {
      test_tank: { name: 'Test Tank', cls: 'T', country: 'ussr' },
      test_plane: { name: 'Test Plane', cls: 'F', country: 'usa' },
    } satisfies VehicleDict,
    mission: { area: { x0: -1000, z0: -1000, x1: 1000, z1: 1000 }, zones: [] },
    mode: 'ground' as const,
  }
  const layer = (svg: string, name: string): string => {
    const start = svg.indexOf(`<g data-map-layer="${name}">`)
    if (start < 0) return ''
    const end = svg.indexOf('<g data-map-layer="', start + 1)
    return svg.slice(start, end >= 0 ? end : undefined)
  }
  const ground = buildHeatmapSvg(input)
  const air = buildHeatmapSvg({ ...input, mode: 'air' })

  // One name per life, in the track's colour, drawn above every marker.
  assert.equal(ground.match(/data-route-label="1"/g)?.length, 2)
  assert.equal(ground.match(/data-route-label="2"/g)?.length, 1)
  assert.ok(!ground.includes('data-route-label="3"'))
  assert.match(ground, /data-route-label="1"[^>]* fill="#4C99F8"[^>]*>Player<\/text>/)
  assert.match(ground, /data-route-label="2"[^>]* fill="#F56600"[^>]*>Enemy<\/text>/)
  assert.ok(ground.indexOf('<g data-map-layer="24-route-labels">') > ground.indexOf('<g data-map-layer="23-killer-labels">'))
  assert.match(air, /data-route-label="3"[^>]*>LongNickname_12…<\/text>/)

  const groundCauses = layer(ground, '22-death-causes')
  assert.equal(groundCauses.match(/<g transform="translate\(/g)?.length, 1)
  assert.ok(groundCauses.includes('<path d="M0 -9.5 L2.3 -2.8'))
  assert.ok(!groundCauses.includes('<rect x="-8.5" y="0.5" width="17"'))
  assert.ok(layer(ground, '23-killer-labels').includes('>Test Plane</text>'))
  assert.ok(ground.includes('>killer if not a tank</text>'))
  assert.ok(air.includes('>killed by</text>'))

  // The plane's kill has no line on the ground map: only the tank's kill keeps one.
  assert.equal(layer(ground, '17-kill-lines').match(/<line /g)?.length, 1)
})

test('the legend stays visible with sixteen players', () => {
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
  assert.ok(svg.includes('>Legend</text>'))
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

test('a drone shows only on its squadron\'s ground map, in its owner\'s colour', () => {
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
  assert.ok(ownClan.includes('stroke="#4C99F8" stroke-width="2"'))
  assert.ok(ownClan.includes('data-uav-observation="1"'))
  assert.ok(!enemyClan.includes('data-uav-route='))
  assert.ok(!airClan.includes('data-uav-route='))
})
