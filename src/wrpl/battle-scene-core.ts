import { gzipSync } from 'node:zlib'
import { decodeEventsPayload } from './events-codec.js'
import { pickPerspective } from '../tactical-map/perspective.js'
import type { ReplayEvents, SpaceTime } from './replay-events.js'

// The pure core of the battle scene for the interactive player: no database
// and no Fastify, so a worker imports it safely (src/workers/entry.ts). The
// heavy part (events_blob decoding, track thinning, scene gzip) runs only in
// a CPU worker.

// 3: bot slot tracks and kills credited to their players (player-events.ts).
// 4: wt-tools maps with "-", "()" or diacritics in the key (battle-assets.ts).
// 5: maps drawn from the game client (src/tactical-map): their view and the perspective of team 1.
// 6: the HQ map textures and the air view (map.air: the game's air map around the air tracks).
// 7: a player slot the AI drove carries the player's nick (DB v22 slot_nick), not the bot's.
export const BATTLE_SCENE_VERSION = 7

/** Прореживание по времени: точка не чаще, чем раз в секунду. */
const TIME_STEP_MS = 1_000
/** Максимум точек одного юнита после прореживания — защита от гигантских путей. */
const MAX_UNIT_POINTS = 1_200

export interface ScenePlayerRef {
  userId: string
  nick: string
  team: number
  clanTag: string | null
}

export interface ScenePrepareInput {
  sessionId: string
  missionName: string
  gameMode: string | null
  startTime: number
  durationSec: number
  teamWon: number
  /** The mission's battleArea; null — bounds come from the track points. */
  missionArea: { x0: number; z0: number; x1: number; z1: number } | null
  /** Whether a tactical map matching missionArea is available. */
  mapAvailable: boolean
  /** The game-file map's tank bases (src/tactical-map): pick the side where team 1 starts. */
  mapSpawns?: { team: 'A' | 'B'; kind: string; x: number; z: number }[] | null
  /** Level key for the map.png route (levels/… from the header). */
  level: string
  players: ScenePlayerRef[]
  /** [bot slot userId, player userId]: the slot's tracks and kills go to the player. */
  botSlots: [string, string][]
}

export interface BattleSceneUnit {
  id: number
  userId: string | null
  model: string
  source: 'ground' | 'air'
  /** [t(мс), x, z] — мировые координаты, прорежены до ~1 точки/сек. */
  path: [number, number, number][]
}

export interface BattleSceneKill {
  t: number
  killerId: string | null
  victimId: string | null
  weapon: string
  x: number | null
  z: number | null
}

export interface BattleScene {
  v: number
  sessionId: string
  missionName: string
  gameMode: string | null
  startTime: number
  durationSec: number
  teamWon: number
  endTimeMs: number
  /** The world rect shown [x0, z0, x1, z1]. */
  worldBounds: [number, number, number, number]
  /**
   * team: the game-file map's perspective whose blue bases are team 1's (map.png?team=); air: the
   * air view's world rect (sceneAir; map.png?kind=air draws it on the first request).
   */
  map: { available: boolean; level: string; team?: 'A' | 'B'; air?: { view: [number, number, number, number] } }
  zones: { name: string; x: number; z: number }[]
  players: ScenePlayerRef[]
  units: BattleSceneUnit[]
  kills: BattleSceneKill[]
}

const round = (value: number): number => Math.round(value)

/** Дуглас–Пекер по (x, z); время сохраняется у выживших точек. */
function simplifyPath(points: SpaceTime[], epsilon: number): SpaceTime[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [from, to] = stack.pop()!
    const a = points[from]!
    const b = points[to]!
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSq = dx * dx + dz * dz
    let maxDistSq = 0
    let maxIndex = -1
    for (let i = from + 1; i < to; i += 1) {
      const p = points[i]!
      let distSq: number
      if (lengthSq === 0) {
        const ex = p.x - a.x
        const ez = p.z - a.z
        distSq = ex * ex + ez * ez
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq))
        const ex = p.x - (a.x + t * dx)
        const ez = p.z - (a.z + t * dz)
        distSq = ex * ex + ez * ez
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIndex = i
      }
    }
    if (maxIndex >= 0 && maxDistSq > epsilon * epsilon) {
      keep[maxIndex] = 1
      stack.push([from, maxIndex], [maxIndex, to])
    }
  }
  const result: SpaceTime[] = []
  for (let i = 0; i < points.length; i += 1) if (keep[i]) result.push(points[i]!)
  return result
}

