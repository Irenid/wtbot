import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { config } from '../config.js'
import { isLocale, type Locale } from '../i18n/index.js'
import { mapConcurrent } from '../concurrency.js'
import { getBattleWeaponIds, getScoutStages } from '../db/index.js'
import { stageAt } from '../clan-season.js'
import { balanceLevelOfBr, ensureGameAirMap, ensureGameTacticalMaps, type GameAirMap, type GameTacticalMaps } from '../tactical-map/index.js'
import {
  runWorkerTask,
  transferableBuffer,
  transferableCopy,
  type WorkerPriority,
  type WorkerTaskControl,
} from '../workers/pool.js'
import type { BattleEventSummary, WireGameMaps } from '../workers/protocol.js'
import { loadBattleData, reconstructBattle, type BattleItemMeta } from './battle-data.js'
import {
  ensureTacticalMap,
  ensureWeaponSeekers,
  loadLocalTacticalMap,
  loadMapBackground,
  loadMapIconFontPath,
  type MissileSeeker,
} from './battle-assets.js'
import { fetchMissionInfo, type MissionInfo } from './mission-info.js'
import { withUnlistedReplayParts, type ReplayResults, type WrplHeader } from './replay.js'
import { ensureVehicleDict, promoteVehicleDictLoad } from './vehicles.js'
import { ensureGameFonts, promoteGameFontLoad } from './wt-fonts.js'
import {
  heatmapSelection,
  isBattleHeatmapKind,
  type BattleHeatmapKind,
  type BattleMediaKind,
} from './battle-media-kind.js'

export type { BattleHeatmapKind, BattleMediaKind } from './battle-media-kind.js'

/**
 * Battle media: the log, heatmaps and chat. Disk, network and SQLite stay on
 * the main thread; event unpacking and JSON, SVG and Resvg run in a CPU
 * worker. A Discord button builds one artifact, the `battle` CLI the full
 * set; each artifact is built and cached per language.
 */

const CACHE_DIR = './data/battles'
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CHAT_BYTES = 2 * 1024 * 1024
const ALL_MEDIA_KINDS: readonly BattleMediaKind[] = [
  'log',
  'heatmap-ground',
  'heatmap-air',
  'heatmap-team-0',
  'heatmap-team-1',
  'heatmap-team-air-0',
  'heatmap-team-air-1',
  'chat',
]
const mediaKinds = new Set<string>(ALL_MEDIA_KINDS)
const CACHE_TOUCH_INTERVAL_MS = 60_000
const MAX_TRACKED_CACHE_TOUCHES = 4096
const cacheLastTouchedAt = new Map<string, number>()
const CACHE_CATALOG_RECONCILE_MS = 5 * 60_000
const CACHE_SCAN_THRESHOLD = 0.9
const CACHE_SCAN_CONCURRENCY = 16

export interface BattleMedia {
  log: Buffer
  heatmapGround: Buffer
  heatmapAir: Buffer | null
  heatmapTeamGround: [Buffer, Buffer]
  heatmapTeamAir: [Buffer, Buffer] | null
  chat: string
}

export interface BuiltBattleMedia extends BattleMedia {
  header: WrplHeader
  summary: BattleEventSummary
}

/** One file per language: the media draws the catalog's text (src/i18n). */
const cacheFile = (sessionIdHex: string, kind: BattleMediaKind, locale: Locale): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}.${locale}${kind === 'chat' ? '.txt' : '.png'}`)

const highResCacheFile = (sessionIdHex: string, kind: BattleHeatmapKind, locale: Locale): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}@2x-${BATTLE_MEDIA_RENDER_VARIANT}.${locale}.png`)

