// Типизированный клиент JSON API wtbot. Все эндпоинты read-only.

export interface ApiError {
  ok: false
  code: string
  error: string
  retryAfterSec?: number
}

export class SiteApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SiteApiError'
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const err = (body ?? {}) as Partial<ApiError>
    throw new SiteApiError(response.status, err.code ?? 'ERROR', err.error ?? `HTTP ${response.status}`)
  }
  return body as T
}

export interface PlayerSearchEntry {
  identityId: number | null
  wtUserId: string | null
  nick: string
  platform: string | null
  origin: 'identity' | 'alias' | 'replay'
  lastSeenAt: number | null
}

export interface ClanSeasonStage {
  week: number
  startsAt: number
  endsAt: number
  maxBr: number
}

export interface ClanSeasonContext {
  season: {
    id: string
    name: string
    startsAt: number
    endsAt: number
    active: boolean
  } | null
  stages: ClanSeasonStage[]
  currentStage: ClanSeasonStage | null
}

export function searchPlayers(query: string, limit = 20): Promise<{ ok: true; players: PlayerSearchEntry[] }> {
  return getJson(`/api/players?query=${encodeURIComponent(query)}&limit=${limit}`)
}

export interface ExternalTotal {
  gameType: string | null
  mode: string | null
  category: string | null
  battles: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  timePlayedSec: number | null
  respawns: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

export interface ExternalVehicle {
  gameType: string | null
  mode: string | null
  vehicleId: string
  flyouts: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
  timePlayedSec: number | null
}

export interface AccountView {
  source: string
  status: string
  checkedAt: number | null
  fetchedAt: number | null
  sourceUpdatedAt: number | null
  error: string | null
  totals: ExternalTotal[]
  vehicles: ExternalVehicle[]
  vehicleCount: number
}

export interface ReplayStats {
  battles: number
  wins: number
  losses: number
  unknownResults: number
  winRate: number | null
  airKills: number
  groundKills: number
  navalKills: number
  aiAirKills: number
  aiGroundKills: number
  assists: number
  deaths: number
  score: number
  teamKills: number
  observedBattleTimeSec: number
  firstBattleAt: number | null
  lastBattleAt: number | null
  vehicles: { vehicleId: string; battles: number }[]
  coverageBattles: number
}

export interface PlayerProfile {
  ok: true
  player: {
    identityId: number | null
    wtUserId: string | null
    nick: string
    platform: string | null
    aliases: { source: string; nick: string; firstSeenAt: number; lastSeenAt: number }[]
  }
  rating: { clanTag: string; rating: number; delta: number | null } | null
  accounts: AccountView[]
  replay: ReplayStats | null
}

export function fetchPlayerProfile(kind: 'wt' | 'identity', key: string): Promise<PlayerProfile> {
  const base = kind === 'wt' ? `/api/players/${key}` : `/api/players/identity/${key}`
  return getJson(base)
}

export interface RatingPoint { nick: string; clanTag: string; rating: number; seenAt: number }
export interface AccountHistoryPoint {
  snapshotId: number
  checkedAt: number
  fetchedAt: number
  sourceUpdatedAt: number | null
  battles: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  timePlayedSec: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}
export interface ActivityPoint { day: string; battles: number; wins: number; unknownResults: number }

export interface PlayerHistory {
  ok: true
  days: number
  rating: RatingPoint[]
  account: Record<string, AccountHistoryPoint[]>
  activity: ActivityPoint[]
}

export function fetchPlayerHistory(kind: 'wt' | 'identity', key: string, days: number): Promise<PlayerHistory> {
  const base = kind === 'wt' ? `/api/players/${key}/history` : `/api/players/identity/${key}/history`
  return getJson(`${base}?days=${days}`)
}

export interface ClanListEntry {
  coreTag: string
  displayTag: string
  name: string | null
  members: number
  totalRating: number
  avgRating: number
  lastSeenAt: number
  /**
   * Изменение ПКР участников, известных и месяц назад, и сейчас — приход и
   * уход из состава в дельту не входят; null — ни у кого нет базиса.
   */
  delta30d: number | null
  /** Место в общем рейтинге всех кланов, а не только в показанной сотне. */
  rank: number
  /** false — ростер ещё не обходили: сумма может включать ушедших участников. */
  rosterKnown: boolean
}

export function fetchClans(): Promise<{ ok: true; season: ClanSeasonContext; clans: ClanListEntry[] }> {
  return getJson('/api/clans')
}

export interface SiteStats {
  ok: true
  season: ClanSeasonContext
  players: number
  clans: number
  battlesTotal: number
  battlesWeek: number
  lastBattleAt: number | null
  byDay: { day: string; battles: number }[]
}

export function fetchSiteStats(): Promise<SiteStats> {
  return getJson('/api/site-stats')
}

export interface ClanHistoryPoint { t: number; total: number }

export interface ClanHistory {
  ok: true
  days: number
  points: ClanHistoryPoint[]
  season: ClanSeasonContext
  /** true — серия упёрлась в лимит событий и не полна. */
  truncated: boolean
}

export function fetchClanHistory(coreTag: string, days = 90): Promise<ClanHistory> {
  return getJson(`/api/clans/${encodeURIComponent(coreTag)}/history?days=${days}`)
}

export interface BattleListEntry {
  sessionId: string
  sessionHex: string
  missionName: string
  gameMode: string | null
  startTime: number
  durationSec: number
  teamWon: number
  playerCount: number
  killCount: number
  /** Все команды боя; clanTag — доминирующий клан (null — без клана из 2+ игроков). */
  teams: { team: number; clanTag: string | null }[]
  /** При клановом фильтре: сторона клана в бою и её исход. */
  clanSide: { team: number; won: boolean | null } | null
  player: {
    team: number
    won: boolean | null
    score: number | null
    frags: number | null
    deaths: number | null
    vehicle: string | null
  } | null
}

export interface ClanDetail {
  ok: true
  season: ClanSeasonContext
  clan: {
    coreTag: string
    displayTag: string
    name: string | null
    members: number
    totalRating: number
    lastSeenAt: number
    rank: number
    delta30d: number | null
    rosterKnown: boolean
  }
  roster: {
    nick: string
    rating: number
    delta: number | null
    seenAt: number
    identityId: number | null
    wtUserId: string | null
  }[]
  battles: {
    days: number
    total: number
    wins: number
    losses: number
    unknownResults: number
    winRate: number | null
    score: number
    kills: number
    deaths: number
  }
  recent: BattleListEntry[]
}

export function fetchClan(coreTag: string, days?: number): Promise<ClanDetail> {
  const query = days === undefined ? '' : `?days=${days}`
  return getJson(`/api/clans/${encodeURIComponent(coreTag)}${query}`)
}

/** `to` — исключающая граница по времени старта (Unix, с): для «показать ещё». */
export function fetchBattles(params: { player?: string; clan?: string; limit?: number; to?: number }): Promise<{ ok: true; battles: BattleListEntry[] }> {
  const search = new URLSearchParams()
  if (params.player) search.set('player', params.player)
  if (params.clan) search.set('clan', params.clan)
  if (params.limit) search.set('limit', String(params.limit))
  if (params.to !== undefined) search.set('to', String(params.to))
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return getJson(`/api/battles${suffix}`)
}

export interface ScoreboardPlayer {
  userId: string | null
  nick: string
  clanTag: string | null
  clanCore: string | null
  airKills: number
  groundKills: number
  navalKills: number
  aiAirKills: number
  aiGroundKills: number
  assists: number
  deaths: number
  captureZone: number
  score: number
  teamKills: number
  squadId: number
  vehicle: string | null
  vehicles: string[]
  disconnected: boolean
  autoSquad: boolean | null
}

export interface BattleScoreboard {
  ok: true
  battle: {
    sessionId: string
    sessionHex: string
    missionName: string
    level: string
    gameMode: string | null
    battleType: string | null
    startTime: number
    durationSec: number
    teamWon: number
    winnerKnown: boolean
    gameVersion: string | null
    playerCount: number
    killCount: number
  }
  teams: { team: number; totalScore: number; won: boolean | null; players: ScoreboardPlayer[] }[]
}

export function fetchBattle(key: string): Promise<BattleScoreboard> {
  return getJson(`/api/battles/${encodeURIComponent(key)}`)
}

export interface SceneUnit {
  id: number
  userId: string | null
  model: string
  source: 'ground' | 'air'
  /** [t(мс), x, z] в мировых координатах, ~1 точка/сек. */
  path: [number, number, number][]
}

export interface SceneKill {
  t: number
  killerId: string | null
  victimId: string | null
  weapon: string
  x: number | null
  z: number | null
}

export interface BattleScene {
  v: number
  sessionId: string
  missionName: string
  gameMode: string | null
  startTime: number
  durationSec: number
  teamWon: number
  endTimeMs: number
  worldBounds: [number, number, number, number]
  map: { available: boolean; level: string }
  zones: { name: string; x: number; z: number }[]
  players: { userId: string; nick: string; team: number; clanTag: string | null }[]
  units: SceneUnit[]
  kills: SceneKill[]
}

/** Сцена сжата gzip-ом; браузер распаковывает её прозрачно по Content-Encoding. */
export function fetchBattleScene(key: string): Promise<BattleScene> {
  return getJson(`/api/battles/${encodeURIComponent(key)}/scene`)
}

export function battleMapUrl(key: string): string {
  return `/api/battles/${encodeURIComponent(key)}/map.png`
}

export interface VehicleInfo { name: string; cls: 'F' | 'H' | 'T' | 'L' | 'AA' | '?'; country: string }
export type VehicleDict = Record<string, VehicleInfo>

let vehicleDictPromise: Promise<VehicleDict> | null = null

/**
 * Словарь техники кэшируется на всё время жизни вкладки. Отказ (429, 503) не
 * запоминается: иначе после одной ошибки весь сайт до перезагрузки показывал
 * бы внутренние id техники. Текущий экран получает пустой словарь, следующий
 * вызов повторит запрос.
 */
export function fetchVehicleDict(): Promise<VehicleDict> {
  vehicleDictPromise ??= getJson<{ ok: true; vehicles: VehicleDict }>('/api/vehicles')
    .then((body) => body.vehicles)
    .catch(() => {
      vehicleDictPromise = null
      return {}
    })
  return vehicleDictPromise
}
