import type { MissileSeeker } from './battle-assets.js'
import type { MissionInfo } from './mission-info.js'
import type { ReplayEvents, ReplayKill, ReplayUnitPath, SpaceTime } from './replay-events.js'
import type { ReplayResults, WrplHeader } from './replay.js'
import { buildRosters, stripClanDecorators, tagMarkup } from './render-battle.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'

/**
 * Хитмапа боя в стиле Boris Stats: траектории игроков поверх карты,
 * черепа в цвете погибшего со значком причины смерти (силуэт класса
 * убийцы: танк/самолёт/вертолёт/зенитка; для авиации — тип ГСН ракеты
 * ИК/ПАРЛ/АРЛ/ЗУР; звезда — разбился; ободок — цвет убийцы), пунктирные
 * линии фрагов от убийцы к жертве, пятна долгих стоянок с длительностью,
 * точки в конце пути выживших и метки минут вдоль траекторий. Справа — информационная панель:
 * карта/режим/дата, команды в порядке сторон на карте (победитель,
 * игроки с фрагами/смертями, техникой, очками и временем гибели) и
 * блок условных обозначений.
 *
 * mode='ground' — наземная техника (GMSync), mode='air' — авиация
 * (пакеты лётной модели). Наземная карта занимает весь кадр (ровно
 * battleArea); воздушная — по габаритам траекторий, battleArea на ней
 * маленький квадрат. Без файла миссии — по габаритам траекторий.
 *
 * Строгие слои снизу вверх: основа → изображение → запасная сетка → затемнение →
 * граница боя → подписи спавнов → маршруты → пятна стоянок → длительности стоянок →
 * метки минут → линии выстрелов → точки стрелявших → выноски маркеров → точки выживших →
 * черепа → причины смерти → подписи техники. Разные типы элементов не делят слой;
 * экземпляры одного типа сортируются по времени, поздние рисуются выше ранних.
 *
 * Фон — снимок игровой тактической карты нужного режима (см.
 * ensureTacticalMap: качается по missionName, покрывает ровно battleArea);
 * если его нет — ручной скриншот data/maps/<level>.jpg, растянутый на
 * battleArea; иначе тёмная подложка с сеткой.
 */

const MAP_W = 1400
/** Ширина информационной панели справа от карты */
const PANEL_W = 480

/**
 * Палитра траекторий: 16 уникальных цветов, подобраны жадным max-min
 * поиском по OKLab ΔE (обычное зрение + протан/дейтан-симуляция Machado)
 * на фоне хаки-карты; разбиение на команды максимизирует различимость
 * внутри команды — межкомандные пары дополнительно разводит легенда.
 */
const PATH_COLORS = [
  ['#f04a50', '#f57d1f', '#ffd08a', '#19c2c9', '#a8ecff', '#a86ef5', '#ff8fd0', '#ffffff'],
  ['#f2c811', '#c9f25e', '#37c463', '#12dfae', '#c8cdd6', '#cfa4ff', '#f24ab2', '#ffb3a6'],
]

const FONTS = `Segoe UI, Segoe UI Symbol, Microsoft YaHei, Malgun Gothic, Yu Gothic UI, Arial, sans-serif`

export interface HeatmapInput {
  /** " [Domination #2] North Holland" — по нему ищется снимок карты */
  missionName: string
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  dict: VehicleDict
  mission: MissionInfo | null
  mode: 'ground' | 'air'
  /** Индекс команды из buildRosters; без значения рисуются обе команды. */
  teamIndex?: number
  /** Тип ГСН по id оружия (для значков причины смерти) */
  seekers?: Map<string, MissileSeeker>
  /** Масштаб итогового PNG; влияет только на подготовку изображения для HD. */
  renderScale?: 1 | 2
}

interface PlayerPaths {
  userId: string
  name: string
  clanTag: string
  color: string
  models: string[]
  paths: ReplayUnitPath[]
  team: number
}

interface TimedSvg {
  time: number
  sequence: number
  svg: string
}

interface DirectionArrow {
  x: number
  y: number
  angle: number
}

interface PixelRoutePoint {
  x: number
  y: number
  time: number
}

interface RouteGeometry {
  index: number
  baseOrder: number
  playerId: string
  color: string
  points: PixelRoutePoint[]
  sourcePoints: PixelRoutePoint[]
  distances: number[]
  totalLength: number
  startTime: number
  endTime: number
  arrows: DirectionArrow[]
}

interface RouteEdge {
  index: number
  route: RouteGeometry
  from: PixelRoutePoint
  to: PixelRoutePoint
  length: number
}

interface RouteCrossing {
  route: RouteGeometry
  distance: number
  time: number
}

