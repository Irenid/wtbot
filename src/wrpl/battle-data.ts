import {
  getBattleForRender,
  getBattleSummaryForRender,
  type BattleInput,
  type BattlePlayerRow,
  type BattleRow,
} from '../db/index.js'
import {
  runWorkerTask,
  transferableBuffer,
  type WorkerPriority,
  type WorkerTaskControl,
  type WorkerTaskTiming,
} from '../workers/pool.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import type { BattleItemMeta, BattleParseProfile } from './battle-transform.js'
import { ensureEcsHashesJson } from './ecs.js'
import {
  fetchReplayPartsRetained,
  type ReplayPartsTiming,
} from './replay-events.js'
import type { ReplayFetchPriority, ReplayFetchPrioritySource } from './replay-cache.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'

export type { BattleItemMeta } from './battle-transform.js'

/** Результат полного разбора без тяжёлых траекторий в main thread. */
export interface LoadedBattle {
  header: WrplHeader
  results: ReplayResults
  battle: BattleInput
  summary: BattleEventSummary
  timing: BattleLoadTiming
}

export interface BattleLoadTiming {
  startedAtMs: number
  replayReadyAtMs: number
  workerSubmittedAtMs: number
  workerFinishedAtMs: number
  completedAtMs: number
  totalMs: number
  inputPrepareMs: number
  workerWallMs: number
  replay: ReplayPartsTiming
  worker: WorkerTaskTiming | null
  parseProfile: BattleParseProfile
}

export type BattleLoadPhaseEvent =
  | {
      phase: 'replay-ready'
      atMs: number
      replay: ReplayPartsTiming
    }
  | {
      phase: 'worker-submitted'
      atMs: number
      inputBytes: number
    }
  | {
      phase: 'worker-finished'
      atMs: number
      worker: WorkerTaskTiming | null
    }

export interface PreparedBattleData {
  parts: Buffer[]
  ecsHashesJson: string
  replay: ReplayPartsTiming
  startedAtMs: number
  startedMonotonicMs: number
  inputBytes: number
  release(): void
}

/**
 * Сеть и файловый cache остаются в main thread, а WRPL/zlib/zstd/JSON/gzip
 * выполняются в пуле worker_threads. Части передаются без structured-clone.
 */
export async function loadBattleData(
  partUrls: string[],
  realNames: Map<string, string>,
  meta: BattleItemMeta,
  priority: WorkerPriority | (() => WorkerPriority) = 'background',
  signal?: AbortSignal,
  onWorkerControl?: (control: WorkerTaskControl) => void,
  onPhase?: (event: BattleLoadPhaseEvent) => void,
): Promise<LoadedBattle> {
  const replayPriority = (): ReplayFetchPriority => {
    const current = typeof priority === 'function' ? priority() : priority
    return current === 'background' ? 'background' : 'live'
  }
  const prepared = await prepareBattleData(partUrls, signal, onPhase, replayPriority)
  return parsePreparedBattleData(
    prepared,
    realNames,
    meta,
    priority,
    signal,
    onWorkerControl,
    onPhase,
  )
}

export async function prepareBattleData(
  partUrls: string[],
  signal?: AbortSignal,
  onPhase?: (event: BattleLoadPhaseEvent) => void,
  replayPriority: ReplayFetchPrioritySource = 'normal',
): Promise<PreparedBattleData> {
  if (partUrls.length === 0) throw new Error('пустой список частей реплея')
  const startedAtMs = Date.now()
  const startedMonotonicMs = performance.now()
  const replayTimingBox: { value: ReplayPartsTiming | null } = { value: null }
  const [replayResult, ecsResult] = await Promise.allSettled([
    fetchReplayPartsRetained(partUrls, signal, {
      priority: replayPriority,
      onTiming: (timing) => { replayTimingBox.value = timing },
    }),
    ensureEcsHashesJson(),
  ])
  if (replayResult.status === 'rejected') throw replayResult.reason
  const retainedReplay = replayResult.value
  if (ecsResult.status === 'rejected') {
    retainedReplay.release()
    throw ecsResult.reason
  }
  const replayTiming = replayTimingBox.value
  if (!replayTiming) {
    retainedReplay.release()
    throw new Error('не получены метрики загрузки replay')
  }
  emitBattleLoadPhase(onPhase, {
    phase: 'replay-ready',
    atMs: Date.now(),
    replay: replayTiming,
  })
  let released = false
  return {
    parts: retainedReplay.parts,
    ecsHashesJson: ecsResult.value,
    replay: replayTiming,
    startedAtMs,
    startedMonotonicMs,
    inputBytes: retainedReplay.parts.reduce((sum, part) => sum + part.byteLength, 0),
    release() {
      if (released) return
      released = true
      retainedReplay.release()
    },
  }
}

