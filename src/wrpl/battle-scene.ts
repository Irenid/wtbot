import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { config } from '../config.js'
import {
  getSiteBattleEventsBlob,
  getSiteBattleSummary,
} from '../db/index.js'
import { runWorkerTask } from '../workers/pool.js'
import { writeFileAtomic } from '../atomic-file.js'
import { ensureGameAirMap, ensureGameTacticalMap, ensureGameTacticalMaps } from '../tactical-map/index.js'
import type { Team } from '../tactical-map/model.js'
import { ensureTacticalMap, loadCachedTacticalMap, loadLocalTacticalMap } from './battle-assets.js'
import { battleBalanceLevel, enforceBattleCacheCap } from './battle-media.js'
import { fetchMissionInfo } from './mission-info.js'
import { BATTLE_SCENE_VERSION, type SceneAir, type ScenePrepareInput } from './battle-scene-core.js'

// The battle scene's orchestration (main thread): the database, the mission,
// the map and the cache. The heavy work (gunzip, thinning, gzip, drawing the
// air view) runs in worker tasks; data goes in and out as transferable
// buffers (the worker does not see the database).

const CACHE_DIR = './data/battles'
const MAX_SCENE_BYTES = 16 * 1024 * 1024
/** Concurrent scene builds: different sessions must not take the whole pool. */
const MAX_ACTIVE_BUILDS = 2
const SCENE_TIMEOUT_MS = 120_000
const AIR_MAP_TIMEOUT_MS = 60_000

const sceneCacheFile = (sessionIdHex: string): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-scene-v${BATTLE_SCENE_VERSION}.json.gz`)

/** The scene's air view (sceneAir: its world rect and perspective), saved with the scene. */
const sceneAirFile = (sessionIdHex: string): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-scene-v${BATTLE_SCENE_VERSION}-air.json`)

