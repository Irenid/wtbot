import type { DatabaseSync } from 'node:sqlite'
import {
  getBattleTeamsEndedAfter,
  getClanCrawls,
  getClanSeasonContext,
  getLastFullClanCrawlAt,
  getLastSuccessfulParseAt,
  getSiteClanBaselineRatings,
  getSiteClanDictionary,
  getSiteClanLatestMembers,
  getSiteClanOfficialStatsAt,
  getSiteClanRosterAll,
  type ClanSeasonRewards,
  type SiteClanMemberLatest,
} from '../db/index.js'
import { plainClanTag } from '../wrpl/render-battle.js'
import {
  clanCrawlReads,
  clanPlacesAt,
  clanRecords,
  clanTierCutoffs,
  crawlsUnderCurrentTags,
  dayBaseRead,
  renamedClanCores,
  squadronBattleCounts,
  type ClanRankingRow,
  type ClanRecords,
} from './clan-ranking.js'

/**
 * The squadron ranking the site serves (/api/clans, squadron pages): every
 * squadron's group, place, day figures and live mark, rebuilt at most once
 * per CLAN_CACHE_TTL_MS (routes/site.ts). Pure reads: a file database builds
 * it in worker task build-clan-snapshot on its own read-only connection.
 */

export const DAY_SEC = 86_400
/**
 * A day figure starts at the crawl that read the squadron nearest to a day before its end, at
 * most this far off: below the top 100 only full crawls read it, every ~11 h and on demand for an
 * unknown tag (13 in the 3 days to 2026-10-05).
 */
export const DAY_BASE_MAX_SHIFT_SEC = 6 * 3_600
/** The crawl log a snapshot reads: day figures of the rest reach back ~42 h (12 + 24 + 6). */
export const CRAWL_LOG_READ_SEC = 2 * DAY_SEC
/**
 * A squadron whose battle ended within this window is playing now. Replays are stored ~25 s
 * after a battle ends (p50, 2026-10-05), so the mark comes within a minute of the first battle
 * and outlasts a battle and the queue before the next one.
 */
export const LIVE_WINDOW_SEC = 45 * 60
/** Squadron battles last up to ~25 min: one started this long before the window cannot end in it. */
export const LIVE_MAX_BATTLE_SEC = 2 * 3_600
/**
 * wt-replays runs every 20 s and fails while its session is expired: without a successful run
 * this long, the snapshot shows no live marks instead of a table where nobody plays.
 */
export const LIVE_MAX_REPLAY_AGE_SEC = 10 * 60
/** The parser source whose replays feed the battles table (src/parsers/sources/wt-replays.ts). */
export const REPLAY_SOURCE = 'wt-replays'
export const MAX_SQUADRON_MEMBERS = 128
export const TOP_SQUADRON_RATING_MEMBERS = 20
export const OTHER_SQUADRON_RATING_WEIGHT = 0.05

export interface SiteClanGroup {
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
  /** Core tags it had before a rename, newest first (renamedClanCores): its history is under them. */
  formerCoreTags: string[]
  /** Season stats from the official leaderboard; null — the squadron is in no crawl of the season. */
  official: SiteClanOfficial | null
  /** One of the RANK_TIER_* values. */
  rankTier: number
  /**
   * Official rating change over the day before the rating was last confirmed (the top 100 are
   * read every 20 minutes, the rest at full crawls); its start — delta24hFrom. null — no official
   * data, the squadron left the table, or no figures that old inside the season.
   */
  delta24h: number | null
  /**
   * Start of the day figures: the crawl that read the squadron nearest to a day before
   * confirmedAt, within DAY_BASE_MAX_SHIFT_SEC. null — no such read (the crawl log is younger, a
   * zero no crawl reaches): the figures then start at its last read before that mark, at a time
   * history cannot tell (change points only).
   */
  delta24hFrom: number | null
  /** Season battles and wins over the same window; null — no figures that old or no counts. */
  battles24h: number | null
  wins24h: number | null
  /**
   * Places gained (+) or lost (−) since the table stood a day before the latest crawl
   * (clanPlacesAt); null — the squadron had no place then or has left the table.
   */
  rankChange24h: number | null
  /** Squadron battles that ended within LIVE_WINDOW_SEC (replays): above 0 — playing now. */
  recentBattles: number
}

