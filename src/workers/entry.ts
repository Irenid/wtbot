import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { parentPort } from 'node:worker_threads'
import { formatBattleChat } from '../wrpl/battle-chat.js'
import { battleEventRows, decodeEventsBlob, decodeEventsBlobProfiled, parseBattleParts, summarizeEvents } from '../wrpl/battle-transform.js'
import { decodeEventsPayload, encodeEventsJson, isColumnarEventsBlob, isZstdEventsBlob } from '../wrpl/events-codec.js'
import { fadeCutEdges } from '../wrpl/unit-icon-edges.js'
import { repairStoredEvents, type EventsRepairCounts } from '../wrpl/events-repair.js'
import { botSlotOwners, creditBotSlots, derivePlayerEventFacts } from '../wrpl/player-events.js'
import type { ReplayEvents } from '../wrpl/replay-events.js'
import { heatmapSelection, isBattleHeatmapKind } from '../wrpl/battle-media-kind.js'
import { applyRealNames, fakeNamesFromItem, parseReplayResults, parseWrplHeader } from '../wrpl/replay.js'
import { buildBattleLogSvg } from '../wrpl/render-battle-log.js'
import { buildBattleSvg } from '../wrpl/render-battle.js'
import {
  buildHeatmapSvg,
  groundMapInset,
  HEATMAP_MAP_SIZE,
  prepareHeatmapScene,
  type HeatmapInput,
  type HeatmapRenderOptions,
  type PreparedHeatmapScene,
} from '../wrpl/render-heatmap.js'
import { summarizeMissionDocument } from '../wrpl/mission-info.js'
import { buildSceneFromBlob, gzipScene, sceneAir } from '../wrpl/battle-scene-core.js'
import type { MapImageViewport } from '../wrpl/battle-assets.js'
import { unpackVromfs } from '../wrpl/vromfs.js'
import type { SpawnKind, Team } from '../tactical-map/model.js'
import { pickPerspective } from '../tactical-map/perspective.js'
import { atlasFlags } from '../wrpl/game-flags-atlas.js'
import { buildVehicleDict } from '../wrpl/vehicles.js'
import type {
  AnyWorkerTask,
  HeatmapRenderInput,
  MediaKindRenderInput,
  MediaRenderInput,
  RenderedMediaKindResult,
  RenderedMediaResult,
  SerializedWorkerError,
  WorkerMemorySnapshot,
  WorkerMessage,
  WorkerRenderFontProfile,
  WorkerRenderProfile,
  WorkerRequest,
  WorkerResponse,
  WorkerTaskResult,
  WireAirMap,
} from './protocol.js'
import { resolveRenderFonts } from './render-fonts.js'
import { SqliteCheckpointSchedule } from './sqlite-checkpoint.js'

if (!parentPort) throw new Error('CPU worker запущен без parentPort')
const port = parentPort
interface IngestDatabaseState {
  database: DatabaseSync
  checkpoint: ReturnType<DatabaseSync['prepare']>
  checkpointSchedule: SqliteCheckpointSchedule
}

const ingestDatabases = new Map<string, IngestDatabaseState>()

function epochNow(): number {
  return performance.timeOrigin + performance.now()
}

/**
 * The heatmap background: the game-file maps (both perspectives, src/tactical-map), each team's
 * heatmap from its own side, the combined one from the first roster's; else the wt-tools snapshot.
 * A roster's side is where its players' ground vehicles started (battle-scene-core does the same),
 * in the air heatmaps too: the first ground spawn is the team's base.
 */
function heatmapMaps(assets: MediaRenderInput['assets'], events: ReplayEvents): {
  any: string | null
  forRoster(scene: PreparedHeatmapScene, rosterIndex: number): string | null
  perspective(scene: PreparedHeatmapScene, rosterIndex: number): Team
} {
  const spawns = assets.gameMaps?.spawns ?? assets.airMap?.spec.spawns ?? null
  const perspective = (scene: PreparedHeatmapScene, rosterIndex: number): Team => {
    if (!spawns) return 'A'
    const ids = new Set((scene.rosters[rosterIndex] ?? []).map((player) => player.userId))
    const starts = events.units
      .filter((unit) => unit.source === 'ground' && unit.path.length > 0 && ids.has(unit.userId))
      .map((unit) => unit.path[0]!)
    return pickPerspective({ spawns }, starts.length > 0 ? starts : scene.teamSpawnClustersByTeam[rosterIndex] ?? []) ?? 'A'
  }
  const game = assets.gameMaps
  if (!game) {
    const snapshot = assets.tacticalMap ? dataUri('image/png', assets.tacticalMap) : null
    return { any: snapshot, forRoster: () => snapshot, perspective }
  }
  const uris = new Map<Team, string>()
  const uri = (team: Team): string => {
    let value = uris.get(team)
    if (!value) uris.set(team, (value = dataUri(game[team].mime, game[team].data)))
    return value
  }
  return { any: uri('A'), forRoster: (scene, rosterIndex) => uri(perspective(scene, rosterIndex)), perspective }
}

/** The air scene's bounds without auto zoom: the whole air map (it takes the captured level map's place). */
function airMapViewport(airMap: WireAirMap): MapImageViewport {
  return { x: 0, y: 0, width: 1, height: 1, imageWorldBounds: { ...airMap.spec.view } }
}

/**
 * Base kinds an air heatmap's map draws: WT_HEATMAP_AIR_SHOW_AIRFIELDS and _SHOW_SPAWNS hide
 * theirs; tank bases only without the ground map inset over the battle area (it has its own).
 */
function airMapKinds(options: HeatmapRenderOptions, inset: boolean): SpawnKind[] {
  return [
    ...(inset ? [] : ['tank'] as const),
    ...(options.airShowAirfields ? ['airfield', 'helicopter'] as const : []),
    ...(options.airShowSpawns ? ['ucav', 'bomber', 'fighter'] as const : []),
  ]
}

type AirMapImage = NonNullable<HeatmapInput['airMap']>

/**
 * The game's air map drawn for an air scene's map square in a team's colours
 * (src/tactical-map composeTacticalMap: the texture read from the game files,
 * grid, labels and icons at the respawn screen's sizes), as a JPEG data URI;
 * null with a warning when it cannot be drawn.
 */
