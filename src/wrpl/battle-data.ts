import { gzipSync, gunzipSync } from 'node:zlib'
import {
  getBattleForRender,
  type BattleInput,
  type BattleKillInput,
  type BattlePlayerInput,
  type BattleChatInput,
} from '../db/index.js'
import { extractReplayEvents, fetchReplayParts, type ReplayEvents } from './replay-events.js'
import {
  applyRealNames,
  parseReplayResults,
  parseWrplHeader,
  type ReplayPlayerResult,
  type ReplayResults,
  type WrplHeader,
} from './replay.js'

/**
 * Разбор одного боя из частей реплея в структуру для БД.
 *
 * Общий код ingest-воркера и сборки картинок (battle-media): и тому, и
 * другому нужно скачать части, распарсить заголовок, results-BLK и пакетный
 * поток. Раньше эта логика жила только внутри battle-media.doBuildBattleMedia
 * и результат уходил в PNG; теперь она вынесена сюда, а результат можно
 * разложить по таблицам (buildBattleInput) — тогда сам реплей больше не нужен.
 */

export interface LoadedBattle {
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  /** Скачанные части — переиспользуются рендером, чтобы не качать дважды */
  parts: Buffer[]
}

/**
 * Скачивает все части реплея и разбирает их: заголовок (part 0), таблицу
 * результатов (results-BLK в конце последней части, где есть смещение) и
 * события пакетного потока. Анонимные ники в результатах заменяются на
 * настоящие по realNames (см. realNamesFromItem).
 */
export async function loadBattleData(partUrls: string[], realNames: Map<string, string>): Promise<LoadedBattle> {
  if (partUrls.length === 0) throw new Error('пустой список частей реплея')
  const parts = await fetchReplayParts(partUrls)

  const header = parseWrplHeader(parts[0]!)
  let results: ReplayResults | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const h = parseWrplHeader(parts[i]!)
    if (h.resultsBlkOffset > 0 && h.resultsBlkOffset < parts[i]!.length) {
      results = parseReplayResults(parts[i]!.subarray(h.resultsBlkOffset))
      break
    }
  }
  if (!results) throw new Error('ни одна часть реплея не содержит results-BLK')
  applyRealNames(results, realNames)

  // Пакетный поток разбирается синхронно и надолго занимает поток. Уступаем
  // цикл перед этим: нажатия Discord, ждущие в очереди (у них 3 с на
  // подтверждение), успеют ответить, прежде чем поток заморозится разбором.
  await new Promise((resolve) => setImmediate(resolve))
  const events = await extractReplayEvents(parts)
  return { header, results, events, parts }
}

/** Путь к файлу миссии из заголовка (поле levelSettings, 260 байт с 136) */
export function levelSettingsOf(part0: Buffer): string {
  const chunk = part0.subarray(136, 136 + 260)
  const end = chunk.indexOf(0)
  return chunk.subarray(0, end < 0 ? chunk.length : end).toString('utf8')
}

/** Метаданные записи парсера, которых нет в самом реплее */
export interface BattleItemMeta {
  missionName?: string | undefined
  gameMode?: string | undefined
  gameVersion?: string | undefined
}

const pos = (p: { x: number; y: number; z: number } | null): { x: number; y: number; z: number } | null =>
  p ? { x: p.x, y: p.y, z: p.z } : null

/**
 * Округляет координаты траекторий и убийств до целых метров, на месте.
 * Карта боя — километры, картинка ~1000 px, поэтому доли метра невидимы,
 * а float вроде `2343.2382835866` раздувает JSON: округление даёт ~−57%
 * размера сжатого blob. Делается один раз, до записи и в blob, и в
 * battle_kills — координаты везде согласованы.
 */
function roundEventsInPlace(events: ReplayEvents): void {
  for (const u of events.units) {
    for (const p of u.path) {
      p.t = Math.round(p.t)
      p.x = Math.round(p.x)
      p.y = Math.round(p.y)
      p.z = Math.round(p.z)
    }
  }
  for (const k of events.kills) {
    for (const p of [k.killerPos, k.victimPos]) {
      if (p) {
        p.x = Math.round(p.x)
        p.y = Math.round(p.y)
        p.z = Math.round(p.z)
      }
    }
  }
}