/** The air view drawn, on its first request: one session's set in the shared LRU. */
const sceneAirMapFile = (sessionIdHex: string): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-scene-v${BATTLE_SCENE_VERSION}-air.jpg`)

const isGzip = (data: Buffer): boolean => data.length > 2 && data[0] === 0x1f && data[1] === 0x8b
const isJpeg = (data: Buffer): boolean => data.length > 3 && data[0] === 0xff && data[1] === 0xd8

export type BattleSceneResult =
  | { status: 'ok'; sceneGzip: Buffer }
  | { status: 'not_found' }
  /** The battle is parsed but has no events blob: the player falls back to a message. */
  | { status: 'no_events' }
  /** Every scene build slot is busy; the client retries in a few seconds. */
  | { status: 'busy' }

const inflightScenes = new Map<string, Promise<BattleSceneResult>>()
const inflightAirMaps = new Map<string, Promise<{ data: Buffer; mime: 'image/jpeg' } | null>>()
let activeBuilds = 0

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readCachedScene(file: string): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  const data = await readOptional(file)
  return data && data.byteLength <= MAX_SCENE_BYTES && isGzip(data) ? data : null
}

/** The saved air view, checked: a square of at most 200 km and a team. */
async function readSceneAir(sessionIdHex: string): Promise<SceneAir | null> {
  const data = await readOptional(sceneAirFile(sessionIdHex))
  if (!data || data.byteLength > 4096) return null
  try {
    const air = JSON.parse(data.toString('utf8')) as SceneAir
    const { x0, z0, x1, z1 } = air.view
    const valid = [x0, z0, x1, z1].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      x1 > x0 && z1 > z0 && x1 - x0 <= 200_000 && z1 - z0 <= 200_000 && (air.team === 'A' || air.team === 'B')
    return valid ? { view: { x0, z0, x1, z1 }, team: air.team } : null
  } catch {
    return null
  }
}

/**
 * The battle scene for the player: gzip JSON (BattleScene in
 * battle-scene-core.ts). Reads the database only; the result is cached in
 * data/battles/ under the shared LRU cap. Parallel requests for one session
 * are merged.
 */
export async function buildBattleSceneGzip(sessionId: string): Promise<BattleSceneResult> {
  const summary = getSiteBattleSummary(sessionId)
  if (!summary) return { status: 'not_found' }
  const file = sceneCacheFile(summary.battle.session_hex)
  const cached = await readCachedScene(file)
  if (cached) return { status: 'ok', sceneGzip: cached }

  const existing = inflightScenes.get(sessionId)
  if (existing) return existing
  if (activeBuilds >= MAX_ACTIVE_BUILDS) return { status: 'busy' }

  activeBuilds += 1
  const job = (async (): Promise<BattleSceneResult> => {
    const blob = getSiteBattleEventsBlob(sessionId)
    if (!blob || blob.byteLength === 0) return { status: 'no_events' }

    const battle = summary.battle
    const balanceLevel = battleBalanceLevel(battle.start_time)
    // Maps drawn from the game client first: their view is the scene's world rect. Either may fail
    // alone: without the ground maps the scene falls back to a snapshot and the air view takes its
    // perspective from the air map's bases; without the air map there is no air view.
    const [gameMaps, airMap] = battle.mission_settings
      ? await Promise.all([
          ensureGameTacticalMaps(battle.mission_settings, { balanceLevel, size: SCENE_MAP_SIZE, priority: 'interactive' }).catch(() => null),
          ensureGameAirMap(battle.mission_settings, { balanceLevel, priority: 'interactive' }).catch(() => null),
        ])
      : [null, null]
    const mission = gameMaps
      ? { area: { ...gameMaps.A.meta.view } }
      : battle.mission_settings
        ? await fetchMissionInfo(battle.mission_settings, 'interactive').catch(() => null)
        : null
    // The map covers the mission's battleArea: without it no map is needed,
    // and the player draws a grid and zones.
    const mapAvailable = gameMaps !== null || (mission?.area ? (await sceneMapImage(battle.mission_name, battle.level)) !== null : false)
    const botSlots = new Map(
      summary.players.flatMap((player) => (player.bot_user_id ? [[player.bot_user_id, player.user_id] as const] : [])),
    )

    const scene: ScenePrepareInput = {
      sessionId: battle.session_id,
      missionName: battle.mission_name,
      gameMode: battle.game_mode,
      startTime: battle.start_time,
      durationSec: battle.duration_sec,
      teamWon: battle.team_won,
      missionArea: mission?.area ?? null,
      mapAvailable,
      mapSpawns: gameMaps?.A.meta.spawns ?? null,
      level: battle.level,
      // Team ≤ 0 is unknown; a paired bot slot's tracks belong to its player.
      players: summary.players
        .filter((player) => player.user_id !== '' && player.team > 0 && !botSlots.has(player.user_id))
        .map((player) => ({
          userId: player.user_id,
          nick: player.nick,
          team: player.team,
          clanTag: player.clan_tag || null,
        })),
      botSlots: [...botSlots],
    }
    const air = airMap
      ? { view: airMap.spec.view, spawns: airMap.spec.spawns, paddingPercent: config.heatmapOptions.airPaddingPercent }
      : null

    // An exact ArrayBuffer, no SharedArrayBuffer branch: a copy of just the slice.
    const eventsAb = new ArrayBuffer(blob.byteLength)
    new Uint8Array(eventsAb).set(blob)
    const prepared = await runWorkerTask(
      { kind: 'prepare-scene', input: { eventsBlob: eventsAb, scene, air } },
      { priority: 'interactive', timeoutMs: SCENE_TIMEOUT_MS, transferList: [eventsAb] },
    )
    const sceneGzip = Buffer.from(prepared.scene)
    // The air view before the scene that names it (map.png?kind=air draws from it). Like the PNG
    // artifacts: saved even with the read cache disabled, atomically, under the shared LRU cap.
    if (prepared.air) await writeFileAtomic(sceneAirFile(battle.session_hex), `${JSON.stringify(prepared.air)}\n`).catch(() => undefined)
    if (sceneGzip.byteLength <= MAX_SCENE_BYTES) {
      await writeFileAtomic(file, sceneGzip).catch(() => undefined)
      await enforceBattleCacheCap(sceneGzip.byteLength).catch(() => undefined)
    }
    return { status: 'ok', sceneGzip }
  })().finally(() => {
    activeBuilds -= 1
    inflightScenes.delete(sessionId)
  })
  inflightScenes.set(sessionId, job)
  return job
}

/**
 * The scene's background, as the ground heatmap's: the snapshot of the
 * mission's mode (wt-tools, exactly battleArea; downloaded once into
 * data/maps), else the old local level map. The scene used to take only the
 * local one, which few levels have.
 */
async function sceneMapImage(missionName: string, level: string): Promise<Buffer | null> {
  return (await ensureTacticalMap(missionName).catch(() => null))
    ?? (await loadLocalTacticalMap(level).catch(() => null))
}

/** The scene's map size: the player's canvas scales it. */
const SCENE_MAP_SIZE = 1400

/**
 * The scene's air view as a JPEG: drawn on its first request (a worker task,
 * single-flight per session) from the view the scene build saved, then read
 * from the cache. A browser may keep a scene whose files the LRU evicted: the
 * scene is built again then.
 */
async function loadSceneAirMap(
  sessionId: string,
  battle: { session_hex: string; mission_settings: string | null; start_time: number },
): Promise<{ data: Buffer; mime: 'image/jpeg' } | null> {
  const hex = battle.session_hex
  const image = sceneAirMapFile(hex)
  const cached = await readOptional(image)
  if (cached && isJpeg(cached)) return { data: cached, mime: 'image/jpeg' }
  let job = inflightAirMaps.get(hex)
  if (!job) {
    job = (async () => {
      try {
        let air = await readSceneAir(hex)
        if (!air) {
          await buildBattleSceneGzip(sessionId)
          air = await readSceneAir(hex)
        }
        if (!air || !battle.mission_settings) return null
        const map = await ensureGameAirMap(battle.mission_settings, { balanceLevel: battleBalanceLevel(battle.start_time), priority: 'interactive' })
        if (!map) return null
        const jpeg = Buffer.from(await runWorkerTask(
          { kind: 'compose-tactical-map', input: { map, view: air.view, size: SCENE_MAP_SIZE, team: air.team } },
          { priority: 'interactive', timeoutMs: AIR_MAP_TIMEOUT_MS },
        ))
        await writeFileAtomic(image, jpeg).catch(() => undefined)
        await enforceBattleCacheCap(jpeg.byteLength).catch(() => undefined)
        return { data: jpeg, mime: 'image/jpeg' as const }
      } catch (error) {
        console.warn(`[maps] air view ${hex}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      } finally {
        inflightAirMaps.delete(hex)
      }
    })()
    inflightAirMaps.set(hex, job)
  }
  return job
}

