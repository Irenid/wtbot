import type {
  BattleChatInput,
  BattleInput,
  BattleKillInput,
  BattlePlayerInput,
} from '../db/index.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import { decodeEventsPayloadProfiled, encodeEventsJson, type EventsDecodeProfile } from './events-codec.js'
import { canonicalizeReplayEvents } from './events-repair.js'
import { applyPlayerEventFacts } from './player-events.js'
import { fillSquadronTags } from './squadron-tags.js'
import { parseComponentHashMaps } from './ecs.js'
import {
  extractReplayEventsProfiled,
  isValidReplayChatChannel,
  type ReplayEvents,
  type ReplayEventsProfile,
} from './replay-events.js'
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
  /** userId состава боя по Replay API; без него игроки results-BLK не отбрасываются. */
  listedUserIds?: string[] | undefined
  /** Анонимное имя → настоящее (fakeNamesFromItem): отправители чата. */
  fakeNames?: [string, string][] | undefined
}

export interface ParsedBattle {
  header: WrplHeader
  results: ReplayResults
  battle: BattleInput
  summary: BattleEventSummary
  profile: BattleParseProfile
}

export interface BattleParseProfile {
  headerResultsMs: number
  ecsHashesMs: number
  eventsMs: number
  eventPhases: ReplayEventsProfile
  normalizeMs: number
  transformAndGzipMs: number
  totalMs: number
}

/** The CPU part of a full parse. Call only inside a worker thread. */
export async function parseBattleParts(
  parts: Buffer[],
  realNames: Map<string, string>,
  meta: BattleItemMeta,
  ecsHashesJson: string,
): Promise<ParsedBattle> {
  if (parts.length === 0) throw new Error('empty replay part list')
  const totalStarted = performance.now()
  let phaseStarted = totalStarted
  const header = parseWrplHeader(parts[0]!)
  if (meta.gameVersion) header.gameVersion = meta.gameVersion
  let results: ReplayResults | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    const currentHeader = parseWrplHeader(part)
    if (currentHeader.resultsBlkOffset > 0 && currentHeader.resultsBlkOffset < part.length) {
      results = parseReplayResults(part.subarray(currentHeader.resultsBlkOffset))
      break
    }
  }
  // ingest.ts isIncompleteReplayParse matches this text: the replay is not fully uploaded yet.
  if (!results) throw new Error('no replay part holds a results-BLK')
  applyRealNames(results, realNames)
  const headerResultsMs = performance.now() - phaseStarted

  phaseStarted = performance.now()
  const componentHashes = parseComponentHashMaps(ecsHashesJson)
  const ecsHashesMs = performance.now() - phaseStarted
  const extracted = extractReplayEventsProfiled(parts, componentHashes)
  const events = extracted.events
  const eventsMs = extracted.profile.totalMs
  phaseStarted = performance.now()
  roundEventsInPlace(events)
  canonicalizeReplayEvents(events, new Map(meta.fakeNames ?? []))
  const slotByUserId = new Map(events.players.map((slot) => [slot.userId, slot]))
  for (const player of results.players) {
    const slot = slotByUserId.get(player.userId)
    if (!slot) continue
    player.slot = slot.slot
    player.title = slot.title
  }
  // The stored rows, as the repair pass sees them: its facts must come out the same.
  const participants = battleParticipants(results.players, meta.listedUserIds)
  applyPlayerEventFacts(participants, events)
  // After the facts: they give a team-0 player the team its marker names.
  fillSquadronTags(participants)
  const summary = summarizeEvents(events)
  const normalizeMs = performance.now() - phaseStarted
  phaseStarted = performance.now()
  const battle = buildBattleInput(meta, header, results, events, levelSettingsOf(parts[0]!), summary)
  const transformAndGzipMs = performance.now() - phaseStarted
  return {
    header,
    results,
    battle,
    summary,
    profile: {
      headerResultsMs,
      ecsHashesMs,
      eventsMs,
      eventPhases: extracted.profile,
      normalizeMs,
      transformAndGzipMs,
      totalMs: performance.now() - totalStarted,
    },
  }
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

