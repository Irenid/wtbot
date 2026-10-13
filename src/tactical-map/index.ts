import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { runWorkerTask, type WorkerPriority } from '../workers/pool.js'
import { findWarThunderGameDir } from '../wrpl/wt-fonts.js'
import { TACTICAL_MAP_OPTIONAL_SOURCES, TACTICAL_MAP_SOURCES } from './game-files.js'
import type { Team } from './model.js'
import { balanceBucket } from './perspective.js'
import { LABEL_FONT_FILE, TACTICAL_MAP_VERSION, type TacticalMapMeta, type TacticalMapSpec } from './spec.js'

/**
 * Tactical maps drawn from the local game client (build.ts in a CPU worker),
 * cached in data/maps/game/: a ground map as <mission>-<team>-r<bucket>-<size>-<hash>.jpg
 * plus its .json meta, an air map as its spec <mission>-air-r<bucket>-<hash>.json
 * (drawn for each heatmap's view by the worker that renders it; bucket:
 * balanceBucket of the battle's rank). The hash covers the mission,
 * TACTICAL_MAP_VERSION and the size and mtime of every game file the map is
 * built from (the HQ pack's presence too): a game patch or a drawing change
 * rebuilds it, and the mission's files of an older hash are deleted.
 *
 * The ground map shows the respawn screen as a team sees it (its bases blue,
 * the hatch of its battle areas); which replay team stands at which mission
 * team's spawn differs from battle to battle (40 recent battles: 18 and 22),
 * so both perspectives are built and the renderer picks by the players' first
 * positions (pickPerspective).
 */

const CACHE_DIR = './data/maps/game'
const FONT_DIR = './data/fonts'
const BUILD_TIMEOUT_MS = 60_000
/** A failed build is not retried for this long (a broken mission, a missing texture). */
const FAILURE_TTL_MS = 10 * 60_000
const GAME_DIR_TTL_MS = 10 * 60_000
const MAX_SPEC_BYTES = 4 * 1024 * 1024

export interface GameTacticalMap {
  image: Buffer
  mime: 'image/png' | 'image/jpeg'
  meta: TacticalMapMeta
}

export type GameTacticalMaps = Record<Team, GameTacticalMap>

/** An air map for a worker to draw: its spec, the game folder its texture is read from, the label font. */
export interface GameAirMap {
  spec: TacticalMapSpec
  gameDir: string
  fontFile: string | null
}

let gameDirCache: { dir: string | null; at: number } | null = null

/** The game folder with every required source of the map, or null; re-probed every GAME_DIR_TTL_MS. */
async function gameDir(): Promise<string | null> {
  if (gameDirCache && Date.now() - gameDirCache.at < GAME_DIR_TTL_MS) return gameDirCache.dir
  const dir = await findWarThunderGameDir()
  let complete = dir !== null
  if (dir) {
    for (const rel of Object.values(TACTICAL_MAP_SOURCES)) {
      try {
        await stat(path.join(dir, ...rel.split('/')))
      } catch {
        complete = false
        break
      }
    }
  }
  if (!complete && gameDirCache?.dir !== null) {
    console.warn(`[maps] game client ${dir ? `${dir} lacks a map source` : 'not found'}: tactical maps fall back to snapshots (WT_GAME_DIR)`)
  }
  gameDirCache = { dir: complete ? dir : null, at: Date.now() }
  return gameDirCache.dir
}

async function sourcesStamp(dir: string): Promise<string> {
  const required = Object.values(TACTICAL_MAP_SOURCES).map(async (rel) => {
    const info = await stat(path.join(dir, ...rel.split('/')))
    return `${rel}=${info.size}:${Math.round(info.mtimeMs)}`
  })
  const optional = Object.values(TACTICAL_MAP_OPTIONAL_SOURCES).map(async (rel) => {
    try {
      const info = await stat(path.join(dir, ...rel.split('/')))
      return `${rel}=${info.size}:${Math.round(info.mtimeMs)}`
    } catch {
      return `${rel}=none`
    }
  })
  return (await Promise.all([...required, ...optional])).join(';')
}

