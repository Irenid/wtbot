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
} from '../workers/pool.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import type { BattleItemMeta } from './battle-transform.js'
import { ensureEcsHashesJson } from './ecs.js'
import { fetchReplayParts } from './replay-events.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'

export type { BattleItemMeta } from './battle-transform.js'

/** Результат полного разбора без тяжёлых траекторий в main thread. */
export interface LoadedBattle {
  header: WrplHeader
  results: ReplayResults
  battle: BattleInput
  summary: BattleEventSummary
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
): Promise<LoadedBattle> {
  if (partUrls.length === 0) throw new Error('пустой список частей реплея')
  const [parts, ecsHashesJson] = await Promise.all([
    fetchReplayParts(partUrls, signal),
    ensureEcsHashesJson(),
  ])
  const wireParts = parts.map(transferableBuffer)
  const taskPriority = typeof priority === 'function' ? priority() : priority
  const parsed = await runWorkerTask(
    {
      kind: 'parse-battle',
      input: { parts: wireParts, realNames: [...realNames], meta, ecsHashesJson },
    },
    { priority: taskPriority, transferList: wireParts, signal, onControl: onWorkerControl },
  )
  return {
    header: parsed.header,
    results: parsed.results,
    battle: { ...parsed.battle, eventsBlob: Buffer.from(parsed.battle.eventsBlob) },
    summary: parsed.summary,
  }
}

export interface ReconstructedBattleSummary {
  header: WrplHeader
  results: ReplayResults
  missionSettings: string | null
}

export interface ReconstructedBattle extends ReconstructedBattleSummary {
  eventsBlob: Buffer | null
}

/** Scoreboard из БД без чтения и gunzip events_blob. */
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
  const header: WrplHeader = {
    version: 0,
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
    autoSquad: false,
    vehicles: safeParseVehicles(player.vehicles),
  }))
  const results: ReplayResults = {
    status: battle.status ?? '',
    timePlayed: battle.duration_sec,
    players,
  }
  return { header, results, missionSettings: battle.mission_settings }
}

function safeParseVehicles(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : []
  } catch {
    return []
  }
}