/** A cache hit without a synchronous read of a large PNG on the Discord event loop. */
export async function cachedBattleMedia(sessionIdHex: string, kind: BattleMediaKind, locale: Locale): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  const metadata = await cachedBattleMeta(sessionIdHex)
  if (!metadata?.artifacts[locale]?.includes(kind)) return null
  const file = cacheFile(sessionIdHex, kind, locale)
  try {
    const maxBytes = kind === 'chat' ? MAX_CHAT_BYTES : MAX_IMAGE_BYTES
    if ((await stat(file)).size > maxBytes) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const data = await readFile(file)
    if (kind !== 'chat' && !isPng(data)) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface BattleMeta {
  version?: typeof BATTLE_MEDIA_VERSION
  renderOptions?: string
  teamWon: number
  endTimeMs: number
  hasAir: boolean
  hasChat: boolean
  /** The published artifacts of each language. */
  artifacts: BattleArtifactsByLocale
}

export type BattleArtifactsByLocale = Partial<Record<Locale, BattleMediaKind[]>>

/** The lazy 2× cache of one chosen map; the ordinary bundle is not rebuilt for it. */
export async function cachedBattleHeatmap2x(
  sessionIdHex: string,
  kind: BattleHeatmapKind,
  locale: Locale,
): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  if (!(await cachedBattleMeta(sessionIdHex))) return null
  const file = highResCacheFile(sessionIdHex, kind, locale)
  try {
    if ((await stat(file)).size > MAX_IMAGE_BYTES) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const data = await readFile(file)
    if (!isPng(data)) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// 42: 2.59 replays (zstd stream, new ECS byte) — older images of these battles are empty.
// 43: bot slot tracks, kills and damage credited to their players (player-events.ts).
// 44: icons and missile seekers of mixed-case ids, wt-tools maps with "-", "()" or
// diacritics in the key.
// 45: chat senders get the squadron tags the game left out (squadron-tags.ts).
// 46: maps from the HQ textures; air heatmaps on the game's air map (src/tactical-map).
// 47: player slots the AI drove (DB v22 slot_nick) and bots that filled an empty place get rows.
// 48: air heatmaps show the bases where squadron battles spawn (runways, bombers' air spawns, the rank's airfields).
// 49: a stage's first night window keeps the previous cap's maps (battleBalanceLevel by stageAt).
// 50: ground maps outline the spawn detection zones (TACTICAL_MAP_VERSION 4).
// 51: texts from the WT_BOT_LOCALE catalog (src/i18n), English by default.
// 52: one artifact per language: servers and users read the bot in their own (src/bot/locale.ts).
// 53: heatmaps: a colour family per team, named tracks, a muted map, fewer and smaller markers.
// 54: vehicle icons cut by the datamine's tile fade out at the cut (unit-icon-edges.ts).
// 55: ground maps: brighter spawn detection outlines and out-of-bounds hatch (TACTICAL_MAP_VERSION 5).
// 56: detection outlines without the grey halo, thinner (TACTICAL_MAP_VERSION 6).
// 57: the ground heatmap draws no kill line for a plane's or helicopter's kill.
// 58: heatmap track colours from the static per-team-size table (heatmap-palette.ts).
// 59: that table with wider hue arcs for crowded teams (worst pair 0.096 instead of 0.054).
// 60: the out-of-bounds hatch always red, its lightness set against the map (TACTICAL_MAP_VERSION 7).
// 61: the palette searched again: each team keeps its hue family (balanced teams no green or
// magenta, a bigger team takes them), no dark yellows or dull darks; ground pairs 4..8 tell a
// team's tracks apart by ΔE 0.12 at worst instead of 0.089.
// 62: the map keeps the game's colours (no tint or shade) and the palette is searched again against it
// (tracks ΔE ≥ 0.15 from the ground, 0.112 apart at worst); the out-of-bounds hatch as thin red lines,
// their lightness set against the ground under them (TACTICAL_MAP_VERSION 8).
const BATTLE_MEDIA_VERSION = 62
/** What the artifacts depend on beyond the version and their language: a changed heatmap option redraws them. */
const BATTLE_MEDIA_RENDER_OPTIONS = JSON.stringify({ heatmap: config.heatmapOptions })
const BATTLE_MEDIA_RENDER_VARIANT = createHash('sha256')
  .update(`${BATTLE_MEDIA_VERSION}:${BATTLE_MEDIA_RENDER_OPTIONS}`)
  .digest('hex')
  .slice(0, 12)

export async function cachedBattleMeta(sessionIdHex: string): Promise<BattleMeta | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  const metadata = await readBattleMetaFile(sessionIdHex)
  if (metadata) await touchBattleBundle(sessionIdHex)
  return metadata
}

async function readBattleMetaFile(sessionIdHex: string): Promise<BattleMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(CACHE_DIR, `${sessionIdHex}-meta.json`), 'utf8'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as BattleMeta).version === BATTLE_MEDIA_VERSION &&
      (parsed as BattleMeta).renderOptions === BATTLE_MEDIA_RENDER_OPTIONS &&
      Number.isFinite((parsed as BattleMeta).teamWon) &&
      Number.isFinite((parsed as BattleMeta).endTimeMs) &&
      typeof (parsed as BattleMeta).hasAir === 'boolean' &&
      typeof (parsed as BattleMeta).hasChat === 'boolean' &&
      isArtifactsByLocale((parsed as BattleMeta).artifacts)
    ) {
      return parsed as BattleMeta
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function isArtifactsByLocale(value: unknown): value is BattleArtifactsByLocale {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([locale, kinds]) =>
      isLocale(locale) &&
      Array.isArray(kinds) &&
      kinds.every((kind) => typeof kind === 'string' && mediaKinds.has(kind)))
}

/**
 * The artifact lists after publishing `kinds` in `locale`: added to that
 * language's list, or replacing it (a full bundle); the other languages' stay.
 */
export function publishedArtifacts(
  existing: BattleArtifactsByLocale | undefined,
  locale: Locale,
  kinds: readonly BattleMediaKind[],
  replace: boolean,
): BattleArtifactsByLocale {
  const available = new Set<BattleMediaKind>(replace ? [] : existing?.[locale] ?? [])
  for (const kind of kinds) available.add(kind)
  return { ...existing, [locale]: ALL_MEDIA_KINDS.filter((kind) => available.has(kind)) }
}

