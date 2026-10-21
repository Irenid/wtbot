import type { BattleInput, DbMaintenanceResult, PlayerReplayInsights, ScoutStatSharkBattles, ScoutTeamRow, SitePlayerSearchHit } from '../db/index.js'
import type { Locale } from '../i18n/index.js'
import type { MissionDocSummary, MissionInfo } from '../wrpl/mission-info.js'
import type { ReplayResults, WrplHeader } from '../wrpl/replay.js'
import type { BattleImageInput } from '../wrpl/render-battle.js'
import type { MapImageViewport, MissileSeeker } from '../wrpl/battle-assets.js'
import type { VehicleDict } from '../wrpl/vehicles.js'
import type { BattleItemMeta, BattleParseProfile } from '../wrpl/battle-transform.js'
import type { BattleMediaKind } from '../wrpl/battle-media-kind.js'
import type { SceneAir, SceneAirInput, ScenePrepareInput } from '../wrpl/battle-scene-core.js'
import type { EventsRepairCounts } from '../wrpl/events-repair.js'
import type { TacticalMapBuildInput, TacticalMapSpecInput } from '../tactical-map/build.js'
import type { TacticalMapMeta, TacticalMapSpec } from '../tactical-map/spec.js'

/** FlagTemplatePack (src/scout/flags.ts) with its pixels as a transferable buffer. */
export interface WireFlagTemplates { icons: string[]; width: number; height: number; rgb: ArrayBuffer }
import type { ScoreboardReadResult } from '../scout/scoreboard-read.js'
import type { AnonymousGuess } from '../scout/anonymous.js'
import type { ClanSnapshot } from '../web/clan-snapshot.js'
import type { RateInput, RateOutput } from '../platoons/rate.js'

/** Короткая сводка событий, которую можно вернуть без клонирования траекторий. */
export interface BattleEventSummary {
  teamWon: number
  endTimeMs: number
  players: number
  kills: number
  damage: number
  chat: number
  units: number
  /** Воздушные юниты с реальной траекторией, а не самолёты в списке слотов. */
  airUnits: number
  /** Модели этих юнитов: БПЛА отсекаются при сравнении со словарём техники. */
  airModels: string[]
  zones: number
  errors: string[]
}

export type WireBattleInput = Omit<BattleInput, 'eventsBlob'> & { eventsBlob: ArrayBuffer }

export interface WireImage {
  mime: 'image/png' | 'image/jpeg'
  data: ArrayBuffer
  viewport?: MapImageViewport
}

export interface ParsedBattleResult {
  header: WrplHeader
  results: ReplayResults
  battle: WireBattleInput
  summary: BattleEventSummary
  profile: BattleParseProfile
}

export interface ScoreboardAssets {
  unitIcons: [string, ArrayBuffer][]
  mapImage: WireImage | null
  gameFont: boolean
  gameFlags: [string, string][]
  fontFiles: string[]
}

export interface HeatmapRenderOptions {
  airAutoZoom: boolean
  airShowGroundMap: boolean
  airShowAirfields: boolean
  airShowSpawns: boolean
  airPaddingPercent: number
}

/**
 * Both perspectives of a mission's tactical map drawn from the game files
 * (src/tactical-map): the renderer shows each team its own bases in blue.
 */
export interface WireGameMaps {
  A: { mime: 'image/png' | 'image/jpeg'; data: ArrayBuffer }
  B: { mime: 'image/png' | 'image/jpeg'; data: ArrayBuffer }
  /** Tank bases as drawn, for matching a team's first positions to its perspective. */
  spawns: { team: 'A' | 'B'; kind: string; x: number; z: number }[]
}

/**
 * A mission's air map for the worker to draw the view it needs (src/tactical-map
 * composeTacticalMap): the spec, the game folder its texture is read from, the
 * label font.
 */
export interface WireAirMap {
  spec: TacticalMapSpec
  gameDir: string
  fontFile: string | null
}

export interface MediaRenderInput {
  missionName: string
  header: WrplHeader
  results: ReplayResults
  eventsBlob: ArrayBuffer
  dict: VehicleDict
  mission: MissionInfo | null
  heatmapOptions?: HeatmapRenderOptions
  /** The language of the images' and chat's text; English without it. */
  locale?: Locale
  assets: {
    fontFiles: string[]
    gameFont: boolean
    mapIconFont: boolean
    tacticalMap: ArrayBuffer | null
    /** Takes the place of tacticalMap; mission.area is then the maps' view. */
    gameMaps?: WireGameMaps | null
    /** The air heatmaps' background; takes the place of fallbackMap there. */
    airMap?: WireAirMap | null
    fallbackMap: WireImage | null
    seekers: [string, MissileSeeker][]
  }
}

export interface MediaKindRenderInput extends MediaRenderInput {
  kind: BattleMediaKind
}

