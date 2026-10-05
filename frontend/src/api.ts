// Typed client of the wtbot JSON API: GETs read, the POSTs queue work for the bot.

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

/** Profile route key: /players/:wtUserId, /players/id/:identityId, /players/nick/:nick. */
export type PlayerKind = 'wt' | 'identity' | 'nick'

function playerApiBase(kind: PlayerKind, key: string): string {
  if (kind === 'wt') return `/api/players/${key}`
  if (kind === 'identity') return `/api/players/identity/${key}`
  return `/api/players/nick/${encodeURIComponent(key)}`
}

export function fetchPlayerInsights(
  kind: PlayerKind,
  key: string,
  days: number,
): Promise<{ ok: true; days: number; insights: PlayerInsights | null }> {
  return getJson(`${playerApiBase(kind, key)}/insights?days=${days}`)
}

export interface PlayerStatsRefresh {
  ok: true
  /** refreshQueued: the bot is rereading this source now; a source checked less than a day ago is not reread. */
  stats: { accountSources: { source: string; refreshQueued: boolean }[] }
}

/** Asks the bot to reread the player's external sources; it answers at once, the reads run in the background. */
export function requestPlayerStatsRefresh(player: string): Promise<PlayerStatsRefresh> {
  return postJson('/api/player-stats', { player })
}

export interface PlayerIdLookup {
  ok: true
  /** pending: the lookup goes on, ask again; not_found and ambiguous are cached for hours. */
  status: 'found' | 'pending' | 'not_found' | 'ambiguous'
  wtUserId: string | null
}

/** WT user id of a nick known without one; the bot stores a found id, so the roster links it next time. */
export function lookupPlayerId(nick: string): Promise<PlayerIdLookup> {
  return postJson('/api/player-id', { nick })
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

export function fetchPlayerProfile(kind: PlayerKind, key: string): Promise<PlayerProfile> {
  return getJson(playerApiBase(kind, key))
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

export function fetchPlayerHistory(kind: PlayerKind, key: string, days: number): Promise<PlayerHistory> {
  return getJson(`${playerApiBase(kind, key)}/history?days=${days}`)
}

export interface ClanListEntry {
  coreTag: string
  displayTag: string
  name: string | null
  members: number
  /** Official squadron rating; for a squadron outside the leaderboard — the sum of members' PSR. */
  totalRating: number
  /** Average PSR over roster snapshots; null — no snapshots. */
  avgRating: number | null
  /** Season battles and wins from the official leaderboard; null — not in it. */
  seasonBattles: number | null
  seasonWins: number | null
  /** Season kills and deaths from the leaderboard; null — not in it. */
  airKills: number | null
  groundKills: number | null
  deaths: number | null
  /** Crawl time of the official figures; without them — the latest member snapshot. */
  lastSeenAt: number
  /**
   * Official rating change over the day before the rating was last confirmed (its crawl; for a
   * zero below the crawled part, the last full crawl); null — no figures that old in the season,
   * no official data, or the squadron left the leaderboard.
   */
  delta24h: number | null
  /**
   * The window of delta24h, battles24h and wins24h: from the crawl that read the squadron nearest
   * to a day before delta24hTo (below the top 100 crawls come ~11 h apart, so it may be off by
   * hours) to its last confirmation; null — no change.
   */
  delta24hFrom: number | null
  delta24hTo: number | null
  /** Season battles and wins over the same window; null — no figures that old or no counts. */
  battles24h: number | null
  wins24h: number | null
  /** Places gained (+) or lost (−) since the table a day before the latest crawl; null — no place then. */
  rankChange24h: number | null
  /** Squadron battles that ended within the live window (replays): above 0 — playing now. */
  recentBattles: number
  /** The rating one place higher; null — first place or not in the leaderboard. */
  aboveRating: number | null
  /**
   * current — in the leaderboard; dropped — a rating above zero missed by the last full crawl
   * (renamed, disbanded or fallen to zero), the figures are its last; null — not in it this
   * season, rated by members' PSR.
   */
  leaderboard: 'current' | 'dropped' | null
  /** Place among all squadrons, not within the returned page. */
  rank: number
  /** false — no roster crawl yet: the sum may include members who left. */
  rosterKnown: boolean
}

/** Сезон по данным игры (лидерборд); даты могут расходиться с расписанием с форума. */
export interface OfficialClanSeason {
  seasonId: number
  startsAt: number
  /** Исключающая граница, Unix-секунды. */
  endsAt: number
}

/** Sort keys of /api/clans; place — the ranking's own order. */
export type ClanSortKey = 'place' | 'change' | 'battles' | 'winRate' | 'kd' | 'members'

/** Core tags of the squadrons holding the season's best figures; null — nobody qualifies. */
export interface ClanRecords {
  /** Win rate and K/D only count squadrons with enough battles (MIN_RATE_BATTLES on the server). */
  winRate: string | null
  kd: string | null
  battles: string | null
  /** The largest rating gain over 24 hours. */
  gain: string | null
}

/**
 * One page of the ranking by place, of a search by tag or name, or of a filtered and sorted view;
 * without parameters — the top 100.
 */
export function fetchClans(params: {
  query?: string
  offset?: number
  limit?: number
  /** Without it: by place, a search by relevance. */
  sort?: ClanSortKey
  dir?: 'asc' | 'desc'
  /** Only squadrons playing now. */
  live?: boolean
  /** Only these core tags (an empty list matches nothing). */
  tags?: readonly string[]
} = {}): Promise<{
  ok: true
  season: ClanSeasonContext
  officialSeason: OfficialClanSeason | null
  /** Every squadron matching the query and filters; not only this page. */
  total: number
  /** The oldest crawl time among the page's squadrons in the leaderboard; null — none on the page. */
  updatedAt: number | null
  /** The overall leader's rating, also on later pages and in a search: rating bars are shares of it. */
  leaderRating: number | null
  /** The rating at each reward tier's last place, top 5 to top 100; a tier not filled is missing. */
  tierCutoffs: { place: number; rating: number }[]
  records: ClanRecords
  /** Squadrons playing now in the whole ranking and when the window ended; null — replays are not coming in. */
  live: { count: number; at: number; windowSec: number } | null
  clans: ClanListEntry[]
}> {
  const search = new URLSearchParams()
  if (params.query) search.set('query', params.query)
  if (params.offset) search.set('offset', String(params.offset))
  if (params.limit) search.set('limit', String(params.limit))
  if (params.sort) search.set('sort', params.sort)
  if (params.dir) search.set('dir', params.dir)
  if (params.live) search.set('live', 'true')
  if (params.tags) search.set('tags', params.tags.join(','))
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
