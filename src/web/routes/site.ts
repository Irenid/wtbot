import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  findKnownPlayerMatches,
  getClanSeasonContext,
  getClanRatingsWithDelta,
  getOfficialClanSeason,
  getDbWorkerPath,
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
  getSiteClanRosterAll,
  getSiteExternalAggregateHistory,
  getSiteRatingHistory,
  getSiteReplayNick,
  getSiteReplayPlayerCount,
  listSiteBattles,
  normalizeWtNick,
  resolveSiteSessionId,
  searchSitePlayers,
  type PlayerReplayStats,
  type SiteBattleListRow,
  type SiteClanMemberLatest,
} from '../../db/index.js'
import type { ClanSeasonRewards } from '../../db/index.js'
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
  /** Сырые украшенные теги, встречавшиеся у клана (для SQL-фильтров). */
  rawTags: string[]
  /** Самый свежий сырой тег — из него строится отображаемое имя. */
  displayTag: string
  name: string | null
  members: SiteClanMemberLatest[]
  totalRating: number
  lastSeenAt: number
  /** Место в рейтинге всех кланов по totalRating (1 — лучший). */
  rank: number
  /**
   * Состав известен из обхода claninfo. false — ростера ещё нет, и сумма
   * считается по всем, кто когда-либо носил этот тег (могут быть ушедшие).
   */
  rosterKnown: boolean
  /** Статистика с официального лидерборда сезона; null — клана нет в обходах. */
  official: SiteClanOfficial | null
  /**
   * Ступень порядка: 0 — клан из последнего обхода лидерборда, 1 — из прежних
   * обходов сезона (сейчас он ниже охваченной части списка), 2 — без
   * официальных данных, сумма по снимкам ПКР.
   */
  rankTier: number
}

interface SiteClanOfficial {
  /** Текущий тег клана в лидерборде. */
  tag: string
  rating: number
  position: number | null
  members: number | null
  battles: number | null
  wins: number | null
  ratingAt: number
  airKills: number | null
  groundKills: number | null
  deaths: number | null
  /** Налёт сезона, минуты. */
  flightTime: number | null
  activity: number | null
  region: string | null
  clanType: string | null
  foundedAt: number | null
  slogan: string | null
  rewards: ClanSeasonRewards | null
}

/**
 * Единый порядок рейтинга кланов: ступень, затем рейтинг, место в
 * лидерборде и тег. Устаревший рейтинг клана, выпавшего из свежего обхода,
 * иначе вытеснял бы кланы, которые сейчас выше него.
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
  /** Базис ПКР (клан-ядро + ник → значение месяц назад) для честных дельт. */
  baseline: Map<string, number>
  seasonStart: number
  /** Граница «месяц назад» для дельт, не раньше начала сезона. */
  baselineAt: number
  /** Официальный рейтинг на baselineAt по ядру тега; заполняется по запросу. */
  officialBaseline: Map<string, number | null>
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
  // Текущий состав по ядру тега: покинувшие исключаются из групп и сумм;
  // ядро без строк ростера (до первого обхода) читается без фильтра.
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
  // Один ник может жить в нескольких вариантах украшенного тега одного ядра —
  // берём самую свежую запись, чтобы не задваивать участника в сумме.
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
        rankTier: 2,
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

  // Официальный лидерборд: рейтинг, место и состав клана берутся отсюда, а
  // сумма по снимкам ПКР остаётся только кланам без официальных данных сезона
  // (снимки есть лишь у кланов, чьи бои бот рисовал, и лидеры выпадали).
  const nameByTag = new Map<string, string>()
  const dictionaryTagsByCore = new Map<string, string[]>()
  const officialByCore = new Map<string, { name: string; stats: SiteClanOfficial }>()
  let latestOfficialAt = 0
  for (const row of getSiteClanDictionary()) {
    nameByTag.set(row.tag, row.name)
    const core = plainClanTag(row.tag)
    if (!core) continue
    const tags = dictionaryTagsByCore.get(core)
    if (tags) tags.push(row.tag)
    else dictionaryTagsByCore.set(core, [row.tag])
    if (row.rating === null || row.ratingAt === null || row.ratingAt < seasonStart) continue
    latestOfficialAt = Math.max(latestOfficialAt, row.ratingAt)
    // Смена украшений оставляет в словаре прежний тег — берём свежую строку.
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
        rankTier: 2,
      }
      groups.set(core, group)
    }
    group.official = stats
    group.name = name
    group.displayTag = stats.tag
    group.totalRating = stats.rating
    group.lastSeenAt = stats.ratingAt
    group.rankTier = stats.ratingAt === latestOfficialAt ? 0 : 1
  }
  for (const group of groups.values()) {
    // Теги для выборки боёв (SQL берёт первые 8): текущий тег лидерборда,
    // затем встреченные в снимках и прочие варианты украшений из словаря.
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

  // Ранг считается по всем кланам: список /api/clans обрезан до 100, и
  // страница клана вне сотни раньше теряла своё место и дельту.
  const ranked = [...groups.values()].sort(compareClanGroups)
  ranked.forEach((group, index) => {
    group.rank = index + 1
  })
  // Час-округлённая граница даёт стабильный базис в пределах TTL кэша.
  // Базис тоже фильтруется по текущему составу — уход не искажает дельту.
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
  return { builtAt: Date.now(), groups, baseline, seasonStart, baselineAt, officialBaseline: new Map() }
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
}