/**
 * The battle's map for the player; null when there is none. kind "air": the
 * scene's air view (loadSceneAirMap). With `team` (the scene's map.team) the
 * game-file ground map of that perspective, built on a miss (a worker task,
 * single-flight); otherwise only from disk: the wt-tools snapshot is
 * downloaded by the scene build, and the player asks for the map only when the
 * scene announced it.
 */
export async function loadBattleSceneMap(
  sessionId: string,
  team: Team | null = null,
  kind: 'ground' | 'air' = 'ground',
): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' } | null> {
  const summary = getSiteBattleSummary(sessionId)
  if (!summary) return null
  const battle = summary.battle
  if (kind === 'air') return loadSceneAirMap(sessionId, battle)
  if (team && battle.mission_settings) {
    const map = await ensureGameTacticalMap(battle.mission_settings, {
      team,
      balanceLevel: battleBalanceLevel(battle.start_time),
      size: SCENE_MAP_SIZE,
      priority: 'interactive',
    }).catch(() => null)
    if (map) return { data: map.image, mime: map.mime }
  }
  const snapshot = (await loadCachedTacticalMap(battle.mission_name).catch(() => null))
    ?? (await loadLocalTacticalMap(battle.level).catch(() => null))
  return snapshot ? { data: snapshot, mime: 'image/png' } : null
}
