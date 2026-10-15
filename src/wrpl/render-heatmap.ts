import { botText, type BotText, type Locale, type SpawnDirection } from '../i18n/index.js'
import type { MapImageViewport, MissileSeeker } from './battle-assets.js'
import type { MissionInfo } from './mission-info.js'
import type { ReplayEvents, ReplayKill, ReplayUnitPath, SpaceTime } from './replay-events.js'
import type { ReplayResults, WrplHeader } from './replay.js'
import { buildRosters, clanDisplayName, shownName, tagMarkup } from './render-battle.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'

/**
 * A battle heatmap in the style of Boris Stats: the players' tracks over the
 * map, each life's track named beside it; skulls in the victim's colour with a
 * cause-of-death badge (the killer's class silhouette: tank, plane, helicopter,
 * AA; for aircraft the missile's seeker: IR, SARH, ARH, SAM; a star is a
 * crash; the ring is the killer's colour; a tank's kill on the ground map has
 * none: its kill line shows it); dashed kill lines from killer to victim; long
 * stops with their duration; dots at the survivors' last positions; minute
 * marks along the tracks where they collide with nothing. Colours come in two
 * families (TEAM_ROUTE_COLORS), so a track's team reads from its hue, over a
 * muted map (MAP_SATURATION). On the right an information panel: map, mode and
 * date, the teams in the order of their sides on the map (winner, players with
 * kills and deaths, vehicles, score and time of death) and the legend.
 *
 * mode='ground': ground vehicles (GMSync); mode='air': aircraft (flight-model
 * packets). The ground map fills the frame (exactly the battle area); the air
 * view follows the tracks, with the battle area a small square in it. Without
 * the mission file the view follows the tracks.
 *
 * Strict layers, bottom to top: base → image → fallback grid → shade → battle
 * area border → spawn labels → routes → stops → stop durations → minute marks →
 * shot lines → shooter dots → marker callouts → survivor dots → skulls → causes
 * of death → vehicle labels → track names. Element types never share a layer;
 * instances of one type are sorted by time, later ones on top.
 *
 * Background: the mission's tactical map as the game draws it, built from the
 * game client (src/tactical-map; mission.area is then its view), else the
 * wt-tools snapshot of the mission's mode (ensureTacticalMap, exactly
 * battleArea), else a hand-placed screenshot data/maps/<level>.jpg stretched
 * over battleArea, else a dark grid. The air view's background is the game's
 * air map drawn for that view (HeatmapInput.airMap), with the ground map inset
 * at the battle area; without the client, the level map captured from the
 * game's port 8111 (data/maps/<level>.jpg + .map.json), if any.
 */

/** The map square's side in output pixels at 1× (the image is this plus PANEL_W wide). */
export const HEATMAP_MAP_SIZE = 1400
const MAP_W = HEATMAP_MAP_SIZE
/** The information panel's width, right of the map. */
const PANEL_W = 480

/**
 * Track colours, one family per team, so a track's team reads from its hue:
 * the image's own team (teamIndex ?? 0, whose spawn the game map draws blue)
 * takes the cool family, the other team the warm one. Picked by greedy max-min
 * OKLab ΔE within a family (the labels name the players) while every
 * cool/warm pair keeps ΔE ≥ 0.12 also under protan and deutan simulation
 * (Machado 2009); olive yellows and dark teals vanish on the khaki map. The
 * most distinct come first: they go to the top scorers.
 */
const TEAM_ROUTE_COLORS = [
  ['#457CFD', '#32D3EE', '#A57AFE', '#1C98A0', '#E1CDFE', '#93ADFE', '#05A3E9', '#A94BFC'],
  ['#FD2B33', '#FFD404', '#FD8706', '#FFE7C7', '#AD7C1D', '#FDAD97', '#DC631A', '#F3B01D'],
] as const
/** The saturation left to the map image: muted, it stays behind the tracks. */
const MAP_SATURATION = 0.5
const TEAM_SPAWN_COLORS = ['#17e6ec', '#fa2028'] as const
/** Временный переключатель точного crop/grid из capture:map. */
const CAPTURED_MAP_RENDERING_ENABLED = false

const FONTS = `Segoe UI, Segoe UI Symbol, Microsoft YaHei, Malgun Gothic, Yu Gothic UI, Arial, sans-serif`

export interface HeatmapInput {
  /** " [Domination #2] North Holland": the wt-tools snapshot is looked up by it. */
  missionName: string
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  dict: VehicleDict
  mission: MissionInfo | null
  mode: 'ground' | 'air'
  /** A roster index of buildRosters; without it both teams are drawn. */
  teamIndex?: number
  /** Seeker type by weapon id (cause-of-death icons). */
  seekers?: Map<string, MissileSeeker>
  /** The output PNG's scale; only changes how the map image is prepared for HD. */
  renderScale?: 1 | 2
  /** Air background settings; without them the defaults apply. */
  heatmapOptions?: Partial<HeatmapRenderOptions>
  /**
   * Air mode: the game's air map drawn for the scene's map square (src/tactical-map
   * composeTacticalMap over PreparedHeatmapScene.mapRect); it replaces the captured
   * level map, and the ground map stays inset at the battle area.
   */
  airMap?: { href: string; rect: { x0: number; z0: number; x1: number; z1: number } } | null
  /** The language of the image's text; English without it. */
  locale?: Locale
}

export interface HeatmapRenderOptions {
  airAutoZoom: boolean
  airShowGroundMap: boolean
  airShowAirfields: boolean
  airShowSpawns: boolean
  airPaddingPercent: number
}

const DEFAULT_HEATMAP_OPTIONS: HeatmapRenderOptions = {
  airAutoZoom: true,
  airShowGroundMap: true,
  airShowAirfields: true,
  airShowSpawns: true,
  airPaddingPercent: 6,
}

interface PlayerPaths {
  userId: string
  name: string
  clanTag: string
  /** The player's place among the team's players drawn in this mode: picks the colour. */
  slot: number
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
  life: number
  points: PixelRoutePoint[]
  sourcePoints: PixelRoutePoint[]
  distances: number[]
  totalLength: number
  startTime: number
  endTime: number
  arrows: DirectionArrow[]
}

export interface RouteStrokeDrawing {
  baseOrder: number
  color: string
  d: string
  attrs: string
  directionArrows: number
}

export interface RouteSegment {
  from: PixelRoutePoint
  to: PixelRoutePoint
  length: number
}

interface RouteEdge extends RouteSegment {
  index: number
  route: RouteGeometry
}

interface RouteCrossing {
  route: RouteGeometry
  distance: number
  time: number
}

interface PreparedRoutePart {
  /** The unit's index in PlayerPaths.paths: one name label per life. */
  life: number
  points: PixelRoutePoint[]
  sourcePoints: PixelRoutePoint[]
  distances: number[]
  totalLength: number
  startTime: number
  endTime: number
  arrows: DirectionArrow[]
}

interface PlayerPathRange {
  from: number
  to: number
  last: SpaceTime
}

export interface PreparedCamp {
  x: number
  y: number
  durMs: number
  time: number
}

interface PreparedMinuteMark {
  x: number
  y: number
  minute: number
  time: number
}

interface ClanUav {
  unit: ReplayUnitPath
  owner: PlayerPaths
}

/**
 * Неизменяемая тяжёлая часть heatmap. Живёт только внутри одной worker-задачи
 * и повторно используется общей и двумя командными картами одного режима.
 */
export interface PreparedHeatmapScene {
  mode: 'ground' | 'air'
  heatmapOptions: HeatmapRenderOptions
  rosters: ReturnType<typeof buildRosters>
  allPlayers: PlayerPaths[]
  playersByTeam: [PlayerPaths[], PlayerPaths[]]
  playerById: Map<string, PlayerPaths>
  resultById: Map<string, ReturnType<typeof buildRosters>[number][number]>
  killsByVictim: Map<string, ReplayKill[]>
  killsByKiller: Map<string, ReplayKill[]>
  killsDeaths: Map<string, [number, number]>
  pathRangesByPlayer: Map<PlayerPaths, PlayerPathRange[]>
  preparedRoutesByPlayer: Map<PlayerPaths, PreparedRoutePart[]>
  visibleSegmentsByPlayer: Map<PlayerPaths, PixelSegment[]>
  campsByPlayer: Map<PlayerPaths, PreparedCamp[]>
  minuteMarksByPlayer: Map<PlayerPaths, PreparedMinuteMark[]>
  clanUavsByTeam: [ClanUav[], ClanUav[]]
  teamSpawnClustersByTeam: ReturnType<typeof teamSpawnClusters>[]
  teamSpawns: ReturnType<typeof teamSpawn>[]
  fallbackImageWorldBounds: MapImageViewport['imageWorldBounds']
  fullBleed: boolean
  px: (x: number) => number
  pz: (z: number) => number
  /** The world rect of the whole map square (0…MAP_W in both axes): an air map drawn for it fills the square. */
  mapRect: { x0: number; z0: number; x1: number; z1: number }
  endTime: number
}