interface MediaBuildState {
  priority: WorkerPriority
  workerControls: Set<WorkerTaskControl>
}

const inflightBuilds = new Map<string, { promise: Promise<BuiltBattleMedia>; state: MediaBuildState }>()
const inflightHeatmapBuilds = new Map<string, { promise: Promise<Buffer>; state: MediaBuildState }>()
const inflightMediaKindBuilds = new Map<string, { promise: Promise<Buffer>; state: MediaBuildState }>()
const activeCacheSessions = new Map<string, number>()

function acquireCacheSession(sessionIdHex: string): void {
  activeCacheSessions.set(sessionIdHex, (activeCacheSessions.get(sessionIdHex) ?? 0) + 1)
}

function releaseCacheSession(sessionIdHex: string): void {
  const remaining = (activeCacheSessions.get(sessionIdHex) ?? 1) - 1
  if (remaining > 0) activeCacheSessions.set(sessionIdHex, remaining)
  else activeCacheSessions.delete(sessionIdHex)
}

/** Renders only the requested heatmap at 2×, without the battle's other media. */
export function buildBattleHeatmap2x(
  sessionId: string,
  partUrls: string[],
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  locale: Locale,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const sessionHex = toSessionHex(sessionId)
  const key = `${sessionHex}:${kind}:2:${locale}`
  const running = inflightHeatmapBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleHeatmap2x(sessionId, partUrls, kind, meta, locale, realNames, state).finally(() => {
    inflightHeatmapBuilds.delete(key)
    releaseCacheSession(sessionHex)
  })
  inflightHeatmapBuilds.set(key, { promise: build, state })
  return build
}

async function doBuildBattleHeatmap2x(
  sessionId: string,
  partUrls: string[],
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  locale: Locale,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<Buffer> {
  const source = await loadBattleRenderSource(sessionId, partUrls, meta, realNames, state)
  const missionName = meta.missionName ?? source.header.locName ?? ''
  const trackMission = workerControlTracker(state)
  const selection = heatmapSelection(kind)
  const [gameMaps, airMap] = await Promise.all([
    battleGameMaps(source.missionSettings, source.header, 2, state),
    selection.mode === 'air' ? battleAirMap(source.missionSettings, source.header, state) : null,
  ])
  const [dict, mission, gameFontFiles, seekers, mapIconFont] = await Promise.all([
    ensureVehicleDict(state.priority),
    gameMaps
      ? Promise.resolve(gameMapMission(gameMaps))
      : source.missionSettings
        ? fetchMissionInfo(source.missionSettings, () => state.priority, trackMission)
        : Promise.resolve(null),
    ensureGameFonts(state.priority),
    ensureWeaponSeekers(source.weaponIds),
    loadMapIconFontPath(),
  ])
  const fontFiles = mapIconFont ? [...gameFontFiles, mapIconFont] : gameFontFiles
  const tacticalMap = !gameMaps && mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(source.header.level))
    : null
  const fallbackMap = await loadMapBackground(source.header.level)
  const wireBlob = transferableBuffer(source.eventsBlob)
  const wireTacticalMap = tacticalMap ? transferableBuffer(tacticalMap) : null
  const wireMaps = wireGameMaps(gameMaps)
  const wireFallbackMap = fallbackMap
    ? {
        mime: fallbackMap.mime,
        data: transferableBuffer(fallbackMap.data),
        ...(fallbackMap.viewport ? { viewport: fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
  if (wireMaps) transferList.push(wireMaps.A.data, wireMaps.B.data)
  if (wireFallbackMap) transferList.push(wireFallbackMap.data)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-heatmap',
      input: {
        missionName,
        header: source.header,
        results: source.results,
        eventsBlob: wireBlob,
        dict,
        mission,
        heatmapOptions: config.heatmapOptions,
        locale,
        mode: selection.mode,
        ...(selection.teamIndex === undefined ? {} : { teamIndex: selection.teamIndex }),
        scale: 2,
        assets: {
          fontFiles,
          gameFont: gameFontFiles.length > 0,
          mapIconFont: mapIconFont !== null,
          tacticalMap: wireTacticalMap,
          gameMaps: wireMaps,
          airMap,
          fallbackMap: wireFallbackMap,
          seekers: [...seekers],
        },
      },
    },
    {
      priority: state.priority,
      transferList,
      timeoutMs: 120_000,
      onControl: (control) => trackRender(control),
    },
  ).finally(() => trackRender(null))
  const png = Buffer.from(rendered)
  if (png.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`the HD map is too large: ${(png.byteLength / 1024 / 1024).toFixed(1)} MiB`)
  }
  // The cache flag controls reuse; every render is saved regardless.
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFileAtomic(highResCacheFile(source.header.sessionIdHex, kind, locale), png)
  await enforceCacheCap(png.byteLength)
  return png
}

interface BattleRenderSource {
  header: WrplHeader
  results: ReplayResults
  eventsBlob: Buffer
  missionSettings: string | null
  weaponIds: string[]
  parseErrors: string[]
}

