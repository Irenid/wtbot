import { gzipSync } from 'node:zlib'
import { decodeEventsPayload } from './events-codec.js'
import type { ReplayEvents, SpaceTime } from './replay-events.js'

// The pure core of the battle scene for the interactive player: no database
// and no Fastify, so a worker imports it safely (src/workers/entry.ts). The
// heavy part (events_blob decoding, track thinning, scene gzip) runs only in
// a CPU worker.

// 3: bot slot tracks and kills credited to their players (player-events.ts).
// 4: wt-tools maps with "-", "()" or diacritics in the key (battle-assets.ts).
export const BATTLE_SCENE_VERSION = 4

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
  /** Видимая область мира [x0, z0, x1, z1]. */
  worldBounds: [number, number, number, number]
  map: { available: boolean; level: string }
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
    map: { available: input.mapAvailable && input.missionArea !== null, level: input.level },
    zones: events.zones.map((zone) => ({ name: zone.name, x: round(zone.x), z: round(zone.z) })),
    players: input.players,
    units,
    kills,
  }
}

/** Полный worker-путь: распаковка events_blob → сцена → gzip JSON для браузера. */
export function prepareSceneFromBlob(eventsBlob: ArrayBuffer, input: ScenePrepareInput): ArrayBuffer {
  const events = decodeEventsPayload(new Uint8Array(eventsBlob)) as ReplayEvents
  const scene = buildBattleScene(events, input)
  const gz = gzipSync(Buffer.from(JSON.stringify(scene), 'utf8'))
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)
}