export interface WorkerMemorySnapshot {
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

export interface WorkerRenderFontProfile {
  loadSystemFonts: boolean
  defaultFamily: string
  source:
    | 'win32-segoe-ui'
    | 'win32-arial'
    | 'linux-dejavu-sans'
    | 'linux-liberation-sans'
    | 'linux-noto-sans'
    | 'darwin-arial'
    | 'system-fallback'
  uiFileCount: number
  scriptFileCount: number
  customFileCount: number
  missingScriptFallback: boolean
}

/** Профиль формируется внутри worker, поэтому не включает ожидание в очереди. */
export interface WorkerRenderProfile {
  totalMs: number
  phasesMs: Record<string, number>
  font?: WorkerRenderFontProfile
  memory: {
    start: WorkerMemorySnapshot
    peakObserved: WorkerMemorySnapshot
    end: WorkerMemorySnapshot
  }
}

export interface HeatmapRenderInput extends MediaRenderInput {
  mode: 'ground' | 'air'
  teamIndex?: number
  scale: 2
}

export interface RenderedMediaResult {
  log: ArrayBuffer
  heatmapGround: ArrayBuffer
  heatmapAir: ArrayBuffer | null
  heatmapTeamGround: [ArrayBuffer, ArrayBuffer]
  heatmapTeamAir: [ArrayBuffer, ArrayBuffer] | null
  chat: string
  summary: BattleEventSummary
  profile: WorkerRenderProfile
}

export interface RenderedMediaKindResult {
  media: ArrayBuffer | string
  summary: BattleEventSummary
  profile: WorkerRenderProfile
}

export interface WorkerTaskMap {
  'parse-results': {
    input: { part: ArrayBuffer; realNames: [string, string][] }
    output: { header: WrplHeader; results: ReplayResults } | null
  }
  'parse-battle': {
    input: { parts: ArrayBuffer[]; realNames: [string, string][]; meta: BattleItemMeta; ecsHashesJson: string }
    output: ParsedBattleResult
  }
  'persist-ingested-battle': {
    input: { dbPath: string; sessionId: string; battle: WireBattleInput }
    output: {
      committedAtMs: number
      sqliteMs: number
      transactionMs: number
      checkpointMs: number
      checkpointed: boolean
    }
  }
  'checkpoint-ingest-database': {
    input: { dbPath: string }
    output: { checkpointMs: number }
  }
  'record-parse-result': {
    input: {
      dbPath: string
      source: string
      ok: boolean
      summary: string | null
      error: string | null
    }
    output: { sqliteMs: number }
  }
  'update-player-stat-board-publication': {
    input: {
      dbPath: string
      guildId: string
      messageId: string
      contentHash: string
    }
    output: { sqliteMs: number }
  }
  'warm-sqlite': {
    input: { dbPath: string; statements: string[] }
    output: { elapsedMs: number; statements: number }
  }
  'read-player-insights': {
    input: { dbPath: string; userId: string; fromTs: number; toTs: number }
    output: PlayerReplayInsights & { elapsedMs: number }
  }
  /** The site's typo-tolerant player search (findSimilarSitePlayers): the worker keeps its nick index NICK_INDEX_TTL_MS. */
  'search-player-nicks': {
    input: { dbPath: string; query: string; limit: number }
    output: { players: SitePlayerSearchHit[]; elapsedMs: number }
  }
  /**
   * /scout by picture: the screenshot read (src/scout/scoreboard-read.ts), players matched against fromTs on;
   * flags — the game's flags as templates (null: no game files, no flags read), flagIcons — the ones vehicles show.
   */
  'read-scoreboard-image': {
    input: { dbPath: string; image: ArrayBuffer; fromTs: number; flags: WireFlagTemplates | null; flagIcons: string[] | null }
    output: ScoreboardReadResult
  }
  /** The game's flag SVGs (game-flags.ts) drawn as templates for /scout pictures (src/scout/flag-templates.ts). */
  'render-flag-templates': {
    input: { svgs: [string, string][] }
    output: WireFlagTemplates
  }
  /**
   * /scout by picture: the recognised players' rows and the season stages, the
   * cap's spawns so far (every squadron), the players' StatShark battles and
   * the own squadron's rows (allyTags; its air habit). With `anonymous` (the
   * enemy squadron's tags and the unread rows' text) it first guesses who hides
   * behind an anonymiser name (src/scout/anonymous.ts) and reads that player too.
   */
  'read-scout-players': {
    input: {
      dbPath: string
      userIds: string[]
      fromTs: number
      toTs: number
      allyTags: string[]
      allyFromTs: number
      anonymous?: { tags: string[]; unread: string[] } | undefined
    }
    output: {
      anonymous: AnonymousGuess | null
      rows: ScoutTeamRow[]
      stages: { startsAt: number; endsAt: number; maxBr: number }[]
      capSpawns: [string, number][]
      statShark: ScoutStatSharkBattles[]
      allyRows: ScoutTeamRow[]
    }
  }
  /** Platoons (src/bot/platoons.ts): who the voice members are and their strength now (src/platoons/rate.ts). */
  'read-platoon-players': {
    input: { dbPath: string } & RateInput
    output: RateOutput
  }
  /** /scout: a squadron's player rows and the season stages (src/scout/report.ts). */
  'read-scout-history': {
    input: { dbPath: string; tags: string[]; fromTs: number; toTs: number }
    output: {
      rows: ScoutTeamRow[]
      stages: { startsAt: number; endsAt: number; maxBr: number }[]
      elapsedMs: number
    }
  }
  'repair-battle-events': {
    /**
     * Battles after afterSessionId in key order: events to the canonical form
     * (events-repair.ts) and the columnar format, empty derived fields and
     * player facts (player-events.ts) from the events, then freed pages back
     * to the OS.
     */
    input: { dbPath: string; afterSessionId: string; limit: number; vacuumPages: number }
    output: {
      /** null — the end of the table. */
      lastSessionId: string | null
      scanned: number
      /** Battles whose blob was rewritten: an events repair or a format change. */
      rewritten: number
      /** The blob changed since it was read (ingest re-parsed the battle) — skipped. */
      changedMeanwhile: number
      /** Filled rows: players' slot and title, the battle's counters. */
      filledRows: number
      /** Player rows with new team, vehicle, played vehicles, bot slot or team kills. */
      playerRows: number
      repairs: EventsRepairCounts
      bytesBefore: number
      bytesAfter: number
      /** Returned to the OS after the batch (incremental_vacuum). */
      freedBytes: number
      /** The batch's write transaction — how long a main-thread write would wait. */
      writeMs: number
      elapsedMs: number
    }
  }
  'db-maintenance': {
    /** PRAGMA optimize (если optimize) и incremental_vacuum до maxPages страниц. */
    input: { dbPath: string; maxPages: number; optimize: boolean }
    output: DbMaintenanceResult
  }
  'build-clan-snapshot': {
    input: { dbPath: string }
    output: { snapshot: ClanSnapshot; elapsedMs: number }
  }
  'read-site-dashboard-stats': {
    input: { dbPath: string; sinceTs: number }
    output: {
      players: number
      battlesTotal: number
      battlesRecent: number
      lastBattleAt: number | null
      byDay: { day: string; battles: number }[]
      elapsedMs: number
    }
  }
  'render-scoreboard': {
    input: { input: BattleImageInput; assets: ScoreboardAssets }
    output: ArrayBuffer
  }
  'render-media': {
    input: MediaRenderInput
    output: RenderedMediaResult
  }
  'render-media-kind': {
    input: MediaKindRenderInput
    output: RenderedMediaKindResult
  }
  'render-heatmap': {
    input: HeatmapRenderInput
    output: ArrayBuffer
  }
  'extract-game-font': {
    input: { vromfs: ArrayBuffer }
    output: ArrayBuffer | null
  }
  'extract-game-flags': {
    input: { vromfs: ArrayBuffer }
    output: [string, string][]
  }
  'build-vehicle-dict': {
    input: { csv: ArrayBuffer; wpcost: ArrayBuffer; tags: ArrayBuffer }
    output: VehicleDict
  }
  'parse-mission': {
    input: { document: ArrayBuffer }
    output: MissionDocSummary
  }
  /** The site's battle scene (gzip JSON) and, with the air map and air tracks, its air view (sceneAir). */
  'prepare-scene': {
    input: { eventsBlob: ArrayBuffer; scene: ScenePrepareInput; air?: SceneAirInput | null }
    output: { scene: ArrayBuffer; air: SceneAir | null }
  }
  /** One view of a map as a JPEG (src/tactical-map composeTacticalMap): the scene's air view. */
  'compose-tactical-map': {
    input: { map: WireAirMap; view: { x0: number; z0: number; x1: number; z1: number }; size: number; team: 'A' | 'B' }
    output: ArrayBuffer
  }
  /** A mission's ground map drawn from the game files (src/tactical-map/build.ts). */
  'build-tactical-map': {
    input: TacticalMapBuildInput
    output: { image: ArrayBuffer; mime: 'image/png' | 'image/jpeg'; meta: TacticalMapMeta }
  }
  /** A mission's map spec from the game files: the air map's cache entry. */
  'build-tactical-map-spec': {
    input: TacticalMapSpecInput
    output: TacticalMapSpec
  }
}

export type WorkerTaskKind = keyof WorkerTaskMap

export type WorkerTask<K extends WorkerTaskKind = WorkerTaskKind> = K extends WorkerTaskKind
  ? { kind: K; input: WorkerTaskMap[K]['input'] }
  : never

export type AnyWorkerTask = { [K in WorkerTaskKind]: WorkerTask<K> }[WorkerTaskKind]
export type WorkerTaskResult<K extends WorkerTaskKind> = WorkerTaskMap[K]['output']

export interface WorkerRequest {
  id: number
  task: AnyWorkerTask
  sentAtMs: number
}

export interface SerializedWorkerError {
  name: string
  message: string
  stack?: string | undefined
}

export interface WorkerTransportTiming {
  receivedAtMs: number
  completedAtMs: number
  outputTransferBytes: number
}

export type WorkerResponse =
  | { id: number; ok: true; value: unknown; timing: WorkerTransportTiming; transfer?: ArrayBuffer[] | undefined }
  | { id: number; ok: false; error: SerializedWorkerError; timing: WorkerTransportTiming }

export type WorkerMessage = { type: 'ready' } | { type: 'result'; response: WorkerResponse }