/** "tankModels/ussr_2s38" → "ussr_2s38" (ключ словаря техники) */
const modelId = (model: string): string => model.replace(/^.*\//, '')

export function buildHeatmapSvg(
  input: HeatmapInput,
  gameFont = false,
  tacticalMap: string | null = null,
  fallbackMap: string | null = null,
): string {
  const { events, results, dict, mission, mode, seekers, teamIndex } = input
  const renderScale = input.renderScale ?? 1

  // Игроки в порядке команд со скриншота результатов (слева — «золотая»)
  const rosters = buildRosters(results)
  const allPlayers: PlayerPaths[] = []
  rosters.forEach((roster, ti) => {
    roster.forEach((p, pi) => {
      const paths = events.units
        .filter((u) => u.userId === p.userId && u.source === mode && u.path.length >= 2)
        .map((u) => (mode === 'air' ? truncateAtDeath(u, events, p.userId) : u))
        .filter((u) => u.path.length >= 2)
      if (paths.length === 0) return
      allPlayers.push({
        userId: p.userId,
        name: p.name.replace(/@(psn|live|epic)$/i, ''),
        clanTag: p.clanTag,
        color: PATH_COLORS[Math.min(ti, 1)]![pi % 8]!,
        models: [...new Set(paths.map((q) => modelId(q.model)))],
        paths,
        team: ti,
      })
    })
  })
  const players = teamIndex === undefined ? allPlayers : allPlayers.filter((player) => player.team === teamIndex)

  // Границы мира: battleArea миссии, иначе габариты траекторий; всегда квадрат.
  // Наземная карта с известным battleArea кладётся на весь кадр (снимок
  // покрывает ровно его), остальные режимы — с небольшим полем.
  // Масштаб командной карты совпадает с общей: границы считаются по обеим
  // командам, а цвета назначаются до фильтрации.
  const allPoints = allPlayers.flatMap((p) => p.paths.flatMap((q) => q.path))
  let bounds = mission?.area ?? null
  const fullBleed = mode === 'ground' && bounds !== null
  if (!fullBleed) {
    bounds = fitBounds(allPoints, bounds)
  }
  const cx = (bounds!.x0 + bounds!.x1) / 2
  const cz = (bounds!.z0 + bounds!.z1) / 2
  const half = Math.max(bounds!.x1 - bounds!.x0, bounds!.z1 - bounds!.z0) / 2 || 1000
  const view = fullBleed ? 1 : 0.94
  // мир → пиксели; Z растёт на север, на картинке — вверх
  const px = (x: number): number => ((x - cx) / half) * (MAP_W / 2) * view + MAP_W / 2
  const pz = (z: number): number => MAP_W / 2 - ((z - cz) / half) * (MAP_W / 2) * view

  const W = MAP_W + PANEL_W
  const H = MAP_W

  const parts: string[] = []
  parts.push(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">`)
  if (renderScale === 2) {
    parts.push(
      `<defs><filter id="hd-map-sharpen" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">` +
        `<feConvolveMatrix order="3" kernelMatrix="0 -0.12 0 -0.12 1.48 -0.12 0 -0.12 0" divisor="1" edgeMode="duplicate" preserveAlpha="true"/>` +
        `</filter></defs>`,
    )
  }
  let temporalSequence = 0
  const timed = (time: number, svg: string): TimedSvg => ({ time, sequence: temporalSequence++, svg })
  const chronological = (items: TimedSvg[]): string[] =>
    items
      .sort((a, b) => a.time - b.time || a.sequence - b.sequence)
      .map((item) => item.svg)
  const pushMapLayer = (level: number, name: string, items: string[]): void => {
    if (items.length === 0) return
    parts.push(`<g data-map-layer="${String(level).padStart(2, '0')}-${name}">`, ...items, `</g>`)
  }

  // Фон карты: снимок игровой карты режима → ручной скриншот → сетка.
  // Оба изображения покрывают ровно battleArea, поэтому кладутся на его
  // прямоугольник в мировых координатах (на воздушной карте он меньше кадра).
  const mapImage = tacticalMap ?? fallbackMap
  const mapImageAttrs = renderScale === 2
    ? ` image-rendering="optimizeQuality" filter="url(#hd-map-sharpen)"`
    : ''
  pushMapLayer(1, 'base', [`<rect width="${MAP_W}" height="${MAP_W}" fill="#3c4034"/>`])
  if (mapImage && mission?.area) {
    const a = mission.area
    const ix = px(a.x0)
    const iy = pz(a.z1)
    const iw = px(a.x1) - ix
    const ih = pz(a.z0) - iy
    pushMapLayer(2, 'map-image', [
      `<image x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" preserveAspectRatio="none"${mapImageAttrs} href="${mapImage}"/>`,
    ])
    // лёгкое затемнение — чтобы траектории читались поверх карты
    pushMapLayer(4, 'readability-shade', [
      `<rect x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" fill="#0a0e14" fill-opacity="0.18"/>`,
    ])
  } else if (mapImage) {
    pushMapLayer(2, 'map-image', [
      `<image x="0" y="0" width="${MAP_W}" height="${MAP_W}" preserveAspectRatio="xMidYMid slice"${mapImageAttrs} href="${mapImage}"/>`,
    ])
  } else {
    // подложка с сеткой
    const fallbackGrid = [`<rect width="${MAP_W}" height="${MAP_W}" fill="#41453a"/>`]
    const cells = 10
    for (let i = 0; i <= cells; i++) {
      const v = (MAP_W / cells) * i
      fallbackGrid.push(
        `<line x1="${v}" y1="0" x2="${v}" y2="${MAP_W}" stroke="#2d3028" stroke-width="1.5"/>`,
        `<line x1="0" y1="${v}" x2="${MAP_W}" y2="${v}" stroke="#2d3028" stroke-width="1.5"/>`,
      )
    }
    pushMapLayer(3, 'fallback-grid', fallbackGrid)
  }

  // Рамка battleArea (важно на воздушной карте, где мир шире зоны боя;
  // при карте на весь кадр совпадает с границей и не рисуется)
  if (mission?.area && !fullBleed) {
    const a = mission.area
    const fx = px(a.x0)
    const fy = pz(a.z1)
    pushMapLayer(5, 'battle-area', [
      `<rect x="${r1(fx)}" y="${r1(fy)}" width="${r1(px(a.x1) - fx)}" height="${r1(pz(a.z0) - fy)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.5" stroke-dasharray="14 10"/>`,
    ])
  }

  // По началам всех жизней находим один или два спавна команды. Подпись остаётся
  // нижним слоем, но выбирает свободную сторону спавна без видимых маршрутов.
  const visibleRouteSegments: PixelSegment[] = players.flatMap((player) =>
    player.paths.flatMap((unit) =>
      splitSegments(unit.path).flatMap((segment) => segment.slice(1).map((point, i) => ({
        x1: px(segment[i]!.x),
        y1: pz(segment[i]!.z),
        x2: px(point.x),
        y2: pz(point.z),
      }))),
    ),
  )
  const occupiedSpawnLabels: PixelBox[] = []
  const spawnLabels: string[] = []
  for (const ti of [0, 1]) {
    const roster = rosters[ti]
    if (!roster) continue
    const rawClan = mostCommonTag(roster.map((player) => player.clanTag))
    const clan = rawClan ? stripClanDecorators(rawClan) : `Команда ${roster[0]?.team ?? ti + 1}`
    for (const spawn of teamSpawnClusters(allPlayers.filter((player) => player.team === ti), half)) {
      const placement = placeSpawnLabel(px(spawn.x), pz(spawn.z), clan, visibleRouteSegments, occupiedSpawnLabels)
      occupiedSpawnLabels.push(placement.box)
      const attrs = `data-spawn-label="${ti}" x="${r1(placement.x)}" y="${r1(placement.y)}" text-anchor="${placement.anchor}" font-family="${FONTS}" font-size="24" font-weight="700"`
      spawnLabels.push(
        `<text ${attrs} fill="none" stroke="#10130d" stroke-width="5" stroke-opacity="0.72">${esc(clan)}</text>`,
        `<text ${attrs} fill="#f2f4f7" fill-opacity="0.68">${esc(clan)}</text>`,
      )
    }
  }
  pushMapLayer(6, 'spawn-labels', spawnLabels)

  // Непрерывный маршрут и его стрелки остаются одним SVG path. Маршруты
  // сортируются по времени начала, а редкие локальные мостики в пересечениях
  // показывают, кто проехал через конкретную точку позже.
  const routes: RouteGeometry[] = []
  let routeIndex = 0
  for (const p of players) {
    for (const unit of p.paths) {
      for (const seg of splitSegments(unit.path)) {
        const sourcePoints = seg.map((point) => ({ x: px(point.x), y: pz(point.z), time: point.t }))
        const points = simplifyRoutePoints(sourcePoints, 1)
        const distances = routeDistances(points)
        routes.push({
          index: routeIndex++,
          baseOrder: 0,
          playerId: p.userId,
          color: p.color,
          points,
          sourcePoints,
          distances,
          totalLength: distances[distances.length - 1] ?? 0,
          startTime: seg[0]!.t,
          endTime: seg[seg.length - 1]!.t,
          arrows: directionArrows(points),
        })
      }
    }
  }
  routes.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.index - b.index)
  routes.forEach((route, index) => { route.baseOrder = index })
  const routeDrawings = routes.map((route) => {
    const d = routePath(route.points) + route.arrows.map(arrowSubpath).join('')
    const attrs = `data-route-player="${esc(route.playerId)}" data-route-start-time="${Math.round(route.startTime)}" data-route-end-time="${Math.round(route.endTime)}" data-route-points="${route.points.length}" data-route-source-points="${route.sourcePoints.length}"`
    return { route, d, attrs }
  })
  // Все обводки лежат ниже всех цветов. Поэтому верхний маршрут не вырезает
  // чёрную щель в нижнем, но контраст линий с фоном карты сохраняется.
  const routeParts = [
    ...routeDrawings.map(({ route, d, attrs }) =>
      `<g data-route-stroke-pass="outline" ${attrs}>` +
        `<path data-route-layer="outline" data-direction-arrows="${route.arrows.length}" d="${d}" fill="none" stroke="#10130d" stroke-opacity="0.55" stroke-width="5.4" stroke-linejoin="round" stroke-linecap="round"/>` +
        `</g>`),
    ...routeDrawings.map(({ route, d, attrs }) =>
      `<g data-route-stroke-pass="color" ${attrs}>` +
        `<path data-route-layer="color" data-direction-arrows="${route.arrows.length}" d="${d}" fill="none" stroke="${route.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
        `</g>`),
  ]
  const crossingParts = routeCrossings(routes).map((crossing) => {
    const d = routeSlicePath(crossing.route, crossing.distance, 10)
    return timed(
      crossing.time,
      `<g data-route-crossing="1" data-route-player="${esc(crossing.route.playerId)}" data-crossing-time="${Math.round(crossing.time)}">` +
        `<path data-route-crossing-layer="color" d="${d}" fill="none" stroke="${crossing.route.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
        `</g>`,
    )
  })
  pushMapLayer(7, 'routes', [...routeParts, ...chronological(crossingParts)])

  // Время первой смерти игрока в пределах жизни юнита: остов подбитой
  // машины шлёт статичную позицию до конца боя — без обрезки по смерти
  // он превратился бы в ложную «стоянку»
  const deathTimeOf = (p: PlayerPaths, unit: ReplayUnitPath): number | null => {
    const start = unit.path[0]!.t
    const end = unit.path[unit.path.length - 1]!.t
    const kill = events.kills.find(
      (k) => k.victimId === p.userId && k.time >= start - 5000 && k.time <= end + 45000,
    )
    return kill ? kill.time : null
  }

  // Стоянки (только наземка): где юнит простоял дольше минуты — пятно
  // в цвете игрока (размер растёт с длительностью) с подписью «м:сс»
  const campAreas: TimedSvg[] = []
  const campLabels: TimedSvg[] = []
  if (mode === 'ground') {
    for (const p of players) {
      for (const unit of p.paths) {
        const death = deathTimeOf(p, unit)
        const alive = death === null ? unit.path : unit.path.filter((q) => q.t <= death)
        if (alive.length < 2) continue
        for (const camp of findCamps(alive)) {
          const r = Math.min(30, 13 + (camp.durMs / 60000) * 5)
          const mm = Math.floor(camp.durMs / 60000)
          const ss = String(Math.floor((camp.durMs % 60000) / 1000)).padStart(2, '0')
          const x = r1(px(camp.x))
          const y = pz(camp.z)
          campAreas.push(timed(
            camp.time,
            `<circle data-camp-time="${Math.round(camp.time)}" cx="${x}" cy="${r1(y)}" r="${r1(r)}" fill="${p.color}" fill-opacity="0.26" stroke="${p.color}" stroke-opacity="0.85" stroke-width="1.8"/>`,
          ))
          campLabels.push(timed(
            camp.time,
            `<g data-camp-label-time="${Math.round(camp.time)}">` +
              `<text x="${x}" y="${r1(y + r + 17)}" font-family="${FONTS}" font-size="14.5" font-weight="700" text-anchor="middle" fill="none" stroke="#10130d" stroke-width="3.4">${mm}:${ss}</text>` +
              `<text x="${x}" y="${r1(y + r + 17)}" font-family="${FONTS}" font-size="14.5" font-weight="700" text-anchor="middle" fill="#f2f4f7">${mm}:${ss}</text>` +
              `</g>`,
          ))
        }
      }
    }
  }
  pushMapLayer(8, 'camp-areas', chronological(campAreas))
  pushMapLayer(9, 'camp-labels', chronological(campLabels))

  // Метки времени: кружок с номером минуты раз в tickStep минут вдоль
  // каждой траектории; у стоящего юнита слипшиеся метки пропускаются —
  // остаётся время прибытия в точку
  const endTime = Math.max(events.endTime, ...allPoints.map((q) => q.t), 1)
  const stepMs = tickStepMinutes(endTime) * 60000
  const minuteMarks: TimedSvg[] = []
  for (const p of players) {
    for (const unit of p.paths) {
      let lastX = -1e9
      let lastY = -1e9
      for (const tick of timeTicks(unit.path, stepMs)) {
        const x = px(tick.x)
        const y = pz(tick.z)
        if (Math.hypot(x - lastX, y - lastY) < 27) continue
        lastX = x
        lastY = y
        minuteMarks.push(timed(
          tick.time,
          `<g data-minute-time="${Math.round(tick.time)}" transform="translate(${r1(x)} ${r1(y)})">` +
            `<circle r="11" fill="#10130d" fill-opacity="0.74" stroke="${p.color}" stroke-width="2.4"/>` +
            `<text y="4.6" font-family="${FONTS}" font-size="13" font-weight="700" fill="#f2f4f7" text-anchor="middle">${tick.minute}</text>` +
            `</g>`,
        ))
      }
    }
  }
  pushMapLayer(10, 'minute-marks', chronological(minuteMarks))

  // Смерти: череп на месте каждого убийства этого игрока (в рамках путей
  // данного режима, в цвете погибшего), значок и подпись причины,
  // пунктирная линия фрага от позиции убийцы; точка — конец пути юнита,
  // дожившего до конца боя. Подслои снизу вверх: линии фрагов → точки
  // выживших → черепа → значки → подписи, чтобы соседний череп в свалке
  // не накрывал чужой значок, а значки — подписи.
  const killLines: TimedSvg[] = []
  const killOriginDots: TimedSvg[] = []
  const markerLeaders: TimedSvg[] = []
  const survivorDots: TimedSvg[] = []
  const skulls: TimedSvg[] = []
  const causeBadges: TimedSvg[] = []
  const causeLabels: TimedSvg[] = []
  const playerById = new Map(allPlayers.map((p) => [p.userId, p]))
  const occupiedDeathMarkers: { x: number; y: number }[] = []
  const placeDeathMarker = (trueX: number, trueY: number, time: number): { x: number; y: number } => {
    const offsets: [number, number][] = [
      [0, 0], [0, -48], [48, 0], [0, 48], [-48, 0],
      [42, -42], [42, 42], [-42, 42], [-42, -42],
      [0, -72], [72, 0], [0, 72], [-72, 0],
    ]
    const candidates = offsets.map(([dx, dy]) => ({
      x: Math.max(28, Math.min(MAP_W - 28, trueX + dx)),
      y: Math.max(28, Math.min(MAP_W - 44, trueY + dy)),
    }))
    const distance = (candidate: { x: number; y: number }): number =>
      occupiedDeathMarkers.length === 0
        ? Infinity
        : Math.min(...occupiedDeathMarkers.map((placed) => Math.hypot(candidate.x - placed.x, candidate.y - placed.y)))
    const placed = candidates.find((candidate) => distance(candidate) >= 50) ??
      candidates.reduce((best, candidate) => distance(candidate) > distance(best) ? candidate : best)
    occupiedDeathMarkers.push(placed)
    if (Math.hypot(placed.x - trueX, placed.y - trueY) > 2) {
      markerLeaders.push(timed(
        time,
        `<line data-marker-leader="1" x1="${r1(trueX)}" y1="${r1(trueY)}" x2="${r1(placed.x)}" y2="${r1(placed.y)}" stroke="#e5e9ef" stroke-width="1.4" stroke-opacity="0.62"/>`,
      ))
    }
    return placed
  }
  for (const p of players) {
    const ranges = p.paths.map((u) => ({
      from: u.path[0]!.t - 5000,
      to: u.path[u.path.length - 1]!.t + 45000,
      last: u.path[u.path.length - 1]!,
    }))
    for (const k of events.kills) {
      if (k.victimId !== p.userId) continue
      const range = ranges.find((rg) => k.time >= rg.from && k.time <= rg.to)
      if (!range) continue
      const pos = k.victimPos && isNear(k.victimPos, range.last) ? k.victimPos : nearestPoint(p.paths, k.time)
      if (!pos) continue
      const tx = px(pos.x)
      const ty = pz(pos.z)
      const marker = placeDeathMarker(tx, ty, k.time)
      skulls.push(timed(k.time, skullIcon(marker.x, marker.y, p.color)))
      if (!k.killerId || k.killerId === p.userId) {
        causeBadges.push(timed(k.time, causeBadge(marker.x + 15, marker.y + 14, { icon: 'crash' }, '#8a919e')))
        continue
      }
      const killer = playerById.get(k.killerId)
      const cause = deathCause(k, mode, dict, seekers)
      if (cause) {
        causeBadges.push(timed(k.time, causeBadge(marker.x + 15, marker.y + 14, cause, killer?.color ?? '#8a919e')))
      }
      if (!killer) {
        // убийцы нет на этой карте (зенитка на воздушной, самолёт на
        // наземной) — цветом его не опознать, подписываем его технику
        const who = vehicleInfo(dict, modelId(k.killerModel)).name
        causeLabels.push(timed(k.time, killerLabel(marker.x, marker.y + 34, trimTo(who, 18))))
      }
      // Позиция убийцы: точка его пути в момент фрага; если пути на этой
      // карте нет (авиация на наземной, зенитка на воздушной) — позиция
      // из события. Убийца за кадром — линия обрезается по краю карты
      // (видно направление атаки), точка его позиции тогда не рисуется.
      const from =
        (killer ? (pointAtTime(killer.paths, k.time) ?? nearestPoint(killer.paths, k.time)) : null) ??
        k.killerPos
      if (!from) continue
      let fx = px(from.x)
      let fy = pz(from.z)
      let clipped = false
      if (fx < 0 || fx > MAP_W || fy < 0 || fy > MAP_W) {
        const t = Math.max(
          fx < 0 ? -fx / (tx - fx) : fx > MAP_W ? (MAP_W - fx) / (tx - fx) : 0,
          fy < 0 ? -fy / (ty - fy) : fy > MAP_W ? (MAP_W - fy) / (ty - fy) : 0,
        )
        if (!Number.isFinite(t) || t <= 0 || t >= 1) continue
        fx += (tx - fx) * t
        fy += (ty - fy) * t
        clipped = true
      }
      const lineColor = killer?.color ?? '#8a919e'
      killLines.push(timed(
        k.time,
        `<line x1="${r1(fx)}" y1="${r1(fy)}" x2="${r1(tx)}" y2="${r1(ty)}" stroke="${lineColor}" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"/>`,
      ))
      if (!clipped) {
        killOriginDots.push(timed(
          k.time,
          `<circle cx="${r1(fx)}" cy="${r1(fy)}" r="4.5" fill="${lineColor}" stroke="#10130d" stroke-width="1.6"/>`,
        ))
      }
    }
    for (const unit of p.paths) {
      const last = unit.path[unit.path.length - 1]!
      // подбитая машина остаётся в мире и шлёт статичную позицию —
      // конец пути возле места гибели точкой выжившего не считается
      const diedHere = events.kills.some(
        (k) =>
          k.victimId === p.userId &&
          (Math.abs(k.time - last.t) < 45000 || (k.victimPos !== null && isNear(k.victimPos, last, 60))),
      )
      if (!diedHere && events.endTime - last.t < 90000) {
        survivorDots.push(timed(
          last.t,
          `<circle cx="${r1(px(last.x))}" cy="${r1(pz(last.z))}" r="8" fill="${p.color}" stroke="#10130d" stroke-width="2"/>`,
        ))
      }
    }
  }

  // На поле карты одного клана показываем уничтоженных им противников только
  // точкой гибели, без чужого маршрута; в панели остаются оба состава.
  if (teamIndex !== undefined) {
    for (const killer of players) {
      for (const k of events.kills) {
        if (k.killerId !== killer.userId || k.victimId === killer.userId) continue
        const victim = playerById.get(k.victimId)
        if (!victim || victim.team === teamIndex) continue
        if (!killer.models.includes(modelId(k.killerModel)) || !victim.models.includes(modelId(k.victimModel))) continue

        const killerActive = killer.paths.some(
          (unit) => k.time >= unit.path[0]!.t - 5000 && k.time <= unit.path[unit.path.length - 1]!.t + 45000,
        )
        const victimRange = victim.paths
          .map((unit) => ({
            from: unit.path[0]!.t - 5000,
            to: unit.path[unit.path.length - 1]!.t + 45000,
            last: unit.path[unit.path.length - 1]!,
          }))
          .find((range) => k.time >= range.from && k.time <= range.to)
        if (!killerActive || !victimRange) continue

        const pos =
          k.victimPos && isNear(k.victimPos, victimRange.last)
            ? k.victimPos
            : nearestPoint(victim.paths, k.time)
        if (!pos) continue

        const tx = px(pos.x)
        const ty = pz(pos.z)
        const marker = placeDeathMarker(tx, ty, k.time)
        skulls.push(timed(k.time, skullIcon(marker.x, marker.y, victim.color)))
        const cause = deathCause(k, mode, dict, seekers)
        if (cause) causeBadges.push(timed(k.time, causeBadge(marker.x + 15, marker.y + 14, cause, killer.color)))

        // Пунктир повторяет обозначение общей карты: цветом убийцы клана.
        const from = pointAtTime(killer.paths, k.time) ?? nearestPoint(killer.paths, k.time) ?? k.killerPos
        if (!from) continue
        let fx = px(from.x)
        let fy = pz(from.z)
        let clipped = false
        if (fx < 0 || fx > MAP_W || fy < 0 || fy > MAP_W) {
          const t = Math.max(
            fx < 0 ? -fx / (tx - fx) : fx > MAP_W ? (MAP_W - fx) / (tx - fx) : 0,
            fy < 0 ? -fy / (ty - fy) : fy > MAP_W ? (MAP_W - fy) / (ty - fy) : 0,
          )
          if (!Number.isFinite(t) || t <= 0 || t >= 1) continue
          fx += (tx - fx) * t
          fy += (ty - fy) * t
          clipped = true
        }
        killLines.push(timed(
          k.time,
          `<line x1="${r1(fx)}" y1="${r1(fy)}" x2="${r1(tx)}" y2="${r1(ty)}" stroke="${killer.color}" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"/>`,
        ))
        if (!clipped) {
          killOriginDots.push(timed(
            k.time,
            `<circle cx="${r1(fx)}" cy="${r1(fy)}" r="4.5" fill="${killer.color}" stroke="#10130d" stroke-width="1.6"/>`,
          ))
        }
      }
    }
  }
  pushMapLayer(11, 'kill-lines', chronological(killLines))
  pushMapLayer(12, 'kill-origins', chronological(killOriginDots))
  pushMapLayer(13, 'marker-leaders', chronological(markerLeaders))
  pushMapLayer(14, 'survivor-dots', chronological(survivorDots))
  pushMapLayer(15, 'death-skulls', chronological(skulls))
  pushMapLayer(16, 'death-causes', chronological(causeBadges))
  pushMapLayer(17, 'killer-labels', chronological(causeLabels))

  // Фраги/смерти за весь бой для легенды (самострел фрагом не считается)
  const killsDeaths = new Map<string, [number, number]>()
  for (const k of events.kills) {
    if (k.killerId && k.killerId !== k.victimId) {
      const e = killsDeaths.get(k.killerId) ?? [0, 0]
      e[0]++
      killsDeaths.set(k.killerId, e)
    }
    if (k.victimId) {
      const e = killsDeaths.get(k.victimId) ?? [0, 0]
      e[1]++
      killsDeaths.set(k.victimId, e)
    }
  }

  // ---------- панель справа: заголовок, команды, обозначения ----------
  parts.push(
    `<rect x="${MAP_W}" width="${PANEL_W}" height="${H}" fill="#0c0d0f"/>`,
    `<line x1="${MAP_W + 1}" y1="0" x2="${MAP_W + 1}" y2="${H}" stroke="#2a2e35" stroke-width="2"/>`,
  )
  const PX = MAP_W + 30
  const PR = MAP_W + PANEL_W - 30

  // Заголовок: карта, режим, дата и длительность боя
  const title = /^\s*(?:\[(?:arcade|realistic|simulation|hardcore)\]\s*)?(?:\[([^\]]+)\]\s*)?(.+)$/i.exec(
    input.missionName.trim(),
  )
  const gameMode = title?.[1] ?? 'Бой'
  const mapName = title?.[2] ?? input.missionName
  const selectedRoster = teamIndex === undefined ? undefined : rosters[teamIndex]
  const selectedRawClan = selectedRoster ? mostCommonTag(selectedRoster.map((player) => player.clanTag)) : null
  const selectedClan = selectedRawClan ? stripClanDecorators(selectedRawClan) : null
  const selectedText = selectedClan ? ` · маршруты: ${trimTo(selectedClan, 12)}` : ''
  const modeFontSize = selectedText ? 16 : 19
  const when = new Date(input.header.startTime * 1000)
  const dateText =
    `${when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}, ` +
    when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const durText = endTime > 60000 ? ` · Длительность: ${fmtTime(endTime)}` : ''
  parts.push(
    `<text x="${PX}" y="66" font-family="${FONTS}" font-size="33" font-weight="700" fill="#ffffff">${esc(trimTo(mapName, 22))}</text>`,
    `<text x="${PX}" y="100" font-family="${FONTS}" font-size="${modeFontSize}" fill="#9aa2b1">${esc(gameMode)} · ${mode === 'ground' ? 'наземная техника' : 'авиация'}${esc(selectedText)}</text>`,
    `<text x="${PX}" y="127" font-family="${FONTS}" font-size="19" fill="#9aa2b1">${esc(dateText)}${durText}</text>`,
    `<line x1="${PX}" y1="150" x2="${PR}" y2="150" stroke="#2a2e35" stroke-width="1.5"/>`,
  )

  // Медиана первых позиций игроков даёт устойчивую точку спавна команды.
  // Порядок в панели повторяет чтение карты: сверху вниз, затем слева направо.
  const teamSpawns = [0, 1].map((ti) => teamSpawn(allPlayers.filter((p) => p.team === ti), cx, cz, half))
  const orderTeams = [0, 1].sort((a, b) => {
    const sa = teamSpawns[a]
    const sb = teamSpawns[b]
    if (!sa || !sb) return sa ? -1 : sb ? 1 : a - b
    const dy = pz(sa.z) - pz(sb.z)
    return Math.abs(dy) > MAP_W * 0.15 ? dy : px(sa.x) - px(sb.x)
  })
  const resultById = new Map(rosters.flat().map((rp) => [rp.userId, rp]))
  const orderedTeams = orderTeams.filter((ti) => rosters[ti] !== undefined)
  const legendRows = 4
  const legendHeight = 40 + legendRows * 34
  const legendY = H - 30 - legendHeight
  const teamGap = 52
  const visiblePlayerCount = allPlayers.length
  const rowBudget = legendY - 12 - 192 - orderedTeams.length * 30 - Math.max(0, orderedTeams.length - 1) * teamGap
  const playerRowStep = visiblePlayerCount > 0
    ? Math.max(50, Math.min(58, Math.floor(rowBudget / visiblePlayerCount)))
    : 58
  const playerSecondLineY = Math.min(46, playerRowStep - 12)

  let py = 192
  orderedTeams.forEach((ti, orderIndex) => {
    const roster = rosters[ti]
    if (!roster) return
    // Панель всегда повторяет общую heatmap; teamIndex фильтрует только поле карты.
    const teamPlayers = allPlayers.filter((p) => p.team === ti)
    const clan = mostCommonTag(roster.map((rp) => rp.clanTag))
    const label = clan ? tagMarkup(clan, gameFont) : `Команда ${roster[0]?.team ?? ti + 1}`
    const won = events.teamWon > 0 && roster[0]?.team === events.teamWon
    const spawn = teamSpawns[ti]
    const spawnText = spawn?.label ?? ''
    const teamKills = roster.reduce((sum, player) => sum + (killsDeaths.get(player.userId)?.[0] ?? 0), 0)
    const survivors = roster.filter((player) => (killsDeaths.get(player.userId)?.[1] ?? 0) === 0).length
    const summary =
      `${roster.length} ${pluralRu(roster.length, 'игрок', 'игрока', 'игроков')} · ` +
      `${teamKills} ${pluralRu(teamKills, 'фраг', 'фрага', 'фрагов')} · ` +
      `${survivors} ${pluralRu(survivors, 'выжил', 'выжили', 'выжили')}`
    parts.push(
      `<text x="${PX}" y="${py}" font-family="${FONTS}" font-size="29" font-weight="700" fill="${won ? '#f2c811' : '#ffffff'}">${label}</text>`,
      won
        ? `<text x="${PR}" y="${py}" font-family="${FONTS}" font-size="17" font-weight="700" text-anchor="end" fill="#f2c811">победа</text>`
        : '',
      `<text x="${PX}" y="${py + 21}" font-family="${FONTS}" font-size="14.5" fill="#7f8998">${summary}</text>`,
      `<text x="${PR}" y="${py + 21}" font-family="${FONTS}" font-size="15" text-anchor="end" fill="#9aa2b1">${spawnText}</text>`,
    )
    py += 30
    for (const p of teamPlayers) {
      const rp = resultById.get(p.userId)
      const [kills, deaths] = killsDeaths.get(p.userId) ?? [0, 0]
      const vehicles = p.models.map((m) => vehicleInfo(dict, m).name).join(', ')
      const deathsAt = events.kills.filter((k) => k.victimId === p.userId).map((k) => k.time)
      const fate = deathsAt.length > 0 ? `погиб ${fmtTime(Math.max(...deathsAt))}` : 'жив'
      const fateColor = deathsAt.length > 0 ? '#d98c8c' : '#9fd6a4'
      parts.push(
        `<rect x="${PX}" y="${py + 6}" width="20" height="20" rx="4" fill="${p.color}"/>`,
        `<text x="${PX + 32}" y="${py + 23}" font-family="${FONTS}" font-size="23" fill="#f2f4f7">${esc(trimTo(p.name, 18))}</text>`,
        `<text x="${PR}" y="${py + 23}" font-family="${FONTS}" font-size="21" font-weight="700" text-anchor="end" fill="#d7dce4">${kills}/${deaths}</text>`,
        `<text x="${PX + 32}" y="${py + playerSecondLineY}" font-family="${FONTS}" font-size="17" fill="#8f97a6">${esc(trimTo(vehicles, 27))}</text>`,
        `<text x="${PR}" y="${py + playerSecondLineY}" font-family="${FONTS}" font-size="17" text-anchor="end">` +
          (rp ? `<tspan fill="#8f97a6">${rp.score} очк. · </tspan>` : '') +
          `<tspan fill="${fateColor}">${fate}</tspan></text>`,
      )
      py += playerRowStep
    }
    if (teamPlayers.length === 0) {
      parts.push(
        `<text x="${PX}" y="${py + 20}" font-family="${FONTS}" font-size="18" fill="#5a616e">без траекторий в этом режиме</text>`,
      )
      py += 34
    }
    if (orderIndex < orderedTeams.length - 1) py += teamGap
  })

  // Обозначения — прижаты к низу панели, если осталось место
  const glyphColor = '#19c2c9'
  const symbols: [string, string][] = [
    [`<path d="M-11 4 C-5 -7, 3 9, 11 -2" fill="none" stroke="${glyphColor}" stroke-width="3" stroke-linecap="round"/>`, 'траектория'],
    [
      `<circle r="9" fill="#10130d" fill-opacity="0.74" stroke="${glyphColor}" stroke-width="2"/>` +
        `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">4</text>`,
      'минута боя',
    ],
    [`<circle r="9.5" fill="${glyphColor}" fill-opacity="0.26" stroke="${glyphColor}" stroke-width="1.6"/>`, 'стоянка и её время'],
    [`<line x1="-11" y1="3" x2="11" y2="-3" stroke="${glyphColor}" stroke-width="1.8" stroke-dasharray="5 4"/>`, 'выстрел убийцы'],
    [
      `<circle cy="-1" r="7" fill="${glyphColor}" stroke="#15181c" stroke-width="1.4"/>` +
        `<circle cx="-2.6" cy="-1.6" r="1.8" fill="#15181c"/><circle cx="2.6" cy="-1.6" r="1.8" fill="#15181c"/>` +
        `<rect x="-3.4" y="4.4" width="6.8" height="3.6" rx="1.4" fill="${glyphColor}" stroke="#15181c" stroke-width="1"/>`,
      'гибель (цвет — чей)',
    ],
    [causeBadge(0, 0, { icon: 'tank' }, '#8a919e').replace(/^<g transform="translate\(0 0\)">/, '<g>'), 'чем убит'],
    [`<circle r="6.5" fill="${glyphColor}" stroke="#10130d" stroke-width="1.8"/>`, 'жив в конце боя'],
  ]
  parts.push(
    `<line data-panel-legend="1" x1="${PX}" y1="${legendY}" x2="${PR}" y2="${legendY}" stroke="#2a2e35" stroke-width="1.5"/>`,
    `<text x="${PX}" y="${legendY + 30}" font-family="${FONTS}" font-size="19" font-weight="600" fill="#cfd4dc">Обозначения</text>`,
  )
  const colW = (PANEL_W - 60) / 2
  symbols.forEach(([glyph, text], i) => {
    const gx = PX + (i % 2) * colW + 12
    const gy = legendY + 58 + Math.floor(i / 2) * 34
    parts.push(
      `<g transform="translate(${gx} ${gy})">${glyph}</g>`,
      `<text x="${gx + 24}" y="${gy + 6}" font-family="${FONTS}" font-size="16.5" fill="#9aa2b1">${text}</text>`,
    )
  })

  parts.push('</svg>')
  return parts.join('\n')
}