async function airMapImage(airMap: WireAirMap, scene: PreparedHeatmapScene, team: Team, scale: number, inset: boolean): Promise<AirMapImage | null> {
  try {
    const { composeTacticalMap, encodeMapImage } = await import('../tactical-map/build.js')
    const image = composeTacticalMap(airMap.spec, {
      gameDir: airMap.gameDir,
      view: scene.mapRect,
      size: HEATMAP_MAP_SIZE * scale,
      team,
      fontFile: airMap.fontFile,
      kinds: airMapKinds(scene.heatmapOptions, inset),
      zones: !inset,
    })
    return { href: `data:image/jpeg;base64,${encodeMapImage(image, 'jpeg', 90).toString('base64')}`, rect: scene.mapRect }
  } catch (error) {
    console.warn(`[maps] air map ${airMap.spec.mission}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

interface HeatmapBackground {
  scene: PreparedHeatmapScene
  /** The level map captured from port 8111 and its overlays: none under the game's air map. */
  fallbackMap: string | null
  svgViewport: MapImageViewport | undefined
  /** The game's air map in a roster's perspective, drawn once per perspective; null on the ground and without one. */
  airMap(rosterIndex: number): Promise<AirMapImage | null>
}

/**
 * A heatmap mode's scene and background. In the air the game's air map
 * replaces the level map captured from port 8111 with its overlays (airfields,
 * spawns, grid); when its first view cannot be drawn, the scene is prepared
 * again over the capture, as without the air map.
 */
async function prepareHeatmapBackground(
  assets: MediaRenderInput['assets'],
  heatmapInput: HeatmapInput,
  maps: ReturnType<typeof heatmapMaps>,
  scale: number,
): Promise<HeatmapBackground> {
  const spec = heatmapInput.mode === 'air' ? assets.airMap ?? null : null
  if (spec) {
    const scene = prepareHeatmapScene(heatmapInput, maps.any, airMapViewport(spec))
    const inset = groundMapInset(scene, maps.any, heatmapInput.mission)
    const drawn = new Map<Team, Promise<AirMapImage | null>>()
    const draw = (rosterIndex: number): Promise<AirMapImage | null> => {
      const team = maps.perspective(scene, rosterIndex)
      let image = drawn.get(team)
      if (!image) drawn.set(team, (image = airMapImage(spec, scene, team, scale, inset)))
      return image
    }
    if (await draw(heatmapInput.teamIndex ?? 0)) return { scene, fallbackMap: null, svgViewport: undefined, airMap: draw }
  }
  const viewport = assets.fallbackMap?.viewport
  return {
    scene: prepareHeatmapScene(heatmapInput, maps.any, viewport),
    fallbackMap: assets.fallbackMap ? dataUri(assets.fallbackMap.mime, assets.fallbackMap.data) : null,
    svgViewport: viewport,
    airMap: async () => null,
  }
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(data.byteLength)
  owned.set(data)
  return owned.buffer
}

function dataUri(mime: string, data: ArrayBuffer | Buffer): string {
  return `data:${mime};base64,${(Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('base64')}`
}

/** Только фирменный шрифт рамок клан-тегов. */
function clanFontFiles(fontFiles: readonly string[]): string[] {
  return fontFiles.filter((file) =>
    file.replace(/\\/g, '/').toLowerCase().endsWith('/symbols_skyquake.ttf'),
  )
}

interface MutableRenderProfile {
  startedAt: number
  phasesMs: Record<string, number>
  font?: WorkerRenderFontProfile
  memoryStart: WorkerMemorySnapshot
  memoryPeak: WorkerMemorySnapshot
}

function memorySnapshot(): WorkerMemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  }
}

function startRenderProfile(): MutableRenderProfile {
  const memory = memorySnapshot()
  return {
    startedAt: performance.now(),
    phasesMs: {},
    memoryStart: memory,
    memoryPeak: { ...memory },
  }
}

function observeMemory(profile: MutableRenderProfile): WorkerMemorySnapshot {
  const memory = memorySnapshot()
  profile.memoryPeak.rssBytes = Math.max(profile.memoryPeak.rssBytes, memory.rssBytes)
  profile.memoryPeak.heapUsedBytes = Math.max(profile.memoryPeak.heapUsedBytes, memory.heapUsedBytes)
  profile.memoryPeak.externalBytes = Math.max(profile.memoryPeak.externalBytes, memory.externalBytes)
  profile.memoryPeak.arrayBuffersBytes = Math.max(profile.memoryPeak.arrayBuffersBytes, memory.arrayBuffersBytes)
  return memory
}

function addPhase(profile: MutableRenderProfile, name: string, elapsedMs: number): void {
  profile.phasesMs[name] = (profile.phasesMs[name] ?? 0) + elapsedMs
  observeMemory(profile)
}

function finishRenderProfile(profile: MutableRenderProfile): WorkerRenderProfile {
  const end = observeMemory(profile)
  return {
    totalMs: performance.now() - profile.startedAt,
    phasesMs: profile.phasesMs,
    ...(profile.font ? { font: profile.font } : {}),
    memory: {
      start: profile.memoryStart,
      peakObserved: profile.memoryPeak,
      end,
    },
  }
}

async function rasterize(
  svg: string,
  fontFiles: string[],
  scale = 1,
  profile?: MutableRenderProfile,
  phasePrefix = 'raster',
): Promise<ArrayBuffer> {
  // Native binding нужен только рендеру. Его отсутствие не должно выключать
  // WRPL parse/font/vehicle tasks во всём пуле.
  let started = performance.now()
  const { Resvg } = await import('@resvg/resvg-js')
  if (profile) addPhase(profile, `${phasePrefix}.module`, performance.now() - started)

  started = performance.now()
  const fonts = resolveRenderFonts(fontFiles, svg)
  if (profile) {
    profile.font = {
      loadSystemFonts: fonts.loadSystemFonts,
      defaultFamily: fonts.defaultFamily,
      source: fonts.source,
      uiFileCount: fonts.uiFileCount,
      scriptFileCount: fonts.scriptFileCount,
      customFileCount: fonts.customFileCount,
      missingScriptFallback: fonts.missingScriptFallback,
    }
    addPhase(profile, `${phasePrefix}.fonts`, performance.now() - started)
  }

  started = performance.now()
  const renderer = new Resvg(svg, {
    font: {
      loadSystemFonts: fonts.loadSystemFonts,
      fontFiles: fonts.fontFiles,
      defaultFontFamily: fonts.defaultFamily,
    },
    fitTo: scale === 1 ? { mode: 'original' } : { mode: 'zoom', value: scale },
  })
  if (profile) addPhase(profile, `${phasePrefix}.init`, performance.now() - started)

  started = performance.now()
  const rendered = renderer.render()
  if (profile) addPhase(profile, `${phasePrefix}.render`, performance.now() - started)

  started = performance.now()
  const png = rendered.asPng()
  if (profile) addPhase(profile, `${phasePrefix}.png`, performance.now() - started)

  started = performance.now()
  const output = exactArrayBuffer(png)
  if (profile) addPhase(profile, `${phasePrefix}.copy`, performance.now() - started)
  return output
}

async function renderHeatmap(input: HeatmapRenderInput): Promise<{ value: ArrayBuffer; transfer: ArrayBuffer[] }> {
  const events = decodeEventsBlob(Buffer.from(input.eventsBlob))
  creditBotSlots(events, botSlotOwners(input.results.players))
  const fonts = clanFontFiles(input.assets.fontFiles)
  const gameFont = fonts.length > 0
  const maps = heatmapMaps(input.assets, events)
  const heatmapInput: HeatmapInput = {
    missionName: input.missionName,
    header: input.header,
    results: input.results,
    events,
    dict: input.dict,
    mission: input.mission,
    mode: input.mode,
    ...(input.heatmapOptions ? { heatmapOptions: input.heatmapOptions } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.teamIndex === undefined ? {} : { teamIndex: input.teamIndex }),
    seekers: new Map(input.assets.seekers),
    renderScale: input.scale,
  }
  const background = await prepareHeatmapBackground(input.assets, heatmapInput, maps, input.scale)
  heatmapInput.airMap = await background.airMap(input.teamIndex ?? 0)
  const svg = buildHeatmapSvg(
    heatmapInput,
    gameFont,
    maps.forRoster(background.scene, input.teamIndex ?? 0),
    background.fallbackMap,
    background.svgViewport,
    input.assets.mapIconFont,
    undefined,
    background.scene,
  )
  const png = await rasterize(svg, fonts, input.scale)
  return { value: png, transfer: [png] }
}

async function parseResults(input: Extract<AnyWorkerTask, { kind: 'parse-results' }>['input']) {
  const part = Buffer.from(input.part)
  const header = parseWrplHeader(part)
  if (header.resultsBlkOffset <= 0 || header.resultsBlkOffset >= part.length) return null
  const results = parseReplayResults(part.subarray(header.resultsBlkOffset))
  applyRealNames(results, new Map(input.realNames))
  return { header, results }
}

async function parseBattle(input: Extract<AnyWorkerTask, { kind: 'parse-battle' }>['input']) {
  const parts = input.parts.map((part) => Buffer.from(part))
  const parsed = await parseBattleParts(parts, new Map(input.realNames), input.meta, input.ecsHashesJson)
  const eventsBlob = exactArrayBuffer(parsed.battle.eventsBlob)
  return {
    value: {
      header: parsed.header,
      results: parsed.results,
      battle: { ...parsed.battle, eventsBlob },
      summary: parsed.summary,
      profile: parsed.profile,
    },
    transfer: [eventsBlob],
  }
}

async function ingestDatabase(dbPath: string): Promise<IngestDatabaseState> {
  const existing = ingestDatabases.get(dbPath)
  if (existing) return existing
  if (!existsSync(dbPath)) throw new Error(`SQLite для ingest не найден: ${dbPath}`)
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(dbPath)
  database.exec('PRAGMA busy_timeout = 5000;')
  // Like the main connection: declared foreign keys hold for every writer.
  database.exec('PRAGMA foreign_keys = ON;')
  // Как у основного подключения: в WAL коммит не ждёт fsync (он — при checkpoint).
  database.exec('PRAGMA synchronous = NORMAL;')
  // Автоматический checkpoint выполняется внутри COMMIT и продлевает
  // эксклюзивный writer-lock. Делаем PASSIVE checkpoint отдельно после
  // транзакции: диск по-прежнему обслуживает worker, а main connection может
  // писать в WAL параллельно.
  database.exec('PRAGMA wal_autocheckpoint = 0;')
  const state: IngestDatabaseState = {
    database,
    checkpoint: database.prepare('PRAGMA wal_checkpoint(PASSIVE)'),
    checkpointSchedule: new SqliteCheckpointSchedule(),
  }
  ingestDatabases.set(dbPath, state)
  return state
}

async function persistIngestedBattle(
  input: Extract<AnyWorkerTask, { kind: 'persist-ingested-battle' }>['input'],
) {
  const started = performance.now()
  const [databaseState, { saveIngestedBattle }] = await Promise.all([
    ingestDatabase(input.dbPath),
    import('../db/index.js'),
  ])
  const { database, checkpoint, checkpointSchedule } = databaseState
  const transactionStarted = performance.now()
  saveIngestedBattle(
    database,
    { ...input.battle, eventsBlob: Buffer.from(input.battle.eventsBlob) },
    input.sessionId,
  )
  const transactionMs = performance.now() - transactionStarted
  let checkpointMs = 0
  let checkpointed = false
  if (checkpointSchedule.recordCommit()) {
    const checkpointStarted = performance.now()
    checkpoint.get()
    checkpointMs = performance.now() - checkpointStarted
    checkpointed = true
    checkpointSchedule.markCheckpoint()
  }
  return {
    value: {
      committedAtMs: Date.now(),
      sqliteMs: performance.now() - started,
      transactionMs,
      checkpointMs,
      checkpointed,
    },
    transfer: [],
  }
}

async function checkpointIngestDatabase(
  input: Extract<AnyWorkerTask, { kind: 'checkpoint-ingest-database' }>['input'],
) {
  const { checkpoint, checkpointSchedule } = await ingestDatabase(input.dbPath)
  const started = performance.now()
  checkpoint.get()
  checkpointSchedule.markCheckpoint()
  return {
    value: { checkpointMs: performance.now() - started },
    transfer: [],
  }
}

async function recordParseResult(
  input: Extract<AnyWorkerTask, { kind: 'record-parse-result' }>['input'],
) {
  const [databaseState, { recordParseResultInDatabase }] = await Promise.all([
    ingestDatabase(input.dbPath),
    import('../db/index.js'),
  ])
  const started = performance.now()
  recordParseResultInDatabase(
    databaseState.database,
    input.source,
    input.ok,
    input.summary,
    input.error,
  )
  return {
    value: { sqliteMs: performance.now() - started },
    transfer: [],
  }
}

async function updatePlayerStatBoardPublication(
  input: Extract<AnyWorkerTask, { kind: 'update-player-stat-board-publication' }>['input'],
) {
  const [databaseState, { updatePlayerStatBoardPublicationInDatabase }] = await Promise.all([
    ingestDatabase(input.dbPath),
    import('../db/index.js'),
  ])
  const started = performance.now()
  updatePlayerStatBoardPublicationInDatabase(
    databaseState.database,
    input.guildId,
    input.messageId,
    input.contentHash,
  )
  return {
    value: { sqliteMs: performance.now() - started },
    transfer: [],
  }
}

async function warmSqlite(
  input: Extract<AnyWorkerTask, { kind: 'warm-sqlite' }>['input'],
): Promise<{ value: { elapsedMs: number; statements: number }; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`SQLite для прогрева не найден: ${input.dbPath}`)
  for (const sql of input.statements) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('SQLite warmup разрешает только SELECT')
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 268435456;')
    database.exec('PRAGMA cache_size = -65536;')
    for (const sql of input.statements) database.exec(sql)
    return {
      value: { elapsedMs: performance.now() - started, statements: input.statements.length },
      transfer: [],
    }
  } finally {
    database.close()
  }
}

/** The site's squadron ranking (web/clan-snapshot.ts) on its own read-only connection. */
async function buildClanSnapshotTask(
  input: Extract<AnyWorkerTask, { kind: 'build-clan-snapshot' }>['input'],
): Promise<{ value: WorkerTaskResult<'build-clan-snapshot'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, { buildClanSnapshot }] = await Promise.all([
    import('node:sqlite'),
    import('../web/clan-snapshot.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 1073741824;')
    database.exec('PRAGMA cache_size = -65536;')
    database.exec('PRAGMA temp_store = MEMORY;')
    const snapshot = buildClanSnapshot(database)
    return { value: { snapshot, elapsedMs: performance.now() - started }, transfer: [] }
  } finally {
    database.close()
  }
}

/** Аналитика игрока по реплеям (db/index.ts) на отдельном read-only подключении. */
async function readPlayerInsights(
  input: Extract<AnyWorkerTask, { kind: 'read-player-insights' }>['input'],
): Promise<{ value: WorkerTaskResult<'read-player-insights'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`SQLite сайта не найден: ${input.dbPath}`)
  const [{ DatabaseSync }, { getPlayerReplayInsights }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 1073741824;')
    database.exec('PRAGMA cache_size = -65536;')
    database.exec('PRAGMA temp_store = MEMORY;')
    const insights = getPlayerReplayInsights(input.userId, input.fromTs, input.toTs, database)
    return { value: { ...insights, elapsedMs: performance.now() - started }, transfer: [] }
  } finally {
    database.close()
  }
}

/** Typo-tolerant player search (db/index.ts) on its own read-only connection; the nick index outlives the task. */
async function searchPlayerNicks(
  input: Extract<AnyWorkerTask, { kind: 'search-player-nicks' }>['input'],
): Promise<{ value: WorkerTaskResult<'search-player-nicks'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, { findSimilarSitePlayers }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 268435456;')
    const players = findSimilarSitePlayers(input.query, input.limit, database, input.dbPath)
    return { value: { players, elapsedMs: performance.now() - started }, transfer: [] }
  } finally {
    database.close()
  }
}

/** /scout history (db/index.ts) on its own read-only connection. */
async function readScoutHistory(
  input: Extract<AnyWorkerTask, { kind: 'read-scout-history' }>['input'],
): Promise<{ value: WorkerTaskResult<'read-scout-history'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, { getScoutStages, getScoutTeamRows }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 1073741824;')
    database.exec('PRAGMA cache_size = -16384;')
    const rows = getScoutTeamRows(input.tags, input.fromTs, input.toTs, database)
    const stages = getScoutStages(database)
    return { value: { rows, stages, elapsedMs: performance.now() - started }, transfer: [] }
  } finally {
    database.close()
  }
}

/** /scout by picture: OCR in a child process, the players to match from a read-only connection. */
async function readScoreboardImage(
  input: Extract<AnyWorkerTask, { kind: 'read-scoreboard-image' }>['input'],
): Promise<{ value: WorkerTaskResult<'read-scoreboard-image'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, { getScoutRecentPlayers }, { candidateIndex, readScoreboard }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
    import('../scout/scoreboard-read.js'),
  ])
  const flags = input.flags ? { ...input.flags, rgb: new Uint8Array(input.flags.rgb) } : null
  const players = candidateIndex(`${input.dbPath}:${input.fromTs - (input.fromTs % 600)}`, () => {
    const database = new DatabaseSync(input.dbPath, { readOnly: true })
    try {
      database.exec('PRAGMA busy_timeout = 5000;')
      return getScoutRecentPlayers(input.fromTs, database)
    } finally {
      database.close()
    }
  })
  const flagIcons = input.flagIcons ? new Set(input.flagIcons) : null
  return { value: await readScoreboard(new Uint8Array(input.image), players, undefined, flags ? { pack: flags, icons: flagIcons } : null), transfer: [] }
}

/** /scout by picture: the flag templates, drawn once per process (the main thread keeps them). */
async function renderFlagTemplatesTask(
  input: Extract<AnyWorkerTask, { kind: 'render-flag-templates' }>['input'],
): Promise<{ value: WorkerTaskResult<'render-flag-templates'>; transfer: ArrayBuffer[] }> {
  const { renderFlagTemplates } = await import('../scout/flag-templates.js')
  const pack = renderFlagTemplates(input.svgs)
  const rgb = exactArrayBuffer(pack.rgb)
  return { value: { icons: pack.icons, width: pack.width, height: pack.height, rgb }, transfer: [rgb] }
}

/** /scout by picture: the recognised players' rows, the cap's spawns so far, their StatShark battles, the own squadron's rows. */
async function readScoutPlayers(
  input: Extract<AnyWorkerTask, { kind: 'read-scout-players' }>['input'],
): Promise<{ value: WorkerTaskResult<'read-scout-players'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, db, { periodBounds, stageAt }, { ANONYMOUS_WINDOWS_SEC, fakeFirstNames, guessAnonymous }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
    import('../scout/model.js'),
    import('../scout/anonymous.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 1073741824;')
    const stages = db.getScoutStages(database)
    const stage = stageAt(stages, input.toTs)
    const capFrom = stage ? periodBounds(stage).from : input.toTs - 7 * 86_400
    const hidden = input.anonymous
    const anonymous = hidden && hidden.unread.length > 0 && hidden.tags.length > 0
      ? guessAnonymous(
          hidden.unread,
          fakeFirstNames(db.getScoutFakeNames(database)),
          db.getScoutAnonymousPlayers(hidden.tags.slice(0, 8), input.toTs - ANONYMOUS_WINDOWS_SEC.at(-1)!, database),
          new Set(input.userIds),
          input.toTs,
        )
      : null
    const userIds = anonymous ? [...input.userIds, anonymous.userId] : input.userIds
    return {
      value: {
        anonymous,
        rows: db.getScoutPlayerRows(userIds, input.fromTs, input.toTs, database),
        stages,
        capSpawns: capFrom < input.toTs ? db.getScoutCapSpawns(capFrom, input.toTs, database) : [],
        statShark: db.getScoutStatSharkBattles(userIds, database),
        allyRows: input.allyTags.length > 0 ? db.getScoutTeamRows(input.allyTags, input.allyFromTs, input.toTs, database) : [],
      },
      transfer: [],
    }
  } finally {
    database.close()
  }
}

/** Platoons: who the voice members are and their strength (src/platoons/rate.ts). */
async function readPlatoonPlayers(
  input: Extract<AnyWorkerTask, { kind: 'read-platoon-players' }>['input'],
): Promise<{ value: WorkerTaskResult<'read-platoon-players'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`Database not found: ${input.dbPath}`)
  const [{ DatabaseSync }, db, { ratePlatoonPlayers }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
    import('../platoons/rate.js'),
  ])
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    const { dbPath: _dbPath, ...rateInput } = input
    const value = ratePlatoonPlayers(rateInput, {
      roster: (clanCore) => db.getPlatoonRoster(clanCore, database),
      accounts: (keys) => db.getPlatoonNickPlayers(keys, database),
      rows: (userIds, fromTs, toTs) => db.getPlatoonPlayerRows(userIds, fromTs, toTs, database),
      stages: () => db.getScoutStages(database),
      ratings: (nicks, sinceTs) => db.getPlatoonRatings(nicks, sinceTs, database),
    })
    return { value, transfer: [] }
  } finally {
    database.close()
  }
}

interface StoredPlayerFacts {
  user_id: string
  nick: string
  team: number
  squad_id: number
  vehicle: string | null
  played_vehicles: string | null
  bot_user_id: string | null
  team_kills: number
  slot_nick: string | null
}

/** Stored players whose facts from the events (player-events.ts) differ from the row. */
function playerFactUpdates(rows: readonly StoredPlayerFacts[], events: Omit<ReplayEvents, 'errors'>) {
  const facts = derivePlayerEventFacts(
    rows.map((row) => ({ userId: row.user_id, name: row.nick, team: row.team, squadId: row.squad_id })),
    events,
  )
  return rows.flatMap((row) => {
    const fact = facts.get(row.user_id)
    if (!fact) return []
    // Events without tracks keep the stored vehicle: the lineup's first, as ingest writes it.
    const vehicle = fact.playedVehicles === null ? row.vehicle : fact.playedVehicles[0] ?? null
    const played = fact.playedVehicles === null ? null : JSON.stringify(fact.playedVehicles)
    const same = row.team === fact.team && row.vehicle === vehicle && row.played_vehicles === played &&
      row.bot_user_id === fact.botUserId && row.team_kills === fact.teamKills && row.slot_nick === fact.slotNick
    return same ? [] : [{ ...fact, userId: row.user_id, vehicle }]
  })
}

/**
 * Background repair of stored battles (db/maintenance.ts): a batch by key
 * after afterSessionId. Decoding, the events-repair.ts rules, player facts,
 * encoding and building rows run here in the worker; the write is one short
 * transaction. The blob with the kill and chat rows, and the player facts,
 * are replaced only if the blob did not change since it was read (ingest may
 * have re-parsed the battle); empty slot, title and counters are filled from
 * the events without replacing set values. Then incremental_vacuum returns
 * freed pages to the OS.
 */
async function repairBattleEvents(
  input: Extract<AnyWorkerTask, { kind: 'repair-battle-events' }>['input'],
): Promise<{ value: WorkerTaskResult<'repair-battle-events'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`SQLite not found: ${input.dbPath}`)
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new RangeError('battle repair limit must be 1–500')
  }
  if (!Number.isSafeInteger(input.vacuumPages) || input.vacuumPages < 0) {
    throw new RangeError('battle repair vacuumPages must be a non-negative integer')
  }
  const [{ DatabaseSync }, db] = await Promise.all([import('node:sqlite'), import('../db/index.js')])
  const database = new DatabaseSync(input.dbPath)
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA foreign_keys = ON;')
    database.exec('PRAGMA synchronous = NORMAL;')
    const rows = database
      .prepare(`
        SELECT b.session_id, e.events_blob, i.data AS item
        FROM battles b
        JOIN battle_events e ON e.session_id = b.session_id
        LEFT JOIN items i ON i.source = 'wt-replays' AND i.external_id = b.session_id
        WHERE b.session_id > ? ORDER BY b.session_id LIMIT ?
      `)
      .all(input.afterSessionId, input.limit) as { session_id: string; events_blob: Uint8Array; item: string | null }[]
    const missingSlots = database.prepare(
      'SELECT user_id, slot, title FROM battle_players WHERE session_id = ? AND (slot IS NULL OR title IS NULL)',
    )
    const missingCounts = database.prepare(
      'SELECT 1 FROM battles WHERE session_id = ? AND (air_unit_count IS NULL OR chat_count IS NULL)',
    )
    const storedPlayers = database.prepare(
      'SELECT user_id, nick, team, squad_id, vehicle, played_vehicles, bot_user_id, team_kills, slot_nick FROM battle_players WHERE session_id = ?',
    )
    const repairs: EventsRepairCounts = { chatNames: 0, duplicateKills: 0, signedIds: 0, brokenChat: 0, roundedValues: 0 }
    const plans = rows.map((row) => {
      const events = decodeEventsPayload(row.events_blob) as Omit<ReplayEvents, 'errors'>
      const fakeNames = new Map(row.item ? fakeNamesFromItem(JSON.parse(row.item) as { players?: unknown }) : [])
      const repair = repairStoredEvents(events, fakeNames)
      for (const key of Object.keys(repairs) as (keyof EventsRepairCounts)[]) repairs[key] += repair[key]
      let eventsBlob: Buffer | null = null
      if (repair.changed || !isColumnarEventsBlob(row.events_blob)) {
        const next = encodeEventsJson(JSON.stringify(events))
        // Unchanged events that do not fit the columnar format keep their
        // zstd-JSON; gzip still moves to zstd-JSON.
        if (repair.changed || isColumnarEventsBlob(next) || !isZstdEventsBlob(row.events_blob)) eventsBlob = next
      }
      const slotByUserId = new Map(events.players.map((player) => [player.userId, player]))
      // Only rows whose empty field the event really knows: a player without
      // a title keeps NULL and is not rewritten by every pass.
      const slots = (missingSlots.all(row.session_id) as { user_id: string; slot: number | null; title: string | null }[])
        .flatMap((player) => {
          const slot = slotByUserId.get(player.user_id)
          if (!slot) return []
          const fillsSlot = player.slot === null && Number.isInteger(slot.slot)
          const fillsTitle = player.title === null && slot.title !== ''
          return fillsSlot || fillsTitle ? [{ userId: player.user_id, slot: slot.slot, title: slot.title || null }] : []
        })
      return {
        sessionId: row.session_id,
        previousBlob: row.events_blob,
        eventsBlob,
        eventRows: eventsBlob ? battleEventRows(events) : null,
        airUnitCount: summarizeEvents({ ...events, errors: [] }).airUnits,
        chatCount: events.chat.length,
        slots,
        fillCounts: missingCounts.get(row.session_id) !== undefined,
        players: playerFactUpdates(storedPlayers.all(row.session_id) as unknown as StoredPlayerFacts[], events),
      }
    })
    let rewritten = 0
    let changedMeanwhile = 0
    let filledRows = 0
    let playerRows = 0
    let bytesBefore = 0
    let bytesAfter = 0
    const writeStarted = performance.now()
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const plan of plans) {
        if (plan.eventsBlob && plan.eventRows) {
          const replaced = db.replaceRepairedBattleEvents(database, {
            sessionId: plan.sessionId,
            previousBlob: plan.previousBlob,
            eventsBlob: plan.eventsBlob,
            kills: plan.eventRows.kills,
            chat: plan.eventRows.chat,
            airUnitCount: plan.airUnitCount,
          })
          if (!replaced) {
            changedMeanwhile += 1
            continue
          }
          rewritten += 1
          bytesBefore += plan.previousBlob.byteLength
          bytesAfter += plan.eventsBlob.byteLength
        }
        if (plan.players.length > 0) {
          const written = db.updateBattlePlayerFacts(database, {
            sessionId: plan.sessionId,
            eventsBlob: plan.eventsBlob ?? plan.previousBlob,
            players: plan.players,
          })
          if (written === null) {
            changedMeanwhile += 1
            continue
          }
          playerRows += written
        }
        if (plan.slots.length > 0 || plan.fillCounts) {
          filledRows += db.fillMissingBattleFields(database, {
            sessionId: plan.sessionId,
            airUnitCount: plan.airUnitCount,
            chatCount: plan.chatCount,
            slots: plan.slots,
          })
        }
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    const writeMs = performance.now() - writeStarted
    const vacuum = input.vacuumPages > 0
      ? await db.runDbMaintenance(database, { maxPages: input.vacuumPages, optimize: false })
      : null
    return {
      value: {
        lastSessionId: rows.at(-1)?.session_id ?? null,
        scanned: rows.length,
        rewritten,
        changedMeanwhile,
        filledRows,
        playerRows,
        repairs,
        bytesBefore,
        bytesAfter,
        freedBytes: vacuum === null ? 0 : vacuum.freedPages * vacuum.pageSize,
        writeMs,
        elapsedMs: performance.now() - started,
      },
      transfer: [],
    }
  } finally {
    database.close()
  }
}

/** PRAGMA optimize и возврат свободных страниц на своём подключении (db/maintenance.ts). */
async function runDatabaseMaintenance(
  input: Extract<AnyWorkerTask, { kind: 'db-maintenance' }>['input'],
): Promise<{ value: WorkerTaskResult<'db-maintenance'>; transfer: [] }> {
  if (!existsSync(input.dbPath)) throw new Error(`SQLite не найден: ${input.dbPath}`)
  if (!Number.isSafeInteger(input.maxPages) || input.maxPages < 0) {
    throw new RangeError('maxPages обслуживания — неотрицательное целое')
  }
  const [{ DatabaseSync }, { runDbMaintenance }] = await Promise.all([
    import('node:sqlite'),
    import('../db/index.js'),
  ])
  const database = new DatabaseSync(input.dbPath)
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA foreign_keys = ON;')
    database.exec('PRAGMA synchronous = NORMAL;')
    return {
      value: await runDbMaintenance(database, { maxPages: input.maxPages, optimize: input.optimize }),
      transfer: [],
    }
  } finally {
    database.close()
  }
}

async function readSiteDashboardStats(
  input: Extract<AnyWorkerTask, { kind: 'read-site-dashboard-stats' }>['input'],
): Promise<{
  value: WorkerTaskResult<'read-site-dashboard-stats'>
  transfer: []
}> {
  if (!existsSync(input.dbPath)) throw new Error(`SQLite сайта не найден: ${input.dbPath}`)
  if (!Number.isSafeInteger(input.sinceTs) || input.sinceTs < 0) {
    throw new RangeError('sinceTs сайта должен быть неотрицательным Unix-временем')
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(input.dbPath, { readOnly: true })
  const started = performance.now()
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA mmap_size = 268435456;')
    database.exec('PRAGMA cache_size = -65536;')
    const counts = database.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN start_time >= ? THEN 1 ELSE 0 END), 0) AS recent,
             MAX(start_time) AS last_start
      FROM battles
      WHERE start_time >= 0
    `).get(input.sinceTs) as { total: number; recent: number; last_start: number | null }
    const players = database.prepare(`
      SELECT COUNT(*) AS players FROM (
        SELECT DISTINCT user_id FROM battle_players WHERE user_id <> ''
      )
    `).get() as { players: number }
    const byDay = database.prepare(`
      SELECT date(start_time, 'unixepoch') AS day, COUNT(*) AS battles
      FROM battles
      WHERE start_time >= ?
      GROUP BY day
      ORDER BY day
    `).all(input.sinceTs) as unknown as { day: string; battles: number }[]
    return {
      value: {
        players: players.players,
        battlesTotal: counts.total,
        battlesRecent: counts.recent,
        lastBattleAt: counts.last_start,
        byDay,
        elapsedMs: performance.now() - started,
      },
      transfer: [],
    }
  } finally {
    database.close()
  }
}

async function renderScoreboard(input: Extract<AnyWorkerTask, { kind: 'render-scoreboard' }>['input']) {
  const svg = buildBattleSvg(input.input, {
    unitIcons: new Map(input.assets.unitIcons.map(([id, data]) => [id, dataUri('image/png', fadeCutEdges(Buffer.from(data)))])),
    mapImage: input.assets.mapImage ? dataUri(input.assets.mapImage.mime, input.assets.mapImage.data) : null,
    gameFlags: new Map(input.assets.gameFlags),
    gameFont: input.assets.gameFont,
  })
  const png = await rasterize(svg, input.assets.fontFiles)
  return { value: png, transfer: [png] }
}

/** Events for media: paired bot slots credited to their players, as in the results. */
function decodeProfiledEvents(input: MediaRenderInput, profile: MutableRenderProfile) {
  const decoded = decodeEventsBlobProfiled(Buffer.from(input.eventsBlob))
  addPhase(profile, 'events.inflate', decoded.profile.inflateMs)
  addPhase(profile, 'events.utf8', decoded.profile.utf8Ms)
  addPhase(profile, 'events.json', decoded.profile.jsonParseMs)
  addPhase(profile, 'events.restore', decoded.profile.restoreMs)
  creditBotSlots(decoded.events, botSlotOwners(input.results.players))
  return decoded.events
}

async function renderMedia(input: MediaRenderInput): Promise<{
  value: RenderedMediaResult
  transfer: ArrayBuffer[]
}> {
  const profile = startRenderProfile()
  const events = decodeProfiledEvents(input, profile)

  // Squadron tags get only symbols_skyquake.ttf: map-icons.ttf must not take part in glyph selection.
  let started = performance.now()
  const fonts = clanFontFiles(input.assets.fontFiles)
  const gameFont = fonts.length > 0
  const seekers = new Map(input.assets.seekers)
  const maps = heatmapMaps(input.assets, events)
  addPhase(profile, 'assets.prepare', performance.now() - started)
  const shared = {
    missionName: input.missionName,
    header: input.header,
    results: input.results,
    events,
    dict: input.dict,
    ...(input.heatmapOptions ? { heatmapOptions: input.heatmapOptions } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
  }

  started = performance.now()
  const summary = summarizeEvents(events)
  addPhase(profile, 'summary', performance.now() - started)

  started = performance.now()
  const logSvg = buildBattleLogSvg(shared, gameFont)
  addPhase(profile, 'log.svg', performance.now() - started)
  const log = await rasterize(logSvg, fonts, 1, profile, 'log.resvg')

  const renderHeatmapMode = async (mode: 'ground' | 'air'): Promise<{
    general: ArrayBuffer
    teams: [ArrayBuffer, ArrayBuffer]
  }> => {
    const heatmapInput: HeatmapInput = {
      ...shared,
      mission: input.mission,
      mode,
      seekers,
    }
    started = performance.now()
    const background = await prepareHeatmapBackground(input.assets, heatmapInput, maps, 1)
    const scene = background.scene
    addPhase(profile, `heatmap-${mode}.prepare`, performance.now() - started)
    const renderVariant = async (phase: string, teamIndex?: number): Promise<ArrayBuffer> => {
      const airStarted = performance.now()
      const variant: HeatmapInput = {
        ...heatmapInput,
        ...(teamIndex === undefined ? {} : { teamIndex }),
        airMap: await background.airMap(teamIndex ?? 0),
      }
      if (mode === 'air') addPhase(profile, `${phase}.air-map`, performance.now() - airStarted)
      const svgStarted = performance.now()
      const svg = buildHeatmapSvg(
        variant,
        gameFont,
        maps.forRoster(scene, teamIndex ?? 0),
        background.fallbackMap,
        background.svgViewport,
        input.assets.mapIconFont,
        undefined,
        scene,
      )
      addPhase(profile, `${phase}.svg`, performance.now() - svgStarted)
      return rasterize(svg, fonts, 1, profile, `${phase}.resvg`)
    }
    const teamPhase = mode === 'ground' ? 'heatmap-team' : 'heatmap-team-air'
    return {
      general: await renderVariant(`heatmap-${mode}`),
      teams: [
        await renderVariant(`${teamPhase}-0`, 0),
        await renderVariant(`${teamPhase}-1`, 1),
      ],
    }
  }

  const ground = await renderHeatmapMode('ground')
  const heatmapGround = ground.general
  const heatmapTeamGround = ground.teams
  const air = summary.airUnits > 0
    ? await renderHeatmapMode('air')
    : null
  const heatmapAir = air?.general ?? null
  const heatmapTeamAir = air?.teams ?? null

  started = performance.now()
  const chat = formatBattleChat(events, input.results.players, input.locale)
  addPhase(profile, 'chat.format', performance.now() - started)
  const transfer = [log, heatmapGround, ...heatmapTeamGround]
  if (heatmapAir && heatmapTeamAir) {
    transfer.push(heatmapAir, ...heatmapTeamAir)
  }
  return {
    value: {
      log,
      heatmapGround,
      heatmapAir,
      heatmapTeamGround,
      heatmapTeamAir,
      chat,
      summary,
      profile: finishRenderProfile(profile),
    },
    transfer,
  }
}

async function renderMediaKind(input: MediaKindRenderInput): Promise<{
  value: RenderedMediaKindResult
  transfer: ArrayBuffer[]
}> {
  const profile = startRenderProfile()
  const events = decodeProfiledEvents(input, profile)
  const heatmap = isBattleHeatmapKind(input.kind)

  let started = performance.now()
  const fonts = input.kind === 'chat' ? [] : clanFontFiles(input.assets.fontFiles)
  const gameFont = fonts.length > 0
  const seekers = heatmap ? new Map(input.assets.seekers) : new Map()
  const maps = heatmap ? heatmapMaps(input.assets, events) : null
  addPhase(profile, 'assets.prepare', performance.now() - started)

  const shared = {
    missionName: input.missionName,
    header: input.header,
    results: input.results,
    events,
    dict: input.dict,
    ...(input.heatmapOptions ? { heatmapOptions: input.heatmapOptions } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
  }

  started = performance.now()
  const summary = summarizeEvents(events)
  addPhase(profile, 'summary', performance.now() - started)

  let media: ArrayBuffer | string
  if (input.kind === 'chat') {
    started = performance.now()
    media = formatBattleChat(events, input.results.players, input.locale)
    addPhase(profile, 'media.chat', performance.now() - started)
  } else if (input.kind === 'log') {
    started = performance.now()
    const svg = buildBattleLogSvg(shared, gameFont)
    addPhase(profile, 'media.svg', performance.now() - started)
    media = await rasterize(svg, fonts, 1, profile, 'media.resvg')
  } else {
    const selection = heatmapSelection(input.kind)
    started = performance.now()
    const heatmapInput: HeatmapInput = {
      ...shared,
      mission: input.mission,
      mode: selection.mode,
      seekers,
      ...(selection.teamIndex === undefined ? {} : { teamIndex: selection.teamIndex }),
    }
    const background = await prepareHeatmapBackground(input.assets, heatmapInput, maps!, 1)
    heatmapInput.airMap = await background.airMap(selection.teamIndex ?? 0)
    addPhase(profile, 'media.prepare', performance.now() - started)
    started = performance.now()
    const svg = buildHeatmapSvg(
      heatmapInput,
      gameFont,
      maps?.forRoster(background.scene, selection.teamIndex ?? 0) ?? null,
      background.fallbackMap,
      background.svgViewport,
      input.assets.mapIconFont,
      undefined,
      background.scene,
    )
    addPhase(profile, 'media.svg', performance.now() - started)
    media = await rasterize(svg, fonts, 1, profile, 'media.resvg')
  }

  return {
    value: { media, summary, profile: finishRenderProfile(profile) },
    transfer: typeof media === 'string' ? [] : [media],
  }
}

function extractGameFont(input: Extract<AnyWorkerTask, { kind: 'extract-game-font' }>['input']) {
  const files = unpackVromfs(Buffer.from(input.vromfs))
  const font = files.find((file) => file.name === 'ttfs/symbols_skyquake.ttf')
  if (!font) return { value: null, transfer: [] }
  const data = exactArrayBuffer(font.data)
  return { value: data, transfer: [data] }
}

function extractGameFlags(input: Extract<AnyWorkerTask, { kind: 'extract-game-flags' }>['input']) {
  return { value: atlasFlags(unpackVromfs(Buffer.from(input.vromfs))), transfer: [] }
}

function buildVehicles(input: Extract<AnyWorkerTask, { kind: 'build-vehicle-dict' }>['input']) {
  return {
    value: buildVehicleDict(
      Buffer.from(input.csv).toString('utf8'),
      Buffer.from(input.wpcost).toString('utf8'),
      Buffer.from(input.tags).toString('utf8'),
    ),
    transfer: [],
  }
}

function parseMission(input: Extract<AnyWorkerTask, { kind: 'parse-mission' }>['input']) {
  return {
    value: summarizeMissionDocument(Buffer.from(input.document).toString('utf8')),
    transfer: [],
  }
}

// The tactical map module loads Resvg's native binding: imported on use, like rasterize, so that
// a missing binding leaves the other tasks working.
async function buildTacticalMapTask(input: Extract<AnyWorkerTask, { kind: 'build-tactical-map' }>['input']) {
  const { buildTacticalMap } = await import('../tactical-map/build.js')
  const built = buildTacticalMap(input)
  const image = exactArrayBuffer(built.image)
  return { value: { image, mime: built.mime, meta: built.meta }, transfer: [image] }
}

async function buildTacticalMapSpecTask(input: Extract<AnyWorkerTask, { kind: 'build-tactical-map-spec' }>['input']) {
  const { buildTacticalMapSpec } = await import('../tactical-map/build.js')
  return { value: buildTacticalMapSpec(input), transfer: [] }
}

/** The battle scene and, with the mission's air map and air tracks, its air view (sceneAir). */
function prepareScene(input: Extract<AnyWorkerTask, { kind: 'prepare-scene' }>['input']) {
  const scene = buildSceneFromBlob(input.eventsBlob, input.scene)
  const air = sceneAir(scene, input.air ?? null)
  if (air) scene.map.air = { view: [air.view.x0, air.view.z0, air.view.x1, air.view.z1] }
  const sceneGzip = gzipScene(scene)
  return { value: { scene: sceneGzip, air }, transfer: [sceneGzip] }
}

/** One view of a map as a JPEG: the site's air view, drawn on its first request. */
async function composeTacticalMapTask(input: Extract<AnyWorkerTask, { kind: 'compose-tactical-map' }>['input']) {
  const { composeTacticalMap, encodeMapImage } = await import('../tactical-map/build.js')
  const image = composeTacticalMap(input.map.spec, {
    gameDir: input.map.gameDir,
    view: input.view,
    size: input.size,
    team: input.team,
    fontFile: input.map.fontFile,
  })
  const jpeg = exactArrayBuffer(encodeMapImage(image, 'jpeg', 90))
  return { value: jpeg, transfer: [jpeg] }
}

async function execute(task: AnyWorkerTask): Promise<{ value: unknown; transfer: ArrayBuffer[] }> {
  switch (task.kind) {
    case 'parse-results':
      return { value: await parseResults(task.input), transfer: [] }
    case 'parse-battle':
      return parseBattle(task.input)
    case 'persist-ingested-battle':
      return persistIngestedBattle(task.input)
    case 'checkpoint-ingest-database':
      return checkpointIngestDatabase(task.input)
    case 'record-parse-result':
      return recordParseResult(task.input)
    case 'update-player-stat-board-publication':
      return updatePlayerStatBoardPublication(task.input)
    case 'warm-sqlite':
      return warmSqlite(task.input)
    case 'read-site-dashboard-stats':
      return readSiteDashboardStats(task.input)
    case 'repair-battle-events':
      return repairBattleEvents(task.input)
    case 'db-maintenance':
      return runDatabaseMaintenance(task.input)
    case 'read-player-insights':
      return readPlayerInsights(task.input)
    case 'build-clan-snapshot':
      return buildClanSnapshotTask(task.input)
    case 'search-player-nicks':
      return searchPlayerNicks(task.input)
    case 'read-platoon-players':
      return readPlatoonPlayers(task.input)
    case 'read-scout-history':
      return readScoutHistory(task.input)
    case 'read-scoreboard-image':
      return readScoreboardImage(task.input)
    case 'render-flag-templates':
      return renderFlagTemplatesTask(task.input)
    case 'read-scout-players':
      return readScoutPlayers(task.input)
    case 'render-scoreboard':
      return await renderScoreboard(task.input)
    case 'render-media':
      return await renderMedia(task.input)
    case 'render-media-kind':
      return await renderMediaKind(task.input)
    case 'render-heatmap':
      return await renderHeatmap(task.input)
    case 'extract-game-font':
      return extractGameFont(task.input)
    case 'extract-game-flags':
      return extractGameFlags(task.input)
    case 'build-vehicle-dict':
      return buildVehicles(task.input)
    case 'parse-mission':
      return parseMission(task.input)
    case 'prepare-scene':
      return prepareScene(task.input)
    case 'compose-tactical-map':
      return await composeTacticalMapTask(task.input)
    case 'build-tactical-map':
      return await buildTacticalMapTask(task.input)
    case 'build-tactical-map-spec':
      return await buildTacticalMapSpecTask(task.input)
  }
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'Error', message: String(error) }
}

port.on('message', (request: WorkerRequest) => {
  const receivedAtMs = epochNow()
  void execute(request.task).then(
    ({ value, transfer }) => {
      const outputTransferBytes = transfer.reduce((sum, item) => sum + item.byteLength, 0)
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        value,
        timing: { receivedAtMs, completedAtMs: epochNow(), outputTransferBytes },
      }
      const message: WorkerMessage = { type: 'result', response }
      port.postMessage(message, transfer)
    },
    (error: unknown) => {
      const serialized = serializeError(error)
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: serialized,
        timing: { receivedAtMs, completedAtMs: epochNow(), outputTransferBytes: 0 },
      }
      port.postMessage({ type: 'result', response } satisfies WorkerMessage)
    },
  )
})

port.on('close', () => {
  for (const { database, checkpoint, checkpointSchedule } of ingestDatabases.values()) {
    try {
      checkpoint.get()
      checkpointSchedule.markCheckpoint()
    } catch {
      // При закрытии всё равно пытаемся закрыть connection; WAL восстановим.
    }
    try {
      database.close()
    } catch {
      // Worker всё равно завершается; SQLite откатит незавершённую транзакцию.
    }
  }
  ingestDatabases.clear()
})

port.postMessage({ type: 'ready' } satisfies WorkerMessage)
