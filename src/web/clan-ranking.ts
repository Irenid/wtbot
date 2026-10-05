/**
 * Views of the squadron ranking for /api/clans: sort orders, filters, season records, the reward
 * tiers' cut-off ratings, places a day ago and who is playing now. Pure functions over the ranked
 * snapshot and the crawl log (routes/site.ts), which owns SQLite.
 */

/** Sort keys of /api/clans?sort=; 'place' is the ranking's own order. */
export const CLAN_SORT_KEYS = ['place', 'change', 'battles', 'winRate', 'kd', 'members'] as const
export type ClanSortKey = (typeof CLAN_SORT_KEYS)[number]
export type ClanSortDirection = 'asc' | 'desc'

/**
 * Last places of the season's reward tiers, top 5 to top 100; places 1–3 also have rewards of
 * their own. The SPA keeps the same list (REWARD_TIERS in frontend/src/components/clan-ui.tsx).
 */
export const CLAN_REWARD_TIER_PLACES = [5, 10, 20, 50, 100] as const

/**
 * Season battles below which a win rate or K/D is noise (2–5 battles gave 100 % on 2026-10-05):
 * such rows sort after the rest by these keys and hold no record. The SPA greys them out by the
 * same number.
 */
export const MIN_RATE_BATTLES = 50

export interface ClanRankingRow {
  coreTag: string
  /** Place in the ranking, 1 — the best. */
  rank: number
  /** In the official table now: only these hold reward tiers and records. */
  current: boolean
  rating: number
  members: number
  battles: number | null
  wins: number | null
  /** Air and ground kills; null — no leaderboard data. */
  kills: number | null
  deaths: number | null
  delta24h: number | null
  /** Squadron battles that ended within the live window (squadronBattleCounts); above 0 — playing now. */
  recentBattles: number
}

export function clanWinRate(row: ClanRankingRow): number | null {
  return row.battles !== null && row.battles > 0 && row.wins !== null ? row.wins / row.battles : null
}

export function clanKd(row: ClanRankingRow): number | null {
  return row.kills !== null && row.deaths !== null && row.deaths > 0 ? row.kills / row.deaths : null
}

function rateReliable(row: ClanRankingRow): boolean {
  return row.battles !== null && row.battles >= MIN_RATE_BATTLES
}

function sortValue(row: ClanRankingRow, key: ClanSortKey): number | null {
  switch (key) {
    case 'place': return row.rank
    case 'change': return row.delta24h
    case 'battles': return row.battles
    case 'winRate': return clanWinRate(row)
    case 'kd': return clanKd(row)
    case 'members': return row.members
  }
}

/** The direction a key sorts in when none is given: places up, figures from the largest. */
export function defaultClanSortDirection(key: ClanSortKey): ClanSortDirection {
  return key === 'place' ? 'asc' : 'desc'
}

/**
 * Rows by a key; rows without the value come last in either direction, a win rate or K/D from
 * fewer than MIN_RATE_BATTLES battles before them, ties by place.
 */
export function sortClanRows<T extends ClanRankingRow>(
  rows: readonly T[],
  key: ClanSortKey,
  direction: ClanSortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  const rate = key === 'winRate' || key === 'kd'
  return rows
    .map((row) => {
      const value = sortValue(row, key)
      return { row, value, group: value === null ? 2 : rate && !rateReliable(row) ? 1 : 0 }
    })
    .sort((left, right) =>
      left.group - right.group
      || (left.value !== null && right.value !== null ? (left.value - right.value) * sign : 0)
      || left.row.rank - right.row.rank)
    .map((entry) => entry.row)
}

export interface ClanRankingFilter {
  /** Only squadrons playing now. */
  live?: boolean | undefined
  /** Only these core tags. */
  tags?: ReadonlySet<string> | undefined
}

export function filterClanRows<T extends ClanRankingRow>(rows: readonly T[], filter: ClanRankingFilter): T[] {
  return rows.filter((row) =>
    (filter.live !== true || row.recentBattles > 0)
    && (filter.tags === undefined || filter.tags.has(row.coreTag)))
}

/** Core tags holding the season's best figures among squadrons in the table; null — none. */
export interface ClanRecords {
  winRate: string | null
  kd: string | null
  battles: string | null
  /** The largest rating gain over 24 hours. */
  gain: string | null
}