/** "tankModels/ussr_2s38" → "ussr_2s38" (ключ словаря техники) */
const modelId = (model: string): string => model.replace(/^.*\//, '')

export function prepareHeatmapScene(
  input: HeatmapInput,
  tacticalMap: string | null = null,
  fallbackMapViewport?: MapImageViewport,
): PreparedHeatmapScene {
  const { events, results, mission, mode } = input
  const heatmapOptions = { ...DEFAULT_HEATMAP_OPTIONS, ...input.heatmapOptions }
  const airPaddingPercent = Number.isFinite(heatmapOptions.airPaddingPercent)
    ? Math.max(0, Math.min(50, heatmapOptions.airPaddingPercent))
    : DEFAULT_HEATMAP_OPTIONS.airPaddingPercent

  const killsByVictim = new Map<string, ReplayKill[]>()
  const killsByKiller = new Map<string, ReplayKill[]>()
  const killsDeaths = new Map<string, [number, number]>()
  for (const kill of events.kills) {
    if (kill.victimId) {
      const victims = killsByVictim.get(kill.victimId)
      if (victims) victims.push(kill)
      else killsByVictim.set(kill.victimId, [kill])
      const stats = killsDeaths.get(kill.victimId) ?? [0, 0]
      stats[1]++
      killsDeaths.set(kill.victimId, stats)
    }
    if (kill.killerId) {
      const killers = killsByKiller.get(kill.killerId)
      if (killers) killers.push(kill)
      else killsByKiller.set(kill.killerId, [kill])
      if (kill.killerId !== kill.victimId) {
        const stats = killsDeaths.get(kill.killerId) ?? [0, 0]
        stats[0]++
        killsDeaths.set(kill.killerId, stats)
      }
    }
  }
  for (const kills of killsByVictim.values()) kills.sort((a, b) => a.time - b.time)
  for (const kills of killsByKiller.values()) kills.sort((a, b) => a.time - b.time)

  const unitsByPlayer = new Map<string, ReplayUnitPath[]>()
  for (const unit of events.units) {
    if (unit.path.length < 2) continue
    const key = `${unit.source}\u0000${unit.userId}`
    const units = unitsByPlayer.get(key)
    if (units) units.push(unit)
    else unitsByPlayer.set(key, [unit])
  }

  const rosters = buildRosters(results)
  const allPlayers: PlayerPaths[] = []
  const playersByTeam: [PlayerPaths[], PlayerPaths[]] = [[], []]
  const allPoints: SpaceTime[] = []
  let latestPointTime = 1
  const slots = new Map<number, number>()
  rosters.forEach((roster, ti) => {
    roster.forEach((player) => {
      const candidates = unitsByPlayer.get(`${mode}\u0000${player.userId}`) ?? []
      const paths = (mode === 'air'
        ? candidates.map((unit) => truncateAtDeath(unit, killsByVictim.get(player.userId) ?? []))
        : candidates
      ).filter((unit) => unit.path.length >= 2)
      if (paths.length === 0) return
      const slot = slots.get(ti) ?? 0
      slots.set(ti, slot + 1)
      const preparedPlayer: PlayerPaths = {
        userId: player.userId,
        name: shownName(player, botText(input.locale).image.bot).replace(/@(psn|live|epic)$/i, ''),
        clanTag: player.clanTag,
        slot,
        models: [...new Set(paths.map((unit) => modelId(unit.model)))],
        paths,
        team: ti,
      }
      allPlayers.push(preparedPlayer)
      if (ti === 0 || ti === 1) playersByTeam[ti].push(preparedPlayer)
      for (const unit of paths) {
        for (const point of unit.path) {
          allPoints.push(point)
          if (point.t > latestPointTime) latestPointTime = point.t
        }
      }
    })
  })
  const endTime = Math.max(events.endTime, latestPointTime, 1)

  const fallbackWorldBounds = fallbackMapViewport?.worldBounds
  const fallbackImageWorldBounds = fallbackMapViewport?.imageWorldBounds
  const visibleGroundArea = mode === 'air' && !heatmapOptions.airShowGroundMap
    ? null
    : (mission?.area ?? null)
  let bounds = mode === 'ground'
    ? ((tacticalMap ? mission?.area : fallbackWorldBounds) ?? mission?.area ?? null)
    : (heatmapOptions.airAutoZoom
        ? visibleGroundArea
        : (fallbackImageWorldBounds ?? visibleGroundArea))
  const fullBleed = (mode === 'ground' && bounds !== null) ||
    (mode === 'air' && !heatmapOptions.airAutoZoom && bounds !== null)
  if (!fullBleed) {
    bounds = fitBounds(allPoints, bounds, mode === 'air' ? 1 + airPaddingPercent / 100 : 1.06)
  }
  const cx = (bounds!.x0 + bounds!.x1) / 2
  const cz = (bounds!.z0 + bounds!.z1) / 2
  const half = Math.max(bounds!.x1 - bounds!.x0, bounds!.z1 - bounds!.z0) / 2 || 1000
  const view = fullBleed ? 1 : 0.94
  const px = (x: number): number => ((x - cx) / half) * (MAP_W / 2) * view + MAP_W / 2
  const pz = (z: number): number => MAP_W / 2 - ((z - cz) / half) * (MAP_W / 2) * view
  const mapRect = { x0: cx - half / view, z0: cz - half / view, x1: cx + half / view, z1: cz + half / view }

  const preparedRoutesByPlayer = new Map<PlayerPaths, PreparedRoutePart[]>()
  const visibleSegmentsByPlayer = new Map<PlayerPaths, PixelSegment[]>()
  const pathRangesByPlayer = new Map<PlayerPaths, PlayerPathRange[]>()
  const campsByPlayer = new Map<PlayerPaths, PreparedCamp[]>()
  const minuteMarksByPlayer = new Map<PlayerPaths, PreparedMinuteMark[]>()
  const minuteStepMs = tickStepMinutes(endTime) * 60000
  for (const player of allPlayers) {
    const routeParts: PreparedRoutePart[] = []
    const visibleSegments: PixelSegment[] = []
    const ranges: PlayerPathRange[] = []
    const camps: PreparedCamp[] = []
    const minuteMarks: PreparedMinuteMark[] = []
    const playerDeaths = killsByVictim.get(player.userId) ?? []
    for (const [life, unit] of player.paths.entries()) {
      ranges.push({
        from: unit.path[0]!.t - 5000,
        to: unit.path[unit.path.length - 1]!.t + 45000,
        last: unit.path[unit.path.length - 1]!,
      })
      for (const segment of splitSegments(unit.path)) {
        const sourcePoints = segment.map((point) => ({ x: px(point.x), y: pz(point.z), time: point.t }))
        for (let i = 1; i < sourcePoints.length; i++) {
          const from = sourcePoints[i - 1]!
          const to = sourcePoints[i]!
          visibleSegments.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
        }
        const points = simplifyRoutePoints(sourcePoints, 1)
        const distances = routeDistances(points)
        routeParts.push({
          life,
          points,
          sourcePoints,
          distances,
          totalLength: distances[distances.length - 1] ?? 0,
          startTime: segment[0]!.t,
          endTime: segment[segment.length - 1]!.t,
          arrows: directionArrows(points),
        })
      }

      if (mode === 'ground') {
        const start = unit.path[0]!.t
        const end = unit.path[unit.path.length - 1]!.t
        const death = firstKillInRange(playerDeaths, start - 5000, end + 45000)
        const alive = death === null ? unit.path : unit.path.filter((point) => point.t <= death.time)
        if (alive.length >= 2) {
          for (const camp of findCamps(alive)) {
            camps.push({
              x: px(camp.x),
              y: pz(camp.z),
              durMs: camp.durMs,
              time: camp.time,
            })
          }
        }
      }

      let lastX = -1e9
      let lastY = -1e9
      for (const tick of timeTicks(unit.path, minuteStepMs)) {
        const x = px(tick.x)
        const y = pz(tick.z)
        if (Math.hypot(x - lastX, y - lastY) < 27) continue
        lastX = x
        lastY = y
        minuteMarks.push({ x, y, minute: tick.minute, time: tick.time })
      }
    }
    preparedRoutesByPlayer.set(player, routeParts)
    visibleSegmentsByPlayer.set(player, visibleSegments)
    pathRangesByPlayer.set(player, ranges)
    campsByPlayer.set(player, mergeNearbyCamps(camps))
    minuteMarksByPlayer.set(player, minuteMarks)
  }

  const playerById = new Map(allPlayers.map((player) => [player.userId, player]))
  const resultById = new Map(rosters.flat().map((player) => [player.userId, player]))
  const teamSpawnClustersByTeam = playersByTeam.map((players) => teamSpawnClusters(players, half))
  const teamSpawns = playersByTeam.map((players) => teamSpawn(players, cx, cz, half))
  const clanUavsByTeam: [ClanUav[], ClanUav[]] = [[], []]
  if (mode === 'ground') {
    const anonymousUavs = events.units.filter((unit) =>
      unit.source === 'air' &&
      unit.userId === '' &&
      unit.path.length >= 2 &&
      /(?:ucav|uav|drone|recon)/i.test(modelId(unit.model)),
    )
    for (const team of [0, 1] as const) {
      for (const unit of anonymousUavs) {
        const start = unit.path[0]!
        let owner: { player: PlayerPaths; distance: number } | null = null
        for (const player of playersByTeam[team]) {
          const point = pointAtTime(player.paths, start.t) ?? nearestPoint(player.paths, start.t)
          if (!point) continue
          const distance = Math.hypot(point.x - start.x, point.z - start.z)
          if (!owner || distance < owner.distance) owner = { player, distance }
        }
        if (owner && owner.distance <= 180) clanUavsByTeam[team].push({ unit, owner: owner.player })
      }
    }
  }

  return {
    mode,
    heatmapOptions,
    rosters,
    allPlayers,
    playersByTeam,
    playerById,
    resultById,
    killsByVictim,
    killsByKiller,
    killsDeaths,
    pathRangesByPlayer,
    preparedRoutesByPlayer,
    visibleSegmentsByPlayer,
    campsByPlayer,
    minuteMarksByPlayer,
    clanUavsByTeam,
    teamSpawnClustersByTeam,
    teamSpawns,
    fallbackImageWorldBounds,
    fullBleed,
    px,
    pz,
    mapRect,
    endTime,
  }
}

/**
 * Whether an air heatmap insets the ground map at the battle area: the air map
 * drawn under it then leaves out its own tank bases and zones there.
 */
export function groundMapInset(
  scene: Pick<PreparedHeatmapScene, 'heatmapOptions'>,
  tacticalMap: string | null,
  mission: MissionInfo | null,
): boolean {
  return scene.heatmapOptions.airShowGroundMap && tacticalMap !== null && Boolean(mission?.area)
}

export function buildHeatmapSvg(
  input: HeatmapInput,
  gameFont = false,
  tacticalMap: string | null = null,
  fallbackMap: string | null = null,
  fallbackMapViewport?: MapImageViewport,
  mapIconFont = false,
  capturedMapRendering = CAPTURED_MAP_RENDERING_ENABLED,
  preparedScene?: PreparedHeatmapScene,
): string {
  const { events, dict, mission, mode, seekers, teamIndex } = input
  const t = botText(input.locale)
  const scene = preparedScene ?? prepareHeatmapScene(input, tacticalMap, fallbackMapViewport)
  if (scene.mode !== mode) throw new Error(`a ${scene.mode} PreparedHeatmapScene cannot draw the ${mode} map`)
  const {
    heatmapOptions,
    rosters,
    allPlayers,
    playersByTeam,
    playerById,
    resultById,
    killsByVictim,
    killsByKiller,
    killsDeaths,
    pathRangesByPlayer,
    preparedRoutesByPlayer,
    visibleSegmentsByPlayer,
    campsByPlayer,
    minuteMarksByPlayer,
    clanUavsByTeam,
    teamSpawnClustersByTeam,
    teamSpawns,
    fallbackImageWorldBounds,
    fullBleed,
    px,
    pz,
    endTime,
  } = scene
  const players = teamIndex === undefined ? allPlayers : (playersByTeam[teamIndex] ?? [])
  const ownTeam = teamIndex ?? 0
  const colorOf = (player: PlayerPaths): string => {
    const family = TEAM_ROUTE_COLORS[player.team === ownTeam ? 0 : 1]
    return family[player.slot % family.length]!
  }
  const clanUavs = mode === 'ground' && teamIndex !== undefined
    ? (clanUavsByTeam[teamIndex] ?? [])
    : []
  const renderScale = input.renderScale ?? 1
  // Координатная привязка нужна и для готового игрового скриншота. Отключатель ниже
  // убирает только повторную обрезку, сетку и значки новой прорисовки.
  if (!capturedMapRendering) {
    fallbackMapViewport = undefined
    mapIconFont = false
  }

  const W = MAP_W + PANEL_W
  const H = MAP_W

  const parts: string[] = []
  parts.push(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">`)
  // The map image is muted, so the tracks keep the strongest colours; at 2× it is also sharpened.
  parts.push(
    `<defs><filter id="map-tone" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">` +
      (renderScale === 2
        ? `<feConvolveMatrix order="3" kernelMatrix="0 -0.12 0 -0.12 1.48 -0.12 0 -0.12 0" divisor="1" edgeMode="duplicate" preserveAlpha="true"/>`
        : '') +
      `<feColorMatrix type="saturate" values="${MAP_SATURATION}"/>` +
      `</filter></defs>`,
  )
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

  // On the ground the map covers the battle area. In the air the air map is the background (the
  // game's, drawn for this view, else the level map captured from port 8111), and the ground map
  // stays inset at the battle area.
  const mapImageAttrs = renderScale === 2
    ? ` image-rendering="optimizeQuality" filter="url(#map-tone)"`
    : ` filter="url(#map-tone)"`
  pushMapLayer(1, 'base', [`<rect width="${MAP_W}" height="${MAP_W}" fill="#3c4034"/>`])
  const mapImages: string[] = []
  const shades: string[] = []
  const airMapObjects: string[] = []
  const gameAirMap = mode === 'air' ? input.airMap ?? null : null
  const airRect = gameAirMap?.rect ?? (fallbackMap ? fallbackImageWorldBounds : undefined)
  const airBackground = mode === 'air' && airRect
  if (airBackground) {
    const imageX = px(airRect.x0)
    const imageY = pz(airRect.z1)
    const imageWidth = px(airRect.x1) - imageX
    const imageHeight = pz(airRect.z0) - imageY
    mapImages.push(
      `<image data-map-role="${gameAirMap ? 'air-map' : 'air-background'}" x="${r1(imageX)}" y="${r1(imageY)}" width="${r1(imageWidth)}" height="${r1(imageHeight)}" preserveAspectRatio="none"${mapImageAttrs} href="${gameAirMap?.href ?? fallbackMap}"/>`,
    )
    shades.push(
      `<rect x="${r1(imageX)}" y="${r1(imageY)}" width="${r1(imageWidth)}" height="${r1(imageHeight)}" fill="#0a0e14" fill-opacity="0.18"/>`,
    )
    if (groundMapInset(scene, tacticalMap, mission) && mission?.area) {
      const a = mission.area
      const tacticalX = px(a.x0)
      const tacticalY = pz(a.z1)
      mapImages.push(
        `<image data-map-role="tactical-overlay" x="${r1(tacticalX)}" y="${r1(tacticalY)}" width="${r1(px(a.x1) - tacticalX)}" height="${r1(pz(a.z0) - tacticalY)}" preserveAspectRatio="none"${mapImageAttrs} href="${tacticalMap}"/>`,
      )
    }
    // The game's air map draws its own airfields and air spawns.
    if (capturedMapRendering && !gameAirMap) {
      for (const [index, airfield] of (
        heatmapOptions.airShowAirfields ? (fallbackMapViewport?.airfields ?? []) : []
      ).entries()) {
        const x1 = imageX + airfield.sx * imageWidth
        const y1 = imageY + airfield.sy * imageHeight
        const x2 = imageX + airfield.ex * imageWidth
        const y2 = imageY + airfield.ey * imageHeight
        airMapObjects.push(
          `<g data-airfield="${index}">` +
            `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="#10130d" stroke-opacity="0.8" stroke-width="8" stroke-linecap="round"/>` +
            `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${airfield.color}" stroke-opacity="0.82" stroke-width="4" stroke-linecap="round"/>` +
          `</g>`,
        )
      }
      for (const [index, spawn] of (
        heatmapOptions.airShowSpawns ? (fallbackMapViewport?.airSpawns ?? []) : []
      ).entries()) {
        const x = imageX + spawn.x * imageWidth
        const y = imageY + spawn.y * imageHeight
        airMapObjects.push(
          `<g data-air-spawn="${index}" transform="translate(${r1(x)} ${r1(y)})">` +
            `<circle r="11" fill="#10130d" fill-opacity="0.84" stroke="${spawn.color}" stroke-width="2"/>` +
            `<path d="M0 -7L2 -2L8 1L2 2L1 7L-1 7L-2 2L-8 1L-2 -2Z" fill="${spawn.color}"/>` +
          `</g>`,
        )
      }
    }
  } else {
    const mapImage = tacticalMap ?? fallbackMap
    const mapViewport = tacticalMap ? undefined : fallbackMapViewport
    if (mapImage && (mission?.area || mapViewport)) {
      const a = mission?.area
      const ix = mapViewport ? 0 : px(a!.x0)
      const iy = mapViewport ? 0 : pz(a!.z1)
      const iw = mapViewport ? MAP_W : px(a!.x1) - ix
      const ih = mapViewport ? MAP_W : pz(a!.z0) - iy
      if (mapViewport) {
        const crop = mapViewport
        const imageX = ix - (crop.x / crop.width) * iw
        const imageY = iy - (crop.y / crop.height) * ih
        const imageWidth = iw / crop.width
        const imageHeight = ih / crop.height
        mapImages.push(
          `<defs><clipPath id="fallback-map-viewport"><rect x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}"/></clipPath></defs>`,
          `<image data-map-viewport="${r1(crop.x)} ${r1(crop.y)} ${r1(crop.width)} ${r1(crop.height)}" x="${r1(imageX)}" y="${r1(imageY)}" width="${r1(imageWidth)}" height="${r1(imageHeight)}" preserveAspectRatio="none" clip-path="url(#fallback-map-viewport)"${mapImageAttrs} href="${mapImage}"/>`,
        )
      } else {
        mapImages.push(
          `<image x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" preserveAspectRatio="none"${mapImageAttrs} href="${mapImage}"/>`,
        )
      }
      shades.push(
        `<rect x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" fill="#0a0e14" fill-opacity="0.18"/>`,
      )
      if (mapViewport?.gridStepX && mapViewport.gridStepY) {
        pushMapLayer(5, 'coordinate-grid', coordinateGrid(
          ix,
          iy,
          iw,
          ih,
          mapViewport.gridStepX,
          mapViewport.gridStepY,
          mapViewport.gridStepMeters,
        ))
      }
    } else if (mapImage) {
      mapImages.push(
        `<image x="0" y="0" width="${MAP_W}" height="${MAP_W}" preserveAspectRatio="xMidYMid slice"${mapImageAttrs} href="${mapImage}"/>`,
      )
    }
  }
  pushMapLayer(2, 'map-image', mapImages)
  pushMapLayer(4, 'readability-shade', shades)
  pushMapLayer(5, 'air-objects', airMapObjects)
  if (mapImages.length === 0) {
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
  if (mission?.area && !fullBleed && (mode === 'ground' || heatmapOptions.airShowGroundMap)) {
    const a = mission.area
    const fx = px(a.x0)
    const fy = pz(a.z1)
    pushMapLayer(6, 'battle-area', [
      `<rect x="${r1(fx)}" y="${r1(fy)}" width="${r1(px(a.x1) - fx)}" height="${r1(pz(a.z0) - fy)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.5" stroke-dasharray="14 10"/>`,
    ])
  }

  const hasReplayZoneFallback =
    events.zones.length > 0 && !fallbackMapViewport?.captureZones?.length && !mission?.zones?.length
  if (mode === 'ground' && capturedMapRendering && (!tacticalMap || hasReplayZoneFallback)) {
    const captureZones = fallbackMapViewport?.captureZones?.length
      ? fallbackMapViewport.captureZones.map((zone) =>
          captureZoneMarker(zone.x * MAP_W, zone.y * MAP_W, zone.letter, mapIconFont))
      : mission?.zones?.length
        ? mission.zones.map((zone) => captureZoneMarker(px(zone.x), pz(zone.z), zone.letter, mapIconFont))
        : events.zones.map((zone, index) =>
            captureZoneMarker(px(zone.x), pz(zone.z), String.fromCharCode(65 + index), mapIconFont),
          )
    pushMapLayer(7, 'capture-zones', captureZones)
  }

  // По началам всех жизней находим один или два спавна команды. Подпись остаётся
  // нижним слоем, но выбирает свободную сторону спавна без видимых маршрутов.
  const visibleRouteSegments: PixelSegment[] = players.flatMap(
    (player) => visibleSegmentsByPlayer.get(player) ?? [],
  )
  if (mode === 'ground' && capturedMapRendering) {
    const spawnMarkers = !tacticalMap && fallbackMapViewport?.groundSpawns?.length
      ? fallbackMapViewport.groundSpawns.map((spawn) => {
          const x = spawn.x * MAP_W
          const y = spawn.y * MAP_W
          const nearestTeam = teamSpawnClustersByTeam
            .map((clusters, ti) => ({
              ti,
              distance: clusters.length === 0 ? Infinity : Math.min(...clusters.map((cluster) =>
                Math.hypot(px(cluster.x) - x, pz(cluster.z) - y),
              )),
            }))
            .sort((a, b) => a.distance - b.distance)[0]?.ti ?? 0
          return teamSpawnMarker(x, y, nearestTeam, mapIconFont)
        })
      : teamSpawnClustersByTeam.flatMap((spawns, ti) =>
          spawns.map((spawn) => teamSpawnMarker(px(spawn.x), pz(spawn.z), ti, mapIconFont)),
        )
    pushMapLayer(8, 'team-spawns', spawnMarkers)
  }
  const occupiedSpawnLabels: PixelBox[] = []
  const spawnLabels: string[] = []
  for (const ti of [0, 1]) {
    const roster = rosters[ti]
    if (!roster) continue
    const rawClan = mostCommonTag(roster.map((player) => player.clanTag))
    const clan = rawClan ? clanDisplayName(rawClan) : t.battle.team(roster[0]?.team ?? ti + 1)
    for (const spawn of teamSpawnClustersByTeam[ti] ?? []) {
      const placement = placeSpawnLabel(px(spawn.x), pz(spawn.z), clan, visibleRouteSegments, occupiedSpawnLabels)
      occupiedSpawnLabels.push(placement.box)
      const attrs = `data-spawn-label="${ti}" x="${r1(placement.x)}" y="${r1(placement.y)}" text-anchor="${placement.anchor}" font-family="${FONTS}" font-size="24" font-weight="700"`
      spawnLabels.push(
        `<text ${attrs} fill="none" stroke="#10130d" stroke-width="5" stroke-opacity="0.72">${esc(clan)}</text>`,
        `<text ${attrs} fill="#f2f4f7" fill-opacity="0.68">${esc(clan)}</text>`,
      )
    }
  }
  pushMapLayer(9, 'spawn-labels', spawnLabels)

  // Непрерывный маршрут и его стрелки остаются одним SVG path. Маршруты
  // сортируются по времени начала, а редкие локальные мостики в пересечениях
  // показывают, кто проехал через конкретную точку позже.
  const routes: RouteGeometry[] = []
  let routeIndex = 0
  for (const p of players) {
    for (const route of preparedRoutesByPlayer.get(p) ?? []) {
      routes.push({
        index: routeIndex++,
        baseOrder: 0,
        playerId: p.userId,
        color: colorOf(p),
        ...route,
      })
    }
  }
  routes.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.index - b.index)
  routes.forEach((route, index) => { route.baseOrder = index })
  const routeDrawings = routes.map((route) => {
    const d = routePath(route.points) + route.arrows.map(arrowSubpath).join('')
    const attrs = `data-route-player="${esc(route.playerId)}" data-route-start-time="${Math.round(route.startTime)}" data-route-end-time="${Math.round(route.endTime)}" data-route-points="${route.points.length}" data-route-source-points="${route.sourcePoints.length}"`
    return { route, d, attrs }
  })

  // БПЛА — отдельный, более спокойный слой командной наземной карты: зона
  // наблюдения, тонкий пунктир цвета владельца и отметка запуска. Обычные
  // маршруты остаются выше, поэтому разведка не перекрывает движение техники.
  const uavAreas: TimedSvg[] = []
  const uavPaths: TimedSvg[] = []
  const uavStarts: TimedSvg[] = []
  for (const { unit, owner } of clanUavs) {
    const points = simplifyRoutePoints(
      unit.path.map((point) => ({ x: px(point.x), y: pz(point.z), time: point.t })),
      1,
    )
    if (points.length < 2) continue
    const start = points[0]!
    const last = points[points.length - 1]!
    const d = routePath(points)
    const color = colorOf(owner)
    uavAreas.push(timed(
      last.time,
      `<circle data-uav-observation="1" cx="${r1(last.x)}" cy="${r1(last.y)}" r="22" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-opacity="0.56" stroke-width="1.5" stroke-dasharray="5 4"/>`,
    ))
    uavPaths.push(timed(
      start.time,
      `<path data-uav-route="1" data-uav-owner="${esc(owner.userId)}" d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.82" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 5"/>`,
    ))
    uavStarts.push(timed(
      start.time,
      `<g data-uav-start="1" transform="translate(${r1(start.x)} ${r1(start.y)})">` +
        `<circle r="6" fill="#10130d" fill-opacity="0.82" stroke="${color}" stroke-width="2"/>` +
        `<path d="M-3 0H3M0-3V3" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>` +
        `</g>`,
    ))
  }
  pushMapLayer(10, 'uav-observation', chronological(uavAreas))
  pushMapLayer(11, 'uav-routes', chronological(uavPaths))
  pushMapLayer(12, 'uav-starts', chronological(uavStarts))

  const routeParts = routeStrokeParts(routeDrawings.map(({ route, d, attrs }) => ({
    baseOrder: route.baseOrder,
    color: route.color,
    d,
    attrs,
    directionArrows: route.arrows.length,
  })))
  const crossingParts = routeCrossings(routes).map((crossing) => {
    const d = routeSlicePath(crossing.route, crossing.distance, 10)
    return timed(
      crossing.time,
      `<g data-route-crossing="1" data-route-player="${esc(crossing.route.playerId)}" data-crossing-time="${Math.round(crossing.time)}">` +
        `<path data-route-crossing-layer="color" d="${d}" fill="none" stroke="${crossing.route.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
        `</g>`,
    )
  })
  pushMapLayer(13, 'routes', [...routeParts, ...chronological(crossingParts)])

  // Stops (ground only): where a unit stood over a minute, a disc in the
  // player's colour growing with the stop's length; its "m:ss" label is placed
  // once the markers it must avoid are known.
  const campAreas: TimedSvg[] = []
  const camps: { x: number; y: number; r: number; text: string; time: number }[] = []
  if (mode === 'ground') {
    for (const p of players) {
      const color = colorOf(p)
      for (const camp of campsByPlayer.get(p) ?? []) {
        const r = campMarkerRadius(camp.durMs)
        campAreas.push(timed(
          camp.time,
          `<circle data-camp-time="${Math.round(camp.time)}" cx="${r1(camp.x)}" cy="${r1(camp.y)}" r="${r1(r)}" fill="${color}" fill-opacity="0.26" stroke="${color}" stroke-opacity="0.85" stroke-width="1.8"/>`,
        ))
        camps.push({ x: camp.x, y: camp.y, r, text: fmtTime(camp.durMs), time: camp.time })
      }
    }
  }

  // Deaths: a skull where each death on this mode's paths happened, in the
  // victim's colour, with the cause's badge and label and a dashed kill line
  // from the killer's position; a dot ends the path of a unit alive at the
  // end. Sublayers bottom to top: kill lines → survivor dots → skulls → badges
  // → labels, so a skull in a crowd never covers another's badge, nor a badge
  // a label. markerBoxes keeps every marker's footprint for the labels placed
  // after them.
  const killLines: TimedSvg[] = []
  const killLineSegments: PixelSegment[] = []
  const killOriginDots: TimedSvg[] = []
  const markerLeaders: TimedSvg[] = []
  const survivorDots: TimedSvg[] = []
  const skulls: TimedSvg[] = []
  const causeBadges: TimedSvg[] = []
  const causeLabels: TimedSvg[] = []
  const markerBoxes: PixelBox[] = []
  const pushKillLine = (time: number, fx: number, fy: number, tx: number, ty: number, clipped: boolean, color: string): void => {
    killLines.push(timed(
      time,
      `<line x1="${r1(fx)}" y1="${r1(fy)}" x2="${r1(tx)}" y2="${r1(ty)}" stroke="${color}" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"/>`,
    ))
    killLineSegments.push({ x1: fx, y1: fy, x2: tx, y2: ty })
    if (clipped) return
    killOriginDots.push(timed(
      time,
      `<circle cx="${r1(fx)}" cy="${r1(fy)}" r="4.5" fill="${color}" stroke="#10130d" stroke-width="1.6"/>`,
    ))
    markerBoxes.push(boxAround(fx, fy, 6))
  }
  const pushCauseBadge = (time: number, marker: { x: number; y: number }, cause: DeathCause, ring: string): void => {
    // On the ground map a tank's kill is the rule, and its kill line already says it.
    if (mode === 'ground' && 'icon' in cause && cause.icon === 'tank') return
    const x = marker.x + SKULL_BADGE_DX
    const y = marker.y + SKULL_BADGE_DY
    causeBadges.push(timed(time, causeBadge(x, y, cause, ring)))
    markerBoxes.push(causeBadgeBox(x, y, cause))
  }
  const pushKillerLabel = (time: number, marker: { x: number; y: number }, text: string): void => {
    causeLabels.push(timed(time, killerLabel(marker.x, marker.y + KILLER_LABEL_DY, text)))
    markerBoxes.push(textBox(marker.x, marker.y + KILLER_LABEL_DY, text, 13.5, 'middle'))
  }
  const occupiedDeathMarkers: { x: number; y: number }[] = []
  const placeDeathMarker = (trueX: number, trueY: number, time: number): { x: number; y: number } => {
    const offsets: [number, number][] = [
      [0, 0], [0, -38], [38, 0], [0, 38], [-38, 0],
      [34, -34], [34, 34], [-34, 34], [-34, -34],
      [0, -58], [58, 0], [0, 58], [-58, 0],
    ]
    const candidates = offsets.map(([dx, dy]) => ({
      x: Math.max(24, Math.min(MAP_W - 24, trueX + dx)),
      y: Math.max(24, Math.min(MAP_W - KILLER_LABEL_DY - 10, trueY + dy)),
    }))
    const distance = (candidate: { x: number; y: number }): number =>
      occupiedDeathMarkers.length === 0
        ? Infinity
        : Math.min(...occupiedDeathMarkers.map((placed) => Math.hypot(candidate.x - placed.x, candidate.y - placed.y)))
    const placed = candidates.find((candidate) => distance(candidate) >= 40) ??
      candidates.reduce((best, candidate) => distance(candidate) > distance(best) ? candidate : best)
    occupiedDeathMarkers.push(placed)
    markerBoxes.push(boxAround(placed.x, placed.y, 14))
    if (Math.hypot(placed.x - trueX, placed.y - trueY) > 2) {
      markerLeaders.push(timed(
        time,
        `<line data-marker-leader="1" x1="${r1(trueX)}" y1="${r1(trueY)}" x2="${r1(placed.x)}" y2="${r1(placed.y)}" stroke="#e5e9ef" stroke-width="1.4" stroke-opacity="0.62"/>`,
      ))
    }
    return placed
  }
  for (const p of players) {
    const ranges = pathRangesByPlayer.get(p) ?? []
    const playerDeaths = killsByVictim.get(p.userId) ?? []
    for (const k of playerDeaths) {
      const range = ranges.find((rg) => k.time >= rg.from && k.time <= rg.to)
      if (!range) continue
      const pos = k.victimPos && isNear(k.victimPos, range.last) ? k.victimPos : nearestPoint(p.paths, k.time)
      if (!pos) continue
      const tx = px(pos.x)
      const ty = pz(pos.z)
      const marker = placeDeathMarker(tx, ty, k.time)
      skulls.push(timed(k.time, skullIcon(marker.x, marker.y, colorOf(p))))
      if (!k.killerId || k.killerId === p.userId) {
        pushCauseBadge(k.time, marker, { icon: 'crash' }, '#8a919e')
        continue
      }
      const killer = playerById.get(k.killerId)
      const cause = deathCause(k, mode, dict, seekers, t.heatmap.causes)
      if (cause) pushCauseBadge(k.time, marker, cause, killer ? colorOf(killer) : '#8a919e')
      if (!killer) {
        // The killer is not on this map (AA on the air map, a plane on the
        // ground one): no colour names it, so its vehicle is written.
        pushKillerLabel(k.time, marker, trimTo(vehicleInfo(dict, modelId(k.killerModel)).name, 18))
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
      pushKillLine(k.time, fx, fy, tx, ty, clipped, killer ? colorOf(killer) : '#8a919e')
    }
    for (const unit of p.paths) {
      const last = unit.path[unit.path.length - 1]!
      // подбитая машина остаётся в мире и шлёт статичную позицию —
      // конец пути возле места гибели точкой выжившего не считается
      const diedHere = playerDeaths.some(
        (k) =>
          (Math.abs(k.time - last.t) < 45000 || (k.victimPos !== null && isNear(k.victimPos, last, 60))),
      )
      if (!diedHere && events.endTime - last.t < 90000) {
        survivorDots.push(timed(
          last.t,
          `<circle cx="${r1(px(last.x))}" cy="${r1(pz(last.z))}" r="8" fill="${colorOf(p)}" stroke="#10130d" stroke-width="2"/>`,
        ))
        markerBoxes.push(boxAround(px(last.x), pz(last.z), 9))
      }
    }
  }

  // На поле карты одного клана показываем уничтоженных им противников только
  // точкой гибели, без чужого маршрута; в панели остаются оба состава.
  if (teamIndex !== undefined) {
    for (const killer of players) {
      for (const k of killsByKiller.get(killer.userId) ?? []) {
        if (k.victimId === killer.userId) continue
        const victim = playerById.get(k.victimId)
        if (!victim || victim.team === teamIndex) continue
        if (!killer.models.includes(modelId(k.killerModel)) || !victim.models.includes(modelId(k.victimModel))) continue

        const killerActive = (pathRangesByPlayer.get(killer) ?? []).some(
          (range) => k.time >= range.from && k.time <= range.to,
        )
        const victimRange = (pathRangesByPlayer.get(victim) ?? [])
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
        skulls.push(timed(k.time, skullIcon(marker.x, marker.y, colorOf(victim))))
        const cause = deathCause(k, mode, dict, seekers, t.heatmap.causes)
        if (cause) pushCauseBadge(k.time, marker, cause, colorOf(killer))

        // The dashed line as on the overview: in the squadron killer's colour.
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
        pushKillLine(k.time, fx, fy, tx, ty, clipped, colorOf(killer))
      }
    }
  }

  // Stop lengths, clear of the markers (placeCampLabel).
  const campLabels: TimedSvg[] = []
  const campLabelBoxes: PixelBox[] = []
  for (const camp of camps.sort((a, b) => a.time - b.time)) {
    const label = placeCampLabel(camp, markerBoxes.concat(campLabelBoxes))
    if (!label) continue
    campLabelBoxes.push(label.box)
    const attrs = `x="${r1(label.x)}" y="${r1(label.y)}" font-family="${FONTS}" font-size="${CAMP_LABEL_FONT_SIZE}" font-weight="700" text-anchor="${label.anchor}"`
    campLabels.push(timed(
      camp.time,
      `<g data-camp-label-time="${Math.round(camp.time)}">` +
        `<text ${attrs} fill="none" stroke="#10130d" stroke-width="3.4">${camp.text}</text>` +
        `<text ${attrs} fill="#f2f4f7">${camp.text}</text>` +
        `</g>`,
    ))
  }

  // A name beside each life's longest track part, placed last so it can avoid
  // every marker (placeRouteLabels).
  const longestByLife = new Map<string, RouteGeometry>()
  for (const route of routes) {
    const key = `${route.playerId}\u0000${route.life}`
    const longest = longestByLife.get(key)
    if (!longest || route.totalLength > longest.totalLength) longestByLife.set(key, route)
  }
  const routeLabels = placeRouteLabels(
    [...longestByLife.values()]
      .map((route) => ({ route, text: trimTo(playerById.get(route.playerId)?.name ?? '', ROUTE_LABEL_MAX_CHARS) }))
      .filter((target) => target.text !== ''),
    routes,
    killLineSegments,
    markerBoxes.concat(
      campLabelBoxes,
      camps.map((camp) => boxAround(camp.x, camp.y, camp.r)),
      (mission?.zones ?? []).map((zone) => boxAround(px(zone.x), pz(zone.z), 22)),
    ),
    [...occupiedSpawnLabels],
  )

  // Minute marks: a numbered disc every tickStep minutes along each track,
  // left out where it would cover a marker, a label or another track's mark.
  const minuteMarks: TimedSvg[] = []
  const minuteBlockers = markerBoxes.concat(campLabelBoxes, routeLabels.map((label) => label.box))
  const placedMinuteMarks: PreparedMinuteMark[] = []
  for (const p of players) {
    const color = colorOf(p)
    for (const tick of minuteMarksByPlayer.get(p) ?? []) {
      const box = boxAround(tick.x, tick.y, MINUTE_MARK_RADIUS)
      if (minuteBlockers.some((blocker) => boxesOverlap(box, blocker))) continue
      if (placedMinuteMarks.some((mark) => Math.hypot(mark.x - tick.x, mark.y - tick.y) < MINUTE_MARK_RADIUS * 2 + 2)) continue
      placedMinuteMarks.push(tick)
      minuteMarks.push(timed(
        tick.time,
        `<g data-minute-time="${Math.round(tick.time)}" transform="translate(${r1(tick.x)} ${r1(tick.y)})">` +
          `<circle r="${MINUTE_MARK_RADIUS}" fill="#10130d" fill-opacity="0.74" stroke="${color}" stroke-width="2"/>` +
          `<text y="3.9" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">${tick.minute}</text>` +
          `</g>`,
      ))
    }
  }

  pushMapLayer(14, 'camp-areas', chronological(campAreas))
  pushMapLayer(15, 'camp-labels', chronological(campLabels))
  pushMapLayer(16, 'minute-marks', chronological(minuteMarks))
  pushMapLayer(17, 'kill-lines', chronological(killLines))
  pushMapLayer(18, 'kill-origins', chronological(killOriginDots))
  pushMapLayer(19, 'marker-leaders', chronological(markerLeaders))
  pushMapLayer(20, 'survivor-dots', chronological(survivorDots))
  pushMapLayer(21, 'death-skulls', chronological(skulls))
  pushMapLayer(22, 'death-causes', chronological(causeBadges))
  pushMapLayer(23, 'killer-labels', chronological(causeLabels))
  pushMapLayer(24, 'route-labels', routeLabels.map((label) =>
    `<text data-route-label="${esc(label.playerId)}" x="${r1(label.x)}" y="${r1(label.y)}" font-family="${FONTS}" font-size="${ROUTE_LABEL_FONT_SIZE}" font-weight="700" text-anchor="${label.anchor}" fill="${label.color}" stroke="#10130d" stroke-width="3.6" stroke-linejoin="round" paint-order="stroke">${esc(label.text)}</text>`,
  ))

  // ---------- the right panel: title, teams, legend ----------
  parts.push(
    `<rect x="${MAP_W}" width="${PANEL_W}" height="${H}" fill="#0c0d0f"/>`,
    `<line x1="${MAP_W + 1}" y1="0" x2="${MAP_W + 1}" y2="${H}" stroke="#2a2e35" stroke-width="2"/>`,
  )
  const PX = MAP_W + 30
  const PR = MAP_W + PANEL_W - 30

  // Title: the map, mode, date and the battle's length
  const title = /^\s*(?:\[(?:arcade|realistic|simulation|hardcore)\]\s*)?(?:\[([^\]]+)\]\s*)?(.+)$/i.exec(
    input.missionName.trim(),
  )
  const gameMode = title?.[1] ?? t.heatmap.battle
  const mapName = title?.[2] ?? input.missionName
  const selectedRoster = teamIndex === undefined ? undefined : rosters[teamIndex]
  const selectedRawClan = selectedRoster ? mostCommonTag(selectedRoster.map((player) => player.clanTag)) : null
  const selectedClan = selectedRawClan ? clanDisplayName(selectedRawClan) : null
  const selectedText = selectedClan ? ` · ${t.heatmap.routes(trimTo(selectedClan, 12))}` : ''
  const modeFontSize = selectedText ? 16 : 19
  const dateText = t.heatmap.date(new Date(input.header.startTime * 1000))
  const durText = endTime > 60000 ? ` · ${t.heatmap.duration(fmtTime(endTime))}` : ''
  parts.push(
    `<text x="${PX}" y="66" font-family="${FONTS}" font-size="33" font-weight="700" fill="#ffffff">${esc(trimTo(mapName, 22))}</text>`,
    `<text x="${PX}" y="100" font-family="${FONTS}" font-size="${modeFontSize}" fill="#9aa2b1">${esc(gameMode)} · ${esc(mode === 'ground' ? t.heatmap.ground : t.heatmap.air)}${esc(selectedText)}</text>`,
    `<text x="${PX}" y="127" font-family="${FONTS}" font-size="19" fill="#9aa2b1">${esc(dateText)}${esc(durText)}</text>`,
    `<line x1="${PX}" y1="150" x2="${PR}" y2="150" stroke="#2a2e35" stroke-width="1.5"/>`,
  )

  // The median of the players' first positions is a stable team spawn point.
  // The panel's order follows reading the map: top to bottom, then left to right.
  const orderTeams = [0, 1].sort((a, b) => {
    const sa = teamSpawns[a]
    const sb = teamSpawns[b]
    if (!sa || !sb) return sa ? -1 : sb ? 1 : a - b
    const dy = pz(sa.z) - pz(sb.z)
    return Math.abs(dy) > MAP_W * 0.15 ? dy : px(sa.x) - px(sb.x)
  })
  const orderedTeams = orderTeams.filter((ti) => rosters[ti] !== undefined)
  const legendRows = clanUavs.length > 0 ? 5 : 4
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
    // The panel always repeats the general heatmap; teamIndex filters only the map field.
    const teamPlayers = playersByTeam[ti] ?? []
    const clan = mostCommonTag(roster.map((rp) => rp.clanTag))
    const label = clan ? tagMarkup(clan, gameFont) : esc(t.battle.team(roster[0]?.team ?? ti + 1))
    const won = events.teamWon > 0 && roster[0]?.team === events.teamWon
    const spawn = teamSpawns[ti]
    const spawnText = spawn ? esc(t.heatmap.spawn[spawn.direction]) : ''
    const teamKills = roster.reduce((sum, player) => sum + (killsDeaths.get(player.userId)?.[0] ?? 0), 0)
    const survivors = roster.filter((player) => (killsDeaths.get(player.userId)?.[1] ?? 0) === 0).length
    const summary = esc(t.heatmap.teamSummary(roster.length, teamKills, survivors))
    parts.push(
      `<text x="${PX}" y="${py}" font-family="${FONTS}" font-size="29" font-weight="700" fill="${won ? '#f2c811' : '#ffffff'}">${label}</text>`,
      won
        ? `<text x="${PR}" y="${py}" font-family="${FONTS}" font-size="17" font-weight="700" text-anchor="end" fill="#f2c811">${esc(t.heatmap.victory)}</text>`
        : '',
      `<text x="${PX}" y="${py + 21}" font-family="${FONTS}" font-size="14.5" fill="#7f8998">${summary}</text>`,
      `<text x="${PR}" y="${py + 21}" font-family="${FONTS}" font-size="15" text-anchor="end" fill="#9aa2b1">${spawnText}</text>`,
    )
    py += 30
    for (const p of teamPlayers) {
      const rp = resultById.get(p.userId)
      const [kills, deaths] = killsDeaths.get(p.userId) ?? [0, 0]
      const vehicles = p.models.map((m) => vehicleInfo(dict, m).name).join(', ')
      const deathsAt = (killsByVictim.get(p.userId) ?? []).map((kill) => kill.time)
      const fate = esc(deathsAt.length > 0 ? t.heatmap.died(fmtTime(Math.max(...deathsAt))) : t.heatmap.alive)
      const fateColor = deathsAt.length > 0 ? '#d98c8c' : '#9fd6a4'
      parts.push(
        `<rect x="${PX}" y="${py + 6}" width="20" height="20" rx="4" fill="${colorOf(p)}"/>`,
        `<text x="${PX + 32}" y="${py + 23}" font-family="${FONTS}" font-size="23" fill="#f2f4f7">${esc(trimTo(p.name, 18))}</text>`,
        `<text x="${PR}" y="${py + 23}" font-family="${FONTS}" font-size="21" font-weight="700" text-anchor="end" fill="#d7dce4">${kills}/${deaths}</text>`,
        `<text x="${PX + 32}" y="${py + playerSecondLineY}" font-family="${FONTS}" font-size="17" fill="#8f97a6">${esc(trimTo(vehicles, 27))}</text>`,
        `<text x="${PR}" y="${py + playerSecondLineY}" font-family="${FONTS}" font-size="17" text-anchor="end">` +
          (rp ? `<tspan fill="#8f97a6">${esc(t.heatmap.points(rp.score))} · </tspan>` : '') +
          `<tspan fill="${fateColor}">${fate}</tspan></text>`,
      )
      py += playerRowStep
    }
    if (teamPlayers.length === 0) {
      parts.push(
        `<text x="${PX}" y="${py + 20}" font-family="${FONTS}" font-size="18" fill="#5a616e">${esc(t.heatmap.noPaths)}</text>`,
      )
      py += 34
    }
    if (orderIndex < orderedTeams.length - 1) py += teamGap
  })

  // The legend sits at the bottom of the panel
  const glyphColor = '#19c2c9'
  const symbols: [string, string][] = [
    [`<path d="M-11 4 C-5 -7, 3 9, 11 -2" fill="none" stroke="${glyphColor}" stroke-width="3" stroke-linecap="round"/>`, t.heatmap.legend.path],
    [
      `<circle r="9" fill="#10130d" fill-opacity="0.74" stroke="${glyphColor}" stroke-width="2"/>` +
        `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">4</text>`,
      t.heatmap.legend.minute,
    ],
    [`<circle r="9.5" fill="${glyphColor}" fill-opacity="0.26" stroke="${glyphColor}" stroke-width="1.6"/>`, t.heatmap.legend.stop],
    [`<line x1="-11" y1="3" x2="11" y2="-3" stroke="${glyphColor}" stroke-width="1.8" stroke-dasharray="5 4"/>`, t.heatmap.legend.shot],
    [
      `<circle cy="-1" r="7" fill="${glyphColor}" stroke="#15181c" stroke-width="1.4"/>` +
        `<circle cx="-2.6" cy="-1.6" r="1.8" fill="#15181c"/><circle cx="2.6" cy="-1.6" r="1.8" fill="#15181c"/>` +
        `<rect x="-3.4" y="4.4" width="6.8" height="3.6" rx="1.4" fill="${glyphColor}" stroke="#15181c" stroke-width="1"/>`,
      t.heatmap.legend.death,
    ],
    mode === 'ground'
      ? [causeBadge(0, 0, { icon: 'plane' }, '#8a919e').replace(/^<g transform="translate\(0 0\)">/, '<g>'), t.heatmap.legend.causeNotTank]
      : [causeBadge(0, 0, { icon: 'tank' }, '#8a919e').replace(/^<g transform="translate\(0 0\)">/, '<g>'), t.heatmap.legend.cause],
    [`<circle r="6.5" fill="${glyphColor}" stroke="#10130d" stroke-width="1.8"/>`, t.heatmap.legend.survivor],
  ]
  if (clanUavs.length > 0) {
    symbols.push([
      `<path d="M-11 0H11" stroke="${glyphColor}" stroke-width="2" stroke-dasharray="6 5" stroke-linecap="round"/>` +
        `<circle r="5" fill="#10130d" stroke="${glyphColor}" stroke-width="1.7"/>`,
      t.heatmap.legend.uav,
    ])
  }
  parts.push(
    `<line data-panel-legend="1" x1="${PX}" y1="${legendY}" x2="${PR}" y2="${legendY}" stroke="#2a2e35" stroke-width="1.5"/>`,
    `<text x="${PX}" y="${legendY + 30}" font-family="${FONTS}" font-size="19" font-weight="600" fill="#cfd4dc">${esc(t.heatmap.legendTitle)}</text>`,
  )
  const colW = (PANEL_W - 60) / 2
  symbols.forEach(([glyph, text], i) => {
    const gx = PX + (i % 2) * colW + 12
    const gy = legendY + 58 + Math.floor(i / 2) * 34
    parts.push(
      `<g transform="translate(${gx} ${gy})">${glyph}</g>`,
      `<text x="${gx + 24}" y="${gy + 6}" font-family="${FONTS}" font-size="16.5" fill="#9aa2b1">${esc(text)}</text>`,
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

/** Координатная сетка игровой тактической карты с цифрами сверху и буквами слева. */
function coordinateGrid(
  x: number,
  y: number,
  width: number,
  height: number,
  stepX: number,
  stepY: number,
  stepMeters?: number,
): string[] {
  const parts: string[] = []
  const cellWidth = width * stepX
  const cellHeight = height * stepY
  const lineAttrs = 'stroke="#10130d" stroke-opacity="0.58" stroke-width="1.6"'
  const labelAttrs = `font-family="${FONTS}" font-size="22" fill="#0b0d0a" stroke="#ded7aa" stroke-opacity="0.32" stroke-width="2.2" paint-order="stroke" text-anchor="middle"`
  for (let offset = 0; offset <= width + 0.1; offset += cellWidth) {
    const gx = Math.min(x + offset, x + width)
    parts.push(`<line data-grid-line="vertical" x1="${r1(gx)}" y1="${r1(y)}" x2="${r1(gx)}" y2="${r1(y + height)}" ${lineAttrs}/>`)
  }
  for (let offset = 0; offset <= height + 0.1; offset += cellHeight) {
    const gy = Math.min(y + offset, y + height)
    parts.push(`<line data-grid-line="horizontal" x1="${r1(x)}" y1="${r1(gy)}" x2="${r1(x + width)}" y2="${r1(gy)}" ${lineAttrs}/>`)
  }
  for (let offset = 0, column = 1; offset < width; offset += cellWidth, column++) {
    const center = x + offset + cellWidth / 2
    if (center > x + width) break
    parts.push(`<text data-grid-column="${column}" x="${r1(center)}" y="${r1(y + 28)}" ${labelAttrs}>${column}</text>`)
  }
  for (let offset = 0, row = 0; offset < height && row < 26; offset += cellHeight, row++) {
    const center = y + offset + cellHeight / 2
    if (center > y + height - 12) break
    const label = String.fromCharCode(97 + row)
    parts.push(`<text data-grid-row="${label}" x="${r1(x + 16)}" y="${r1(center + 7)}" ${labelAttrs}>${label}</text>`)
  }
  if (stepMeters) {
    const barRight = x + width - 8
    const barLeft = barRight - cellWidth
    const barY = y + height - 7
    parts.push(
      `<line data-grid-scale="${r1(stepMeters)}" x1="${r1(barLeft)}" y1="${r1(barY)}" x2="${r1(barRight)}" y2="${r1(barY)}" stroke="#0b0d0a" stroke-width="4"/>`,
      `<text x="${r1((barLeft + barRight) / 2)}" y="${r1(barY - 10)}" ${labelAttrs}>${r1(stepMeters)} m</text>`,
    )
  }
  return parts
}

/** Белый ромб точки захвата, как на игровой тактической карте. */
function captureZoneMarker(x: number, y: number, letter: string, mapIconFont: boolean): string {
  const diamond = mapIconFont
    ? `<text y="17" font-family="indicators" font-size="55" fill="#f4f6f8" stroke="#252b31" stroke-width="2.2" paint-order="stroke" text-anchor="middle">7</text>`
    : `<rect x="-14" y="-14" width="28" height="28" rx="2" transform="rotate(45)" fill="#f4f6f8" stroke="#252b31" stroke-width="2.2"/>`
  return `<g data-capture-zone="${esc(letter)}" transform="translate(${r1(x)} ${r1(y)})">` +
    diamond +
    `<text y="7" font-family="${FONTS}" font-size="21" font-weight="800" fill="#171b20" text-anchor="middle">${esc(letter)}</text>` +
    `</g>`
}

/** Танковый спавн команды; первая команда получает игровые жёлтые уголки. */
function teamSpawnMarker(x: number, y: number, teamIndex: number, mapIconFont: boolean): string {
  const color = TEAM_SPAWN_COLORS[Math.min(teamIndex, 1)]!
  const brackets = teamIndex === 0
    ? `<path d="M-31-18V-29H-18M18-29H31V-18M31 18V29H18M-18 29H-31V18" fill="none" stroke="#f4ef16" stroke-width="6" stroke-linecap="square"/>`
    : ''
  const icon = mapIconFont
    ? `<text y="18" font-family="indicators" font-size="88" fill="${color}" stroke="#10130d" stroke-width="5" paint-order="stroke" text-anchor="middle">0</text>` +
      `<text y="18" font-family="indicators" font-size="88" fill="${color}" stroke="#f4f6f8" stroke-width="1.3" paint-order="stroke" text-anchor="middle">0</text>`
    : `<path d="M-27 3L-22-9H-10L-7-15H8L12-9H23L28-2L23 10H-22Z" fill="#10130d" fill-opacity="0.72" stroke="#10130d" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M-27 3L-22-9H-10L-7-15H8L12-9H23L28-2L23 10H-22Z" fill="${color}" stroke="#f4f6f8" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<path d="M-11-9H12M-3-15L17-19" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`
  return `<g data-team-spawn="${teamIndex}" transform="translate(${r1(x)} ${r1(y)})">` +
    brackets +
    icon +
    `</g>`
}

function trimTo(s: string, n: number): string {
  return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s
}

/** мс от начала боя → «м:сс» */
const fmtTime = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`


interface TeamSpawn {
  x: number
  z: number
  direction: SpawnDirection
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

function boxAround(x: number, y: number, radius: number): PixelBox {
  return { x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius }
}

/** Characters a UI font draws a whole em wide: CJK, kana, Hangul, fullwidth forms, emoji. */
function isWideChar(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
}

/**
 * A bold text's width by character class, fitted to Noto Sans Bold (the
 * Docker image's UI font) on 9,515 stored nicknames and raised 6%: the
 * estimate falls short by over 1% for 5% of them, by 18% at most.
 */
function labelWidth(text: string, fontSize: number): number {
  let em = 0
  for (const char of text) {
    em += isWideChar(char.codePointAt(0)!) ? 1
      : /[ijlI.,:;'!|]/.test(char) ? 0.32
      : /[_-]/.test(char) ? 0.45
      : /[A-Z]/.test(char) ? 0.74
      : /[а-яё]/.test(char) ? 0.7
      : /[А-ЯЁ]/.test(char) ? 0.8
      : 0.64
  }
  return em * fontSize
}

/** A text line's box around its baseline: 0.8 em above, 0.25 em below. */
function textBox(x: number, baseline: number, text: string, fontSize: number, anchor: 'start' | 'middle' | 'end'): PixelBox {
  const width = labelWidth(text, fontSize)
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2
  return { x0, y0: baseline - fontSize * 0.8, x1: x0 + width, y1: baseline + fontSize * 0.25 }
}

/**
 * A stop's length: below its disc, else above, beside or at a corner, the
 * first place clear of the markers and other labels; null where none is (the
 * disc stays).
 */
function placeCampLabel(
  camp: { x: number; y: number; r: number; text: string },
  blockers: readonly PixelBox[],
): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; box: PixelBox } | null {
  const corner = camp.r * 0.75
  const candidates = [
    { x: camp.x, y: camp.y + camp.r + 17, anchor: 'middle' },
    { x: camp.x, y: camp.y - camp.r - 6, anchor: 'middle' },
    { x: camp.x + camp.r + 5, y: camp.y + 5, anchor: 'start' },
    { x: camp.x - camp.r - 5, y: camp.y + 5, anchor: 'end' },
    { x: camp.x + corner + 3, y: camp.y + corner + 14, anchor: 'start' },
    { x: camp.x - corner - 3, y: camp.y + corner + 14, anchor: 'end' },
    { x: camp.x + corner + 3, y: camp.y - corner - 3, anchor: 'start' },
    { x: camp.x - corner - 3, y: camp.y - corner - 3, anchor: 'end' },
  ] as const
  for (const candidate of candidates) {
    const box = textBox(candidate.x, candidate.y, camp.text, CAMP_LABEL_FONT_SIZE, candidate.anchor)
    if (box.x0 < 2 || box.y0 < 2 || box.x1 > MAP_W - 2 || box.y1 > MAP_W - 2) continue
    if (!blockers.some((blocker) => boxesOverlap(box, blocker))) return { ...candidate, box }
  }
  return null
}

interface RouteLabel {
  playerId: string
  text: string
  color: string
  /** The anchor point on the baseline: the side facing the track, so the estimate's error falls on the far side. */
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: PixelBox
}

/**
 * Track names: each target takes the cheapest place beside its track, scanned
 * along it every few pixels in eight positions. Costs: another player's track
 * through the label 10, within ROUTE_LABEL_NEAR of it 3 (the label could be
 * read as its name), its own track through it 4, a kill line 2, a marker 30, a
 * placed label 1000 (labels overlap only where nothing else is left); the
 * first 80 px, where a team's tracks leave the spawn bundled, up to 16; up to
 * 2 off the track's middle. Short tracks go first: they have the fewest places.
 */
function placeRouteLabels(
  targets: readonly { route: RouteGeometry; text: string }[],
  routes: readonly RouteGeometry[],
  killLines: readonly PixelSegment[],
  markers: readonly PixelBox[],
  occupied: PixelBox[],
): RouteLabel[] {
  const cellSize = 64
  const lines: { segment: PixelSegment; owner: string }[] = []
  const cells = new Map<string, number[]>()
  const cellRange = (from: number, to: number): [number, number] => [
    Math.floor(Math.max(0, from) / cellSize),
    Math.floor(Math.min(MAP_W, to) / cellSize),
  ]
  const addLine = (segment: PixelSegment, owner: string): void => {
    const index = lines.push({ segment, owner }) - 1
    const [fromX, toX] = cellRange(Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2))
    const [fromY, toY] = cellRange(Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2))
    for (let x = fromX; x <= toX; x++) {
      for (let y = fromY; y <= toY; y++) {
        const bucket = cells.get(`${x}:${y}`)
        if (bucket) bucket.push(index)
        else cells.set(`${x}:${y}`, [index])
      }
    }
  }
  for (const route of routes) {
    for (let i = 1; i < route.points.length; i++) {
      const from = route.points[i - 1]!
      const to = route.points[i]!
      addLine({ x1: from.x, y1: from.y, x2: to.x, y2: to.y }, route.playerId)
    }
  }
  for (const line of killLines) addLine(line, '')
  const seen = new Uint32Array(lines.length)
  let visit = 0
  const lineCost = (box: PixelBox, playerId: string): number => {
    visit++
    let cost = 0
    const near = {
      x0: box.x0 - ROUTE_LABEL_NEAR,
      y0: box.y0 - ROUTE_LABEL_NEAR,
      x1: box.x1 + ROUTE_LABEL_NEAR,
      y1: box.y1 + ROUTE_LABEL_NEAR,
    }
    const [fromX, toX] = cellRange(near.x0, near.x1)
    const [fromY, toY] = cellRange(near.y0, near.y1)
    for (let x = fromX; x <= toX; x++) {
      for (let y = fromY; y <= toY; y++) {
        for (const index of cells.get(`${x}:${y}`) ?? []) {
          if (seen[index] === visit) continue
          seen[index] = visit
          const line = lines[index]!
          const foreign = line.owner !== '' && line.owner !== playerId
          if (segmentIntersectsBox(line.segment, box)) cost += line.owner === '' ? 2 : foreign ? 10 : 4
          else if (foreign && segmentIntersectsBox(line.segment, near)) cost += 3
        }
      }
    }
    return cost
  }

  const labels: RouteLabel[] = []
  for (const { route, text } of [...targets].sort((a, b) => a.route.totalLength - b.route.totalLength)) {
    const width = labelWidth(text, ROUTE_LABEL_FONT_SIZE)
    const height = ROUTE_LABEL_HEIGHT
    const gap = ROUTE_LABEL_GAP
    // The box's top left from the track point, its cost (above, below and beside first) and the text's anchor.
    const offsets: readonly (readonly [number, number, number, RouteLabel['anchor']])[] = [
      [-width / 2, -gap - height, 0, 'middle'],
      [-width / 2, gap, 0, 'middle'],
      [gap + 2, -height / 2, 0, 'start'],
      [-gap - 2 - width, -height / 2, 0, 'end'],
      [gap, -gap - height, 1, 'start'],
      [-gap - width, -gap - height, 1, 'end'],
      [gap, gap, 1, 'start'],
      [-gap - width, gap, 1, 'end'],
    ]
    const step = Math.max(6, route.totalLength / 80)
    let best: { box: PixelBox; cost: number; anchor: RouteLabel['anchor'] } | null = null
    for (let distance = 0; distance <= route.totalLength; distance += step) {
      const point = routePointAtDistance(route, distance)
      const offMiddle = route.totalLength > 0 ? Math.abs(distance / route.totalLength - 0.5) * 4 : 0
      const place = Math.max(0, 80 - distance) * 0.2 + offMiddle
      for (const [dx, dy, offsetCost, anchor] of offsets) {
        const box = { x0: point.x + dx, y0: point.y + dy, x1: point.x + dx + width, y1: point.y + dy + height }
        if (box.x0 < 6 || box.y0 < 6 || box.x1 > MAP_W - 6 || box.y1 > MAP_W - 6) continue
        let cost = place + offsetCost
        for (const other of occupied) if (boxesOverlap(box, other)) cost += 1000
        if (best && cost >= best.cost) continue
        for (const marker of markers) if (boxesOverlap(box, marker)) cost += 30
        if (best && cost >= best.cost) continue
        cost += lineCost(box, route.playerId)
        if (!best || cost < best.cost) best = { box, cost, anchor }
      }
    }
    if (!best) continue
    occupied.push(best.box)
    const { box, anchor } = best
    const x = anchor === 'start' ? box.x0 : anchor === 'end' ? box.x1 : (box.x0 + box.x1) / 2
    labels.push({ playerId: route.playerId, text, color: route.color, x, y: box.y1 - 4, anchor, box })
  }
  return labels
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

const ROUTE_CORNER_RADIUS = 8
const ROUTE_CORNER_FRACTION = 0.35

/**
 * Скругляет только локальные углы маршрута. Прямые и развороты остаются
 * полилиниями, а радиус ограничен долей соседних отрезков, поэтому кривая не
 * срезает заметную часть реального пути.
 */
export function routePath(points: PixelRoutePoint[]): string {
  const first = points[0]
  if (!first) return ''

  const parts = [`M${r1(first.x)} ${r1(first.y)}`]
  for (let i = 1; i + 1 < points.length; i++) {
    const previous = points[i - 1]!
    const corner = points[i]!
    const next = points[i + 1]!
    const incomingX = corner.x - previous.x
    const incomingY = corner.y - previous.y
    const outgoingX = next.x - corner.x
    const outgoingY = next.y - corner.y
    const incomingLength = Math.hypot(incomingX, incomingY)
    const outgoingLength = Math.hypot(outgoingX, outgoingY)

    if (incomingLength < 0.01 || outgoingLength < 0.01) {
      parts.push(`L${r1(corner.x)} ${r1(corner.y)}`)
      continue
    }

    const cosine = (incomingX * outgoingX + incomingY * outgoingY) /
      (incomingLength * outgoingLength)
    // Почти прямой участок не раздуваем, а резкий разворот не маскируем дугой.
    if (cosine > 0.999 || cosine < -0.85) {
      parts.push(`L${r1(corner.x)} ${r1(corner.y)}`)
      continue
    }

    const radius = Math.min(
      ROUTE_CORNER_RADIUS,
      incomingLength * ROUTE_CORNER_FRACTION,
      outgoingLength * ROUTE_CORNER_FRACTION,
    )
    const entryX = corner.x - (incomingX / incomingLength) * radius
    const entryY = corner.y - (incomingY / incomingLength) * radius
    const exitX = corner.x + (outgoingX / outgoingLength) * radius
    const exitY = corner.y + (outgoingY / outgoingLength) * radius
    parts.push(
      `L${r1(entryX)} ${r1(entryY)}`,
      `Q${r1(corner.x)} ${r1(corner.y)} ${r1(exitX)} ${r1(exitY)}`,
    )
  }

  const last = points[points.length - 1]
  if (points.length > 1) parts.push(`L${r1(last!.x)} ${r1(last!.y)}`)
  return parts.join('')
}

export function routeStrokeParts(drawings: readonly RouteStrokeDrawing[]): string[] {
  const chronological = [...drawings].sort((a, b) => a.baseOrder - b.baseOrder)

  // Все обводки лежат ниже всех цветов. Поэтому верхний маршрут не вырезает
  // чёрную щель в нижнем, но контраст линий с фоном карты сохраняется.
  const outlines = chronological.map(({ d, attrs, directionArrows }) =>
    `<g data-route-stroke-pass="outline" ${attrs}>` +
      `<path data-route-layer="outline" data-direction-arrows="${directionArrows}" d="${d}" fill="none" stroke="#10130d" stroke-opacity="0.55" stroke-width="5.4" stroke-linejoin="round" stroke-linecap="round"/>` +
      `</g>`)
  const colors = chronological.map(({ color, d, attrs, directionArrows }) =>
    `<g data-route-stroke-pass="color" ${attrs}>` +
      `<path data-route-layer="color" data-direction-arrows="${directionArrows}" d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
      `</g>`)

  // Совпадающие пути рисуются в хронологическом порядке: более поздний
  // маршрут всегда остаётся сверху. Тонкий проход сохраняет его непрерывный
  // центр на общем участке, а основной слой оставляет видимыми края второго
  // маршрута. На одиночном пути проход совпадает с основным цветом.
  const sharedRouteReveal = chronological.map(({ color, d, attrs, directionArrows }) =>
    `<g data-route-stroke-pass="shared-reveal" ${attrs}>` +
      `<path data-route-layer="shared-reveal" data-direction-arrows="${directionArrows}" d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `</g>`)

  return [...outlines, ...colors, ...sharedRouteReveal]
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
 * Находит видимые пересечения и близкие общие участки маршрутов через
 * пространственную сетку. Это заменяет квадратичное сравнение всех рёбер и
 * не нарезает основной path: поверх него добавляются только короткие мостики.
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

export function segmentIntersection(
  first: RouteSegment,
  second: RouteSegment,
): { x: number; y: number; first: number; second: number } | null {
  const rx = first.to.x - first.from.x
  const ry = first.to.y - first.from.y
  const sx = second.to.x - second.from.x
  const sy = second.to.y - second.from.y
  const denominator = rx * sy - ry * sx
  const parallelness = Math.abs(denominator) / (first.length * second.length)
  if (parallelness < 0.2) {
    // На общей дороге отрезки почти параллельны и не пересекаются
    // математически. Всё же находим середину их продольного перекрытия,
    // чтобы routeCrossings мог положить сверху маршрут, приехавший позже.
    const firstLengthSquared = first.length * first.length
    const secondLengthSquared = second.length * second.length
    const projectOnFirst = (x: number, y: number): number =>
      ((x - first.from.x) * rx + (y - first.from.y) * ry) / firstLengthSquared
    const secondStart = projectOnFirst(second.from.x, second.from.y)
    const secondEnd = projectOnFirst(second.to.x, second.to.y)
    const overlapStart = Math.max(0, Math.min(secondStart, secondEnd))
    const overlapEnd = Math.min(1, Math.max(secondStart, secondEnd))
    if (overlapEnd - overlapStart < 0.02) return null

    const firstFraction = (overlapStart + overlapEnd) / 2
    const pointX = first.from.x + rx * firstFraction
    const pointY = first.from.y + ry * firstFraction
    const secondFraction = Math.max(
      0,
      Math.min(
        1,
        ((pointX - second.from.x) * sx + (pointY - second.from.y) * sy) / secondLengthSquared,
      ),
    )
    const secondPointX = second.from.x + sx * secondFraction
    const secondPointY = second.from.y + sy * secondFraction
    if (Math.hypot(pointX - secondPointX, pointY - secondPointY) > 6) return null
    return { x: pointX, y: pointY, first: firstFraction, second: secondFraction }
  }
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

/** The team's median first spawn and its direction from the map's centre. */
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
  if (Math.hypot(dx, dz) < 0.12) return { x, z, direction: 'centre' }
  // Eighths of a turn counter-clockwise from the right; ±4 is the left.
  const sector = Math.round(Math.atan2(dz, dx) / (Math.PI / 4))
  const directions: Record<string, SpawnDirection> = {
    '0': 'right',
    '1': 'topRight',
    '2': 'top',
    '3': 'topLeft',
    '4': 'left',
    '-4': 'left',
    '-3': 'bottomLeft',
    '-2': 'bottom',
    '-1': 'bottomRight',
  }
  return { x, z, direction: directions[String(sector)] ?? 'right' }
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
    const i = Math.max(0, lowerBoundPathTime(path, t) - 1)
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
    const index = lowerBoundPathTime(u.path, t)
    if (index > 0) {
      const p = u.path[index - 1]!
      const dt = Math.abs(p.t - t)
      if (dt < bestDt) {
        bestDt = dt
        best = p
      }
    }
    if (index < u.path.length) {
      const p = u.path[index]!
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
function truncateAtDeath(unit: ReplayUnitPath, deaths: readonly ReplayKill[]): ReplayUnitPath {
  const start = unit.path[0]!.t
  const end = unit.path[unit.path.length - 1]!.t
  const death = firstKillInRange(deaths, start, end)
  if (!death) return unit
  return { ...unit, path: unit.path.filter((p) => p.t <= death.time + 4000) }
}

function lowerBoundPathTime(path: readonly SpaceTime[], time: number): number {
  let low = 0
  let high = path.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (path[middle]!.t < time) low = middle + 1
    else high = middle
  }
  return low
}

function lowerBoundKillTime(kills: readonly ReplayKill[], time: number): number {
  let low = 0
  let high = kills.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (kills[middle]!.time < time) low = middle + 1
    else high = middle
  }
  return low
}

function firstKillInRange(
  kills: readonly ReplayKill[],
  from: number,
  to: number,
): ReplayKill | null {
  const kill = kills[lowerBoundKillTime(kills, from)]
  return kill && kill.time <= to ? kill : null
}

/** Квадратные границы по точкам (+ опциональная стартовая область) */
function fitBounds(
  points: SpaceTime[],
  seed: { x0: number; z0: number; x1: number; z1: number } | null,
  paddingFactor = 1.06,
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
  const half = (Math.max(x1 - x0, z1 - z0) / 2 || 1000) * paddingFactor
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

function campMarkerRadius(durMs: number): number {
  return Math.min(30, 13 + (durMs / 60000) * 5)
}

/**
 * Объединяет пересекающиеся маркеры стоянок одного игрока уже после проекции
 * на изображение. Поэтому одинаковое расстояние в мире объединяется на карте
 * большого охвата и остаётся раздельным на более крупном масштабе.
 */
export function mergeNearbyCamps(camps: readonly PreparedCamp[]): PreparedCamp[] {
  const merged: PreparedCamp[] = []
  const chronological = camps
    .map((camp) => ({ ...camp }))
    .sort((a, b) => a.time - b.time)

  for (const camp of chronological) {
    let cluster = camp
    while (true) {
      const overlapIndex = merged.findIndex((candidate) =>
        Math.hypot(cluster.x - candidate.x, cluster.y - candidate.y) <=
          campMarkerRadius(cluster.durMs) + campMarkerRadius(candidate.durMs),
      )
      if (overlapIndex < 0) break

      const candidate = merged.splice(overlapIndex, 1)[0]!
      const durMs = candidate.durMs + cluster.durMs
      cluster = {
        x: (candidate.x * candidate.durMs + cluster.x * cluster.durMs) / durMs,
        y: (candidate.y * candidate.durMs + cluster.y * cluster.durMs) / durMs,
        durMs,
        time: Math.max(candidate.time, cluster.time),
      }
    }
    merged.push(cluster)
  }

  return merged.sort((a, b) => a.time - b.time)
}

/** The skull's scale (24 px drawing, ≈28 px on the map) and its cause badge's offset from the skull's centre, px. */
const SKULL_SCALE = 1.15
const SKULL_BADGE_DX = 12
const SKULL_BADGE_DY = 11
/** The killer's vehicle label's baseline below the skull's centre, px. */
const KILLER_LABEL_DY = 28
const MINUTE_MARK_RADIUS = 9
const CAMP_LABEL_FONT_SIZE = 14.5
/** Track names: bold text with a dark halo, kept clear of its track's outline by the gap; px. */
const ROUTE_LABEL_FONT_SIZE = 15
const ROUTE_LABEL_HEIGHT = 17
const ROUTE_LABEL_GAP = 5
const ROUTE_LABEL_NEAR = 10
const ROUTE_LABEL_MAX_CHARS = 16

/** A skull in the victim's colour. */
function skullIcon(x: number, y: number, color: string): string {
  return (
    `<g transform="translate(${r1(x - 12 * SKULL_SCALE)} ${r1(y - 12 * SKULL_SCALE)}) scale(${SKULL_SCALE})">` +
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
 * What killed: for aircraft the missile's seeker (IR/SARH/ARH from the
 * datamine, a SAM by the AA vehicle's weapon name), otherwise the killer's
 * class silhouette. No killer — a crash. null — the cause is unknown.
 */
function deathCause(
  k: ReplayKill,
  mode: 'ground' | 'air',
  dict: VehicleDict,
  seekers: Map<string, MissileSeeker> | undefined,
  labels: BotText['heatmap']['causes'],
): DeathCause | null {
  if (!k.killerId || k.killerId === k.victimId) return { icon: 'crash' }
  const killerCls = vehicleInfo(dict, modelId(k.killerModel)).cls
  if (mode === 'air') {
    const seeker = seekers?.get(k.weapon)
    if (seeker === 'ir') return { label: labels.ir }
    if (seeker === 'sarh') return { label: labels.sarh }
    if (seeker === 'arh') return { label: labels.arh }
    if (killerCls === 'AA' && SAM_RE.test(k.weapon)) return { label: labels.sam }
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

/** causeBadge's footprint: a 10.5 px disc or a pill as wide as its label. */
function causeBadgeBox(x: number, y: number, cause: DeathCause): PixelBox {
  const half = 'icon' in cause ? 11.5 : (12 + cause.label.length * 7.2) / 2 + 1
  return { x0: x - half, y0: y - 11.5, x1: x + half, y1: y + 11.5 }
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
    `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">${esc(cause.label)}</text>` +
    `</g>`
  )
}