const MISSION_PATTERN = /^gamedata\/missions\/[a-z0-9_./-]+\.blk$/

interface MapRequest {
  missionSettings: string
  team: Team
  balanceLevel: number
  size: number
  priority: WorkerPriority
}

const inflight = new Map<string, Promise<GameTacticalMap | null>>()
const inflightSpecs = new Map<string, Promise<TacticalMapSpec | null>>()
const failures = new Map<string, number>()

function normalizedMission(missionSettings: string): string | null {
  const mission = missionSettings.trim().toLowerCase().replace(/\\/g, '/')
  return MISSION_PATTERN.test(mission) ? mission : null
}

async function cacheHash(mission: string, dir: string): Promise<string> {
  return createHash('sha256')
    .update(`${mission}\n${TACTICAL_MAP_VERSION}\n${await sourcesStamp(dir)}`)
    .digest('hex')
    .slice(0, 12)
}

async function readCached(file: string): Promise<GameTacticalMap | null> {
  try {
    const [image, metaText] = await Promise.all([readFile(file), readFile(file.replace(/\.jpg$/, '.json'), 'utf8')])
    const meta = JSON.parse(metaText) as TacticalMapMeta
    return meta.version === TACTICAL_MAP_VERSION ? { image, mime: 'image/jpeg', meta } : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function ensureOne(request: MapRequest): Promise<GameTacticalMap | null> {
  const mission = normalizedMission(request.missionSettings)
  if (!mission) return null
  const dir = await gameDir()
  if (!dir) return null
  const bucket = balanceBucket(request.balanceLevel)
  const hash = await cacheHash(mission, dir)
  const file = path.join(CACHE_DIR, `${path.basename(mission, '.blk')}-${request.team}-r${bucket}-${request.size}-${hash}.jpg`)
  const cached = await readCached(file)
  if (cached) return cached
  if ((failures.get(file) ?? 0) > Date.now()) return null

  const running = inflight.get(file)
  if (running) return running
  const job = (async (): Promise<GameTacticalMap | null> => {
    try {
      const built = await runWorkerTask(
        {
          kind: 'build-tactical-map',
          input: { gameDir: dir, mission, team: request.team, balanceLevel: bucket, size: request.size, format: 'jpeg', fontDir: path.resolve(FONT_DIR) },
        },
        { priority: request.priority, timeoutMs: BUILD_TIMEOUT_MS },
      )
      const image = Buffer.from(built.image)
      await writeFileAtomic(file.replace(/\.jpg$/, '.json'), `${JSON.stringify(built.meta)}\n`)
      await writeFileAtomic(file, image)
      await pruneStaleMaps(mission, hash)
      return { image, mime: built.mime, meta: built.meta }
    } catch (error) {
      failures.set(file, Date.now() + FAILURE_TTL_MS)
      console.warn(`[maps] ${mission} (${request.team}): ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      inflight.delete(file)
    }
  })()
  inflight.set(file, job)
  return job
}

/** A cache file: <mission>-<A|B|air>-r<bucket>[-<size>]-<hash>.<jpg|json>. */
const CACHE_FILE = /^(.+)-(?:A|B|air)-r\d+(?:-\d+)?-([0-9a-f]{12})\.(?:jpg|json)$/

/**
 * Deletes the mission's builds of another hash (an older game or drawing
 * version) of any team, bucket and size: a bucket BALANCE_LEVEL_THRESHOLDS no
 * longer has is never rebuilt, so its files would stay.
 */
export async function pruneStaleMaps(mission: string, hash: string, dir = CACHE_DIR): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const base = path.basename(mission, '.blk')
  await Promise.all(names
    .filter((name) => {
      const match = CACHE_FILE.exec(name)
      return match !== null && match[1] === base && match[2] !== hash
    })
    .map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)))
}

/** One perspective of a mission's ground map; null without the game client or for a mission it cannot build. */
export function ensureGameTacticalMap(
  missionSettings: string,
  options: { team: Team; balanceLevel: number; size?: number; priority?: WorkerPriority },
): Promise<GameTacticalMap | null> {
  return ensureOne({ missionSettings, team: options.team, balanceLevel: options.balanceLevel, size: options.size ?? 1400, priority: options.priority ?? 'normal' })
}

/** Both perspectives (built in parallel); null when either is unavailable. */
export async function ensureGameTacticalMaps(
  missionSettings: string,
  options: { balanceLevel: number; size?: number; priority?: WorkerPriority },
): Promise<GameTacticalMaps | null> {
  const [a, b] = await Promise.all((['A', 'B'] as const).map((team) => ensureGameTacticalMap(missionSettings, { ...options, team })))
  return a && b ? { A: a, B: b } : null
}

async function readCachedSpec(file: string): Promise<TacticalMapSpec | null> {
  try {
    if ((await stat(file)).size > MAX_SPEC_BYTES) return null
    const spec = JSON.parse(await readFile(file, 'utf8')) as TacticalMapSpec
    return spec.version === TACTICAL_MAP_VERSION && spec.kind === 'air' ? spec : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

/**
 * A mission's air map (the map of aircraft: the level's whole air texture, its
 * grid, every base): the spec, built once per game version and rank bucket; a
 * worker draws the view it needs (composeTacticalMap). Null without the game
 * client or for a mission it cannot build.
 */
export async function ensureGameAirMap(
  missionSettings: string,
  options: { balanceLevel: number; priority?: WorkerPriority },
): Promise<GameAirMap | null> {
  const mission = normalizedMission(missionSettings)
  if (!mission) return null
  const dir = await gameDir()
  if (!dir) return null
  const bucket = balanceBucket(options.balanceLevel)
  const hash = await cacheHash(mission, dir)
  const file = path.join(CACHE_DIR, `${path.basename(mission, '.blk')}-air-r${bucket}-${hash}.json`)
  const fontFile = path.resolve(FONT_DIR, LABEL_FONT_FILE)
  const withFont = async (spec: TacticalMapSpec | null): Promise<GameAirMap | null> =>
    spec ? { spec, gameDir: dir, fontFile: await stat(fontFile).then(() => fontFile, () => null) } : null
  const cached = await readCachedSpec(file)
  if (cached) return withFont(cached)
  if ((failures.get(file) ?? 0) > Date.now()) return null

  let job = inflightSpecs.get(file)
  if (!job) {
    job = (async (): Promise<TacticalMapSpec | null> => {
      try {
        const spec = await runWorkerTask(
          { kind: 'build-tactical-map-spec', input: { gameDir: dir, mission, balanceLevel: bucket, kind: 'air', fontDir: path.resolve(FONT_DIR) } },
          { priority: options.priority ?? 'normal', timeoutMs: BUILD_TIMEOUT_MS },
        )
        await writeFileAtomic(file, `${JSON.stringify(spec)}\n`)
        await pruneStaleMaps(mission, hash)
        return spec
      } catch (error) {
        failures.set(file, Date.now() + FAILURE_TTL_MS)
        console.warn(`[maps] ${mission} (air): ${error instanceof Error ? error.message : String(error)}`)
        return null
      } finally {
        inflightSpecs.delete(file)
      }
    })()
    inflightSpecs.set(file, job)
  }
  return withFont(await job)
}

/** For tests: forget the game folder probe. */
export function resetGameTacticalMapsForTests(): void {
  gameDirCache = null
  failures.clear()
}

export { CACHE_DIR as GAME_MAP_CACHE_DIR }
export { balanceBucket, balanceLevelOfBr, pickPerspective } from './perspective.js'
export type { TacticalMapMeta, TacticalMapSpec }