/**
 * Игроки results-BLK без фантомного бота: отрицательный userId, ни одной
 * машины и нет в составе Replay API — давал 17 игроков вместо 16. Бот без
 * машины из официального состава остаётся: сайт игры тоже считает его
 * участником. Без состава (старые пути разбора) никто не отбрасывается.
 */
export function battleParticipants<T extends { userId: string; vehicles: readonly string[] }>(
  players: readonly T[],
  listedUserIds: readonly string[] | undefined,
): T[] {
  if (listedUserIds === undefined) return [...players]
  const listed = new Set(listedUserIds)
  return players.filter((player) => !(player.userId.startsWith('-') && player.vehicles.length === 0 && !listed.has(player.userId)))
}

/**
 * Строки battle_kills и battle_chat из событий: общий путь ingest и
 * фоновой починки записанных боёв (repair-battle-events).
 */
export function battleEventRows(events: Pick<ReplayEvents, 'kills' | 'chat'>): {
  kills: BattleKillInput[]
  chat: BattleChatInput[]
} {
  return {
    kills: events.kills.map((kill) => ({
      timeMs: kill.time,
      killerId: kill.killerId,
      killerModel: kill.killerModel,
      victimId: kill.victimId,
      victimModel: kill.victimModel,
      weapon: kill.weapon,
      killerPos: pos(kill.killerPos),
      victimPos: pos(kill.victimPos),
    })),
    chat: events.chat.map((message) => ({
      timeMs: message.time,
      sender: message.sender,
      channel: message.channel,
      channelValid: message.channelValid ?? isValidReplayChatChannel(message.channel),
      message: message.message,
    })),
  }
}

function buildBattleInput(
  meta: BattleItemMeta,
  header: WrplHeader,
  results: ReplayResults,
  events: ReplayEvents,
  missionSettings: string | null,
  summary: BattleEventSummary,
): BattleInput {
  const slotByUserId = new Map(events.players.map((slot) => [slot.userId, slot]))
  const players: BattlePlayerInput[] = battleParticipants(results.players, meta.listedUserIds).map((player) => {
    const slot = slotByUserId.get(player.userId)
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
      vehicle: (player.playedVehicles ?? player.vehicles)[0] ?? null,
      vehicles: player.vehicles,
      playedVehicles: player.playedVehicles ?? null,
      botUserId: player.botUserId ?? null,
      disconnected,
      slot: slot?.slot ?? player.slot ?? null,
      title: slot?.title || player.title || null,
      autoSquad: disconnected ? null : player.autoSquad,
    }
  })

  const { kills, chat } = battleEventRows(events)

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
    airUnitCount: summary.airUnits,
    chatCount: summary.chat,
    eventsBlob: encodeEventsBlob(events),
  }
}

/** Полный ReplayEvents (без диагностических errors) → блоб events-codec.ts (колоночный формат). */
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
  return encodeEventsJson(JSON.stringify(payload))
}

/** Блоб из БД (любой формат events-codec.ts) → события. Вызывать только внутри worker thread. */
export function decodeEventsBlob(blob: Buffer): ReplayEvents {
  return decodeEventsBlobProfiled(blob).events
}

export type EventsBlobDecodeProfile = EventsDecodeProfile

/** Вариант для benchmark/профиля без повторной распаковки blob. */
export function decodeEventsBlobProfiled(blob: Buffer): {
  events: ReplayEvents
  profile: EventsBlobDecodeProfile
} {
  const decoded = decodeEventsPayloadProfiled(blob)
  const parsed = decoded.payload as Omit<ReplayEvents, 'errors'>
  return { events: { ...parsed, errors: [] }, profile: decoded.profile }
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
