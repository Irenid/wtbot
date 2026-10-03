import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { config } from '../config.js'
import { mapConcurrent } from '../concurrency.js'
import { getBattleWeaponIds, markBattleIngest, saveBattle } from '../db/index.js'
import {
  runWorkerTask,
  transferableBuffer,
  type WorkerPriority,
  type WorkerTaskControl,
} from '../workers/pool.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import { loadBattleData, reconstructBattle, type BattleItemMeta } from './battle-data.js'
import {
  ensureTacticalMap,
  ensureWeaponSeekers,
  loadLocalTacticalMap,
  loadMapBackground,
  loadMapIconFontPath,
  type MissileSeeker,
} from './battle-assets.js'
import { fetchMissionInfo } from './mission-info.js'
import { dropReplayCache } from './replay-cache.js'
import type { ReplayResults, WrplHeader } from './replay.js'
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
 * Дополнительные материалы боя. Диск/сеть/SQLite остаются в main thread,
 * а распаковка и JSON событий, SVG и Resvg выполняются в CPU worker. Интерактивный путь
 * строит один материал, фоновый прогрев при необходимости — полный bundle.
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

const cacheFile = (sessionIdHex: string, kind: BattleMediaKind): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}${kind === 'chat' ? '.txt' : '.png'}`)

const highResCacheFile = (sessionIdHex: string, kind: BattleHeatmapKind): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}@2x-${BATTLE_MEDIA_RENDER_VARIANT}.png`)

/** Cache hit без синхронного чтения большого PNG на Discord event loop. */
export async function cachedBattleMedia(sessionIdHex: string, kind: BattleMediaKind): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  const metadata = await cachedBattleMeta(sessionIdHex)
  if (!metadata?.artifacts.includes(kind)) return null
  const file = cacheFile(sessionIdHex, kind)
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
  artifacts: BattleMediaKind[]
}