export async function parsePreparedBattleData(
  prepared: PreparedBattleData,
  realNames: Map<string, string>,
  meta: BattleItemMeta,
  priority: WorkerPriority | (() => WorkerPriority) = 'background',
  signal?: AbortSignal,
  onWorkerControl?: (control: WorkerTaskControl) => void,
  onPhase?: (event: BattleLoadPhaseEvent) => void,
): Promise<LoadedBattle> {
  try {
  const inputStarted = performance.now()
  const wireParts = prepared.parts.map(transferableBuffer)
  const inputBytes = wireParts.reduce((sum, part) => sum + part.byteLength, 0)
  const taskPriority = typeof priority === 'function' ? priority() : priority
  const workerInput = {
    parts: wireParts,
    realNames: [...realNames],
    meta,
    ecsHashesJson: prepared.ecsHashesJson,
  }
  const inputPrepareMs = performance.now() - inputStarted
  const workerSubmittedAtMs = Date.now()
  emitBattleLoadPhase(onPhase, {
    phase: 'worker-submitted',
    atMs: workerSubmittedAtMs,
    inputBytes,
  })
  const workerStarted = performance.now()
  let workerTiming: WorkerTaskTiming | null = null
  const parsed = await runWorkerTask(
    {
      kind: 'parse-battle',
      input: workerInput,
    },
    {
      priority: taskPriority,
      transferList: wireParts,
      signal,
      onControl: onWorkerControl,
      onTiming: (timing) => { workerTiming = timing },
    },
  )
  const workerWallMs = performance.now() - workerStarted
  const workerFinishedAtMs = Date.now()
  emitBattleLoadPhase(onPhase, {
    phase: 'worker-finished',
    atMs: workerFinishedAtMs,
    worker: workerTiming,
  })
  const completedAtMs = Date.now()
  return {
    header: parsed.header,
    results: parsed.results,
    battle: { ...parsed.battle, eventsBlob: Buffer.from(parsed.battle.eventsBlob) },
    summary: parsed.summary,
    timing: {
      startedAtMs: prepared.startedAtMs,
      replayReadyAtMs: prepared.replay.completedAtMs,
      workerSubmittedAtMs,
      workerFinishedAtMs,
      completedAtMs,
      totalMs: performance.now() - prepared.startedMonotonicMs,
      inputPrepareMs,
      workerWallMs,
      replay: prepared.replay,
      worker: workerTiming,
      parseProfile: parsed.profile,
    },
  }
  } finally {
    prepared.release()
  }
}

function emitBattleLoadPhase(
  callback: ((event: BattleLoadPhaseEvent) => void) | undefined,
  event: BattleLoadPhaseEvent,
): void {
  if (!callback) return
  try {
    callback(event)
  } catch {
    // Диагностический callback не должен менять результат загрузки боя.
  }
}

export interface ReconstructedBattleSummary {
  header: WrplHeader
  results: ReplayResults
  gameVersion: string | null
  missionSettings: string | null
}

export interface ReconstructedBattle extends ReconstructedBattleSummary {
  eventsBlob: Buffer | null
}

/** Scoreboard из БД без чтения и распаковки events_blob. */
export function reconstructBattleSummary(sessionId: string): ReconstructedBattleSummary | null {
  const data = getBattleSummaryForRender(sessionId)
  return data ? reconstructRows(data.battle, data.players) : null
}

/** Данные для media worker; events_blob читается, но не распаковывается в main. */
export function reconstructBattle(sessionId: string): ReconstructedBattle | null {
  const data = getBattleForRender(sessionId)
  if (!data) return null
  return { ...reconstructRows(data.battle, data.players), eventsBlob: data.eventsBlob }
}

function reconstructRows(
  battle: BattleRow,
  rows: BattlePlayerRow[],
): ReconstructedBattleSummary {
  const gameVersion = battle.game_version ?? null
  const header: WrplHeader = {
    version: 0,
    ...(gameVersion ? { gameVersion } : {}),
    level: battle.level,
    battleType: battle.battle_type ?? '',
    environment: battle.environment ?? '',
    visibility: '',
    resultsBlkOffset: 0,
    difficulty: 0,
    sessionId: battle.session_id,
    sessionIdHex: battle.session_hex,
    partNumber: 0,
    isServer: true,
    settingsBlkSize: 0,
    locName: battle.mission_name,
    startTime: battle.start_time,
    timeLimit: 0,
    scoreLimit: 0,
    battleClass: '',
  }

  const players: ReplayPlayerResult[] = rows.map((player) => ({
    userId: player.user_id,
    name: player.nick,
    clanTag: player.clan_tag,
    team: player.team,
    kills: player.kills,
    groundKills: player.ground_kills,
    navalKills: player.naval_kills,
    aiKills: player.ai_kills,
    aiGroundKills: player.ai_ground_kills,
    assists: player.assists,
    deaths: player.deaths,
    captureZone: player.capture_zone,
    damageZone: player.damage_zone,
    score: player.score,
    awardDamage: player.award_damage,
    teamKills: player.team_kills,
    squadId: player.squad_id,
    autoSquad: player.auto_squad === 1,
    slot: player.slot,
    title: player.title,
    vehicles: safeParseVehicles(player.vehicles),
  }))
  const results: ReplayResults = {
    status: battle.status ?? '',
    timePlayed: battle.duration_sec,
    players,
  }
  return {
    header,
    results,
    gameVersion,
    missionSettings: battle.mission_settings ?? null,
  }
}

function safeParseVehicles(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : []
  } catch {
    return []
  }
}
