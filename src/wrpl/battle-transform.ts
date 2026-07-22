import { gzipSync, gunzipSync } from 'node:zlib'
import type {
  BattleChatInput,
  BattleInput,
  BattleKillInput,
  BattlePlayerInput,
} from '../db/index.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import { parseComponentHashMaps } from './ecs.js'
import { extractReplayEvents, type ReplayEvents } from './replay-events.js'
import {
  applyRealNames,
  parseReplayResults,
  parseWrplHeader,
  type ReplayResults,
  type WrplHeader,
} from './replay.js'

/** Метаданные записи сайта, которых нет в самом replay. */
export interface BattleItemMeta {
  missionName?: string | undefined
  gameMode?: string | undefined
  gameVersion?: string | undefined
}

export interface ParsedBattle {
  header: WrplHeader
  results: ReplayResults
  battle: BattleInput
  summary: BattleEventSummary
}

/** CPU-часть полного разбора. Вызывать только внутри worker thread. */
export async function parseBattleParts(
  parts: Buffer[],
  realNames: Map<string, string>,
  meta: BattleItemMeta,
  ecsHashesJson: string,
): Promise<ParsedBattle> {
  if (parts.length === 0) throw new Error('пустой список частей реплея')
  const header = parseWrplHeader(parts[0]!)
  let results: ReplayResults | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    const currentHeader = parseWrplHeader(part)
    if (currentHeader.resultsBlkOffset > 0 && currentHeader.resultsBlkOffset < part.length) {
      results = parseReplayResults(part.subarray(currentHeader.resultsBlkOffset))
      break
    }
  }
  if (!results) throw new Error('ни одна часть реплея не содержит results-BLK')
  applyRealNames(results, realNames)

  const events = extractReplayEvents(parts, parseComponentHashMaps(ecsHashesJson))
  roundEventsInPlace(events)
  const battle = buildBattleInput(meta, header, results, events, levelSettingsOf(parts[0]!))
  return { header, results, battle, summary: summarizeEvents(events) }
}

/** Путь к файлу миссии из заголовка (поле levelSettings, 260 байт с 136). */
export function levelSettingsOf(part0: Buffer): string | null {
  const chunk = part0.subarray(136, 136 + 260)
  const end = chunk.indexOf(0)
  const value = chunk.subarray(0, end < 0 ? chunk.length : end).toString('utf8')
  return value || null
}

function roundEventsInPlace(events: ReplayEvents): void {
  for (const unit of events.units) {
    for (const point of unit.path) {
      point.t = Math.round(point.t)
      point.x = Math.round(point.x)
      point.y = Math.round(point.y)
      point.z = Math.round(point.z)
    }
  }
  for (const kill of events.kills) {
    for (const point of [kill.killerPos, kill.victimPos]) {
      if (!point) continue
      point.x = Math.round(point.x)
      point.y = Math.round(point.y)
      point.z = Math.round(point.z)
    }
  }
}

const pos = (point: { x: number; y: number; z: number } | null): { x: number; y: number; z: number } | null =>
  point ? { x: point.x, y: point.y, z: point.z } : null

