import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  findKnownPlayerMatches,
  getClanSeasonContext,
  getClanRatingsWithDelta,
  getOfficialClanSeason,
  getDbWorkerPath,
  getPlayerReplayInsights,
  getLatestPlayerExternalCheck,
  getLatestPlayerExternalStats,
  getPlayerIdentityAliases,
  getPlayerIdentityById,
  getPlayerIdentityByWtUserId,
  getPlayerRating,
  getPlayerReplayStats,
  getSiteActivityByDay,
  getSiteAliasIdentities,
  getSiteBattleCounts,
  getSiteBattleSummary,
  getSiteBattleTeamClansBatch,
  getSiteBattlesByDay,
  getSiteClanBattleTeams,
  getSiteClanBaselineRatings,
  getSiteClanDictionary,
  getSiteClanLatestMembers,
  getSiteClanOfficialRatingAt,
  getSiteClanOfficialRatingEvents,
  getSiteClanRatingBaseline,
  getSiteClanRatingEvents,
  getSiteClanProfile,
  getSiteFirstBattleAt,
  getLastFullClanCrawlAt,
  getSiteClanRosterAll,
  getSiteClanRosterDetails,
  getSiteExternalAggregateHistory,
  getSiteRatingHistory,
  getSiteReplayNick,
  getSiteReplayPlayerCount,
  getSiteReplayUserIdsByNick,
  listSiteBattles,
  normalizePlayerSearchKey,
  normalizeWtNick,
  resolveSiteSessionId,
  searchSitePlayers,
  type PlayerReplayStats,
  type SiteBattleListRow,
  type SiteClanMemberLatest,
} from '../../db/index.js'
import type { ClanSeasonRewards, PlayerReplayInsights, SiteClanRosterDetails } from '../../db/index.js'
import type { PlayerAccount, PlayerAccountSquadron } from '../../player-stats/account.js'
import type { PlayerIdentity } from '../../player-stats/types.js'
import { runWorkerTask } from '../../workers/pool.js'
import { buildBattleSceneGzip, loadBattleSceneMap } from '../../wrpl/battle-scene.js'
import { clanDisplayName, plainClanTag } from '../../wrpl/render-battle.js'
import { ensureVehicleDict, type VehicleDict } from '../../wrpl/vehicles.js'

// Read-модель сайта: только чтение SQLite. Эндпоинты не создают identity,
// не ставят внешние запросы в очередь и не трогают Edge-транспорт — обновление
// внешних снимков остаётся за POST /api/player-stats и фоновыми задачами.

/** Источники внешних снимков, которые показывает сайт. */
const SITE_ACCOUNT_SOURCES = ['official-profile', 'companion-profile', 'statshark'] as const

const RATE_WINDOW_MS = 60_000
const PER_IP_LIMIT = 60
const GLOBAL_LIMIT = 240
const MAX_IP_BUCKETS = 2_048
/** Кэш снапшота кланов: снимает повторную группировку при полинге страниц. */
const CLAN_CACHE_TTL_MS = 60_000
const DAY_SEC = 86_400
const VEHICLE_DICT_TIMEOUT_MS = 10_000
const MAX_SQUADRON_MEMBERS = 128
const TOP_SQUADRON_RATING_MEMBERS = 20
const OTHER_SQUADRON_RATING_WEIGHT = 0.05

interface RateBucket {
  startedAt: number
  count: number
}

function currentBucket(buckets: Map<string, RateBucket>, key: string, now: number): RateBucket {
  const current = buckets.get(key)
  if (current !== undefined && now - current.startedAt < RATE_WINDOW_MS) return current
  const fresh = { startedAt: now, count: 0 }
  buckets.set(key, fresh)
  return fresh
}