/**
 * The battle to draw: its stored rows, else a parse of its replay that is
 * drawn but never stored. Only ingest writes a battle, after its checks
 * (final results, the item's roster): the parse here takes the same unlisted
 * tail parts and roster (`meta.listedUserIds`), keeps the cached parts for
 * ingest, and ingest's commit drops the artifacts drawn from it.
 */
async function loadBattleRenderSource(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<BattleRenderSource> {
  const stored = reconstructBattle(sessionId)
  if (stored?.eventsBlob) {
    return {
      header: stored.header,
      results: stored.results,
      eventsBlob: stored.eventsBlob,
      missionSettings: stored.missionSettings,
      weaponIds: getBattleWeaponIds(stored.header.sessionId),
      parseErrors: [],
    }
  }

  const trackLoad = workerControlTracker(state)
  const replayPriority = (): 'live' | 'background' => state.priority === 'background' ? 'background' : 'live'
  const loaded = await loadBattleData(
    await withUnlistedReplayParts(partUrls, { priority: replayPriority }),
    realNames,
    meta,
    () => state.priority,
    undefined,
    (control) => trackLoad(control),
  ).finally(() => trackLoad(null))
  const parseErrors = loaded.summary.errors
  if (parseErrors.length > 0) {
    console.warn(
      `[wrpl] events of ${loaded.header.sessionId}: ${parseErrors.length} parse errors, the first: ${parseErrors[0]}`,
    )
  }
  return {
    header: loaded.header,
    results: loaded.results,
    eventsBlob: loaded.battle.eventsBlob,
    missionSettings: loaded.battle.missionSettings,
    weaponIds: loaded.battle.kills.map((kill) => kill.weapon).filter(Boolean),
    parseErrors,
  }
}

let stagesCache: { at: number; stages: { startsAt: number; endsAt: number; maxBr: number }[] } | null = null

/**
 * The BR cap the battle played, by stageAt over every season's stages (the
 * night window of a stage's first day still plays the previous cap, also
 * across seasons); null outside the known stages.
 */
export function battleMaxBr(startTimeSec: number): number | null {
  if (!stagesCache || Date.now() - stagesCache.at > 10 * 60_000) {
    try {
      stagesCache = { at: Date.now(), stages: getScoutStages() }
    } catch {
      stagesCache = { at: Date.now(), stages: [] }
    }
  }
  return stageAt(stagesCache.stages, startTimeSec)?.maxBr ?? null
}

/** The battle's balance level (the air spawns of the mission depend on it): its cap's, outside the known stages the top tier. */
export function battleBalanceLevel(startTimeSec: number): number {
  const maxBr = battleMaxBr(startTimeSec)
  return maxBr === null ? 32 : balanceLevelOfBr(maxBr)
}

/** The game-file maps of a battle (both perspectives) and the mission area they cover. */
async function battleGameMaps(missionSettings: string | null, header: WrplHeader, scale: 1 | 2, state: MediaBuildState): Promise<GameTacticalMaps | null> {
  if (!missionSettings) return null
  return ensureGameTacticalMaps(missionSettings, {
    balanceLevel: battleBalanceLevel(header.startTime),
    size: 1400 * scale,
    priority: state.priority,
  }).catch(() => null)
}

/** The battle's air map (its spec: the worker draws each air heatmap's view); null without the game client. */
async function battleAirMap(missionSettings: string | null, header: WrplHeader, state: MediaBuildState): Promise<GameAirMap | null> {
  if (!missionSettings) return null
  return ensureGameAirMap(missionSettings, {
    balanceLevel: battleBalanceLevel(header.startTime),
    priority: state.priority,
  }).catch(() => null)
}

function gameMapMission(maps: GameTacticalMaps): MissionInfo {
  const view = maps.A.meta.view
  return { area: { ...view }, zones: maps.A.meta.zones.map((zone) => ({ letter: zone.letter, x: zone.x, z: zone.z })) }
}

/** Copies: parallel builds share one map object, and a transfer would detach it for the others. */
function wireGameMaps(maps: GameTacticalMaps | null): WireGameMaps | null {
  if (!maps) return null
  return {
    A: { mime: maps.A.mime, data: transferableCopy(maps.A.image) },
    B: { mime: maps.B.mime, data: transferableCopy(maps.B.image) },
    spawns: maps.A.meta.spawns,
  }
}

async function loadBattleRenderAssets(
  source: BattleRenderSource,
  missionName: string,
  state: MediaBuildState,
  needsHeatmap: boolean,
  needsFonts: boolean,
  needsAirMap = needsHeatmap,
) {
  const trackMission = workerControlTracker(state)
  // Maps drawn from the game client replace the datamine's mission area and the wt-tools snapshot.
  const [gameMaps, airMap] = await Promise.all([
    needsHeatmap ? battleGameMaps(source.missionSettings, source.header, 1, state) : null,
    needsAirMap ? battleAirMap(source.missionSettings, source.header, state) : null,
  ])
  const missionPromise = gameMaps
    ? Promise.resolve(gameMapMission(gameMaps))
    : needsHeatmap && source.missionSettings
      ? fetchMissionInfo(source.missionSettings, () => state.priority, trackMission)
      : Promise.resolve(null)
  const gameFontsPromise = needsFonts ? ensureGameFonts(state.priority) : Promise.resolve([] as string[])
  const seekersPromise = needsHeatmap
    ? ensureWeaponSeekers(source.weaponIds)
    : Promise.resolve(new Map<string, MissileSeeker>())
  const mapIconFontPromise = needsHeatmap ? loadMapIconFontPath() : Promise.resolve(null)
  const [dict, mission, gameFontFiles, seekers, mapIconFont] = await Promise.all([
    ensureVehicleDict(state.priority),
    missionPromise,
    gameFontsPromise,
    seekersPromise,
    mapIconFontPromise,
  ])
  const fontFiles = mapIconFont ? [...gameFontFiles, mapIconFont] : gameFontFiles
  const tacticalMap = needsHeatmap && !gameMaps && mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(source.header.level))
    : null
  const fallbackMap = needsHeatmap ? await loadMapBackground(source.header.level) : null
  return { dict, mission, gameFontFiles, fontFiles, seekers, mapIconFont, tacticalMap, gameMaps, airMap, fallbackMap }
}