// ---------- утилиты ----------

const r1 = (v: number): string => (Math.round(v * 10) / 10).toString()

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function trimTo(s: string, n: number): string {
  return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s
}

/** мс от начала боя → «м:сс» */
const fmtTime = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

function pluralRu(value: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(value) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

interface TeamSpawn {
  x: number
  z: number
  label: string
}

interface SpawnCluster {
  x: number
  z: number
}

interface PixelSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface SpawnLabelPlacement {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: PixelBox
}

/** Выбирает ближайшее к спавну место, которое не пересекают видимые маршруты. */
function placeSpawnLabel(
  spawnX: number,
  spawnY: number,
  text: string,
  routes: PixelSegment[],
  occupied: PixelBox[],
): SpawnLabelPlacement {
  const width = Math.max(64, [...text].length * 14 + 8)
  const candidates: { dx: number; dy: number; anchor: SpawnLabelPlacement['anchor'] }[] = [
    { dx: 28, dy: -24, anchor: 'start' },
    { dx: -28, dy: -24, anchor: 'end' },
    { dx: 28, dy: 38, anchor: 'start' },
    { dx: -28, dy: 38, anchor: 'end' },
    { dx: 0, dy: -44, anchor: 'middle' },
    { dx: 0, dy: 56, anchor: 'middle' },
    { dx: 54, dy: 8, anchor: 'start' },
    { dx: -54, dy: 8, anchor: 'end' },
  ]
  const placements = candidates.map((candidate): SpawnLabelPlacement => {
    let x = spawnX + candidate.dx
    const y = Math.max(38, Math.min(MAP_W - 14, spawnY + candidate.dy))
    let x0 = candidate.anchor === 'start' ? x : candidate.anchor === 'end' ? x - width : x - width / 2
    let x1 = x0 + width
    if (x0 < 12) {
      x += 12 - x0
      x0 = 12
      x1 = x0 + width
    }
    if (x1 > MAP_W - 12) {
      x -= x1 - (MAP_W - 12)
      x1 = MAP_W - 12
      x0 = x1 - width
    }
    return { x, y, anchor: candidate.anchor, box: { x0, y0: y - 27, x1, y1: y + 7 } }
  })
  const score = (placement: SpawnLabelPlacement): number => {
    const margin = 7
    const expanded = {
      x0: placement.box.x0 - margin,
      y0: placement.box.y0 - margin,
      x1: placement.box.x1 + margin,
      y1: placement.box.y1 + margin,
    }
    const routeHits = routes.filter((route) => segmentIntersectsBox(route, expanded)).length
    const labelHits = occupied.filter((box) => boxesOverlap(placement.box, box)).length
    return routeHits * 10_000 + labelHits * 20_000 + Math.hypot(placement.x - spawnX, placement.y - spawnY)
  }
  return placements.reduce((best, placement) => score(placement) < score(best) ? placement : best)
}

function boxesOverlap(a: PixelBox, b: PixelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
}

/** Liang–Barsky: пересекает ли отрезок прямоугольник. */
function segmentIntersectsBox(segment: PixelSegment, box: PixelBox): boolean {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  let from = 0
  let to = 1
  for (const [p, q] of [
    [-dx, segment.x1 - box.x0],
    [dx, box.x1 - segment.x1],
    [-dy, segment.y1 - box.y0],
    [dy, box.y1 - segment.y1],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const ratio = q / p
    if (p < 0) from = Math.max(from, ratio)
    else to = Math.min(to, ratio)
    if (from > to) return false
  }
  return true
}

/** Один или два спавна команды по началам всех её жизней в текущем режиме. */
function teamSpawnClusters(players: PlayerPaths[], half: number): SpawnCluster[] {
  const starts = players.flatMap((player) =>
    player.paths.flatMap((unit) => unit.path[0] ? [unit.path[0]] : []),
  )
  if (starts.length === 0) return []
  if (starts.length === 1) return [{ x: starts[0]!.x, z: starts[0]!.z }]

  let seedA = starts[0]!
  let seedB = starts[1]!
  let farthest = 0
  for (let i = 0; i < starts.length; i++) {
    for (let j = i + 1; j < starts.length; j++) {
      const distance = Math.hypot(starts[i]!.x - starts[j]!.x, starts[i]!.z - starts[j]!.z)
      if (distance > farthest) {
        farthest = distance
        seedA = starts[i]!
        seedB = starts[j]!
      }
    }
  }
  const center = (points: SpaceTime[]): SpawnCluster => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
  })
  if (farthest < half * 0.35) return [center(starts)]

  let a: SpawnCluster = { x: seedA.x, z: seedA.z }
  let b: SpawnCluster = { x: seedB.x, z: seedB.z }
  let groupA: SpaceTime[] = []
  let groupB: SpaceTime[] = []
  for (let iteration = 0; iteration < 5; iteration++) {
    groupA = []
    groupB = []
    for (const point of starts) {
      const da = Math.hypot(point.x - a.x, point.z - a.z)
      const db = Math.hypot(point.x - b.x, point.z - b.z)
      ;(da <= db ? groupA : groupB).push(point)
    }
    if (groupA.length === 0 || groupB.length === 0) return [center(starts)]
    a = center(groupA)
    b = center(groupB)
  }
  return Math.hypot(a.x - b.x, a.z - b.z) < half * 0.35 ? [center(starts)] : [a, b]
}

