import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { runWorkerTask, type WorkerPriority } from '../workers/pool.js'
import { findWarThunderGameDir } from '../wrpl/wt-fonts.js'
import { TACTICAL_MAP_VERSION, type TacticalMapMeta } from './build.js'
import { TACTICAL_MAP_SOURCES } from './game-files.js'
import type { Team } from './model.js'
import { balanceBucket } from './perspective.js'

/**
 * Tactical maps drawn from the local game client (build.ts in a CPU worker),
 * cached in data/maps/game/ as <mission>-<team>-r<rank>-<size>-<hash>.jpg plus
 * its .json meta. The hash covers the mission, TACTICAL_MAP_VERSION and the
 * size and mtime of every game file the map is built from: a game patch or a
 * drawing change rebuilds it, and the older variant is deleted.
 *
 * The map shows the respawn screen as a team sees it (its bases blue, the
 * hatch of its battle areas); which replay team stands at which mission team's
 * spawn differs from battle to battle (40 recent battles: 18 and 22), so both
 * perspectives are built and the renderer picks by the players' first
 * positions (pickPerspective).
 */

const CACHE_DIR = './data/maps/game'
const FONT_DIR = './data/fonts'
const BUILD_TIMEOUT_MS = 60_000
/** A failed build is not retried for this long (a broken mission, a missing texture). */
const FAILURE_TTL_MS = 10 * 60_000
const GAME_DIR_TTL_MS = 10 * 60_000

export interface GameTacticalMap {
  image: Buffer
  mime: 'image/png' | 'image/jpeg'
  meta: TacticalMapMeta
}

export type GameTacticalMaps = Record<Team, GameTacticalMap>

let gameDirCache: { dir: string | null; at: number } | null = null

/** The game folder with every source of the map, or null; re-probed every GAME_DIR_TTL_MS. */
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
  const parts = await Promise.all(Object.values(TACTICAL_MAP_SOURCES).map(async (rel) => {
    const info = await stat(path.join(dir, ...rel.split('/')))
    return `${rel}=${info.size}:${Math.round(info.mtimeMs)}`
  }))
  return parts.join(';')
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
const failures = new Map<string, number>()

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
  const mission = request.missionSettings.trim().toLowerCase().replace(/\\/g, '/')
  if (!MISSION_PATTERN.test(mission)) return null
  const dir = await gameDir()
  if (!dir) return null
  const bucket = balanceBucket(request.balanceLevel)
  const stem = `${path.basename(mission, '.blk')}-${request.team}-r${bucket}-${request.size}`
  const hash = createHash('sha256')
    .update(`${mission}\n${TACTICAL_MAP_VERSION}\n${await sourcesStamp(dir)}`)
    .digest('hex')
    .slice(0, 12)
  const file = path.join(CACHE_DIR, `${stem}-${hash}.jpg`)
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
      await pruneVariants(stem, path.basename(file))
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

/** Deletes other builds of the same mission, team, rank and size (an older game or drawing version). */
async function pruneVariants(stem: string, keep: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(CACHE_DIR)
  } catch {
    return
  }
  const keepStem = keep.replace(/\.jpg$/, '')
  await Promise.all(names
    .filter((name) => name.startsWith(`${stem}-`) && !name.startsWith(keepStem))
    .map((name) => rm(path.join(CACHE_DIR, name), { force: true }).catch(() => undefined)))
}

/** One perspective of a mission's map; null without the game client or for a mission it cannot build. */
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

/** For tests: forget the game folder probe. */
export function resetGameTacticalMapsForTests(): void {
  gameDirCache = null
  failures.clear()
}

export { CACHE_DIR as GAME_MAP_CACHE_DIR }
export { balanceBucket, balanceLevelOfBr, pickPerspective } from './perspective.js'
export type { TacticalMapMeta }