function mediaWorkerPayload(
  source: BattleRenderSource,
  missionName: string,
  assets: Awaited<ReturnType<typeof loadBattleRenderAssets>>,
  locale: Locale,
) {
  const wireBlob = transferableBuffer(source.eventsBlob)
  const wireTacticalMap = assets.tacticalMap ? transferableBuffer(assets.tacticalMap) : null
  const wireMaps = wireGameMaps(assets.gameMaps)
  const wireFallbackMap = assets.fallbackMap
    ? {
        mime: assets.fallbackMap.mime,
        data: transferableBuffer(assets.fallbackMap.data),
        ...(assets.fallbackMap.viewport ? { viewport: assets.fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
  if (wireMaps) transferList.push(wireMaps.A.data, wireMaps.B.data)
  if (wireFallbackMap) transferList.push(wireFallbackMap.data)
  return {
    input: {
      missionName,
      header: source.header,
      results: source.results,
      eventsBlob: wireBlob,
      dict: assets.dict,
      mission: assets.mission,
      heatmapOptions: config.heatmapOptions,
      locale,
      assets: {
        fontFiles: assets.fontFiles,
        gameFont: assets.gameFontFiles.length > 0,
        mapIconFont: assets.mapIconFont !== null,
        tacticalMap: wireTacticalMap,
        gameMaps: wireMaps,
        airMap: assets.airMap,
        fallbackMap: wireFallbackMap,
        seekers: [...assets.seekers],
      },
    },
    transferList,
  }
}

function selectBuiltMedia(media: BuiltBattleMedia, kind: BattleMediaKind): Buffer | null {
  if (kind === 'log') return media.log
  if (kind === 'heatmap-ground') return media.heatmapGround
  if (kind === 'heatmap-air') return media.heatmapAir
  if (kind === 'heatmap-team-0') return media.heatmapTeamGround[0]
  if (kind === 'heatmap-team-1') return media.heatmapTeamGround[1]
  if (kind === 'heatmap-team-air-0') return media.heatmapTeamAir?.[0] ?? null
  if (kind === 'heatmap-team-air-1') return media.heatmapTeamAir?.[1] ?? null
  return Buffer.from(media.chat, 'utf8')
}

/** Builds one artifact in `locale`; a running full bundle of that language answers it instead. */
export function buildBattleMediaKind(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  kind: BattleMediaKind,
  locale: Locale,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const sessionHex = toSessionHex(sessionId)
  const runningBundle = inflightBuilds.get(`${sessionHex}:${locale}`)
  if (runningBundle) {
    promoteBuild(runningBundle.state, priority)
    return runningBundle.promise.then((media) => {
      const selected = selectBuiltMedia(media, kind)
      return selected ?? buildBattleMediaKind(sessionId, partUrls, meta, kind, locale, realNames, priority)
    })
  }

  const key = `${sessionHex}:${kind}:1:${locale}`
  const running = inflightMediaKindBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleMediaKind(sessionId, partUrls, meta, kind, locale, realNames, state).finally(() => {
    inflightMediaKindBuilds.delete(key)
    releaseCacheSession(sessionHex)
  })
  inflightMediaKindBuilds.set(key, { promise: build, state })
  return build
}

async function doBuildBattleMediaKind(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  kind: BattleMediaKind,
  locale: Locale,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<Buffer> {
  const source = await loadBattleRenderSource(sessionId, partUrls, meta, realNames, state)
  const missionName = meta.missionName ?? source.header.locName ?? ''
  const heatmap = isBattleHeatmapKind(kind)
  const assets = await loadBattleRenderAssets(
    source,
    missionName,
    state,
    heatmap,
    kind !== 'chat',
    heatmap && heatmapSelection(kind).mode === 'air',
  )
  const payload = mediaWorkerPayload(source, missionName, assets, locale)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-media-kind',
      input: { ...payload.input, kind },
    },
    {
      priority: state.priority,
      transferList: payload.transferList,
      timeoutMs: 120_000,
      onControl: (control) => trackRender(control),
    },
  ).finally(() => trackRender(null))
  const media = typeof rendered.media === 'string'
    ? Buffer.from(rendered.media, 'utf8')
    : Buffer.from(rendered.media)
  const maxBytes = kind === 'chat' ? MAX_CHAT_BYTES : MAX_IMAGE_BYTES
  if (media.byteLength > maxBytes) {
    throw new Error(
      `${kind === 'chat' ? 'the chat' : 'the image'} is too large: ${(media.byteLength / 1024 / 1024).toFixed(1)} MiB`,
    )
  }
  const summary = { ...rendered.summary, errors: source.parseErrors }
  await publishBattleArtifacts(
    source.header.sessionIdHex,
    [{ kind, data: media }],
    buildBattleMeta(summary, assets.dict),
    locale,
  )
  return media
}

/** Builds every artifact in `locale` (the `battle` CLI). */
export function buildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  locale: Locale,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<BuiltBattleMedia> {
  const sessionHex = toSessionHex(sessionId)
  const key = `${sessionHex}:${locale}`
  const running = inflightBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleMedia(sessionId, partUrls, meta, locale, realNames, state).finally(() => {
    inflightBuilds.delete(key)
    releaseCacheSession(sessionHex)
  })
  inflightBuilds.set(key, { promise: build, state })
  return build
}

async function doBuildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  locale: Locale,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<BuiltBattleMedia> {
  const source = await loadBattleRenderSource(sessionId, partUrls, meta, realNames, state)
  const { header, parseErrors } = source
  const missionName = meta.missionName ?? header.locName ?? ''
  const assets = await loadBattleRenderAssets(source, missionName, state, true, true)
  const payload = mediaWorkerPayload(source, missionName, assets, locale)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-media',
      input: payload.input,
    },
    {
      priority: state.priority,
      transferList: payload.transferList,
      timeoutMs: 120_000,
      onControl: (control) => trackRender(control),
    },
  ).finally(() => trackRender(null))
  const log = Buffer.from(rendered.log)
  const heatmapGround = Buffer.from(rendered.heatmapGround)
  const heatmapAir = rendered.heatmapAir ? Buffer.from(rendered.heatmapAir) : null
  const heatmapTeamGround: [Buffer, Buffer] = [
    Buffer.from(rendered.heatmapTeamGround[0]),
    Buffer.from(rendered.heatmapTeamGround[1]),
  ]
  const heatmapTeamAir: [Buffer, Buffer] | null = rendered.heatmapTeamAir
    ? [
        Buffer.from(rendered.heatmapTeamAir[0]),
        Buffer.from(rendered.heatmapTeamAir[1]),
      ]
    : null
  const summary = { ...rendered.summary, errors: parseErrors }
  const artifacts: BattleArtifact[] = [
    { kind: 'log', data: log },
    { kind: 'heatmap-ground', data: heatmapGround },
    { kind: 'heatmap-team-0', data: heatmapTeamGround[0] },
    { kind: 'heatmap-team-1', data: heatmapTeamGround[1] },
    { kind: 'chat', data: rendered.chat },
  ]
  if (heatmapAir && heatmapTeamAir) {
    artifacts.push(
      { kind: 'heatmap-air', data: heatmapAir },
      { kind: 'heatmap-team-air-0', data: heatmapTeamAir[0] },
      { kind: 'heatmap-team-air-1', data: heatmapTeamAir[1] },
    )
  }
  await publishBattleArtifacts(
    header.sessionIdHex,
    artifacts,
    buildBattleMeta(summary, assets.dict),
    locale,
    true,
  )

  return { log, heatmapGround, heatmapAir, heatmapTeamGround, heatmapTeamAir, chat: rendered.chat, header, summary }
}

