import type { BattleInput } from '../db/index.js'
import type { MissionDocSummary, MissionInfo } from '../wrpl/mission-info.js'
import type { ReplayResults, WrplHeader } from '../wrpl/replay.js'
import type { BattleImageInput } from '../wrpl/render-battle.js'
import type { MissileSeeker } from '../wrpl/battle-assets.js'
import type { VehicleDict } from '../wrpl/vehicles.js'
import type { BattleItemMeta } from '../wrpl/battle-transform.js'

/** Короткая сводка событий, которую можно вернуть без клонирования траекторий. */
export interface BattleEventSummary {
  teamWon: number
  endTimeMs: number
  players: number
  kills: number
  damage: number
  chat: number
  units: number
  zones: number
  errors: string[]
}

export type WireBattleInput = Omit<BattleInput, 'eventsBlob'> & { eventsBlob: ArrayBuffer }

export interface WireImage {
  mime: 'image/png' | 'image/jpeg'
  data: ArrayBuffer
}

export interface ParsedBattleResult {
  header: WrplHeader
  results: ReplayResults
  battle: WireBattleInput
  summary: BattleEventSummary
}

export interface ScoreboardAssets {
  unitIcons: [string, ArrayBuffer][]
  mapImage: WireImage | null
  gameFont: boolean
  fontFiles: string[]
}

export interface MediaRenderInput {
  missionName: string
  header: WrplHeader
  results: ReplayResults
  eventsBlob: ArrayBuffer
  dict: VehicleDict
  mission: MissionInfo | null
  assets: {
    fontFiles: string[]
    gameFont: boolean
    tacticalMap: ArrayBuffer | null
    fallbackMap: WireImage | null
    seekers: [string, MissileSeeker][]
  }
}

export interface RenderedMediaResult {
  log: ArrayBuffer
  heatmapGround: ArrayBuffer
  heatmapAir: ArrayBuffer
  chat: string
  summary: BattleEventSummary
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
  'render-scoreboard': {
    input: { input: BattleImageInput; assets: ScoreboardAssets }
    output: ArrayBuffer
  }
  'render-media': {
    input: MediaRenderInput
    output: RenderedMediaResult
  }
  'extract-game-font': {
    input: { vromfs: ArrayBuffer }
    output: ArrayBuffer | null
  }
  'build-vehicle-dict': {
    input: { csv: ArrayBuffer; wpcost: ArrayBuffer; tags: ArrayBuffer }
    output: VehicleDict
  }
  'parse-mission': {
    input: { document: ArrayBuffer }
    output: MissionDocSummary
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
}

export interface SerializedWorkerError {
  name: string
  message: string
  stack?: string | undefined
}

export type WorkerResponse =
  | { id: number; ok: true; value: unknown; transfer?: ArrayBuffer[] | undefined }
  | { id: number; ok: false; error: SerializedWorkerError }

export type WorkerMessage = { type: 'ready' } | { type: 'result'; response: WorkerResponse }