/** Records over rows in ranking order: of equal figures the higher place holds the record. */
export function clanRecords(ranked: readonly ClanRankingRow[]): ClanRecords {
  const best = (value: (row: ClanRankingRow) => number | null): string | null => {
    let holder: string | null = null
    let top = Number.NEGATIVE_INFINITY
    for (const row of ranked) {
      if (!row.current) continue
      const figure = value(row)
      if (figure !== null && figure > top) {
        top = figure
        holder = row.coreTag
      }
    }
    return holder
  }
  return {
    winRate: best((row) => (rateReliable(row) ? clanWinRate(row) : null)),
    kd: best((row) => (rateReliable(row) ? clanKd(row) : null)),
    battles: best((row) => row.battles),
    gain: best((row) => (row.delta24h !== null && row.delta24h > 0 ? row.delta24h : null)),
  }
}

/**
 * The rating at each reward tier's last place, over rows in ranking order: the score a squadron
 * has to pass to enter the tier. A tier the table does not fill is left out.
 */
export function clanTierCutoffs(ranked: readonly ClanRankingRow[]): { place: number; rating: number }[] {
  return CLAN_REWARD_TIER_PLACES.flatMap((place) => {
    const row = ranked[place - 1]
    return row !== undefined && row.current && row.rank === place ? [{ place, rating: row.rating }] : []
  })
}

/** A squadron's freshest leaderboard row under one core tag, for renamedClanCores. */
export interface ClanIdentityRow {
  core: string
  /** The leaderboard `_id`, which survives a tag change; null — read before the bot stored it. */
  clanId: number | null
  /** Founding time (`cdate`, seconds), which survives it too. */
  foundedAt: number | null
  ratingAt: number
}

/**
 * Former core tags of renamed squadrons → the core tag read last. One squadron is one `_id`; a
 * row without one matches by founding time (no two `_id`s shared one on 2026-10-05). Its last
 * row stayed at its old place after the rename: 4 squadrons at once on 2026-10-05.
 * A squadron whose newest cores were read by one crawl is ambiguous and left alone.
 */
export function renamedClanCores(rows: readonly ClanIdentityRow[]): Map<string, string> {
  const idByFounded = new Map<number, number | null>()
  for (const row of rows) {
    if (row.clanId === null || row.foundedAt === null) continue
    const known = idByFounded.get(row.foundedAt)
    // Two `_id`s on one founding time: a row without an `_id` cannot pick between them.
    idByFounded.set(row.foundedAt, known === undefined || known === row.clanId ? row.clanId : null)
  }
  const squadrons = new Map<string, ClanIdentityRow[]>()
  for (const row of rows) {
    const id = row.clanId ?? (row.foundedAt === null ? undefined : idByFounded.get(row.foundedAt))
    const key = id !== undefined && id !== null
      ? `id ${id}`
      : row.clanId === null && row.foundedAt !== null && !idByFounded.has(row.foundedAt) ? `founded ${row.foundedAt}` : null
    if (key === null) continue
    const cores = squadrons.get(key)
    if (cores === undefined) squadrons.set(key, [row])
    else cores.push(row)
  }
  const renamed = new Map<string, string>()
  for (const cores of squadrons.values()) {
    if (cores.length < 2) continue
    cores.sort((left, right) => right.ratingAt - left.ratingAt)
    const [current, next] = cores
    if (current!.ratingAt === next!.ratingAt) continue
    for (const former of cores.slice(1)) renamed.set(former.core, current!.core)
  }
  return renamed
}

/** Crawls with former core tags read as the current ones (renamedClanCores), each core once. */
export function crawlsUnderCurrentTags(
  crawls: readonly ClanCrawlRead[],
  renamed: ReadonlyMap<string, string>,
): ClanCrawlRead[] {
  if (renamed.size === 0) return [...crawls]
  return crawls.map((crawl) => ({
    ...crawl,
    cores: [...new Set(crawl.cores.map((core) => renamed.get(core) ?? core))],
  }))
}

/** A leaderboard crawl: when it ran, whether it read the whole table, the core tags it read. */
export interface ClanCrawlRead {
  capturedAt: number
  full: boolean
  cores: readonly string[]
}