/** Douglas–Peucker: уменьшает SVG без заметного смещения линии на итоговой карте. */
function simplifyRoutePoints(points: PixelRoutePoint[], tolerance: number): PixelRoutePoint[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [fromIndex, toIndex] = stack.pop()!
    const from = points[fromIndex]!
    const to = points[toIndex]!
    let farthestIndex = -1
    let farthestDistance = tolerance
    for (let i = fromIndex + 1; i < toIndex; i++) {
      const distance = pointSegmentDistance(points[i]!, from, to)
      if (distance > farthestDistance) {
        farthestDistance = distance
        farthestIndex = i
      }
    }
    if (farthestIndex < 0) continue
    keep[farthestIndex] = 1
    stack.push([fromIndex, farthestIndex], [farthestIndex, toIndex])
  }

  return points.filter((_, index) => keep[index] === 1)
}

function pointSegmentDistance(point: PixelRoutePoint, from: PixelRoutePoint, to: PixelRoutePoint): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y)
  const projection = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * projection), point.y - (from.y + dy * projection))
}

function routeDistances(points: PixelRoutePoint[]): number[] {
  const distances = [0]
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const point = points[i]!
    distances.push(distances[i - 1]! + Math.hypot(point.x - previous.x, point.y - previous.y))
  }
  return distances
}