function thinByTime(points: SpaceTime[]): SpaceTime[] {
  if (points.length <= 2) return points
  const result: SpaceTime[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i]!
    if (point.t - result[result.length - 1]!.t >= TIME_STEP_MS) result.push(point)
  }
  result.push(points[points.length - 1]!)
  return result
}

/** Builds the scene from decoded ReplayEvents. A pure function. */
export function buildBattleScene(events: ReplayEvents, input: ScenePrepareInput): BattleScene {
  const botOwners = new Map(input.botSlots)
  const player = (userId: string): string | null => (userId === '' ? null : botOwners.get(userId) ?? userId)
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  const observe = (x: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    if (x < minX) minX = x
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (z > maxZ) maxZ = z
  }

  const units: BattleSceneUnit[] = []
  let endTimeMs = Math.max(1, events.endTime)
  for (const [index, unit] of events.units.entries()) {
    if (unit.path.length < 2) continue
    // The path span sets the simplification epsilon: ~1/1500 of it, at least 2 m.
    let spanX0 = Infinity, spanZ0 = Infinity, spanX1 = -Infinity, spanZ1 = -Infinity
    for (const point of unit.path) {
      if (point.x < spanX0) spanX0 = point.x
      if (point.z < spanZ0) spanZ0 = point.z
      if (point.x > spanX1) spanX1 = point.x
      if (point.z > spanZ1) spanZ1 = point.z
    }
    const span = Math.max(spanX1 - spanX0, spanZ1 - spanZ0)
    const epsilon = Math.max(2, span / 1_500)
    let path = simplifyPath(thinByTime(unit.path), epsilon)
    if (path.length > MAX_UNIT_POINTS) {
      const step = Math.ceil(path.length / MAX_UNIT_POINTS)
      path = path.filter((_point, pointIndex) => pointIndex % step === 0 || pointIndex === path.length - 1)
    }
    for (const point of path) observe(point.x, point.z)
    const last = path[path.length - 1]!
    if (last.t > endTimeMs) endTimeMs = last.t
    units.push({
      id: index,
      userId: player(unit.userId),
      model: unit.model.replace(/^.*\//, ''),
      source: unit.source,
      path: path.map((point) => [Math.round(point.t), round(point.x), round(point.z)]),
    })
  }

  const kills: BattleSceneKill[] = events.kills.map((kill) => {
    const pos = kill.victimPos ?? kill.killerPos
    if (pos) observe(pos.x, pos.z)
    return {
      t: Math.round(kill.time),
      killerId: player(kill.killerId),
      victimId: player(kill.victimId),
      weapon: kill.weapon,
      x: pos ? round(pos.x) : null,
      z: pos ? round(pos.z) : null,
    }
  })

  for (const zone of events.zones) observe(zone.x, zone.z)

  // Bounds: the mission's battleArea, otherwise the points' extent with a 6% margin.
  let worldBounds: [number, number, number, number]
  if (input.missionArea) {
    worldBounds = [input.missionArea.x0, input.missionArea.z0, input.missionArea.x1, input.missionArea.z1]
  } else if (minX < maxX && minZ < maxZ) {
    const margin = Math.max(200, Math.max(maxX - minX, maxZ - minZ) * 0.06)
    worldBounds = [round(minX - margin), round(minZ - margin), round(maxX + margin), round(maxZ + margin)]
  } else {
    worldBounds = [-2_000, -2_000, 2_000, 2_000]
  }

  // Team 1's first ground positions decide which perspective of the game-file map shows it blue.
  const mapTeam = input.mapSpawns ? pickPerspective({ spawns: input.mapSpawns }, teamOneGroundStarts(units, input.players)) : null

  return {
    v: BATTLE_SCENE_VERSION,
    sessionId: input.sessionId,
    missionName: input.missionName,
    gameMode: input.gameMode,
    startTime: input.startTime,
    durationSec: input.durationSec,
    teamWon: input.teamWon,
    endTimeMs,
    worldBounds,
    map: {
      available: input.mapAvailable && input.missionArea !== null,
      level: input.level,
      ...(input.mapSpawns ? { team: mapTeam ?? 'A' } : {}),
    },
    zones: events.zones.map((zone) => ({ name: zone.name, x: round(zone.x), z: round(zone.z) })),
    players: input.players,
    units,
    kills,
  }
}

/** The scene from a stored events blob (a worker decodes it). */
export function buildSceneFromBlob(eventsBlob: ArrayBuffer, input: ScenePrepareInput): BattleScene {
  return buildBattleScene(decodeEventsPayload(new Uint8Array(eventsBlob)) as ReplayEvents, input)
}

/** The scene as gzip JSON for the browser. */
export function gzipScene(scene: BattleScene): ArrayBuffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(scene), 'utf8'))
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)
}