/** Разобранный бой → строки для saveBattle */
export function buildBattleInput(meta: BattleItemMeta, loaded: LoadedBattle): BattleInput {
  const { header, results, events } = loaded
  roundEventsInPlace(events)

  const players: BattlePlayerInput[] = results.players.map((p) => {
    // -1 — сентинел «нет строки результатов» (отключился), в датасете это 0
    const disconnected = p.name === '' || p.vehicles.length === 0
    const n = (v: number): number => (disconnected ? Math.max(v, 0) : v)
    return {
      userId: p.userId,
      nick: p.name,
      clanTag: p.clanTag,
      team: p.team,
      kills: n(p.kills),
      groundKills: n(p.groundKills),
      navalKills: n(p.navalKills),
      aiKills: n(p.aiKills),
      aiGroundKills: n(p.aiGroundKills),
      assists: n(p.assists),
      deaths: n(p.deaths),
      captureZone: n(p.captureZone),
      damageZone: n(p.damageZone),
      score: n(p.score),
      awardDamage: n(p.awardDamage),
      teamKills: n(p.teamKills),
      squadId: p.squadId,
      vehicle: p.vehicles[0] ?? null,
      vehicles: p.vehicles,
      disconnected,
    }
  })

  const kills: BattleKillInput[] = events.kills.map((k) => ({
    timeMs: k.time,
    killerId: k.killerId,
    killerModel: k.killerModel,
    victimId: k.victimId,
    victimModel: k.victimModel,
    weapon: k.weapon,
    killerPos: pos(k.killerPos),
    victimPos: pos(k.victimPos),
  }))

  const chat: BattleChatInput[] = events.chat.map((m) => ({
    timeMs: m.time,
    sender: m.sender,
    channel: m.channel,
    message: m.message,
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
    missionSettings: loaded.parts[0] ? levelSettingsOf(loaded.parts[0]) : null,
    players,
    kills,
    chat,
    eventsBlob: encodeEventsBlob(events),
  }
}

/** Полный ReplayEvents (без errors) → gzip(JSON) для колонки events_blob */
export function encodeEventsBlob(events: ReplayEvents): Buffer {
  const payload = {
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

/** Обратно из blob в ReplayEvents — для перерисовки картинок без реплея */
export function decodeEventsBlob(blob: Buffer): ReplayEvents {
  const parsed = JSON.parse(gunzipSync(blob).toString('utf8')) as Omit<ReplayEvents, 'errors'>
  return { ...parsed, errors: [] }
}

/** Собранный из БД бой для рендера — без частей реплея */
export interface ReconstructedBattle {
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  /** Путь к файлу миссии (для границ карты хитмапа); null — миссии нет в БД */
  missionSettings: string | null
}

/**
 * Восстанавливает бой из БД (battles + battle_players + events_blob) в тот же
 * вид {header, results, events}, что даёт разбор реплея — но без скачивания.
 * Рендерам нужен лишь небольшой набор полей заголовка (level/battleType/
 * startTime/sessionId), остальное заполняется нейтральными значениями.
 * null — бой ещё не разобран (в battles его нет).
 */
export function reconstructBattle(sessionId: string): ReconstructedBattle | null {
  const data = getBattleForRender(sessionId)
  if (!data) return null
  const b = data.battle

  const header: WrplHeader = {
    version: 0,
    level: b.level,
    battleType: b.battle_type ?? '',
    environment: b.environment ?? '',
    visibility: '',
    resultsBlkOffset: 0,
    difficulty: 0,
    sessionId: b.session_id,
    sessionIdHex: b.session_hex,
    partNumber: 0,
    isServer: true,
    settingsBlkSize: 0,
    locName: b.mission_name,
    startTime: b.start_time,
    timeLimit: 0,
    scoreLimit: 0,
    battleClass: '',
  }

  const players: ReplayPlayerResult[] = data.players.map((p) => ({
    userId: p.user_id,
    name: p.nick,
    clanTag: p.clan_tag,
    team: p.team,
    kills: p.kills,
    groundKills: p.ground_kills,
    navalKills: p.naval_kills,
    aiKills: p.ai_kills,
    aiGroundKills: p.ai_ground_kills,
    assists: p.assists,
    deaths: p.deaths,
    captureZone: p.capture_zone,
    damageZone: p.damage_zone,
    score: p.score,
    awardDamage: p.award_damage,
    teamKills: p.team_kills,
    squadId: p.squad_id,
    autoSquad: false,
    vehicles: safeParseVehicles(p.vehicles),
  }))

  const results: ReplayResults = { status: b.status ?? '', timePlayed: b.duration_sec, players }

  const events: ReplayEvents = data.eventsBlob
    ? decodeEventsBlob(data.eventsBlob)
    : { teamWon: b.team_won, players: [], kills: [], damage: [], chat: [], units: [], zones: [], endTime: b.end_time_ms, errors: [] }

  return { header, results, events, missionSettings: b.mission_settings }
}

function safeParseVehicles(json: string): string[] {
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? (arr as string[]) : []
  } catch {
    return []
  }
}