/** Проецирует исходное пересечение на упрощённую отображаемую линию. */
function routeDistanceAtPoint(route: RouteGeometry, x: number, y: number): number {
  let bestDistance = Infinity
  let bestRouteDistance = 0
  for (let i = 0; i + 1 < route.points.length; i++) {
    const from = route.points[i]!
    const to = route.points[i + 1]!
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSquared = dx * dx + dy * dy
    const projection = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared))
    const projectedX = from.x + dx * projection
    const projectedY = from.y + dy * projection
    const distance = Math.hypot(x - projectedX, y - projectedY)
    if (distance < bestDistance) {
      bestDistance = distance
      bestRouteDistance = route.distances[i]! + Math.sqrt(lengthSquared) * projection
    }
  }
  return bestRouteDistance
}

function routePath(points: PixelRoutePoint[]): string {
  const first = points[0]!
  return `M${r1(first.x)} ${r1(first.y)}` + points.slice(1).map((point) => `L${r1(point.x)} ${r1(point.y)}`).join('')
}

function routeEdges(routes: RouteGeometry[]): RouteEdge[] {
  const edges: RouteEdge[] = []
  for (const route of routes) {
    for (let i = 0; i + 1 < route.sourcePoints.length; i++) {
      const from = route.sourcePoints[i]!
      const to = route.sourcePoints[i + 1]!
      const length = Math.hypot(to.x - from.x, to.y - from.y)
      if (length < 0.25) continue
      edges.push({
        index: edges.length,
        route,
        from,
        to,
        length,
      })
    }
  }
  return edges
}