/** In the latest leaderboard crawl. */
export const RANK_TIER_LATEST = 0
/** In an earlier crawl, not older than the last full one: below the part the latest crawl read. */
export const RANK_TIER_EARLIER = 1
/**
 * Missed by the last full crawl, which reads every squadron with a rating above zero: disbanded
 * or fallen to zero (a squadron that moved up a page during the crawl stays here until the next
 * one; a renamed one is merged into its current tag, renamedClanCores). Its last figures would
 * otherwise hold a place above squadrons that are in the table. A zero rating is never dropped:
 * see SiteClanOfficial.confirmedAt.
 */
export const RANK_TIER_DROPPED = 2
/** No official data this season: rated by the sum of members' PSR snapshots. */
export const RANK_TIER_PSR = 3

export interface SiteClanOfficial {
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
export function compareClanGroups(left: SiteClanGroup, right: SiteClanGroup): number {
  return left.rankTier - right.rankTier
    || right.totalRating - left.totalRating
    || (left.official?.position ?? Number.MAX_SAFE_INTEGER) - (right.official?.position ?? Number.MAX_SAFE_INTEGER)
    || left.coreTag.localeCompare(right.coreTag)
}

export interface ClanSnapshot {
  builtAt: number
  groups: Map<string, SiteClanGroup>
  /** PSR baseline (core tag + nick → the value a month ago) for honest deltas. */
  baseline: Map<string, number>
  seasonStart: number
  /** The "month ago" mark of the deltas, not before the season start. */
  baselineAt: number
  /** Official rating at baselineAt by core tag; filled on demand. */
  officialBaseline: Map<string, number | null>
  /** Every group in ranking order: ranked[rank − 1]. */
  ranked: SiteClanGroup[]
  /** The ranking's rows for sorting and filtering, in ranking order. */
  rows: SiteClanRow[]
  rowByCore: Map<string, SiteClanRow>
  /** Former core tag → the current one (renamedClanCores): old links and favourites still resolve. */
  renamed: Map<string, string>
  records: ClanRecords
  tierCutoffs: { place: number; rating: number }[]
  /** Squadrons playing now and when the window ended; null — replays are not coming in. */
  live: { count: number; at: number; windowSec: number } | null
}

export type SiteClanRow = ClanRankingRow & { group: SiteClanGroup }

/** The squadron under a core tag, a former one included (renamedClanCores). */
export function findClanGroup(snapshot: ClanSnapshot, core: string): SiteClanGroup | undefined {
  return snapshot.groups.get(snapshot.renamed.get(core) ?? core)
}

/**
 * The squadron's official figures at atTs (getSiteClanOfficialStatsAt) under whichever core tag it
 * had then: history stays under the tag of its time.
 */
export function clanOfficialStatsAt(
  group: SiteClanGroup,
  fromTs: number,
  atTs: number,
  database?: DatabaseSync,
): ReturnType<typeof getSiteClanOfficialStatsAt> {
  let latest: ReturnType<typeof getSiteClanOfficialStatsAt> = null
  for (const core of [group.coreTag, ...group.formerCoreTags]) {
    const stats = getSiteClanOfficialStatsAt(core, fromTs, atTs, database)
    if (stats !== null && (latest === null || stats.capturedAt > latest.capturedAt)) latest = stats
  }
  return latest
}

/** a − b for two counts of one series; null — a count is missing or went back. */
export function countGrowth(now: number | null, before: number | null): number | null {
  return now !== null && before !== null && now >= before ? now - before : null
}

/** Игровой Total PSR: 20 лучших участников полностью, остальные — 5%. */
export function totalSquadronRating(ratings: readonly number[]): number {
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
export function baselineKey(core: string, nick: string): string {
  return `${core}\u0000${nick}`
}

/**
 * The ranking of every squadron and its day figures; `database` — a worker's
 * own read-only connection (task build-clan-snapshot), else the main one.
 */
export function buildClanSnapshot(database?: DatabaseSync): ClanSnapshot {
  const seasonStart = getClanSeasonContext(undefined, database).season?.startsAt ?? 0
  const members = getSiteClanLatestMembers(database)
  // The current roster by core tag: leavers are excluded from groups and sums; a core without
  // roster rows (before its first crawl) is read unfiltered.
  const rosterByCore = new Map<string, Map<string, number>>()
  for (const row of getSiteClanRosterAll(database)) {
    let roster = rosterByCore.get(row.clanCore)
    if (!roster) {
      roster = new Map()
      rosterByCore.set(row.clanCore, roster)
    }
    roster.set(row.nick, row.lastPresentAt)
  }
  // The official leaderboard gives rating, place and member count; the PSR snapshot sum is left
  // to squadrons without official season data (snapshots exist only for squadrons from drawn
  // battles, and leaders went missing).
  const nameByTag = new Map<string, string>()
  const dictionaryTagsByCore = new Map<string, string[]>()
  const officialByCore = new Map<string, { name: string; clanId: number | null; stats: SiteClanOfficial }>()
  let latestOfficialAt = 0
  const fullCrawlAt = getLastFullClanCrawlAt(database)
  for (const row of getSiteClanDictionary(database)) {
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
      clanId: row.clanId,
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
  // A renamed squadron's old core kept its last row and sat among the dropped at the bottom, a
  // second row of one squadron (4 at once on 2026-10-05): it is merged into the current core.
  // History and crawl reads stay under the core of their time.
  const renamed = renamedClanCores([...officialByCore].map(([core, { clanId, stats }]) =>
    ({ core, clanId, foundedAt: stats.foundedAt, ratingAt: stats.ratingAt })))
  const currentCore = (core: string): string => renamed.get(core) ?? core
  const groups = new Map<string, SiteClanGroup>()
  // One nick can live under several decorated variants of one core: the freshest row is taken
  // so the member is not counted twice.
  const freshestByCoreNick = new Map<string, SiteClanMemberLatest>()
  for (const member of members) {
    const core = currentCore(plainClanTag(member.clanTag))
    if (!core) continue
    const roster = rosterByCore.get(core)
    if (roster && roster.size > 0 && !roster.has(member.nick)) continue
    const key = `${core} ${member.nick}`
    const existing = freshestByCoreNick.get(key)
    if (!existing || member.seenAt > existing.seenAt) freshestByCoreNick.set(key, member)
  }
  for (const member of freshestByCoreNick.values()) {
    const core = currentCore(plainClanTag(member.clanTag))
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
        formerCoreTags: [],
        official: null,
        rankTier: RANK_TIER_PSR,
        delta24h: null,
        delta24hFrom: null,
        battles24h: null,
        wins24h: null,
        rankChange24h: null,
        recentBattles: 0,
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

  for (const [core, { name, stats }] of officialByCore) {
    if (renamed.has(core)) continue
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
        formerCoreTags: [],
        official: null,
        rankTier: RANK_TIER_PSR,
        delta24h: null,
        delta24hFrom: null,
        battles24h: null,
        wins24h: null,
        rankChange24h: null,
        recentBattles: 0,
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
  const formerByAge = [...renamed].sort(([left], [right]) =>
    officialByCore.get(right)!.stats.ratingAt - officialByCore.get(left)!.stats.ratingAt)
  for (const [former, current] of formerByAge) groups.get(current)?.formerCoreTags.push(former)
  for (const group of groups.values()) {
    // Tags for battle queries (SQL takes the first 8): the current leaderboard tag, then the ones
    // seen in snapshots and the other decorated variants from the dictionary.
    const tags: string[] = []
    const candidates = [
      ...(group.official ? [group.official.tag] : []),
      ...group.rawTags,
      ...[group.coreTag, ...group.formerCoreTags].flatMap((core) => dictionaryTagsByCore.get(core) ?? []),
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
  // The day's figures, places and live marks of every squadron, eagerly: sorts and filters need
  // all of them. One or two indexed point queries per squadron (~650: a few ms).
  const nowSec = Math.floor(Date.now() / 1000)
  // History keeps change points only: the crawl log tells which crawls read a squadron.
  const crawls = latestOfficialAt > 0
    ? crawlsUnderCurrentTags(getClanCrawls(Math.max(0, latestOfficialAt - CRAWL_LOG_READ_SEC), database), renamed)
    : []
  const readsByCore = clanCrawlReads(crawls)
  const logFrom = crawls[0]?.capturedAt
  for (const group of ranked) {
    const official = group.official
    if (official === null || group.rankTier > RANK_TIER_EARLIER) continue
    // The plain "last point a day before" put the rest's start a full crawl further back: with
    // full crawls ~11 h apart their "24 h" spanned 32–36 h (2026-10-05).
    const mark = official.confirmedAt - DAY_SEC
    const read = dayBaseRead(readsByCore.get(group.coreTag) ?? [], mark, logFrom, DAY_BASE_MAX_SHIFT_SEC)
    const from = read ?? mark
    const day = from >= seasonStart ? clanOfficialStatsAt(group, seasonStart, from, database) : null
    if (day !== null) {
      group.delta24h = official.rating - day.rating
      group.delta24hFrom = read
      group.battles24h = countGrowth(official.battles, day.battles)
      group.wins24h = countGrowth(official.wins, day.wins)
    }
  }
  // Places a day ago from the table as it stood then, squadrons dropped since included: ranking
  // only today's squadrons by their old ratings moved everyone below a dropped one up a place.
  const placesAt = latestOfficialAt - DAY_SEC
  const earlierPlaces = placesAt >= seasonStart
    ? clanPlacesAt(
      crawls,
      placesAt,
      (core) => {
        const group = groups.get(core)
        const stats = group === undefined
          ? getSiteClanOfficialStatsAt(core, seasonStart, placesAt, database)
          : clanOfficialStatsAt(group, seasonStart, placesAt, database)
        return stats?.rating ?? null
      },
      (core) => groups.get(core)?.rank ?? Number.MAX_SAFE_INTEGER,
    )
    : null
  for (const group of ranked) {
    const earlier = earlierPlaces?.get(group.coreTag)
    group.rankChange24h = earlier !== undefined && group.official !== null && group.rankTier <= RANK_TIER_EARLIER
      ? earlier - group.rank
      : null
  }
  // Playing now: squadron battles from replays, every squadron; the leaderboard's battle counts
  // lagged a crawl or two and marked a squadron entering the top 100 for hours-old battles.
  const replaysAt = getLastSuccessfulParseAt(REPLAY_SOURCE, database)
  const liveFresh = replaysAt !== null && nowSec - replaysAt <= LIVE_MAX_REPLAY_AGE_SEC
  if (liveFresh) {
    const liveFrom = nowSec - LIVE_WINDOW_SEC
    const teams = getBattleTeamsEndedAfter(liveFrom, Math.max(0, seasonStart, liveFrom - LIVE_MAX_BATTLE_SEC), database)
      .flatMap((team) => {
        const core = plainClanTag(team.clanTag)
        return core ? [{ sessionId: team.sessionId, team: team.team, core }] : []
      })
    for (const [core, battles] of squadronBattleCounts(teams)) {
      const group = groups.get(core)
      if (group !== undefined) group.recentBattles = battles
    }
  }
  // A squadron with no season rating at all (no leaderboard row, members' PSR all zero: seen in
  // battles of an earlier season) is left out of the list; its page still opens.
  const listed = ranked.filter((group) => group.rankTier !== RANK_TIER_PSR || group.totalRating > 0)
  const rows: SiteClanRow[] = listed.map((group) => {
    const official = group.official
    return {
      group,
      coreTag: group.coreTag,
      rank: group.rank,
      current: official !== null && group.rankTier <= RANK_TIER_EARLIER,
      rating: group.totalRating,
      members: official?.members ?? group.members.length,
      battles: official?.battles ?? null,
      wins: official?.wins ?? null,
      kills: official === null || (official.airKills === null && official.groundKills === null)
        ? null
        : (official.airKills ?? 0) + (official.groundKills ?? 0),
      deaths: official?.deaths ?? null,
      delta24h: group.delta24h,
      recentBattles: group.recentBattles,
    }
  })
  // An hour-rounded mark keeps the baseline stable within the cache TTL. The baseline is
  // filtered by the current roster too: a leaver does not skew the delta.
  const baselineAt = Math.max(
    seasonStart,
    Math.floor(Date.now() / 3_600_000) * 3_600 - 30 * DAY_SEC,
  )
  const baseline = new Map<string, number>()
  for (const row of getSiteClanBaselineRatings(baselineAt, database)) {
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
    ranked,
    rows,
    rowByCore: new Map(rows.map((row) => [row.coreTag, row])),
    renamed,
    records: clanRecords(rows),
    tierCutoffs: clanTierCutoffs(rows),
    live: liveFresh
      ? { count: rows.filter((row) => row.recentBattles > 0).length, at: nowSec, windowSec: LIVE_WINDOW_SEC }
      : null,
  }
}