function buildBattleInput(
  meta: BattleItemMeta,
  header: WrplHeader,
  results: ReplayResults,
  events: ReplayEvents,
  missionSettings: string | null,
): BattleInput {
  const players: BattlePlayerInput[] = results.players.map((player) => {
    const disconnected = player.name === '' || player.vehicles.length === 0
    const normalized = (value: number): number => (disconnected ? Math.max(value, 0) : value)
    return {
      userId: player.userId,
      nick: player.name,
      clanTag: player.clanTag,
      team: player.team,
      kills: normalized(player.kills),
      groundKills: normalized(player.groundKills),
      navalKills: normalized(player.navalKills),
      aiKills: normalized(player.aiKills),
      aiGroundKills: normalized(player.aiGroundKills),
      assists: normalized(player.assists),
      deaths: normalized(player.deaths),
      captureZone: normalized(player.captureZone),
      damageZone: normalized(player.damageZone),
      score: normalized(player.score),
      awardDamage: normalized(player.awardDamage),
      teamKills: normalized(player.teamKills),
      squadId: player.squadId,
      vehicle: player.vehicles[0] ?? null,
      vehicles: player.vehicles,
      disconnected,
    }
  })

  const kills: BattleKillInput[] = events.kills.map((kill) => ({
    timeMs: kill.time,
    killerId: kill.killerId,
    killerModel: kill.killerModel,
    victimId: kill.victimId,
    victimModel: kill.victimModel,
    weapon: kill.weapon,
    killerPos: pos(kill.killerPos),
    victimPos: pos(kill.victimPos),
  }))
  const chat: BattleChatInput[] = events.chat.map((message) => ({
    timeMs: message.time,
    sender: message.sender,
    channel: message.channel,
    message: message.message,
  }))

  return {
    sessionId: header.sessionId,
    sessionHex: header.sessionIdHex,
    missionName: (meta.missionName ?? header.locName ?? '').trim(),
    level: header.level,
    gameMode: meta.gameMode ?? null,
    battleType: header.battleType || null,
    environment: header.environment || null,
    status: results.status || null,
    startTime: header.startTime,
    durationSec: Math.round(results.timePlayed),
    endTimeMs: events.endTime,
    teamWon: events.teamWon,
    gameVersion: meta.gameVersion ?? String(header.version),
    missionSettings,
    players,
    kills,
    chat,
    eventsBlob: encodeEventsBlob(events),
  }
}

/** Полный ReplayEvents (без диагностических errors) → gzip(JSON). */
export function encodeEventsBlob(events: ReplayEvents): Buffer {
  const payload: Omit<ReplayEvents, 'errors'> = {
    teamWon: events.teamWon,
    players: events.players,
    kills: events.kills,
    damage: events.damage,
    chat: events.chat,
    units: events.units,
    zones: events.zones,
    endTime: events.endTime,
  }
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
}

/** gzip(JSON) из БД → события. Вызывать только внутри worker thread. */
export function decodeEventsBlob(blob: Buffer): ReplayEvents {
  return decodeEventsBlobProfiled(blob).events
}

export interface EventsBlobDecodeProfile {
  gunzipMs: number
  utf8Ms: number
  jsonParseMs: number
}

/** Вариант для benchmark/профиля без повторной распаковки blob. */
export function decodeEventsBlobProfiled(blob: Buffer): {
  events: ReplayEvents
  profile: EventsBlobDecodeProfile
} {
  let started = performance.now()
  const json = gunzipSync(blob)
  const gunzipMs = performance.now() - started

  started = performance.now()
  const text = json.toString('utf8')
  const utf8Ms = performance.now() - started

  started = performance.now()
  const parsed = JSON.parse(text) as Omit<ReplayEvents, 'errors'>
  const jsonParseMs = performance.now() - started
  return {
    events: { ...parsed, errors: [] },
    profile: { gunzipMs, utf8Ms, jsonParseMs },
  }
}

export function summarizeEvents(events: ReplayEvents): BattleEventSummary {
  // Flight Model шлёт траектории БПЛА с пустым userId. На карте игроков
  // они не отображаются, поэтому не должны включать кнопки авиации.
  const airUnits = events.units.filter((unit) => unit.source === 'air' && unit.userId !== '' && unit.path.length >= 2)
  const airModels = [...new Set(airUnits.map((unit) => unit.model))]
  return {
    teamWon: events.teamWon,
    endTimeMs: events.endTime,
    players: events.players.length,
    kills: events.kills.length,
    damage: events.damage.length,
    chat: events.chat.length,
    units: events.units.length,
    airUnits: airUnits.length,
    airModels,
    zones: events.zones.length,
    errors: events.errors,
  }
}