/**
 * Находит только видимые пересечения маршрутов через пространственную сетку.
 * Это заменяет квадратичное сравнение всех рёбер и не нарезает основной path.
 */
function routeCrossings(routes: RouteGeometry[]): RouteCrossing[] {
  const cellSize = 48
  const edges = routeEdges(routes)
  const cells = new Map<string, number[]>()
  const compared = new Set<string>()
  const crossings = new Map<string, RouteCrossing>()

  for (const edge of edges) {
    const minX = Math.max(0, Math.min(edge.from.x, edge.to.x))
    const maxX = Math.min(MAP_W, Math.max(edge.from.x, edge.to.x))
    const minY = Math.max(0, Math.min(edge.from.y, edge.to.y))
    const maxY = Math.min(MAP_W, Math.max(edge.from.y, edge.to.y))
    if (minX > maxX || minY > maxY) continue

    const keys: string[] = []
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x++) {
      for (let y = Math.floor(minY / cellSize); y <= Math.floor(maxY / cellSize); y++) keys.push(`${x}:${y}`)
    }

    for (const key of keys) {
      for (const otherIndex of cells.get(key) ?? []) {
        const other = edges[otherIndex]!
        const pairKey = other.index < edge.index ? `${other.index}:${edge.index}` : `${edge.index}:${other.index}`
        if (compared.has(pairKey)) continue
        compared.add(pairKey)
        if (other.route.playerId === edge.route.playerId) continue

        const intersection = segmentIntersection(other, edge)
        if (!intersection) continue
        const otherTime = other.from.time + (other.to.time - other.from.time) * intersection.first
        const edgeTime = edge.from.time + (edge.to.time - edge.from.time) * intersection.second
        if (Math.abs(otherTime - edgeTime) < 500) continue

        const laterEdge = otherTime > edgeTime ? other : edge
        const earlierEdge = otherTime > edgeTime ? edge : other
        const laterTime = Math.max(otherTime, edgeTime)
        if (laterEdge.route.baseOrder > earlierEdge.route.baseOrder) continue

        const routeA = Math.min(other.route.index, edge.route.index)
        const routeB = Math.max(other.route.index, edge.route.index)
        const crossingKey = `${routeA}:${routeB}:${Math.round(intersection.x / 8)}:${Math.round(intersection.y / 8)}`
        const crossing: RouteCrossing = {
          route: laterEdge.route,
          distance: routeDistanceAtPoint(laterEdge.route, intersection.x, intersection.y),
          time: laterTime,
        }
        const existing = crossings.get(crossingKey)
        if (!existing || crossing.time > existing.time) crossings.set(crossingKey, crossing)
      }
    }

    for (const key of keys) {
      const bucket = cells.get(key)
      if (bucket) bucket.push(edge.index)
      else cells.set(key, [edge.index])
    }
  }

  return [...crossings.values()].sort((a, b) => a.time - b.time || a.route.index - b.route.index)
}

