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

async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const err = (body ?? {}) as Partial<ApiError>
    throw new SiteApiError(response.status, err.code ?? 'ERROR', err.error ?? `HTTP ${response.status}`)
  }
  // Every endpoint answers with an object: no body (a cut connection, an aborted page) is a failure, not data.
  if (body === null) throw new SiteApiError(response.status, 'BAD_RESPONSE', `HTTP ${response.status}: the response is not JSON`)
  return body as T
}

async function getJson<T>(url: string): Promise<T> {
  return readJson<T>(await fetch(url, { headers: { accept: 'application/json' } }))
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  return readJson<T>(await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
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
  /** Техника, элитная техника и медали по нациям; есть только у официального профиля. */
  countries: ExternalCountry[]
  /** Уровень, даты, история кланов и ников, места в рейтингах WT; null — источник не дал. */
  account: PlayerAccount | null
}

export type PlayerRankMetric = 'battles' | 'victories' | 'winRate' | 'score' | 'airKills' | 'groundKills'

export interface PlayerAccount {
  level: number | null
  title: string | null
  registeredAt: number | null
  /** День последнего входа (точность источника — сутки). */
  lastOnlineAt: number | null
  /** Новые первыми; coreTag — ядро тега, если клан есть на сайте. */
  squadrons: { clanId: number | null; tag: string; seenAt: number; coreTag: string | null }[]
  /** Новые первыми. */
  names: { nick: string; seenAt: number }[]
  /** Места в рейтингах WT; place — с 1. */
  ranks: { mode: string; metric: PlayerRankMetric; value: number; place: number }[]
  /** Места во времени, старые первыми. */
  rankHistory: { at: number; mode: string; metric: PlayerRankMetric; place: number }[]
}

/** Текущий клан игрока: coreTag null — клана нет в данных сайта. */
export interface PlayerClan {
  coreTag: string | null
  displayTag: string
  name: string | null
  rank: number | null
  totalRating: number | null
  members: number | null
  role: string | null
  joinedAt: number | null
  activity: number | null
}

export interface PlayerInsightClan { clanTag: string; battles: number; wins: number; losses: number }
export interface PlayerInsightPlayer { userId: string; nick: string; count: number }

/** Разбор локальных реплеев игрока за период (до 500 последних боёв). */
export interface PlayerInsights {
  battles: number
  capped: boolean
  maps: { mission: string; battles: number; wins: number; losses: number }[]
  vehicles: { vehicleId: string; battles: number; wins: number; kills: number; deaths: number }[]
  playedFor: PlayerInsightClan[]
  opponents: PlayerInsightClan[]
  teammates: (PlayerInsightPlayer & { wins: number })[]
  weapons: { weapon: string; kills: number }[]
  victims: { vehicleId: string; kills: number }[]
  killers: { vehicleId: string; kills: number }[]
  preys: PlayerInsightPlayer[]
  nemeses: PlayerInsightPlayer[]
  /** Начало боёв, Unix-секунды: часы активности считаются в поясе браузера. */
  starts: number[]
}

export function fetchPlayerInsights(
  kind: 'wt' | 'identity',
  key: string,
  days: number,
): Promise<{ ok: true; days: number; insights: PlayerInsights | null }> {
  const base = kind === 'wt' ? `/api/players/${key}/insights` : `/api/players/identity/${key}/insights`
  return getJson(`${base}?days=${days}`)
}

/**
 * Просит бота обновить внешние источники игрока. Источник с данными младше
 * суток не перечитывается; ответ приходит сразу, обновление идёт в фоне.
 */
export function requestPlayerStatsRefresh(player: string): Promise<{ ok: true }> {
  return postJson('/api/player-stats', { player })
}

export interface ExternalCountry {
  /** Нация, как подписана на английской странице профиля (USA, USSR…). */
  country: string
  vehicles: number | null
  eliteVehicles: number | null
  medals: number | null
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
  clan: PlayerClan | null
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
  /** Официальный рейтинг полковых боёв; для клана вне лидерборда — сумма ПКР. */
  totalRating: number
  /** Средний ПКР по снимкам состава; null — снимков нет. */
  avgRating: number | null
  /** Бои и победы сезона по официальному лидерборду; null — клана в нём нет. */
  seasonBattles: number | null
  seasonWins: number | null
  /** Фраги и смерти сезона по лидерборду; null — клана в нём нет. */
  airKills: number | null
  groundKills: number | null
  deaths: number | null
  lastSeenAt: number
  /**
   * Изменение рейтинга с отметки месяц назад внутри сезона; у клана вне
   * лидерборда — ПКР участников, известных и тогда, и сейчас. null — базиса нет.
   */
  delta30d: number | null
  /** Place among all squadrons, not within the returned page. */
  rank: number
  /** false — ростер ещё не обходили: сумма может включать ушедших участников. */
  rosterKnown: boolean
}

/** Сезон по данным игры (лидерборд); даты могут расходиться с расписанием с форума. */
export interface OfficialClanSeason {
  seasonId: number
  startsAt: number
  /** Исключающая граница, Unix-секунды. */
  endsAt: number
}

/** One page of the ranking by place; without parameters — the top 100. */
export function fetchClans(params: { offset?: number; limit?: number } = {}): Promise<{
  ok: true
  season: ClanSeasonContext
  officialSeason: OfficialClanSeason | null
  /** All ranked squadrons, not only this page. */
  total: number
  /** The first place's rating; null — no squadrons. */
  leaderRating: number | null
  clans: ClanListEntry[]
}> {
  const search = new URLSearchParams()
  if (params.offset) search.set('offset', String(params.offset))
  if (params.limit) search.set('limit', String(params.limit))
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return getJson(`/api/clans${suffix}`)
}

export interface SiteStats {
  ok: true
  season: ClanSeasonContext
  officialSeason: OfficialClanSeason | null
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

export interface ClanHistoryPoint {
  t: number
  total: number
  /** Бои и победы сезона на момент точки — только у официального рейтинга. */
  battles?: number | null
  wins?: number | null
}

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

/** Награды прошлых сезонов: [номер сезона, звания вида «place1@historical»]. */
export interface ClanSeasonRewards {
  best: [number, string][]
  log: [number, string[]][]
}

/** Условия вступления: ранг техники по веткам и минимум боёв по режиму. */
export interface ClanRequirements {
  ranks: { mode: 'and' | 'or'; items: { unitType: string; rank: number; count: number }[] } | null
  battles: { difficulty: string; count: number }[]
}

/** Профиль клана из лидерборда. Описание и объявление — недоверенный текст. */
export interface ClanProfile {
  clanId: number | null
  description: string | null
  announcement: string | null
  requirements: ClanRequirements | null
  status: string | null
  autoAccept: boolean | null
  plainTag: string | null
  /** Украшение тега за прошлый сезон: common, top100…top5, place3…place1. */
  regalia: string | null
}

export interface ClanDetail {
  ok: true
  season: ClanSeasonContext
  clan: {
    coreTag: string
    displayTag: string
    name: string | null
    members: number
    seasonBattles: number | null
    seasonWins: number | null
    totalRating: number
    lastSeenAt: number
    rank: number
    delta30d: number | null
    rosterKnown: boolean
    /** true — рейтинг и дельта с официального лидерборда, иначе по снимкам ПКР. */
    official: boolean
    /** Статистика сезона из лидерборда; null — клана в нём нет. */
    airKills: number | null
    groundKills: number | null
    deaths: number | null
    /** Налёт участников за сезон, минуты. */
    flightTimeMin: number | null
    activity: number | null
    region: string | null
    /** normal — полк, battalion — батальон. */
    clanType: string | null
    foundedAt: number | null
    slogan: string | null
    rewards: ClanSeasonRewards | null
    profile: ClanProfile | null
  }
  roster: {
    nick: string
    rating: number
    delta: number | null
    seenAt: number
    identityId: number | null
    wtUserId: string | null
    /** Commander, Deputy, Officer, Sergeant, Private — со страницы клана. */
    role: string | null
    /** Дата вступления, Unix-секунды. */
    joinedAt: number | null
    activity: number | null
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
    /** Только при total = 0: первый бой в базе бота; null — боёв нет вовсе. */
    collectedSince: number | null
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
  /** The first driven vehicle; the lineup's first when the battle has no tracks. */
  vehicle: string | null
  /** Driven vehicles in spawn order; the lineup when the battle has no tracks. */
  vehicles: string[]
  /** Did not load in: no results row or no lineup. */
  disconnected: boolean
  /** A bot played the slot; its kills and score are this player's. */
  bot: boolean
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