/** Core tag → the times crawls read it, oldest first; `crawls` oldest first. */
export function clanCrawlReads(crawls: readonly ClanCrawlRead[]): Map<string, number[]> {
  const reads = new Map<string, number[]>()
  for (const crawl of crawls) {
    for (const core of crawl.cores) {
      const times = reads.get(core)
      if (times === undefined) reads.set(core, [crawl.capturedAt])
      else times.push(crawl.capturedAt)
    }
  }
  return reads
}

/** The time in sorted `times` nearest to target, at most maxShift away (the earlier one on a tie); null — none. */
export function nearestCrawl(times: readonly number[], target: number, maxShift: number): number | null {
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (times[middle]! < target) low = middle + 1
    else high = middle
  }
  // times[low] is the first at or after target, times[low − 1] the last before it.
  const after = times[low]
  const before = times[low - 1]
  const best = before !== undefined && (after === undefined || target - before <= after - target) ? before : after
  return best !== undefined && Math.abs(best - target) <= maxShift ? best : null
}

/**
 * The read a squadron's day figures start at: the one nearest to `mark` within maxShift and no
 * further from it than the log's first crawl, `logFrom` (a read before the log could be nearer:
 * a log younger than the window, after v20); null — none.
 */
export function dayBaseRead(times: readonly number[], mark: number, logFrom: number | undefined, maxShift: number): number | null {
  if (logFrom === undefined) return null
  const shift = Math.min(maxShift, mark - logFrom)
  return shift >= 0 ? nearestCrawl(times, mark, shift) : null
}

/**
 * Places in the table as it stood at `at`, in the order of compareClanGroups (routes/site.ts):
 * the squadrons the latest crawl up to `at` read, then the rest read since the last full crawl
 * up to it, each part by its rating then (ratingAt), ties by tieRank. A squadron that full crawl
 * missed (dropped) or without a rating then holds no place. null — the log does not reach a full
 * crawl before `at`. `crawls` oldest first.
 */
export function clanPlacesAt(
  crawls: readonly ClanCrawlRead[],
  at: number,
  ratingAt: (core: string) => number | null,
  tieRank: (core: string) => number,
): Map<string, number> | null {
  let latest = crawls.length - 1
  while (latest >= 0 && crawls[latest]!.capturedAt > at) latest--
  let full = latest
  while (full >= 0 && !crawls[full]!.full) full--
  if (full < 0) return null
  const tiers = new Map<string, number>()
  for (const core of crawls[latest]!.cores) tiers.set(core, 0)
  for (let index = full; index < latest; index++) {
    for (const core of crawls[index]!.cores) {
      if (!tiers.has(core)) tiers.set(core, 1)
    }
  }
  const entries = [...tiers].flatMap(([core, tier]) => {
    const rating = ratingAt(core)
    return rating === null ? [] : [{ core, tier, rating, tie: tieRank(core) }]
  })
  entries.sort((left, right) =>
    left.tier - right.tier
    || right.rating - left.rating
    || left.tie - right.tie
    || left.core.localeCompare(right.core))
  return new Map(entries.map((entry, index) => [entry.core, index + 1]))
}

/**
 * Squadron battles per core tag: a battle counts for a team whose tagged players all wear one
 * squadron's tag, as every squadron-battle team did on 2026-10-05; a team of several tags (a
 * random battle stored by `npm run battle`) counts for nobody.
 */
export function squadronBattleCounts(
  teams: readonly { sessionId: string; team: number; core: string }[],
): Map<string, number> {
  const byTeam = new Map<string, { sessionId: string; cores: Set<string> }>()
  for (const { sessionId, team, core } of teams) {
    const key = `${sessionId} ${team}`
    const entry = byTeam.get(key)
    if (entry === undefined) byTeam.set(key, { sessionId, cores: new Set([core]) })
    else entry.cores.add(core)
  }
  // Sessions, not teams: two squadrons whose tags share a core can meet, and that is one battle.
  const sessionsByCore = new Map<string, Set<string>>()
  for (const { sessionId, cores } of byTeam.values()) {
    if (cores.size !== 1) continue
    for (const core of cores) {
      const sessions = sessionsByCore.get(core)
      if (sessions === undefined) sessionsByCore.set(core, new Set([sessionId]))
      else sessions.add(sessionId)
    }
  }
  return new Map([...sessionsByCore].map(([core, sessions]) => [core, sessions.size]))
}
