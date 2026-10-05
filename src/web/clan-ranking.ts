/**
 * Views of the squadron ranking for /api/clans: sort orders, filters, season records and the
 * reward tiers' cut-off ratings. Pure functions over the ranked snapshot (routes/site.ts), which
 * owns SQLite.
 */

/** Sort keys of /api/clans?sort=; 'place' is the ranking's own order. */
export const CLAN_SORT_KEYS = ['place', 'change', 'battles', 'winRate', 'kd', 'members'] as const
export type ClanSortKey = (typeof CLAN_SORT_KEYS)[number]
export type ClanSortDirection = 'asc' | 'desc'

/**
 * Last places of the season's reward tiers, top 5 to top 100; places 1–3 also have rewards of
 * their own. The SPA keeps the same list (REWARD_TIERS in ClansPage.tsx).
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
  /** Season battles shortly before the latest top crawl; above 0 — playing now. */
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
  /** Only the top N places of the official table. */
  top?: number | undefined
  /** Only squadrons playing now. */
  live?: boolean | undefined
  /** Only these core tags. */
  tags?: ReadonlySet<string> | undefined
}

export function filterClanRows<T extends ClanRankingRow>(rows: readonly T[], filter: ClanRankingFilter): T[] {
  return rows.filter((row) =>
    (filter.top === undefined || (row.current && row.rank <= filter.top))
    && (filter.live !== true || row.recentBattles > 0)
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

/**
 * Places gained (+) or lost (−) since an earlier ranking: the rows with an earlier rating, ranked
 * by it (ties by today's place). Returns core tag → change; a row without one is left out.
 */
export function clanPlaceChanges(
  rows: readonly { coreTag: string; rank: number; earlierRating: number | null }[],
): Map<string, number> {
  const earlier = rows
    .flatMap((row) => (row.earlierRating === null ? [] : [{ row, rating: row.earlierRating }]))
    .sort((left, right) => right.rating - left.rating || left.row.rank - right.row.rank)
  return new Map(earlier.map((entry, index) => [entry.row.coreTag, index + 1 - entry.row.rank]))
}