/** Where team 1's ground vehicles started (the scene's tracks keep their first points). */
function teamOneGroundStarts(units: readonly BattleSceneUnit[], players: readonly ScenePlayerRef[]): { x: number; z: number }[] {
  const teamOne = new Set(players.filter((p) => p.team === 1).map((p) => p.userId))
  return units
    .filter((unit) => unit.source === 'ground' && unit.path.length > 0 && unit.userId !== null && teamOne.has(unit.userId))
    .map((unit) => ({ x: unit.path[0]![1], z: unit.path[0]![2] }))
}

/** The air map (src/tactical-map spec): what the scene's air view needs of it. */
export interface SceneAirInput {
  /** The air map's own view: the air view stays inside it. */
  view: { x0: number; z0: number; x1: number; z1: number }
  /** Its bases: the perspective when the ground map is missing. */
  spawns: { team: 'A' | 'B'; kind: string; x: number; z: number }[]
  /** The margin around the tracks, percent: the air heatmaps' WT_HEATMAP_AIR_PADDING_PERCENT. */
  paddingPercent: number
}

export interface SceneAir {
  view: { x0: number; z0: number; x1: number; z1: number }
  team: 'A' | 'B'
}

/** The air view's smallest side: a short flight still shows a few of the air map's 6 500 m cells. */
const MIN_AIR_VIEW_METERS = 8_000

/**
 * The scene's air view: a square around every air track and the ground view
 * (worldBounds) with the margin, at least MIN_AIR_VIEW_METERS, moved inside
 * the air map's view (all of it when larger). Null without air tracks.
 */
export function sceneAirView(
  scene: Pick<BattleScene, 'units' | 'worldBounds'>,
  airView: { x0: number; z0: number; x1: number; z1: number },
  paddingPercent = 6,
): { x0: number; z0: number; x1: number; z1: number } | null {
  let [x0, z0, x1, z1] = scene.worldBounds
  let air = false
  for (const unit of scene.units) {
    if (unit.source !== 'air') continue
    for (const [, x, z] of unit.path) {
      air = true
      if (x < x0) x0 = x
      if (z < z0) z0 = z
      if (x > x1) x1 = x
      if (z > z1) z1 = z
    }
  }
  if (!air) return null
  const limit = Math.min(airView.x1 - airView.x0, airView.z1 - airView.z0)
  const side = Math.min(limit, Math.max(MIN_AIR_VIEW_METERS, Math.max(x1 - x0, z1 - z0) * (1 + paddingPercent / 100)))
  const clamp = (centre: number, low: number, high: number): number => Math.min(Math.max(centre - side / 2, low), high - side)
  const left = clamp((x0 + x1) / 2, airView.x0, airView.x1)
  const bottom = clamp((z0 + z1) / 2, airView.z0, airView.z1)
  return { x0: left, z0: bottom, x1: left + side, z1: bottom + side }
}

/**
 * The scene's air view and the perspective it is drawn in: the ground map's
 * (map.team), else the same rule over the air map's tank bases, so a failed
 * ground map leaves the air view drawable. Null without the air map or
 * without air tracks.
 */
export function sceneAir(scene: BattleScene, air: SceneAirInput | null): SceneAir | null {
  if (!air) return null
  const view = sceneAirView(scene, air.view, air.paddingPercent)
  if (!view) return null
  const team = scene.map.team ?? pickPerspective({ spawns: air.spawns }, teamOneGroundStarts(scene.units, scene.players)) ?? 'A'
  return { view, team }
}