function cleanupBuckets(buckets: Map<string, RateBucket>, now: number): void {
  if (buckets.size <= MAX_IP_BUCKETS) return
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) buckets.delete(key)
  }
  while (buckets.size > MAX_IP_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

interface SiteClanGroup {
  coreTag: string
  /** Decorated raw tags the squadron has had (SQL filters). */
  rawTags: string[]
  /** The freshest raw tag: the display name is built from it. */
  displayTag: string
  name: string | null
  members: SiteClanMemberLatest[]
  totalRating: number
  lastSeenAt: number
  /** Place among all squadrons, 1 — the best (compareClanGroups). */
  rank: number
  /**
   * The roster is known from a claninfo crawl. false — no roster yet: the PSR sum counts
   * everyone who ever wore the tag, leavers included.
   */
  rosterKnown: boolean
  /** Season stats from the official leaderboard; null — the squadron is in no crawl of the season. */
  official: SiteClanOfficial | null
  /** One of the RANK_TIER_* values. */
  rankTier: number
}

/** In the latest leaderboard crawl. */
const RANK_TIER_LATEST = 0
/** In an earlier crawl, not older than the last full one: below the part the latest crawl read. */
const RANK_TIER_EARLIER = 1
/**
 * Missed by the last full crawl, which reads every squadron with a rating above zero: renamed,
 * disbanded or fallen to zero (a squadron that moved up a page during the crawl stays here until
 * the next one). Its last figures would otherwise hold a place above squadrons that are in the
 * table. A zero rating is never dropped: see SiteClanOfficial.confirmedAt.
 */
const RANK_TIER_DROPPED = 2
/** No official data this season: rated by the sum of members' PSR snapshots. */
const RANK_TIER_PSR = 3

interface SiteClanOfficial {
  /** The squadron's current tag in the leaderboard. */
  tag: string
  rating: number
  position: number | null
  members: number | null
  battles: number | null
  wins: number | null
  /** The crawl that read this row. */
  ratingAt: number
  /**
   * When the rating was last confirmed: ratingAt, or the last full crawl for a zero rating — the
   * crawl stops at a page without a rating above zero, so a zero below the read part is still zero.
   */
  confirmedAt: number
  airKills: number | null
  groundKills: number | null
  deaths: number | null
  /** Season flight time, minutes. */
  flightTime: number | null
  activity: number | null
  region: string | null
  clanType: string | null
  foundedAt: number | null
  slogan: string | null
  rewards: ClanSeasonRewards | null
}

/**
 * The one order of the squadron ranking: tier, then rating, leaderboard place and tag. The stale
 * rating of a squadron missing from a fresher crawl would otherwise push out squadrons that are
 * above it now.
 */
function compareClanGroups(left: SiteClanGroup, right: SiteClanGroup): number {
  return left.rankTier - right.rankTier
    || right.totalRating - left.totalRating
    || (left.official?.position ?? Number.MAX_SAFE_INTEGER) - (right.official?.position ?? Number.MAX_SAFE_INTEGER)
    || left.coreTag.localeCompare(right.coreTag)
}

interface ClanSnapshot {
  builtAt: number
  groups: Map<string, SiteClanGroup>
  /** PSR baseline (core tag + nick → the value a month ago) for honest deltas. */
  baseline: Map<string, number>
  seasonStart: number
  /** The "month ago" mark of the deltas, not before the season start. */
  baselineAt: number
  /** Official rating at baselineAt by core tag; filled on demand. */
  officialBaseline: Map<string, number | null>
  /** Official rating a day before each squadron's confirmedAt (clanDelta24h); filled on demand. */
  dayBaseline: Map<string, number | null>
}

/** Игровой Total PSR: 20 лучших участников полностью, остальные — 5%. */
function totalSquadronRating(ratings: readonly number[]): number {
  const sorted = [...ratings]
    .sort((left, right) => right - left)
    .slice(0, MAX_SQUADRON_MEMBERS)
  const top = sorted
    .slice(0, TOP_SQUADRON_RATING_MEMBERS)
    .reduce((sum, rating) => sum + rating, 0)
  const rest = sorted
    .slice(TOP_SQUADRON_RATING_MEMBERS)
    .reduce((sum, rating) => sum + rating, 0)
  return Math.round(top + rest * OTHER_SQUADRON_RATING_WEIGHT)
}

/** Ключ базиса: ядро тега + разделитель, не встречающийся в никах. */
function baselineKey(core: string, nick: string): string {
  return `${core}\u0000${nick}`
}

function buildClanSnapshot(): ClanSnapshot {
  const seasonStart = getClanSeasonContext().season?.startsAt ?? 0
  const members = getSiteClanLatestMembers()
  // The current roster by core tag: leavers are excluded from groups and sums; a core without
  // roster rows (before its first crawl) is read unfiltered.
  const rosterByCore = new Map<string, Map<string, number>>()
  for (const row of getSiteClanRosterAll()) {
    let roster = rosterByCore.get(row.clanCore)
    if (!roster) {
      roster = new Map()
      rosterByCore.set(row.clanCore, roster)
    }
    roster.set(row.nick, row.lastPresentAt)
  }
  const groups = new Map<string, SiteClanGroup>()
  // One nick can live under several decorated variants of one core: the freshest row is taken
  // so the member is not counted twice.
  const freshestByCoreNick = new Map<string, SiteClanMemberLatest>()
  for (const member of members) {
    const core = plainClanTag(member.clanTag)
    if (!core) continue
    const roster = rosterByCore.get(core)
    if (roster && roster.size > 0 && !roster.has(member.nick)) continue
    const key = `${core} ${member.nick}`
    const existing = freshestByCoreNick.get(key)
    if (!existing || member.seenAt > existing.seenAt) freshestByCoreNick.set(key, member)
  }
  for (const member of freshestByCoreNick.values()) {
    const core = plainClanTag(member.clanTag)
    if (!core) continue
    let group = groups.get(core)
    if (!group) {
      group = {
        coreTag: core,
        rawTags: [],
        displayTag: member.clanTag,
        name: null,
        members: [],
        totalRating: 0,
        lastSeenAt: 0,
        rank: 0,
        rosterKnown: (rosterByCore.get(core)?.size ?? 0) > 0,
        official: null,
        rankTier: RANK_TIER_PSR,
      }
      groups.set(core, group)
    }
    if (!group.rawTags.includes(member.clanTag)) group.rawTags.push(member.clanTag)
    group.members.push(member)
    if (member.seenAt > group.lastSeenAt) {
      group.lastSeenAt = member.seenAt
      group.displayTag = member.clanTag
    }
  }
  for (const group of groups.values()) {
    const roster = rosterByCore.get(group.coreTag)
    group.members = group.members
      .sort((left, right) =>
        (roster?.get(right.nick) ?? 0) - (roster?.get(left.nick) ?? 0)
        || right.seenAt - left.seenAt
        || right.rating - left.rating
        || left.nick.localeCompare(right.nick))
      .slice(0, MAX_SQUADRON_MEMBERS)
    const latestMember = [...group.members].sort((left, right) => right.seenAt - left.seenAt)[0]
    if (latestMember !== undefined) {
      group.displayTag = latestMember.clanTag
      group.lastSeenAt = latestMember.seenAt
    }
    group.totalRating = totalSquadronRating(group.members.map((member) => member.rating))
  }

  // The official leaderboard gives rating, place and member count; the PSR snapshot sum is left
  // to squadrons without official season data (snapshots exist only for squadrons from drawn
  // battles, and leaders went missing).
  const nameByTag = new Map<string, string>()
  const dictionaryTagsByCore = new Map<string, string[]>()
  const officialByCore = new Map<string, { name: string; stats: SiteClanOfficial }>()
  let latestOfficialAt = 0
  const fullCrawlAt = getLastFullClanCrawlAt()
  for (const row of getSiteClanDictionary()) {
    nameByTag.set(row.tag, row.name)
    const core = plainClanTag(row.tag)
    if (!core) continue
    const tags = dictionaryTagsByCore.get(core)
    if (tags) tags.push(row.tag)
    else dictionaryTagsByCore.set(core, [row.tag])
    if (row.rating === null || row.ratingAt === null || row.ratingAt < seasonStart) continue
    latestOfficialAt = Math.max(latestOfficialAt, row.ratingAt)
    // A decoration change leaves the previous tag in the dictionary: the fresher row wins.
    const existing = officialByCore.get(core)
    if (existing && existing.stats.ratingAt >= row.ratingAt) continue
    officialByCore.set(core, {
      name: row.name,
      stats: {
        tag: row.tag,
        rating: row.rating,
        position: row.position,
        members: row.members,
        battles: row.battles,
        wins: row.wins,
        ratingAt: row.ratingAt,
        confirmedAt: row.rating === 0 && fullCrawlAt !== null && row.ratingAt < fullCrawlAt ? fullCrawlAt : row.ratingAt,
        airKills: row.airKills,
        groundKills: row.groundKills,
        deaths: row.deaths,
        flightTime: row.flightTime,
        activity: row.activity,
        region: row.region,
        clanType: row.clanType,
        foundedAt: row.foundedAt,
        slogan: row.slogan,
        rewards: row.rewards,
      },
    })
  }
  for (const [core, { name, stats }] of officialByCore) {
    let group = groups.get(core)
    if (!group) {
      group = {
        coreTag: core,
        rawTags: [],
        displayTag: stats.tag,
        name: null,
        members: [],
        totalRating: 0,
        lastSeenAt: 0,
        rank: 0,
        rosterKnown: (rosterByCore.get(core)?.size ?? 0) > 0,
        official: null,
        rankTier: RANK_TIER_PSR,
      }
      groups.set(core, group)
    }
    group.official = stats
    group.name = name
    group.displayTag = stats.tag
    group.totalRating = stats.rating
    group.lastSeenAt = stats.ratingAt
    group.rankTier = stats.ratingAt === latestOfficialAt
      ? RANK_TIER_LATEST
      : fullCrawlAt !== null && stats.confirmedAt < fullCrawlAt ? RANK_TIER_DROPPED : RANK_TIER_EARLIER
  }
  for (const group of groups.values()) {
    // Tags for battle queries (SQL takes the first 8): the current leaderboard tag, then the ones
    // seen in snapshots and the other decorated variants from the dictionary.
    const tags: string[] = []
    const candidates = [
      ...(group.official ? [group.official.tag] : []),
      ...group.rawTags,
      ...(dictionaryTagsByCore.get(group.coreTag) ?? []),
    ]
    for (const tag of candidates) {
      if (!tags.includes(tag)) tags.push(tag)
    }
    group.rawTags = tags
    if (group.name === null) {
      group.name = tags.map((tag) => nameByTag.get(tag)).find((name) => name !== undefined) ?? null
    }
  }

  // Ranks cover every squadron: /api/clans returns one page, and a squadron page outside it
  // used to lose its place and delta.
  const ranked = [...groups.values()].sort(compareClanGroups)
  ranked.forEach((group, index) => {
    group.rank = index + 1
  })
  // An hour-rounded mark keeps the baseline stable within the cache TTL. The baseline is
  // filtered by the current roster too: a leaver does not skew the delta.
  const baselineAt = Math.max(
    seasonStart,
    Math.floor(Date.now() / 3_600_000) * 3_600 - 30 * DAY_SEC,
  )
  const baseline = new Map<string, number>()
  for (const row of getSiteClanBaselineRatings(baselineAt)) {
    const core = plainClanTag(row.clanTag)
    if (!core) continue
    const roster = rosterByCore.get(core)
    if (roster && roster.size > 0 && !roster.has(row.nick)) continue
    baseline.set(baselineKey(core, row.nick), row.rating)
  }
  return {
    builtAt: Date.now(),
    groups,
    baseline,
    seasonStart,
    baselineAt,
    officialBaseline: new Map(),
    dayBaseline: new Map(),
  }
}

/**
 * Дельта рейтинга за 30 дней. Официальная — от значения на границе «месяц
 * назад» внутри сезона: без такой точки истории дельты нет, а не дельта за
 * меньший срок. Для кланов без официальных данных — честная дельта суммы ПКР:
 * только участники, известные и месяц назад, и сейчас, — приход и уход
 * состава в неё не попадают.
 */
function clanDelta30d(snapshot: ClanSnapshot, group: SiteClanGroup): number | null {
  if (group.official !== null) {
    let base = snapshot.officialBaseline.get(group.coreTag)
    if (base === undefined) {
      base = getSiteClanOfficialRatingAt(group.coreTag, snapshot.seasonStart, snapshot.baselineAt)?.rating ?? null
      snapshot.officialBaseline.set(group.coreTag, base)
    }
    return base === null ? null : group.official.rating - base
  }
  const baselineRatings: number[] = []
  const currentRatings: number[] = []
  for (const member of group.members) {
    const base = snapshot.baseline.get(baselineKey(group.coreTag, member.nick))
    if (base === undefined) continue
    baselineRatings.push(base)
    currentRatings.push(member.rating)
  }
  return baselineRatings.length > 0
    ? totalSquadronRating(currentRatings) - totalSquadronRating(baselineRatings)
    : null
}

/**
 * Official rating change over the day before the rating was last confirmed: the top 100 are read
 * every 20 minutes and the rest at full crawls, so a shared "now − 24 h" mark would give the rest
 * a shorter window. null — no official data, the squadron left the leaderboard, or no history
 * point that old inside the season.
 */
function clanDelta24h(snapshot: ClanSnapshot, group: SiteClanGroup): number | null {
  const official = group.official
  if (official === null || group.rankTier > RANK_TIER_EARLIER) return null
  const dayAgo = official.confirmedAt - DAY_SEC
  if (dayAgo < snapshot.seasonStart) return null
  let base = snapshot.dayBaseline.get(group.coreTag)
  if (base === undefined) {
    base = getSiteClanOfficialRatingAt(group.coreTag, snapshot.seasonStart, dayAgo)?.rating ?? null
    snapshot.dayBaseline.set(group.coreTag, base)
  }
  return base === null ? null : official.rating - base
}

/** Status in the official leaderboard; see the RANK_TIER_* values. */
function leaderboardStatus(group: SiteClanGroup): 'current' | 'dropped' | null {
  if (group.official === null) return null
  return group.rankTier === RANK_TIER_DROPPED ? 'dropped' : 'current'
}

/**
 * Squadrons matching a search: the core tag (decorations and case ignored) or the name contains
 * the query. Exact tags first, then prefixes, then the rest, each by place: "ash" finds the
 * squadron ASH before ASHES and CRASH.
 */
function searchClanGroups(ranked: readonly SiteClanGroup[], query: string): SiteClanGroup[] {
  const core = plainClanTag(query)
  const text = normalizePlayerSearchKey(query.trim())
  const matches: { group: SiteClanGroup; score: number }[] = []
  for (const group of ranked) {
    const name = group.name === null ? '' : normalizePlayerSearchKey(group.name)
    const tagHit = core !== '' && group.coreTag.includes(core)
    if (!tagHit && (text === '' || !name.includes(text))) continue
    const score = core !== '' && group.coreTag === core
      ? 0
      : (core !== '' && group.coreTag.startsWith(core)) || (text !== '' && name.startsWith(text)) ? 1 : 2
    matches.push({ group, score })
  }
  // Array.prototype.sort is stable: equal scores keep the ranking order.
  return matches.sort((left, right) => left.score - right.score).map((match) => match.group)
}

interface SiteAccountView {
  source: string
  status: string
  checkedAt: number | null
  fetchedAt: number | null
  sourceUpdatedAt: number | null
  error: string | null
  totals: unknown[]
  vehicles: unknown[]
  vehicleCount: number
  /** Техника, элитная техника и медали по нациям (только официальный профиль). */
  countries: unknown[]
  /** Уровень, даты, история кланов и ников, места в рейтингах WT. */
  account: SiteAccountProfile | null
}

/** Аккаунт источника; у клана из истории — ядро тега, если клан есть на сайте. */
type SiteAccountProfile = Omit<PlayerAccount, 'squadrons'> & {
  squadrons: (PlayerAccountSquadron & { coreTag: string | null })[]
}

/** Техники в ответе — до 300 строк по вылетам: таблица сайта фильтрует и сортирует их сама. */
const SITE_ACCOUNT_VEHICLES = 300

function buildAccountViews(
  identity: PlayerIdentity,
  knownClanCore: (tag: string) => string | null,
): SiteAccountView[] {
  const views: SiteAccountView[] = []
  for (const source of SITE_ACCOUNT_SOURCES) {
    const lastCheck = getLatestPlayerExternalCheck(identity.id, source)
    const stats = getLatestPlayerExternalStats(identity.id, source)
    if (!lastCheck && !stats) continue
    const vehicles = stats
      ? [...stats.vehicles].sort((a, b) => (b.flyouts ?? 0) - (a.flyouts ?? 0)).slice(0, SITE_ACCOUNT_VEHICLES)
      : []
    const account = stats?.account ?? null
    views.push({
      source,
      status: lastCheck?.status ?? 'ok',
      checkedAt: lastCheck?.lastCheckedAt ?? stats?.snapshot.lastCheckedAt ?? null,
      fetchedAt: stats?.snapshot.fetchedAt ?? lastCheck?.fetchedAt ?? null,
      sourceUpdatedAt: stats?.snapshot.sourceUpdatedAt ?? null,
      error: lastCheck?.error ?? null,
      totals: stats ? stats.totals.slice(0, 100) : [],
      vehicles,
      vehicleCount: stats?.vehicles.length ?? 0,
      countries: stats ? stats.countries.slice(0, 20) : [],
      account: account === null
        ? null
        : {
          ...account,
          squadrons: account.squadrons.map((squadron) => ({ ...squadron, coreTag: knownClanCore(squadron.tag) })),
        },
    })
  }
  return views
}

interface SiteProfileTarget {
  identity: PlayerIdentity | null
  wtUserId: string | null
  nick: string | null
}

/** Profile URL key: /players/:wtUserId, /players/id/:identityId, /players/nick/:nick. */
type ProfileKind = 'wt' | 'identity' | 'nick'

/** Read-only resolution of a profile key: an identity by id or WT user id, a replay-only player or a nick. */
function resolveProfileTarget(kind: ProfileKind, key: string): SiteProfileTarget | null {
  if (kind === 'nick') return resolveNickTarget(key)
  if (kind === 'identity') {
    const identityId = Number(key)
    if (!Number.isSafeInteger(identityId) || identityId <= 0) return null
    const identity = getPlayerIdentityById(identityId)
    if (!identity) return null
    return { identity, wtUserId: identity.wtUserId, nick: identity.canonicalNick }
  }
  const identity = getPlayerIdentityByWtUserId(key)
  if (identity) return { identity, wtUserId: identity.wtUserId ?? key, nick: identity.canonicalNick }
  const replayNick = getSiteReplayNick(key)
  if (replayNick) return { identity: null, wtUserId: key, nick: replayNick }
  // Known only from voice or rating data: look for exact evidence of this id.
  const matches = findKnownPlayerMatches(key).filter((match) => match.wtUserId === key)
  const match = matches[0]
  if (match) return { identity: null, wtUserId: key, nick: match.nick }
  return null
}

/**
 * A profile by nick, for squadron members with no known id: the matching of
 * resolveKnownPlayer (src/player-stats/comparison.ts) without its writes, so the
 * page shows what its refresh button links. One WT user id, else one identity,
 * else the nick alone (PSR, roster); a nick of several ids stays nick-only, as the
 * refresh answers 409 for it.
 */
function resolveNickTarget(nick: string): SiteProfileTarget | null {
  const query = nick.trim()
  if (query === '') return null
  const key = normalizePlayerSearchKey(query)
  // A numeric query also matches a WT user id: keep the matches of this nick.
  const matches = findKnownPlayerMatches(query).filter((match) => normalizePlayerSearchKey(match.nick) === key)
  const wtUserIds = new Set(matches.flatMap((match) =>
    match.wtUserId !== null && /^[1-9]\d*$/.test(match.wtUserId) ? [match.wtUserId] : []))
  const [wtUserId] = wtUserIds
  if (wtUserIds.size === 1 && wtUserId !== undefined) return resolveProfileTarget('wt', wtUserId)
  if (wtUserIds.size === 0) {
    const identityIds = new Set(matches.flatMap((match) => (match.identityId === null ? [] : [match.identityId])))
    const [identityId] = identityIds
    if (identityIds.size === 1 && identityId !== undefined) return resolveProfileTarget('identity', String(identityId))
  }
  // Matches come newest first: the nick as the latest source spells it.
  const latest = matches[0]
  return latest === undefined ? null : { identity: null, wtUserId: null, nick: latest.nick }
}

function periodFromQuery(query: { from?: number; to?: number }): { from?: number; to?: number } {
  const period: { from?: number; to?: number } = {}
  if (query.from !== undefined) period.from = query.from
  if (query.to !== undefined) period.to = query.to
  return period
}

/**
 * Подписи команд в ленте: доминирующий клан каждой команды (минимум 2 игрока),
 * и — при клановом фильтре — сторона клана с исходом. Строки всех показанных
 * сессий загружаются одним batch-запросом по индексу session_id.
 */
function battleTeamsInfo(
  rows: { team: number; clanTag: string; players: number }[],
  teamWon: number,
  clanCores?: ReadonlySet<string>,
): { teams: { team: number; clanTag: string | null }[]; clanSide: { team: number; won: boolean | null } | null } {
  const byTeam = new Map<number, { tag: string; players: number }[]>()
  for (const row of rows) {
    const list = byTeam.get(row.team) ?? []
    list.push({ tag: row.clanTag, players: row.players })
    byTeam.set(row.team, list)
  }
  const teams: { team: number; clanTag: string | null }[] = []
  let clanSide: { team: number; won: boolean | null } | null = null
  let clanPlayers = 0
  for (const [team, tags] of [...byTeam.entries()].sort((a, b) => a[0] - b[0])) {
    // Пустой тег не участвует в выборе доминирующего клана, но команда без
    // клана остаётся в списке — иначе «против случайных» никогда не покажется.
    const top = [...tags].filter((entry) => entry.tag !== '').sort((a, b) => b.players - a.players)[0]
    teams.push({ team, clanTag: top !== undefined && top.players >= 2 ? clanDisplayName(top.tag) : null })
    if (clanCores) {
      const own = tags
        .filter((entry) => clanCores.has(plainClanTag(entry.tag)))
        .reduce((sum, entry) => sum + entry.players, 0)
      if (own > clanPlayers) {
        clanPlayers = own
        clanSide = { team, won: teamWon !== 0 ? team === teamWon : null }
      }
    }
  }
  return { teams, clanSide }
}

function battleListPayload(rows: SiteBattleListRow[], clanCores?: ReadonlySet<string>): unknown[] {
  const teamClans = getSiteBattleTeamClansBatch(rows.map((row) => row.sessionId))
  return rows.map((row) => {
    const info = battleTeamsInfo(teamClans.get(row.sessionId) ?? [], row.teamWon, clanCores)
    return {
      sessionId: row.sessionId,
      sessionHex: row.sessionHex,
      missionName: row.missionName,
      gameMode: row.gameMode,
      startTime: row.startTime,
      durationSec: row.durationSec,
      teamWon: row.teamWon,
      playerCount: row.playerCount,
      killCount: row.killCount,
      teams: info.teams,
      clanSide: info.clanSide,
      player: row.team === null
        ? null
        : {
            team: row.team,
            won: row.teamWon !== 0 ? row.team === row.teamWon : null,
            score: row.score,
            frags: row.frags,
            deaths: row.deaths,
            vehicle: row.vehicle,
          },
    }
  })
}

function parseVehiclesJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

export interface SiteRoutesOptions {
  /** Подменяется в smoke: боевой загрузчик качает датамайн при холодном data/. */
  loadVehicleDict?: () => Promise<VehicleDict>
  /** Подменяется в smoke/benchmark; file-backed DB читает тяжёлые агрегаты в worker. */
  loadDashboardStats?: (
    sinceTs: number,
    seasonStart: number,
  ) => Promise<{
    players: number
    clans: number
    battlesTotal: number
    battlesRecent: number
    lastBattleAt: number | null
    byDay: { day: string; battles: number }[]
  }>
}

export const siteRoutes: FastifyPluginAsync<{ site?: SiteRoutesOptions }> = async (app, opts) => {
  const loadVehicleDict = opts.site?.loadVehicleDict ?? (() => ensureVehicleDict('normal'))
  const ipBuckets = new Map<string, RateBucket>()
  const globalBuckets = new Map<string, RateBucket>()
  let clanSnapshot: ClanSnapshot | null = null
  let clanRebuildScheduled = false
  let closed = false
  app.addHook('onClose', async () => {
    closed = true
  })

  /**
   * Stale-while-revalidate: запрос получает последний снимок сразу, а
   * перестройка (~200 мс синхронного SQLite и JS на большой БД) идёт после
   * ответа, а не внутри него. Синхронно строится только самый первый снимок.
   */
  function cachedClanSnapshot(): ClanSnapshot {
    if (clanSnapshot === null) {
      clanSnapshot = buildClanSnapshot()
      return clanSnapshot
    }
    if (Date.now() - clanSnapshot.builtAt >= CLAN_CACHE_TTL_MS && !clanRebuildScheduled) {
      clanRebuildScheduled = true
      setImmediate(() => {
        try {
          if (!closed) clanSnapshot = buildClanSnapshot()
        } catch (error) {
          console.warn(`[site] Снимок кланов не перестроен: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          clanRebuildScheduled = false
        }
      })
    }
    return clanSnapshot
  }

  function clanGroups(): Map<string, SiteClanGroup> {
    return cachedClanSnapshot().groups
  }

  /** true — запрос пропущен; false — уже отправлен 429. */
  function passRateLimit(request: FastifyRequest, reply: FastifyReply, weight = 1): boolean {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > PER_IP_LIMIT) {
      throw new RangeError('Вес rate limit должен быть положительным целым числом')
    }
    const now = Date.now()
    cleanupBuckets(ipBuckets, now)
    const ipBucket = currentBucket(ipBuckets, request.ip, now)
    const globalBucket = currentBucket(globalBuckets, 'global', now)
    if (ipBucket.count + weight > PER_IP_LIMIT || globalBucket.count + weight > GLOBAL_LIMIT) {
      const retryAt = Math.max(
        ipBucket.count + weight > PER_IP_LIMIT ? ipBucket.startedAt + RATE_WINDOW_MS : now,
        globalBucket.count + weight > GLOBAL_LIMIT ? globalBucket.startedAt + RATE_WINDOW_MS : now,
      )
      const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1_000))
      void reply
        .header('Retry-After', String(retryAfterSec))
        .code(429)
        .send({ ok: false, code: 'RATE_LIMITED', error: 'Слишком много запросов сайта', retryAfterSec })
      return false
    }
    ipBucket.count += weight
    globalBucket.count += weight
    return true
  }

  app.get<{ Querystring: { query: string; limit?: number } }>('/api/players', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 2, maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    try {
      const players = searchSitePlayers(request.query.query, request.query.limit ?? 20)
      return { ok: true, players }
    } catch (error) {
      if (error instanceof RangeError) {
        return reply.code(400).send({ ok: false, code: 'INVALID_QUERY', error: error.message })
      }
      throw error
    }
  })

  const profileHandler = (kind: ProfileKind) =>
    async (
      request: FastifyRequest<{ Params: { key: string }; Querystring: { from?: number; to?: number } }>,
      reply: FastifyReply,
    ) => {
      if (!passRateLimit(request, reply)) return reply
      const target = resolveProfileTarget(kind, request.params.key)
      if (!target || !target.nick) {
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Player not found in local data' })
      }
      const { from, to } = request.query
      if (from !== undefined && to !== undefined && from > to) {
        return reply.code(400).send({ ok: false, code: 'INVALID_PERIOD', error: 'from cannot be later than to' })
      }
      const aliases = target.identity ? getPlayerIdentityAliases(target.identity.id) : []
      const groups = clanGroups()
      const knownClanCore = (tag: string): string | null => {
        const core = plainClanTag(tag)
        return core !== '' && groups.has(core) ? core : null
      }
      const accounts = target.identity ? buildAccountViews(target.identity, knownClanCore) : []
      let replay: PlayerReplayStats | null = null
      if (target.wtUserId) {
        replay = getPlayerReplayStats({ userId: target.wtUserId }, periodFromQuery(request.query))
      }
      const rating = getPlayerRating(target.nick)
      // The squadron of the season's PSR snapshot, else the latest one in the StatShark history.
      const latestSquadron = accounts.find((account) => account.source === 'statshark')?.account?.squadrons[0]
      const clan = playerClanView(target.nick, rating?.clanTag ?? latestSquadron?.tag ?? null)
      return {
        ok: true,
        player: {
          identityId: target.identity?.id ?? null,
          wtUserId: target.wtUserId,
          nick: target.nick,
          platform: target.identity?.platform ?? null,
          aliases: aliases.map((alias) => ({
            source: alias.source,
            nick: alias.nick,
            firstSeenAt: alias.firstSeenAt,
            lastSeenAt: alias.lastSeenAt,
          })),
        },
        rating,
        clan,
        accounts,
        replay,
      }
    }

  /**
   * Текущий клан игрока для профиля: место и рейтинг клана из снимка сайта,
   * роль, дата вступления и активность — из ростера claninfo (ник сверяется
   * без платформенного суффикса). coreTag null — клана нет в данных сайта.
   */
  function playerClanView(nick: string, tag: string | null) {
    if (tag === null) return null
    const core = plainClanTag(tag)
    if (core === '') return null
    const group = clanGroups().get(core)
    const base = normalizeWtNick(nick)
    let details: SiteClanRosterDetails | undefined
    for (const [rosterNick, entry] of getSiteClanRosterDetails(core)) {
      if (normalizeWtNick(rosterNick) === base) {
        details = entry
        break
      }
    }
    return {
      coreTag: group ? core : null,
      displayTag: clanDisplayName(group?.displayTag ?? tag),
      name: group?.name ?? null,
      rank: group?.rank ?? null,
      totalRating: group?.totalRating ?? null,
      members: group ? group.official?.members ?? group.members.length : null,
      role: details?.role ?? null,
      joinedAt: details?.joinedAt ?? null,
      activity: details?.activity ?? null,
    }
  }

  // Аналитика по реплеям игрока: до 500 боёв, на холодном кэше ~0,3 с чтений —
  // в worker со своим подключением; результат кэшируется на минуту, а
  // одновременные одинаковые запросы ждут одну задачу.
  const INSIGHTS_TTL_MS = 60_000
  const INSIGHTS_CACHE_LIMIT = 200
  const insightsCache = new Map<string, { builtAt: number; value: Promise<PlayerReplayInsights> }>()
  function loadPlayerInsights(userId: string, days: number): Promise<PlayerReplayInsights> {
    const key = `${userId}:${days}`
    const now = Date.now()
    const cached = insightsCache.get(key)
    if (cached && now - cached.builtAt < INSIGHTS_TTL_MS) return cached.value
    const toTs = Math.floor(now / 1_000) + 1
    const fromTs = toTs - 1 - days * DAY_SEC
    const dbPath = getDbWorkerPath()
    const value: Promise<PlayerReplayInsights> = dbPath === null
      ? Promise.resolve().then(() => getPlayerReplayInsights(userId, fromTs, toTs))
      : runWorkerTask(
        { kind: 'read-player-insights', input: { dbPath, userId, fromTs, toTs } },
        { priority: 'interactive', timeoutMs: 30_000 },
      ).then(({ elapsedMs: _elapsedMs, ...insights }) => insights)
    insightsCache.delete(key)
    insightsCache.set(key, { builtAt: now, value })
    // Отказ не кэшируем: следующий запрос попробует снова.
    value.catch(() => {
      if (insightsCache.get(key)?.value === value) insightsCache.delete(key)
    })
    while (insightsCache.size > INSIGHTS_CACHE_LIMIT) {
      const oldest = insightsCache.keys().next().value
      if (oldest === undefined) break
      insightsCache.delete(oldest)
    }
    return value
  }

  const insightsHandler = (kind: ProfileKind) =>
    async (
      request: FastifyRequest<{ Params: { key: string }; Querystring: { days?: number } }>,
      reply: FastifyReply,
    ) => {
      // Heavier than a usual site request: double weight in the rate limit.
      if (!passRateLimit(request, reply, 2)) return reply
      const target = resolveProfileTarget(kind, request.params.key)
      if (!target || !target.nick) {
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Player not found in local data' })
      }
      const days = request.query.days ?? 90
      if (!target.wtUserId) return { ok: true, days, insights: null }
      return { ok: true, days, insights: await loadPlayerInsights(target.wtUserId, days) }
    }

  const profileParamsWt = {
    type: 'object',
    additionalProperties: false,
    required: ['key'],
    properties: { key: { type: 'string', pattern: '^[0-9]{1,20}$' } },
  }
  const profileParamsIdentity = {
    type: 'object',
    additionalProperties: false,
    required: ['key'],
    properties: { key: { type: 'string', pattern: '^[0-9]{1,10}$' } },
  }
  // The nick rules of POST /api/player-stats: the refresh button sends this nick there.
  const profileParamsNick = {
    type: 'object',
    additionalProperties: false,
    required: ['key'],
    properties: { key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } },
  }
  const profileQuerystring = {
    type: 'object',
    additionalProperties: false,
    properties: {
      from: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
      to: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
    },
  }

  app.get<{ Params: { key: string }; Querystring: { from?: number; to?: number } }>(
    '/api/players/:key',
    { schema: { params: profileParamsWt, querystring: profileQuerystring } },
    profileHandler('wt'),
  )
  app.get<{ Params: { key: string }; Querystring: { from?: number; to?: number } }>(
    '/api/players/identity/:key',
    { schema: { params: profileParamsIdentity, querystring: profileQuerystring } },
    profileHandler('identity'),
  )
  app.get<{ Params: { key: string }; Querystring: { from?: number; to?: number } }>(
    '/api/players/nick/:key',
    { schema: { params: profileParamsNick, querystring: profileQuerystring } },
    profileHandler('nick'),
  )

  const historyHandler = (kind: ProfileKind) =>
    async (
      request: FastifyRequest<{ Params: { key: string }; Querystring: { days?: number } }>,
      reply: FastifyReply,
    ) => {
      if (!passRateLimit(request, reply)) return reply
      const target = resolveProfileTarget(kind, request.params.key)
      if (!target || !target.nick) {
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Player not found in local data' })
      }
      const days = request.query.days ?? 90
      const fromTs = Math.floor(Date.now() / 1_000) - days * DAY_SEC

      const nicks = new Set<string>([target.nick])
      if (target.identity) {
        for (const alias of getPlayerIdentityAliases(target.identity.id)) nicks.add(alias.nick)
      }
      const rating = getSiteRatingHistory([...nicks].slice(0, 8))
        .filter((point) => point.seenAt >= fromTs)

      const account: Record<string, unknown[]> = {}
      if (target.identity) {
        for (const source of SITE_ACCOUNT_SOURCES) {
          const points = getSiteExternalAggregateHistory(target.identity.id, source)
            .filter((point) => point.checkedAt >= fromTs)
          if (points.length > 0) account[source] = points
        }
      }

      const activity = target.wtUserId ? getSiteActivityByDay(target.wtUserId, fromTs) : []
      return { ok: true, days, rating, account, activity }
    }

  const historyQuerystring = {
    type: 'object',
    additionalProperties: false,
    properties: { days: { type: 'integer', minimum: 7, maximum: 400 } },
  }

  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/:key/history',
    { schema: { params: profileParamsWt, querystring: historyQuerystring } },
    historyHandler('wt'),
  )
  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/identity/:key/history',
    { schema: { params: profileParamsIdentity, querystring: historyQuerystring } },
    historyHandler('identity'),
  )
  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/nick/:key/history',
    { schema: { params: profileParamsNick, querystring: historyQuerystring } },
    historyHandler('nick'),
  )
  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/:key/insights',
    { schema: { params: profileParamsWt, querystring: historyQuerystring } },
    insightsHandler('wt'),
  )
  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/identity/:key/insights',
    { schema: { params: profileParamsIdentity, querystring: historyQuerystring } },
    insightsHandler('identity'),
  )
  app.get<{ Params: { key: string }; Querystring: { days?: number } }>(
    '/api/players/nick/:key/insights',
    { schema: { params: profileParamsNick, querystring: historyQuerystring } },
    insightsHandler('nick'),
  )

  // Плитки главной пересчитывают агрегаты всей БД — кэшируем как кланы.
  let statsSnapshot: { builtAt: number; payload: unknown } | null = null
  let statsSnapshotInFlight: Promise<unknown> | null = null

  async function loadDashboardStats(sinceTs: number, seasonStart: number) {
    if (opts.site?.loadDashboardStats) {
      return opts.site.loadDashboardStats(sinceTs, seasonStart)
    }
    const dbPath = getDbWorkerPath()
    if (dbPath !== null) {
      return runWorkerTask(
        {
          kind: 'read-site-dashboard-stats',
          input: { dbPath, sinceTs, seasonStart },
        },
        { priority: 'background', timeoutMs: 60_000 },
      )
    }
    const counts = getSiteBattleCounts(sinceTs)
    return {
      players: getSiteReplayPlayerCount(),
      clans: clanGroups().size,
      battlesTotal: counts.total,
      battlesRecent: counts.recent,
      lastBattleAt: counts.lastStartAt,
      byDay: getSiteBattlesByDay(sinceTs),
    }
  }

  app.get('/api/site-stats', async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    void reply.header('Cache-Control', 'public, max-age=60')
    const now = Date.now()
    if (!statsSnapshot || now - statsSnapshot.builtAt >= CLAN_CACHE_TTL_MS) {
      statsSnapshotInFlight ??= (async () => {
        const season = getClanSeasonContext(Math.floor(now / 1_000))
        const seasonStart = season.season?.startsAt ?? 0
        const weekAgo = Math.max(Math.floor(now / 1_000) - 7 * DAY_SEC, seasonStart)
        const stats = await loadDashboardStats(weekAgo, seasonStart)
        const payload = {
          ok: true,
          season,
          officialSeason: getOfficialClanSeason(),
          players: stats.players,
          clans: stats.clans,
          battlesTotal: stats.battlesTotal,
          battlesWeek: stats.battlesRecent,
          lastBattleAt: stats.lastBattleAt,
          byDay: stats.byDay,
        }
        statsSnapshot = { builtAt: Date.now(), payload }
        return payload
      })()
      try {
        return await statsSnapshotInFlight
      } finally {
        statsSnapshotInFlight = null
      }
    }
    return statsSnapshot.payload
  })

  // One page of the ranking or of a search: ~1,200 stored squadrons (2026-10-04) do not fit one
  // response.
  app.get<{ Querystring: { query?: string; offset?: number; limit?: number } }>('/api/clans', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 64 },
          offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    // Matches the server snapshot TTL: Home → Clans → Battles does not fetch the same data again.
    void reply.header('Cache-Control', 'public, max-age=60')
    const snapshot = cachedClanSnapshot()
    const offset = request.query.offset ?? 0
    const ranked = [...snapshot.groups.values()].sort((left, right) => left.rank - right.rank)
    const query = request.query.query?.trim() ?? ''
    const found = query === '' ? ranked : searchClanGroups(ranked, query)
    const page = found.slice(offset, offset + (request.query.limit ?? 100))
    // The oldest crawl among the page's squadrons in the table: every official figure on the
    // page is at least this fresh (the top 100 and the rest are crawled at different rates).
    const crawlTimes = page.flatMap((group) =>
      group.official !== null && group.rankTier <= RANK_TIER_EARLIER ? [group.official.confirmedAt] : [])
    return {
      ok: true,
      season: getClanSeasonContext(),
      officialSeason: getOfficialClanSeason(),
      // All matches; without a query — the whole ranking.
      total: found.length,
      updatedAt: crawlTimes.length > 0 ? Math.min(...crawlTimes) : null,
      clans: page.map((group) => ({
        coreTag: group.coreTag,
        displayTag: clanDisplayName(group.displayTag),
        name: group.name,
        members: group.official?.members ?? group.members.length,
        totalRating: group.totalRating,
        // Average PSR only over known roster snapshots: null without them, not 0.
        avgRating: group.members.length > 0
          ? Math.round(group.members.reduce((sum, member) => sum + member.rating, 0) / group.members.length)
          : null,
        seasonBattles: group.official?.battles ?? null,
        seasonWins: group.official?.wins ?? null,
        airKills: group.official?.airKills ?? null,
        groundKills: group.official?.groundKills ?? null,
        deaths: group.official?.deaths ?? null,
        region: group.official?.region ?? null,
        clanType: group.official?.clanType ?? null,
        lastSeenAt: group.lastSeenAt,
        delta24h: clanDelta24h(snapshot, group),
        leaderboard: leaderboardStatus(group),
        rank: group.rank,
        rosterKnown: group.rosterKnown,
      })),
    }
  })

  app.get<{ Params: { coreTag: string }; Querystring: { days?: number } }>('/api/clans/:coreTag/history', {
    schema: {
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['coreTag'],
        properties: { coreTag: { type: 'string', minLength: 1, maxLength: 32 } },
      },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 7, maximum: 400 } },
      },
    },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const core = plainClanTag(request.params.coreTag)
    const group = core ? clanGroups().get(core) : undefined
    if (!group) {
      return reply.code(404).send({ ok: false, code: 'CLAN_NOT_FOUND', error: 'Клан не найден в снимках рейтинга' })
    }
    const days = request.query.days ?? 90
    const season = getClanSeasonContext()
    const seasonStart = season.season?.startsAt ?? 0
    const fromTs = Math.max(Math.floor(Date.now() / 1_000) - days * DAY_SEC, seasonStart)
    if (group.official !== null) {
      // Официальный рейтинг: значение на границе периода (если есть) и все
      // его изменения; последняя точка — свежий обход, чтобы линия доходила
      // до «сейчас», даже если рейтинг с тех пор не менялся.
      const official = group.official
      const base = getSiteClanOfficialRatingAt(group.coreTag, seasonStart, fromTs)
      const { events, truncated } = getSiteClanOfficialRatingEvents(
        group.coreTag,
        fromTs,
        Math.floor(Date.now() / 1_000),
      )
      const points: { t: number; total: number; battles?: number | null; wins?: number | null }[] = base
        ? [{ t: fromTs, total: base.rating }]
        : []
      for (const event of events) {
        points.push({ t: event.capturedAt, total: event.rating, battles: event.battles, wins: event.wins })
      }
      const lastPoint = points[points.length - 1]
      if (lastPoint === undefined || official.ratingAt > lastPoint.t) {
        points.push({ t: official.ratingAt, total: official.rating, battles: official.battles, wins: official.wins })
      }
      return { ok: true, days, points, truncated, season }
    }
    const tags = group.rawTags.slice(0, 8)
    // Сумма ПКР восстанавливается воспроизведением change-point событий поверх
    // базиса: последнее известное значение каждого ника на границе периода.
    // Без базиса стартовой точки нет — серия начинается с первого измерения.
    const last = new Map<string, number>()
    for (const row of getSiteClanRatingBaseline(tags, group.coreTag, fromTs)) last.set(row.nick, row.rating)
    let total = totalSquadronRating([...last.values()])
    const points: { t: number; total: number }[] = last.size > 0 ? [{ t: fromTs, total }] : []
    const { events, truncated } = getSiteClanRatingEvents(tags, group.coreTag, fromTs)
    for (const event of events) {
      last.set(event.nick, event.rating)
      total = totalSquadronRating([...last.values()])
      const previous = points[points.length - 1]
      if (previous !== undefined && previous.t === event.seenAt) previous.total = total
      else points.push({ t: event.seenAt, total })
    }
    return { ok: true, days, points, truncated, season }
  })

  app.get<{ Params: { coreTag: string }; Querystring: { days?: number } }>('/api/clans/:coreTag', {
    schema: {
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['coreTag'],
        properties: { coreTag: { type: 'string', minLength: 1, maxLength: 32 } },
      },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 7, maximum: 90 } },
      },
    },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const core = plainClanTag(request.params.coreTag)
    if (!core) {
      return reply.code(400).send({ ok: false, code: 'INVALID_CLAN', error: 'Invalid squadron tag' })
    }
    const snapshot = cachedClanSnapshot()
    const group = snapshot.groups.get(core)
    if (!group) {
      return reply.code(404).send({ ok: false, code: 'CLAN_NOT_FOUND', error: 'Squadron not found in rating snapshots' })
    }

    // PSR delta of each nick: its two latest snapshots under one raw tag.
    const deltas = new Map<string, number | null>()
    for (const rawTag of group.rawTags.slice(0, 8)) {
      for (const [nick, ratingInfo] of getClanRatingsWithDelta(rawTag)) {
        if (!deltas.has(nick) || deltas.get(nick) === null) deltas.set(nick, ratingInfo.delta)
      }
    }

    // Profile links: an identity only through its aliases (several on one nick_base:
    // none), else the single WT user id of this exact nick in the replays (a covering
    // index, ~0.2 ms for 128 members on 2026-10-04); the site links the rest by nick.
    const nickBases = group.members.map((member) => normalizeWtNick(member.nick))
    const aliasRows = getSiteAliasIdentities(nickBases)
    const byBase = new Map<string, { identityId: number; wtUserId: string | null } | null>()
    for (const row of aliasRows) {
      const existing = byBase.get(row.nickBase)
      if (existing === undefined) {
        byBase.set(row.nickBase, { identityId: row.identityId, wtUserId: row.wtUserId })
      } else if (existing !== null && existing.identityId !== row.identityId) {
        byBase.set(row.nickBase, null)
      }
    }
    const replayIds = getSiteReplayUserIdsByNick(group.members
      .filter((member) => (byBase.get(normalizeWtNick(member.nick)) ?? null) === null)
      .map((member) => member.nick))

    const rosterDetails = getSiteClanRosterDetails(group.coreTag)
    const roster = group.members
      .map((member) => {
        const link = byBase.get(normalizeWtNick(member.nick)) ?? null
        const replayIdsOfNick = replayIds.get(member.nick) ?? []
        const details = rosterDetails.get(member.nick)
        return {
          nick: member.nick,
          rating: member.rating,
          delta: deltas.get(member.nick) ?? null,
          seenAt: member.seenAt,
          identityId: link?.identityId ?? null,
          wtUserId: link !== null
            ? link.wtUserId
            : replayIdsOfNick.length === 1 ? replayIdsOfNick[0] ?? null : null,
          role: details?.role ?? null,
          joinedAt: details?.joinedAt ?? null,
          activity: details?.activity ?? null,
        }
      })
      .sort((a, b) => b.rating - a.rating)

    const days = request.query.days ?? 30
    const nowSec = Math.floor(Date.now() / 1_000)
    const season = getClanSeasonContext(nowSec)
    const seasonStart = season.season?.startsAt ?? 0
    const fromTs = Math.max(nowSec - days * DAY_SEC, seasonStart)
    const teamRows = getSiteClanBattleTeams(group.rawTags.slice(0, 8), fromTs, nowSec + 1)
    const sessions = new Map<string, { teamWon: number; rows: typeof teamRows }>()
    for (const row of teamRows) {
      let session = sessions.get(row.sessionId)
      if (!session) {
        session = { teamWon: row.teamWon, rows: [] }
        sessions.set(row.sessionId, session)
      }
      session.rows.push(row)
    }
    let wins = 0
    let losses = 0
    let unknownResults = 0
    let score = 0
    let kills = 0
    let deaths = 0
    for (const session of sessions.values()) {
      // The squadron's team in a session has most of its players (a tie: the lower team number).
      const clanRow = [...session.rows].sort((a, b) => b.players - a.players || a.team - b.team)[0]!
      score += clanRow.score
      kills += clanRow.kills
      deaths += clanRow.deaths
      if (session.teamWon === 0) unknownResults += 1
      else if (clanRow.team === session.teamWon) wins += 1
      else losses += 1
    }
    const battlesTotal = sessions.size
    const decided = wins + losses

    const recent = listSiteBattles({ clanTags: group.rawTags.slice(0, 8), from: fromTs, limit: 20 })

    return {
      ok: true,
      season,
      clan: {
        coreTag: group.coreTag,
        displayTag: clanDisplayName(group.displayTag),
        name: group.name,
        members: group.official?.members ?? roster.length,
        seasonBattles: group.official?.battles ?? null,
        seasonWins: group.official?.wins ?? null,
        airKills: group.official?.airKills ?? null,
        groundKills: group.official?.groundKills ?? null,
        deaths: group.official?.deaths ?? null,
        flightTimeMin: group.official?.flightTime ?? null,
        activity: group.official?.activity ?? null,
        region: group.official?.region ?? null,
        clanType: group.official?.clanType ?? null,
        foundedAt: group.official?.foundedAt ?? null,
        slogan: group.official?.slogan ?? null,
        rewards: group.official?.rewards ?? null,
        profile: group.official === null ? null : getSiteClanProfile(group.official.tag),
        totalRating: group.totalRating,
        lastSeenAt: group.lastSeenAt,
        rank: group.rank,
        delta30d: clanDelta30d(snapshot, group),
        rosterKnown: group.rosterKnown,
        official: group.official !== null,
      },
      roster,
      battles: {
        days,
        total: battlesTotal,
        wins,
        losses,
        unknownResults,
        winRate: decided > 0 ? wins / decided : null,
        score,
        kills,
        deaths,
        // No battles since the bot started collecting: the page says since which day it collects.
        collectedSince: battlesTotal === 0 ? getSiteFirstBattleAt() : null,
      },
      recent: battleListPayload(recent, new Set([group.coreTag])),
    }
  })

  app.get<{ Querystring: { player?: string; clan?: string; from?: number; to?: number; limit?: number } }>('/api/battles', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string', pattern: '^[0-9]{1,20}$' },
          clan: { type: 'string', minLength: 1, maxLength: 32 },
          from: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
          to: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { player, clan, from, to, limit } = request.query
    if (!passRateLimit(request, reply, player !== undefined || clan !== undefined ? 4 : 1)) return reply
    if (from !== undefined && to !== undefined && from > to) {
      return reply.code(400).send({ ok: false, code: 'INVALID_PERIOD', error: 'from не может быть позже to' })
    }
    if (player !== undefined) {
      const rows = listSiteBattles({ userId: player, from, to, limit })
      return { ok: true, battles: battleListPayload(rows) }
    }
    if (clan !== undefined) {
      const core = plainClanTag(clan)
      const group = core ? clanGroups().get(core) : undefined
      if (!group) {
        return reply.code(404).send({ ok: false, code: 'CLAN_NOT_FOUND', error: 'Клан не найден в снимках рейтинга' })
      }
      // По умолчанию клановая лента ограничена месяцем: без границы выборка
      // главного клана растёт со временем неограниченно.
      const seasonStart = getClanSeasonContext().season?.startsAt ?? 0
      const effectiveFrom = Math.max(from ?? Math.floor(Date.now() / 1_000) - 30 * DAY_SEC, seasonStart)
      const rows = listSiteBattles({ clanTags: group.rawTags.slice(0, 8), from: effectiveFrom, to, limit })
      return { ok: true, battles: battleListPayload(rows, new Set([group.coreTag])) }
    }
    const rows = listSiteBattles({ from, to, limit })
    return { ok: true, battles: battleListPayload(rows) }
  })

  app.get<{ Params: { key: string } }>('/api/battles/:key', {
    schema: {
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: { key: { type: 'string', pattern: '^[0-9a-fA-F]{1,20}$' } },
      },
    },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const sessionId = resolveSiteSessionId(request.params.key)
    if (!sessionId) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Battle key: a decimal session id or a 16-character hex' })
    }
    const summary = getSiteBattleSummary(sessionId)
    if (!summary) {
      return reply.code(404).send({ ok: false, code: 'BATTLE_NOT_FOUND', error: 'Battle not found among parsed replays' })
    }
    // A parsed battle's scoreboard does not change; the short lifetime covers re-parsing.
    void reply.header('Cache-Control', 'public, max-age=300')
    const teamsMap = new Map<number, { team: number; totalScore: number; players: unknown[] }>()
    // A paired bot slot's results row is credited to its player (player-events.ts).
    const pairedBots = new Set(summary.players.flatMap((player) => (player.bot_user_id ? [player.bot_user_id] : [])))
    for (const player of summary.players) {
      // Team ≤ 0 is unknown: no card of its own (player-events.ts resolves the squad marker)
      if (player.team <= 0 || pairedBots.has(player.user_id)) continue
      let team = teamsMap.get(player.team)
      if (!team) {
        team = { team: player.team, totalScore: 0, players: [] }
        teamsMap.set(player.team, team)
      }
      team.totalScore += player.score
      team.players.push({
        userId: player.user_id || null,
        nick: player.nick,
        clanTag: player.clan_tag ? clanDisplayName(player.clan_tag) : null,
        clanCore: player.clan_tag ? plainClanTag(player.clan_tag) || null : null,
        airKills: player.kills,
        groundKills: player.ground_kills,
        navalKills: player.naval_kills,
        aiAirKills: player.ai_kills,
        aiGroundKills: player.ai_ground_kills,
        assists: player.assists,
        deaths: player.deaths,
        captureZone: player.capture_zone,
        score: player.score,
        teamKills: player.team_kills,
        squadId: player.squad_id,
        vehicle: player.vehicle,
        // Driven vehicles in spawn order; the lineup when the events have no tracks
        vehicles: parseVehiclesJson(player.played_vehicles ?? player.vehicles),
        disconnected: player.disconnected !== 0,
        bot: player.bot_user_id !== null,
        autoSquad: player.auto_squad === null ? null : player.auto_squad !== 0,
      })
    }
    const teams = [...teamsMap.values()]
      .map((team) => ({
        ...team,
        players: (team.players as { score: number }[]).sort((a, b) => b.score - a.score),
        won: summary.battle.team_won !== 0 ? team.team === summary.battle.team_won : null,
      }))
      .sort((a, b) => b.totalScore - a.totalScore)
    return {
      ok: true,
      battle: {
        sessionId: summary.battle.session_id,
        sessionHex: summary.battle.session_hex,
        missionName: summary.battle.mission_name,
        level: summary.battle.level,
        gameMode: summary.battle.game_mode,
        battleType: summary.battle.battle_type,
        startTime: summary.battle.start_time,
        durationSec: summary.battle.duration_sec,
        teamWon: summary.battle.team_won,
        winnerKnown: summary.battle.winner_known !== 0,
        gameVersion: summary.battle.game_version,
        playerCount: summary.battle.player_count,
        killCount: summary.battle.kill_count,
      },
      teams,
    }
  })

  const battleKeyParams = {
    type: 'object',
    additionalProperties: false,
    required: ['key'],
    properties: { key: { type: 'string', pattern: '^[0-9a-fA-F]{1,20}$' } },
  }

  // Сцена боя для плеера: самый дорогой эндпоинт (worker, распаковка событий),
  // поэтому rate limit, дедупликация одинаковых session и бюджет сборок обязательны.
  app.get<{ Params: { key: string } }>('/api/battles/:key/scene', {
    schema: { params: battleKeyParams },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const sessionId = resolveSiteSessionId(request.params.key)
    if (!sessionId) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Battle key: a decimal session id or a 16-character hex' })
    }
    const result = await buildBattleSceneGzip(sessionId)
    switch (result.status) {
      case 'not_found':
        return reply.code(404).send({ ok: false, code: 'BATTLE_NOT_FOUND', error: 'Battle not found among parsed replays' })
      case 'no_events':
        return reply.code(404).send({ ok: false, code: 'SCENE_UNAVAILABLE', error: 'У боя нет сохранённых событий — сцена недоступна' })
      case 'busy':
        return reply
          .header('Retry-After', '5')
          .code(503)
          .send({ ok: false, code: 'SCENE_BUSY', error: 'Сборщик сцен занят, повторите через несколько секунд' })
      case 'ok':
        return reply
          .header('Content-Type', 'application/json; charset=utf-8')
          .header('Content-Encoding', 'gzip')
          .header('Cache-Control', 'public, max-age=86400')
          .send(result.sceneGzip)
    }
  })

  app.get<{ Params: { key: string } }>('/api/battles/:key/map.png', {
    schema: { params: battleKeyParams },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const sessionId = resolveSiteSessionId(request.params.key)
    if (!sessionId) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Battle key: a decimal session id or a 16-character hex' })
    }
    const map = await loadBattleSceneMap(sessionId)
    if (!map) {
      return reply.code(404).send({ ok: false, code: 'MAP_UNAVAILABLE', error: 'Локальной тактической карты для этого боя нет' })
    }
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=604800')
      .send(map)
  })

  app.get('/api/vehicles', async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    try {
      const dict = await Promise.race([
        loadVehicleDict(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Словарь техники не успел загрузиться')), VEHICLE_DICT_TIMEOUT_MS).unref()
        }),
      ])
      void reply.header('Cache-Control', 'public, max-age=86400')
      return { ok: true, vehicles: dict }
    } catch (error) {
      // Текст ошибки загрузки (сеть, пути data/) остаётся в серверном логе.
      console.warn(`[site] Словарь техники недоступен: ${error instanceof Error ? error.message : String(error)}`)
      return reply.code(503).send({
        ok: false,
        code: 'VEHICLES_UNAVAILABLE',
        error: 'Словарь техники временно недоступен',
      })
    }
  })
}