function buildAccountViews(identity: PlayerIdentity): SiteAccountView[] {
  const views: SiteAccountView[] = []
  for (const source of SITE_ACCOUNT_SOURCES) {
    const lastCheck = getLatestPlayerExternalCheck(identity.id, source)
    const stats = getLatestPlayerExternalStats(identity.id, source)
    if (!lastCheck && !stats) continue
    const vehicles = stats
      ? [...stats.vehicles].sort((a, b) => (b.flyouts ?? 0) - (a.flyouts ?? 0)).slice(0, 100)
      : []
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
    })
  }
  return views
}

interface SiteProfileTarget {
  identity: PlayerIdentity | null
  wtUserId: string | null
  nick: string | null
}

/** Read-only разрешение ключа профиля: identity по id/wt_user_id либо replay-only игрок. */
function resolveProfileTarget(kind: 'wt' | 'identity', key: string): SiteProfileTarget | null {
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
  // Игрок может быть известен только voice/rating-данным — ищем точное свидетельство.
  const matches = findKnownPlayerMatches(key).filter((match) => match.wtUserId === key)
  const match = matches[0]
  if (match) return { identity: null, wtUserId: key, nick: match.nick }
  return null
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

  const profileHandler = (kind: 'wt' | 'identity') =>
    async (
      request: FastifyRequest<{ Params: { key: string }; Querystring: { from?: number; to?: number } }>,
      reply: FastifyReply,
    ) => {
      if (!passRateLimit(request, reply)) return reply
      const target = resolveProfileTarget(kind, request.params.key)
      if (!target || !target.nick) {
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Игрок не найден в локальных данных' })
      }
      const { from, to } = request.query
      if (from !== undefined && to !== undefined && from > to) {
        return reply.code(400).send({ ok: false, code: 'INVALID_PERIOD', error: 'from не может быть позже to' })
      }
      const aliases = target.identity ? getPlayerIdentityAliases(target.identity.id) : []
      const accounts = target.identity ? buildAccountViews(target.identity) : []
      let replay: PlayerReplayStats | null = null
      if (target.wtUserId) {
        replay = getPlayerReplayStats({ userId: target.wtUserId }, periodFromQuery(request.query))
      }
      const rating = getPlayerRating(target.nick)
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
        accounts,
        replay,
      }
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

  const historyHandler = (kind: 'wt' | 'identity') =>
    async (
      request: FastifyRequest<{ Params: { key: string }; Querystring: { days?: number } }>,
      reply: FastifyReply,
    ) => {
      if (!passRateLimit(request, reply)) return reply
      const target = resolveProfileTarget(kind, request.params.key)
      if (!target || !target.nick) {
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Игрок не найден в локальных данных' })
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

  app.get('/api/clans', async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    // Совпадает с TTL серверного снимка: переходы Home → Clans → Battles не
    // запрашивают одни и те же данные заново.
    void reply.header('Cache-Control', 'public, max-age=60')
    const snapshot = cachedClanSnapshot()
    const groups = [...snapshot.groups.values()]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 100)
      .map((group) => ({
        coreTag: group.coreTag,
        displayTag: clanDisplayName(group.displayTag),
        name: group.name,
        members: group.official?.members ?? group.members.length,
        totalRating: group.totalRating,
        // Средний ПКР — только по известным снимкам состава; без них null, не 0.
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
        delta30d: clanDelta30d(snapshot, group),
        rank: group.rank,
        rosterKnown: group.rosterKnown,
      }))
    return { ok: true, season: getClanSeasonContext(), officialSeason: getOfficialClanSeason(), clans: groups }
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
      return reply.code(400).send({ ok: false, code: 'INVALID_CLAN', error: 'Некорректный тег клана' })
    }
    const snapshot = cachedClanSnapshot()
    const group = snapshot.groups.get(core)
    if (!group) {
      return reply.code(404).send({ ok: false, code: 'CLAN_NOT_FOUND', error: 'Клан не найден в снимках рейтинга' })
    }

    // Дельта ПКР по каждому нику: по двум последним снимкам внутри сырого тега.
    const deltas = new Map<string, number | null>()
    for (const rawTag of group.rawTags.slice(0, 8)) {
      for (const [nick, ratingInfo] of getClanRatingsWithDelta(rawTag)) {
        if (!deltas.has(nick) || deltas.get(nick) === null) deltas.set(nick, ratingInfo.delta)
      }
    }

    // Связка с identity только по алиасам; коллизия nick_base → без ссылки.
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

    const roster = group.members
      .map((member) => {
        const link = byBase.get(normalizeWtNick(member.nick)) ?? null
        return {
          nick: member.nick,
          rating: member.rating,
          delta: deltas.get(member.nick) ?? null,
          seenAt: member.seenAt,
          identityId: link?.identityId ?? null,
          wtUserId: link?.wtUserId ?? null,
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
      // Команда клана в сессии — та, где больше его игроков (при равенстве — меньший номер).
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
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Ключ боя — decimal session id или 16-символьный hex' })
    }
    const summary = getSiteBattleSummary(sessionId)
    if (!summary) {
      return reply.code(404).send({ ok: false, code: 'BATTLE_NOT_FOUND', error: 'Бой не найден среди разобранных' })
    }
    // Скорборд разобранного боя не меняется; короткий срок оставлен на случай переразбора.
    void reply.header('Cache-Control', 'public, max-age=300')
    const teamsMap = new Map<number, { team: number; totalScore: number; players: unknown[] }>()
    for (const player of summary.players) {
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
        vehicles: parseVehiclesJson(player.vehicles),
        disconnected: player.disconnected !== 0,
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

  // Сцена боя для плеера: самый дорогой эндпоинт (worker + gunzip), поэтому
  // rate limit, дедупликация одинаковых session и бюджет сборок обязательны.
  app.get<{ Params: { key: string } }>('/api/battles/:key/scene', {
    schema: { params: battleKeyParams },
  }, async (request, reply) => {
    if (!passRateLimit(request, reply)) return reply
    const sessionId = resolveSiteSessionId(request.params.key)
    if (!sessionId) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Ключ боя — decimal session id или 16-символьный hex' })
    }
    const result = await buildBattleSceneGzip(sessionId)
    switch (result.status) {
      case 'not_found':
        return reply.code(404).send({ ok: false, code: 'BATTLE_NOT_FOUND', error: 'Бой не найден среди разобранных' })
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
      return reply.code(400).send({ ok: false, code: 'INVALID_BATTLE', error: 'Ключ боя — decimal session id или 16-символьный hex' })
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