/** Ленивый 2×-кэш одной выбранной карты; обычный bundle при этом не пересобирается. */
export async function cachedBattleHeatmap2x(
  sessionIdHex: string,
  kind: BattleHeatmapKind,
): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  if (!(await cachedBattleMeta(sessionIdHex))) return null
  const file = highResCacheFile(sessionIdHex, kind)
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
const BATTLE_MEDIA_VERSION = 44
const BATTLE_MEDIA_RENDER_OPTIONS = JSON.stringify(config.heatmapOptions)
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
      Array.isArray((parsed as BattleMeta).artifacts) &&
      (parsed as BattleMeta).artifacts.every((kind) => typeof kind === 'string' && mediaKinds.has(kind))
    ) {
      return parsed as BattleMeta
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
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

/** Рендерит только запрошенную heatmap в 2×, не создавая остальные материалы боя. */
export function buildBattleHeatmap2x(
  sessionId: string,
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const sessionHex = toSessionHex(sessionId)
  const key = `${sessionHex}:${kind}:2`
  const running = inflightHeatmapBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleHeatmap2x(sessionId, kind, meta, state).finally(() => {
    inflightHeatmapBuilds.delete(key)
    releaseCacheSession(sessionHex)
  })
  inflightHeatmapBuilds.set(key, { promise: build, state })
  return build
}

async function doBuildBattleHeatmap2x(
  sessionId: string,
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  state: MediaBuildState,
): Promise<Buffer> {
  const stored = reconstructBattle(sessionId)
  if (!stored?.eventsBlob) throw new Error('Бой ещё не сохранён в базе для HD-рендера')

  const missionName = meta.missionName ?? stored.header.locName ?? ''
  const weaponIds = getBattleWeaponIds(stored.header.sessionId)
  const trackMission = workerControlTracker(state)
  const [dict, mission, gameFontFiles, seekers, mapIconFont] = await Promise.all([
    ensureVehicleDict(state.priority),
    stored.missionSettings
      ? fetchMissionInfo(stored.missionSettings, () => state.priority, trackMission)
      : Promise.resolve(null),
    ensureGameFonts(state.priority),
    ensureWeaponSeekers(weaponIds),
    loadMapIconFontPath(),
  ])
  const fontFiles = mapIconFont ? [...gameFontFiles, mapIconFont] : gameFontFiles
  const tacticalMap = mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(stored.header.level))
    : null
  const fallbackMap = await loadMapBackground(stored.header.level)
  const wireBlob = transferableBuffer(stored.eventsBlob)
  const wireTacticalMap = tacticalMap ? transferableBuffer(tacticalMap) : null
  const wireFallbackMap = fallbackMap
    ? {
        mime: fallbackMap.mime,
        data: transferableBuffer(fallbackMap.data),
        ...(fallbackMap.viewport ? { viewport: fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
  if (wireFallbackMap) transferList.push(wireFallbackMap.data)
  const selection = heatmapSelection(kind)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-heatmap',
      input: {
        missionName,
        header: stored.header,
        results: stored.results,
        eventsBlob: wireBlob,
        dict,
        mission,
        heatmapOptions: config.heatmapOptions,
        mode: selection.mode,
        ...(selection.teamIndex === undefined ? {} : { teamIndex: selection.teamIndex }),
        scale: 2,
        assets: {
          fontFiles,
          gameFont: gameFontFiles.length > 0,
          mapIconFont: mapIconFont !== null,
          tacticalMap: wireTacticalMap,
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
    throw new Error(`HD-карта слишком велика: ${(png.byteLength / 1024 / 1024).toFixed(1)} МБ`)
  }
  // Флаг управляет повторным использованием, но результат каждого рендера
  // сохраняется на диск независимо от него.
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFileAtomic(highResCacheFile(stored.header.sessionIdHex, kind), png)
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
  const loaded = await loadBattleData(
    partUrls,
    realNames,
    meta,
    () => state.priority,
    undefined,
    (control) => trackLoad(control),
  ).finally(() => trackLoad(null))
  const parseErrors = loaded.summary.errors
  if (parseErrors.length > 0) {
    console.warn(
      `[wrpl] события ${loaded.header.sessionId}: ${parseErrors.length} ошибок разбора, первая: ${parseErrors[0]}`,
    )
  }
  try {
    saveBattle(loaded.battle)
    markBattleIngest(loaded.header.sessionId, 'ok')
    await dropReplayCache(loaded.header.sessionIdHex)
  } catch (error) {
    console.warn(`[wrpl] не сохранил бой ${loaded.header.sessionId} в БД: ${(error as Error).message}`)
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

async function loadBattleRenderAssets(
  source: BattleRenderSource,
  missionName: string,
  state: MediaBuildState,
  needsHeatmap: boolean,
  needsFonts: boolean,
) {
  const trackMission = workerControlTracker(state)
  const missionPromise = needsHeatmap && source.missionSettings
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
  const tacticalMap = needsHeatmap && mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(source.header.level))
    : null
  const fallbackMap = needsHeatmap ? await loadMapBackground(source.header.level) : null
  return { dict, mission, gameFontFiles, fontFiles, seekers, mapIconFont, tacticalMap, fallbackMap }
}

function mediaWorkerPayload(
  source: BattleRenderSource,
  missionName: string,
  assets: Awaited<ReturnType<typeof loadBattleRenderAssets>>,
) {
  const wireBlob = transferableBuffer(source.eventsBlob)
  const wireTacticalMap = assets.tacticalMap ? transferableBuffer(assets.tacticalMap) : null
  const wireFallbackMap = assets.fallbackMap
    ? {
        mime: assets.fallbackMap.mime,
        data: transferableBuffer(assets.fallbackMap.data),
        ...(assets.fallbackMap.viewport ? { viewport: assets.fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
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
      assets: {
        fontFiles: assets.fontFiles,
        gameFont: assets.gameFontFiles.length > 0,
        mapIconFont: assets.mapIconFont !== null,
        tacticalMap: wireTacticalMap,
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

/** Собирает один материал; полный bundle продолжает использоваться для фонового прогрева. */
export function buildBattleMediaKind(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  kind: BattleMediaKind,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const sessionHex = toSessionHex(sessionId)
  const runningBundle = inflightBuilds.get(sessionHex)
  if (runningBundle) {
    promoteBuild(runningBundle.state, priority)
    return runningBundle.promise.then((media) => {
      const selected = selectBuiltMedia(media, kind)
      return selected ?? buildBattleMediaKind(sessionId, partUrls, meta, kind, realNames, priority)
    })
  }

  const key = `${sessionHex}:${kind}:1`
  const running = inflightMediaKindBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleMediaKind(sessionId, partUrls, meta, kind, realNames, state).finally(() => {
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
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<Buffer> {
  const source = await loadBattleRenderSource(sessionId, partUrls, meta, realNames, state)
  const missionName = meta.missionName ?? source.header.locName ?? ''
  const assets = await loadBattleRenderAssets(
    source,
    missionName,
    state,
    isBattleHeatmapKind(kind),
    kind !== 'chat',
  )
  const payload = mediaWorkerPayload(source, missionName, assets)
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
      `${kind === 'chat' ? 'Чат' : 'Изображение'} слишком велико: ${(media.byteLength / 1024 / 1024).toFixed(1)} МБ`,
    )
  }
  const summary = { ...rendered.summary, errors: source.parseErrors }
  await publishBattleArtifacts(
    source.header.sessionIdHex,
    [{ kind, data: media }],
    buildBattleMeta(summary, assets.dict),
  )
  return media
}

export function buildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<BuiltBattleMedia> {
  const sessionHex = toSessionHex(sessionId)
  const running = inflightBuilds.get(sessionHex)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  acquireCacheSession(sessionHex)
  const build = doBuildBattleMedia(sessionId, partUrls, meta, realNames, state).finally(() => {
    inflightBuilds.delete(sessionHex)
    releaseCacheSession(sessionHex)
  })
  inflightBuilds.set(sessionHex, { promise: build, state })
  return build
}

async function doBuildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<BuiltBattleMedia> {
  const source = await loadBattleRenderSource(sessionId, partUrls, meta, realNames, state)
  const { header, parseErrors } = source
  const missionName = meta.missionName ?? header.locName ?? ''
  const assets = await loadBattleRenderAssets(source, missionName, state, true, true)
  const payload = mediaWorkerPayload(source, missionName, assets)
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
    artifacts: [],
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
  replaceArtifacts = false,
): Promise<void> {
  const previous = artifactPublishLocks.get(sessionIdHex) ?? Promise.resolve()
  const publish = previous.catch(() => undefined).then(async () => {
    await mkdir(CACHE_DIR, { recursive: true })
    const metaFile = path.join(CACHE_DIR, `${sessionIdHex}-meta.json`)
    const existing = replaceArtifacts ? null : await readBattleMetaFile(sessionIdHex)
    const available = new Set(existing?.artifacts ?? [])
    for (const artifact of artifacts) available.add(artifact.kind)
    const publishedMeta: BattleMeta = {
      ...metadata,
      artifacts: ALL_MEDIA_KINDS.filter((kind) => available.has(kind)),
    }

    // Для полного поколения marker снимается до публикации; ленивый файл
    // сам публикуется атомарно, после чего marker получает новый список.
    if (replaceArtifacts) await rm(metaFile, { force: true })
    await Promise.all(
      artifacts.map((artifact) => writeFileAtomic(cacheFile(sessionIdHex, artifact.kind), artifact.data)),
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
