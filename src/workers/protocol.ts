import type { BattleInput, PlayerReplayInsights } from '../db/index.js'
import type { MissionDocSummary, MissionInfo } from '../wrpl/mission-info.js'
import type { ReplayResults, WrplHeader } from '../wrpl/replay.js'
import type { BattleImageInput } from '../wrpl/render-battle.js'
import type { MapImageViewport, MissileSeeker } from '../wrpl/battle-assets.js'
import type { VehicleDict } from '../wrpl/vehicles.js'
import type { BattleItemMeta, BattleParseProfile } from '../wrpl/battle-transform.js'
import type { BattleMediaKind } from '../wrpl/battle-media-kind.js'
import type { ScenePrepareInput } from '../wrpl/battle-scene-core.js'

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

export interface MediaRenderInput {
  missionName: string
  header: WrplHeader
  results: ReplayResults
  eventsBlob: ArrayBuffer
  dict: VehicleDict
  mission: MissionInfo | null
  heatmapOptions?: HeatmapRenderOptions
  assets: {
    fontFiles: string[]
    gameFont: boolean
    mapIconFont: boolean
    tacticalMap: ArrayBuffer | null
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
  'recompress-events-blobs': {
    /** Пачка battle_events после afterSessionId в порядке ключа. */
    input: { dbPath: string; afterSessionId: string; limit: number }
    output: {
      /** null — дошли до конца таблицы. */
      lastSessionId: string | null
      scanned: number
      converted: number
      bytesBefore: number
      bytesAfter: number
      elapsedMs: number
    }
  }
  'read-site-dashboard-stats': {
    input: { dbPath: string; sinceTs: number; seasonStart: number }
    output: {
      players: number
      clans: number
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
  'prepare-scene': {
    input: { eventsBlob: ArrayBuffer; scene: ScenePrepareInput }
    output: ArrayBuffer
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