function segmentIntersection(
  first: RouteEdge,
  second: RouteEdge,
): { x: number; y: number; first: number; second: number } | null {
  const rx = first.to.x - first.from.x
  const ry = first.to.y - first.from.y
  const sx = second.to.x - second.from.x
  const sy = second.to.y - second.from.y
  const denominator = rx * sy - ry * sx
  // Почти параллельные пути не получают мостики: на общей дороге они создавали бы новую «лесенку».
  if (Math.abs(denominator) / (first.length * second.length) < 0.2) return null
  const qx = second.from.x - first.from.x
  const qy = second.from.y - first.from.y
  const firstFraction = (qx * sy - qy * sx) / denominator
  const secondFraction = (qx * ry - qy * rx) / denominator
  const epsilon = 1e-6
  if (firstFraction < -epsilon || firstFraction > 1 + epsilon || secondFraction < -epsilon || secondFraction > 1 + epsilon) return null
  return {
    x: first.from.x + rx * firstFraction,
    y: first.from.y + ry * firstFraction,
    first: Math.max(0, Math.min(1, firstFraction)),
    second: Math.max(0, Math.min(1, secondFraction)),
  }
}

function routePointAtDistance(route: RouteGeometry, distance: number): PixelRoutePoint {
  const target = Math.max(0, Math.min(route.totalLength, distance))
  let low = 1
  let high = route.distances.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (route.distances[middle]! < target) low = middle + 1
    else high = middle
  }
  const edgeEnd = Math.max(1, low)
  const from = route.points[edgeEnd - 1]!
  const to = route.points[edgeEnd]!
  const start = route.distances[edgeEnd - 1]!
  const length = route.distances[edgeEnd]! - start
  const fraction = length > 0 ? (target - start) / length : 0
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
    time: from.time + (to.time - from.time) * fraction,
  }
}

/** Короткий участок цельной геометрии по обе стороны пересечения. */
function routeSlicePath(route: RouteGeometry, center: number, halfLength: number): string {
  const start = Math.max(0, center - halfLength)
  const end = Math.min(route.totalLength, center + halfLength)
  const points = [routePointAtDistance(route, start)]
  for (let i = 1; i + 1 < route.points.length; i++) {
    const distance = route.distances[i]!
    if (distance > start && distance < end) points.push(route.points[i]!)
  }
  points.push(routePointAtDistance(route, end))
  return routePath(points)
}

/** Редкие стрелки на достаточно длинном непрерывном участке маршрута. */
function directionArrows(
  points: PixelRoutePoint[],
): DirectionArrow[] {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i]!.x, point.y - points[i]!.y))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const count = total < 200 ? 0 : total < 520 ? 1 : total < 900 ? 2 : 3
  const arrows: DirectionArrow[] = []
  for (let n = 1; n <= count; n++) {
    const target = (total * n) / (count + 1)
    let walked = 0
    for (let i = 0; i < lengths.length; i++) {
      const length = lengths[i]!
      if (walked + length < target || length < 1) {
        walked += length
        continue
      }
      const from = points[i]!
      const to = points[i + 1]!
      const k = (target - walked) / length
      arrows.push({
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        angle: Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI,
      })
      break
    }
  }
  return arrows
}

/** Галочка направления как дополнительный subpath общего пути маршрута. */
function arrowSubpath(arrow: DirectionArrow): string {
  const angle = arrow.angle * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const point = (x: number, y: number): string =>
    `${r1(arrow.x + x * cos - y * sin)} ${r1(arrow.y + x * sin + y * cos)}`
  return `M${point(-8, -5)}L${point(2, 0)}L${point(-8, 5)}`
}

/** Медианный начальный спавн команды и его направление относительно центра карты. */
function teamSpawn(players: PlayerPaths[], cx: number, cz: number, half: number): TeamSpawn | null {
  const starts = players.flatMap((player) => {
    const first = player.paths
      .map((unit) => unit.path[0])
      .filter((point): point is SpaceTime => point !== undefined)
      .sort((a, b) => a.t - b.t)[0]
    return first ? [first] : []
  })
  if (starts.length === 0) return null

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  }
  const x = median(starts.map((point) => point.x))
  const z = median(starts.map((point) => point.z))
  const dx = (x - cx) / half
  const dz = (z - cz) / half
  if (Math.hypot(dx, dz) < 0.12) return { x, z, label: 'спавн в центре' }

  const sector = Math.round(Math.atan2(dz, dx) / (Math.PI / 4))
  const direction =
    sector === 0
      ? 'справа'
      : sector === 1
        ? 'сверху справа'
        : sector === 2
          ? 'сверху'
          : sector === 3
            ? 'сверху слева'
            : Math.abs(sector) === 4
              ? 'слева'
              : sector === -3
                ? 'снизу слева'
                : sector === -2
                  ? 'снизу'
                  : 'снизу справа'
  return { x, z, label: `спавн ${direction}` }
}

/** Шаг меток времени в минутах: не больше ~6 меток на траекторию */
function tickStepMinutes(durationMs: number): number {
  const minutes = durationMs / 60000
  return [2, 3, 5, 10, 15].find((s) => minutes / s <= 6) ?? 20
}

/**
 * Точки меток времени вдоль пути: раз в stepMs, позиция интерполируется
 * между соседними точками; разрывы (телепорт/пауза, как в splitSegments)
 * пропускаются.
 */
function timeTicks(path: SpaceTime[], stepMs: number): { x: number; z: number; minute: number; time: number }[] {
  const out: { x: number; z: number; minute: number; time: number }[] = []
  const start = path[0]!.t
  const end = path[path.length - 1]!.t
  let i = 0
  for (let t = Math.ceil(start / stepMs) * stepMs; t <= end; t += stepMs) {
    while (i + 1 < path.length && path[i + 1]!.t < t) i++
    const a = path[i]!
    const b = path[i + 1]
    if (!b) break
    if (b.t - a.t > 60000 || Math.hypot(b.x - a.x, b.z - a.z) > 400) continue
    const k = (t - a.t) / (b.t - a.t || 1)
    out.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, minute: Math.round(t / 60000), time: t })
  }
  return out
}

/**
 * Точка пути игрока в момент t (лерп между соседними записями): пауза
 * записи у стоящего юнита интерполируется корректно, телепорт (>400 м
 * между записями) — нет. null — момент вне путей или разрыв.
 */
function pointAtTime(paths: ReplayUnitPath[], t: number): SpaceTime | null {
  for (const u of paths) {
    const path = u.path
    if (t < path[0]!.t || t > path[path.length - 1]!.t) continue
    let i = 0
    while (i + 1 < path.length && path[i + 1]!.t < t) i++
    const a = path[i]!
    const b = path[i + 1] ?? a
    if (Math.hypot(b.x - a.x, b.z - a.z) > 400) return null
    const k = (t - a.t) / (b.t - a.t || 1)
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }
  }
  return null
}

/** Ближайшая по времени точка путей игрока */
function nearestPoint(paths: ReplayUnitPath[], t: number): SpaceTime | null {
  let best: SpaceTime | null = null
  let bestDt = Infinity
  for (const u of paths) {
    for (const p of u.path) {
      const dt = Math.abs(p.t - t)
      if (dt < bestDt) {
        bestDt = dt
        best = p
      }
    }
  }
  return bestDt < 60000 ? best : null
}

/** Авиация: путь после гибели — падающий остов, обрезаем по событию */
function truncateAtDeath(unit: ReplayUnitPath, events: ReplayEvents, userId: string): ReplayUnitPath {
  const start = unit.path[0]!.t
  const end = unit.path[unit.path.length - 1]!.t
  const death = events.kills.find((k) => k.victimId === userId && k.time >= start && k.time <= end)
  if (!death) return unit
  return { ...unit, path: unit.path.filter((p) => p.t <= death.time + 4000) }
}

/** Квадратные границы по точкам (+ опциональная стартовая область) */
function fitBounds(
  points: SpaceTime[],
  seed: { x0: number; z0: number; x1: number; z1: number } | null,
): { x0: number; z0: number; x1: number; z1: number } {
  let x0 = seed?.x0 ?? Infinity
  let z0 = seed?.z0 ?? Infinity
  let x1 = seed?.x1 ?? -Infinity
  let z1 = seed?.z1 ?? -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.z < z0) z0 = p.z
    if (p.z > z1) z1 = p.z
  }
  if (!Number.isFinite(x0)) {
    x0 = -1000
    z0 = -1000
    x1 = 1000
    z1 = 1000
  }
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const half = (Math.max(x1 - x0, z1 - z0) / 2 || 1000) * 1.06
  return { x0: cx - half, z0: cz - half, x1: cx + half, z1: cz + half }
}