function buildBattleMeta(
  summary: BattleEventSummary,
  dict: Awaited<ReturnType<typeof ensureVehicleDict>>,
): BattleMeta {
  return {
    version: BATTLE_MEDIA_VERSION,
    renderOptions: BATTLE_MEDIA_RENDER_OPTIONS,
    teamWon: summary.teamWon,
    endTimeMs: summary.endTimeMs,
    hasAir: summary.airModels.some((model) => {
      const vehicleClass = dict[model.replace(/^.*\//, '')]?.cls
      return vehicleClass === 'F' || vehicleClass === 'H'
    }),
    hasChat: summary.chat > 0,
    artifacts: {},
  }
}

interface BattleArtifact {
  kind: BattleMediaKind
  data: Buffer | string
}

const artifactPublishLocks = new Map<string, Promise<number>>()

async function publishBattleArtifacts(
  sessionIdHex: string,
  artifacts: BattleArtifact[],
  metadata: BattleMeta,
  locale: Locale,
  replaceArtifacts = false,
): Promise<void> {
  const previous = artifactPublishLocks.get(sessionIdHex) ?? Promise.resolve()
  const publish = previous.catch(() => undefined).then(async () => {
    await mkdir(CACHE_DIR, { recursive: true })
    const metaFile = path.join(CACHE_DIR, `${sessionIdHex}-meta.json`)
    const existing = await readBattleMetaFile(sessionIdHex)
    const publishedMeta: BattleMeta = {
      ...metadata,
      artifacts: publishedArtifacts(existing?.artifacts, locale, artifacts.map((artifact) => artifact.kind), replaceArtifacts),
    }

    // A full bundle takes the marker down before writing its files; a lazy
    // file is published atomically on its own, then the marker lists it.
    if (replaceArtifacts) await rm(metaFile, { force: true })
    await Promise.all(
      artifacts.map((artifact) => writeFileAtomic(cacheFile(sessionIdHex, artifact.kind, locale), artifact.data)),
    )
    const serializedMeta = JSON.stringify(publishedMeta)
    await writeFileAtomic(metaFile, serializedMeta)
    return artifacts.reduce(
      (sum, artifact) => sum + (typeof artifact.data === 'string'
        ? Buffer.byteLength(artifact.data, 'utf8')
        : artifact.data.byteLength),
      Buffer.byteLength(serializedMeta, 'utf8'),
    )
  })
  artifactPublishLocks.set(sessionIdHex, publish)
  let writtenUpperBound = 0
  try {
    writtenUpperBound = await publish
  } finally {
    if (artifactPublishLocks.get(sessionIdHex) === publish) artifactPublishLocks.delete(sessionIdHex)
  }
  await enforceCacheCap(writtenUpperBound)
}

// Диапазон проверяет config.ts: опечатка в WT_BATTLE_CACHE_MB — ошибка старта, а не тихие 400 МБ.
const CACHE_CAP_BYTES = config.battleCacheMb * 1024 * 1024
let cacheCapChecked = false
let cacheEstimatedBytes: number | null = null
let cacheCatalogUpdatedAt = 0
let cacheCapTail = Promise.resolve()

/** Scene-кэш сайта живёт в том же каталоге и подчиняется тому же лимиту. */
/**
 * Удаляет готовые артефакты одной сессии (PNG, meta, сцена). Вызывается после
 * commit разбора: при повторном ingest (например, после исправления парсера)
 * кэш иначе отдавал бы картинки, построенные по прежним событиям, — версия
 * кэша у них та же.
 */
export async function dropBattleArtifacts(sessionIdHex: string): Promise<void> {
  const hex = sessionIdHex.toLowerCase()
  if (!/^[0-9a-f]{12,20}$/.test(hex)) return
  let names: string[]
  try {
    names = await readdir(CACHE_DIR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const owned = names.filter((name) => {
    const lower = name.toLowerCase()
    return lower.startsWith(`${hex}-`) || lower === `${hex}.png`
  })
  await Promise.all(owned.map((name) => rm(path.join(CACHE_DIR, name), { force: true })))
}

export function enforceBattleCacheCap(writtenUpperBound = 0): Promise<void> {
  return enforceCacheCap(writtenUpperBound)
}

function enforceCacheCap(writtenUpperBound = 0): Promise<void> {
  const addedBytes = Math.max(0, writtenUpperBound)
  const run = cacheCapTail.catch(() => undefined).then(async () => {
    const estimatedBytes = cacheEstimatedBytes
    const catalogFresh = Date.now() - cacheCatalogUpdatedAt < CACHE_CATALOG_RECONCILE_MS
    if (
      estimatedBytes !== null &&
      catalogFresh &&
      estimatedBytes + addedBytes <= CACHE_CAP_BYTES * CACHE_SCAN_THRESHOLD
    ) {
      // Верхняя оценка учитывает перезаписанные файлы повторно. Это может
      // вызвать ранний scan, но не позволит пропустить переполнение.
      cacheEstimatedBytes = estimatedBytes + addedBytes
      return
    }

    const scannedBytes = await doEnforceCacheCap()
    cacheEstimatedBytes = scannedBytes
    if (scannedBytes !== null) cacheCatalogUpdatedAt = Date.now()
  })
  cacheCapTail = run
  return run
}

async function doEnforceCacheCap(): Promise<number | null> {
  try {
    const entries = await readdir(CACHE_DIR, { withFileTypes: true })
    interface CacheFile {
      path: string
      size: number
      mtime: number
    }
    interface CacheBundle {
      session: string | null
      files: CacheFile[]
      size: number
      mtime: number
    }
    const bundles = new Map<string, CacheBundle>()
    await mapConcurrent(entries, CACHE_SCAN_CONCURRENCY, async (entry) => {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) return
      const session = /^([0-9a-f]{12,20})(?:-|\.png$)/i.exec(entry.name)?.[1]?.toLowerCase() ?? null
      const file = path.join(CACHE_DIR, entry.name)
      try {
        const info = await stat(file)
        const key = session ? `session:${session}` : `file:${entry.name}`
        const bundle = bundles.get(key) ?? { session, files: [], size: 0, mtime: 0 }
        bundle.files.push({ path: file, size: info.size, mtime: info.mtimeMs })
        bundle.size += info.size
        bundle.mtime = Math.max(bundle.mtime, info.mtimeMs)
        bundles.set(key, bundle)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
    const candidates = [...bundles.values()]
    let total = candidates.reduce((sum, bundle) => sum + bundle.size, 0)
    if (total <= CACHE_CAP_BYTES) {
      cacheCapChecked = true
      return total
    }
    const target = CACHE_CAP_BYTES * 0.9
    candidates.sort((left, right) => left.mtime - right.mtime)
    let removedFiles = 0
    let removedBundles = 0
    // Bundle-ы вытесняются строго по LRU до достижения target; параллельное
    // удаление нарушило бы byte accounting и могло бы удалить лишние данные.
    for (const bundle of candidates) {
      if (total <= target) break
      if (bundle.session && activeCacheSessions.has(bundle.session)) continue
      try {
        const currentFiles = await Promise.all(
          bundle.files.map(async (file) => ({ file, current: await stat(file.path) })),
        )
        const unchanged = currentFiles.every(
          ({ file, current }) => current.size === file.size && current.mtimeMs === file.mtime,
        )
        if (!unchanged || (bundle.session && activeCacheSessions.has(bundle.session))) continue
        // Commit marker удаляется первым: читатель увидит cache miss, а не
        // частично вытесненное поколение PNG/TXT.
        const marker = bundle.files.find((file) => file.path.endsWith('-meta.json'))
        if (marker) await rm(marker.path, { force: true })
        await Promise.all(
          bundle.files.filter((file) => file !== marker).map((file) => rm(file.path, { force: true })),
        )
        total -= bundle.size
        removedFiles += bundle.files.length
        removedBundles++
        if (bundle.session) cacheLastTouchedAt.delete(bundle.session)
      } catch {
        // Гонка очистки/чтения не должна ломать готовый ответ Discord.
      }
    }
    if (!cacheCapChecked && removedFiles > 0) {
      console.log(
        `[battle-media] кэш картинок превысил ${(CACHE_CAP_BYTES / 1024 / 1024) | 0} МБ — ` +
          `вытеснено ${removedBundles} наборов (${removedFiles} файлов)`,
      )
    }
    cacheCapChecked = true
    return total
  } catch {
    // Каталога ещё нет или нет прав: рендер уже готов, не ломаем ответ.
    return null
  }
}

async function touchBattleBundle(sessionIdHex: string): Promise<void> {
  const now = Date.now()
  const previous = cacheLastTouchedAt.get(sessionIdHex)
  if (previous !== undefined && now - previous < CACHE_TOUCH_INTERVAL_MS) return

  // meta.json — commit marker и единый LRU timestamp всего bundle. Запись в Map
  // выполняется до await, чтобы одновременные cache hits коалесцировались.
  cacheLastTouchedAt.delete(sessionIdHex)
  cacheLastTouchedAt.set(sessionIdHex, now)
  if (cacheLastTouchedAt.size > MAX_TRACKED_CACHE_TOUCHES) {
    const oldest = cacheLastTouchedAt.keys().next().value
    if (oldest !== undefined) cacheLastTouchedAt.delete(oldest)
  }

  const marker = path.join(CACHE_DIR, `${sessionIdHex}-meta.json`)
  const time = new Date(now)
  try {
    await utimes(marker, time, time)
  } catch {
    if (cacheLastTouchedAt.get(sessionIdHex) === now) cacheLastTouchedAt.delete(sessionIdHex)
  }
}

function isPng(data: Uint8Array): boolean {
  return (
    data.byteLength >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  )
}

function toSessionHex(sessionId: string): string {
  try {
    return (/^\d+$/.test(sessionId) ? BigInt(sessionId) : BigInt(`0x${sessionId.replace(/^0x/i, '')}`))
      .toString(16)
      .padStart(16, '0')
  } catch {
    return sessionId.toLowerCase()
  }
}

function promoteBuild(state: MediaBuildState, priority: WorkerPriority): void {
  const order: WorkerPriority[] = ['interactive', 'normal', 'background']
  if (order.indexOf(priority) >= order.indexOf(state.priority)) return
  state.priority = priority
  for (const control of state.workerControls) control.promote(priority)
  // Эти cold-start зависимости — process-wide singleton jobs и могут уже
  // выполняться параллельно с mission. Их controls принадлежат своим модулям.
  promoteVehicleDictLoad(priority)
  promoteGameFontLoad(priority)
}

function workerControlTracker(state: MediaBuildState): (control: WorkerTaskControl | null) => void {
  let active: WorkerTaskControl | null = null
  return (control) => {
    if (active) state.workerControls.delete(active)
    active = control
    if (control) {
      state.workerControls.add(control)
      control.promote(state.priority)
    }
  }
}