/** Разрыв траектории на телепорте (респаун) или большой паузе */
function splitSegments(path: SpaceTime[]): SpaceTime[][] {
  const segments: SpaceTime[][] = []
  let cur: SpaceTime[] = []
  let prev: SpaceTime | null = null
  for (const p of path) {
    if (prev && (Math.hypot(p.x - prev.x, p.z - prev.z) > 400 || p.t - prev.t > 60000)) {
      if (cur.length >= 2) segments.push(cur)
      cur = []
    }
    cur.push(p)
    prev = p
  }
  if (cur.length >= 2) segments.push(cur)
  return segments
}

/** Позиция из события смерти годится, если она недалеко от конца пути */
function isNear(pos: SpaceTime, near: SpaceTime, radius = 600): boolean {
  return Math.hypot(pos.x - near.x, pos.z - near.z) < radius
}

function mostCommonTag(tags: string[]): string | null {
  const counts = new Map<string, number>()
  for (const t of tags) {
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** Стоянки: максимальные интервалы, где юнит не отходил от точки-якоря
 * дальше radius; длинный пропуск в записи при той же позиции — тоже
 * стоянка (GMSync может не слать точки неподвижного юнита) */
function findCamps(
  path: SpaceTime[],
  minMs = 60000,
  radius = 30,
): { x: number; z: number; durMs: number; time: number }[] {
  const out: { x: number; z: number; durMs: number; time: number }[] = []
  let i = 0
  while (i < path.length - 1) {
    const anchor = path[i]!
    let j = i
    while (j + 1 < path.length && Math.hypot(path[j + 1]!.x - anchor.x, path[j + 1]!.z - anchor.z) <= radius) {
      j++
    }
    const durMs = path[j]!.t - anchor.t
    if (durMs >= minMs) {
      let sx = 0
      let sz = 0
      for (let k = i; k <= j; k++) {
        sx += path[k]!.x
        sz += path[k]!.z
      }
      out.push({ x: sx / (j - i + 1), z: sz / (j - i + 1), durMs, time: path[j]!.t })
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

/** Череп в цвете погибшего */
function skullIcon(x: number, y: number, color: string): string {
  return (
    `<g transform="translate(${r1(x - 17)} ${r1(y - 17)}) scale(1.45)">` +
    `<circle cx="12" cy="11.5" r="11" fill="#15181c" fill-opacity="0.55"/>` +
    `<circle cx="12" cy="10" r="8.2" fill="${color}" stroke="#15181c" stroke-width="1.6"/>` +
    `<rect x="8" y="14.5" width="8" height="7" rx="2" fill="${color}" stroke="#15181c" stroke-width="1.2"/>` +
    `<circle cx="9" cy="10" r="2.1" fill="#15181c"/>` +
    `<circle cx="15" cy="10" r="2.1" fill="#15181c"/>` +
    `<rect x="10.4" y="16.5" width="1.4" height="3.5" fill="#15181c"/>` +
    `<rect x="13" y="16.5" width="1.4" height="3.5" fill="#15181c"/>` +
    `</g>`
  )
}

// ---------- причина смерти ----------

type DeathCause = { icon: 'tank' | 'plane' | 'heli' | 'aa' | 'crash' } | { label: string }

/** ЗУР зениток: отдельных файлов в датамайне нет, различаем по имени */
const SAM_RE =
  /zur|9m3\d|fim_?92|mim_?72|mim_?146|roland|rapier|type_?81|type_?91|starstreak|igla|stinger|aspide|crotale|santal|adats|vt1/i

/**
 * Чем убит: для авиации — тип ГСН ракеты (ИК/ПАРЛ/АРЛ из датамайна,
 * ЗУР по имени оружия зенитки), иначе — силуэт класса убийцы.
 * Без убийцы — «разбился». null — причину не определить.
 */
function deathCause(
  k: ReplayKill,
  mode: 'ground' | 'air',
  dict: VehicleDict,
  seekers: Map<string, MissileSeeker> | undefined,
): DeathCause | null {
  if (!k.killerId || k.killerId === k.victimId) return { icon: 'crash' }
  const killerCls = vehicleInfo(dict, modelId(k.killerModel)).cls
  if (mode === 'air') {
    const seeker = seekers?.get(k.weapon)
    if (seeker === 'ir') return { label: 'ИК' }
    if (seeker === 'sarh') return { label: 'ПАРЛ' }
    if (seeker === 'arh') return { label: 'АРЛ' }
    if (killerCls === 'AA' && SAM_RE.test(k.weapon)) return { label: 'ЗУР' }
  }
  switch (killerCls) {
    case 'T':
    case 'L':
      return { icon: 'tank' }
    case 'F':
      return { icon: 'plane' }
    case 'H':
      return { icon: 'heli' }
    case 'AA':
      return { icon: 'aa' }
    default:
      return null
  }
}

/** Белые силуэты значков причины смерти (в координатах ±10) */
const CAUSE_ICONS: Record<string, string> = {
  tank:
    `<rect x="-8.5" y="0.5" width="17" height="5.5" rx="2.6"/>` +
    `<rect x="-4.5" y="-4.8" width="7.5" height="4.4" rx="1.2"/>` +
    `<rect x="2.6" y="-3.8" width="7.6" height="1.8" rx="0.9"/>`,
  plane:
    `<path d="M0 -9.5 L2.3 -2.8 L9.5 2.6 L2.2 1.3 L1.7 6.2 L4.3 8.8 L-4.3 8.8 L-1.7 6.2 L-2.2 1.3 L-9.5 2.6 L-2.3 -2.8 Z"/>`,
  heli:
    `<rect x="-9" y="-5" width="18" height="2" rx="1"/>` +
    `<rect x="-1" y="-3.6" width="2" height="3"/>` +
    `<ellipse cx="-1.4" cy="2.2" rx="6" ry="3.8"/>` +
    `<rect x="3.4" y="1" width="6.6" height="1.8" rx="0.9"/>` +
    `<rect x="7.6" y="-1.6" width="1.8" height="3.4" rx="0.9"/>`,
  aa:
    `<rect x="-1.1" y="-10" width="2.2" height="9.5" rx="1" transform="rotate(38)"/>` +
    `<rect x="-1.1" y="-10" width="2.2" height="9.5" rx="1" transform="rotate(22)"/>` +
    `<circle cy="2.4" r="3.4"/>` +
    `<rect x="-7" y="3.6" width="14" height="3.4" rx="1.6"/>`,
  crash:
    `<path d="M0 -10 L2.4 -3.4 L8.4 -6.2 L4.2 -0.8 L10 1.8 L3.4 2.6 L4.8 9.4 L0 4.4 L-4.8 9.4 L-3.4 2.6 L-10 1.8 L-4.2 -0.8 L-8.4 -6.2 L-2.4 -3.4 Z"/>`,
}

/** Подпись техники убийцы под черепом — когда его нет на этой карте */
function killerLabel(x: number, y: number, text: string): string {
  const t = esc(text)
  const attrs = `x="${r1(x)}" y="${r1(y)}" font-family="${FONTS}" font-size="13.5" font-weight="700" text-anchor="middle"`
  return (
    `<text ${attrs} fill="none" stroke="#10130d" stroke-width="3.2">${t}</text>` +
    `<text ${attrs} fill="#e8ebf0">${t}</text>`
  )
}

/** Значок причины смерти у черепа; ободок — цвет убийцы */
function causeBadge(x: number, y: number, cause: DeathCause, ring: string): string {
  if ('icon' in cause) {
    return (
      `<g transform="translate(${r1(x)} ${r1(y)})">` +
      `<circle r="10.5" fill="#10130d" fill-opacity="0.88" stroke="${ring}" stroke-width="1.8"/>` +
      `<g transform="scale(0.72)" fill="#f2f4f7">${CAUSE_ICONS[cause.icon]}</g>` +
      `</g>`
    )
  }
  const w = 12 + cause.label.length * 7.2
  return (
    `<g transform="translate(${r1(x)} ${r1(y)})">` +
    `<rect x="${r1(-w / 2)}" y="-9" width="${r1(w)}" height="18" rx="8.5" fill="#10130d" fill-opacity="0.88" stroke="${ring}" stroke-width="1.8"/>` +
    `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">${cause.label}</text>` +
    `</g>`
  )
}
