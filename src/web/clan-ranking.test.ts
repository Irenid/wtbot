import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIN_RATE_BATTLES,
  clanCrawlReads,
  clanPlacesAt,
  clanRecords,
  clanTierCutoffs,
  defaultClanSortDirection,
  filterClanRows,
  nearestCrawl,
  sortClanRows,
  squadronBattleCounts,
  type ClanCrawlRead,
  type ClanRankingRow,
} from './clan-ranking.js'

function row(coreTag: string, rank: number, extra: Partial<ClanRankingRow> = {}): ClanRankingRow {
  return {
    coreTag,
    rank,
    current: true,
    rating: 10_000 - rank * 100,
    members: 50,
    battles: 500,
    wins: 250,
    kills: 1_000,
    deaths: 1_000,
    delta24h: 0,
    recentBattles: 0,
    ...extra,
  }
}

const tags = (rows: readonly ClanRankingRow[]): string[] => rows.map((entry) => entry.coreTag)

test('sortClanRows puts missing values last in both directions and breaks ties by place', () => {
  const rows = [
    row('a', 1, { delta24h: 50 }),
    row('b', 2, { delta24h: null }),
    row('c', 3, { delta24h: 300 }),
    row('d', 4, { delta24h: 50 }),
    row('e', 5, { delta24h: -20 }),
  ]
  assert.deepEqual(tags(sortClanRows(rows, 'change', 'desc')), ['c', 'a', 'd', 'e', 'b'])
  assert.deepEqual(tags(sortClanRows(rows, 'change', 'asc')), ['e', 'a', 'd', 'c', 'b'])
  assert.deepEqual(tags(sortClanRows(rows, 'place', 'desc')), ['e', 'd', 'c', 'b', 'a'])
  assert.deepEqual(tags(rows), ['a', 'b', 'c', 'd', 'e'], 'the input keeps its order')
})

test('sortClanRows ranks a win rate or K/D from too few battles after the reliable ones', () => {
  const few = MIN_RATE_BATTLES - 1
  const rows = [
    row('a', 1, { battles: 1_000, wins: 520, kills: 1_200, deaths: 1_000 }),
    row('b', 2, { battles: few, wins: few, kills: 900, deaths: 100 }),
    row('c', 3, { battles: 300, wins: 210, kills: 800, deaths: 1_000 }),
    row('d', 4, { battles: null, wins: null, kills: null, deaths: null }),
    row('e', 5, { battles: 400, wins: 100, kills: 50, deaths: 0 }),
  ]
  assert.deepEqual(tags(sortClanRows(rows, 'winRate', 'desc')), ['c', 'a', 'e', 'b', 'd'])
  assert.deepEqual(tags(sortClanRows(rows, 'winRate', 'asc')), ['e', 'a', 'c', 'b', 'd'])
  // K/D of e is undefined (no deaths): it goes with the rows without a value.
  assert.deepEqual(tags(sortClanRows(rows, 'kd', 'desc')), ['a', 'c', 'b', 'd', 'e'])
})

test('defaultClanSortDirection sorts places up and figures from the largest', () => {
  assert.equal(defaultClanSortDirection('place'), 'asc')
  assert.equal(defaultClanSortDirection('members'), 'desc')
})

test('filterClanRows combines the live and tag filters', () => {
  const rows = [
    row('a', 1, { recentBattles: 2 }),
    row('b', 4),
    row('c', 6, { recentBattles: 1 }),
    row('d', 7, { current: false, recentBattles: 3 }),
  ]
  assert.deepEqual(tags(filterClanRows(rows, {})), ['a', 'b', 'c', 'd'])
  assert.deepEqual(tags(filterClanRows(rows, { live: true })), ['a', 'c', 'd'], 'a squadron out of the table still plays')
  assert.deepEqual(tags(filterClanRows(rows, { live: true, tags: new Set(['c', 'd', 'x']) })), ['c', 'd'])
  assert.deepEqual(tags(filterClanRows(rows, { tags: new Set() })), [])
})

test('clanRecords picks the best squadron in the table, the higher place on a tie', () => {
  const rows = [
    row('a', 1, { battles: 2_000, wins: 1_100, kills: 3_000, deaths: 2_000, delta24h: 120 }),
    row('b', 2, { battles: 600, wins: 420, kills: 1_500, deaths: 1_000, delta24h: 400 }),
    row('c', 3, { battles: 10, wins: 10, kills: 90, deaths: 1, delta24h: 400 }),
    row('d', 4, { current: false, battles: 5_000, wins: 5_000, delta24h: 900 }),
  ]
  assert.deepEqual(clanRecords(rows), { winRate: 'b', kd: 'a', battles: 'a', gain: 'b' })
  // Unknown battles make the K/D unreliable too; a loss is no gain record.
  assert.deepEqual(clanRecords([row('a', 1, { delta24h: -50, battles: null, wins: null })]), {
    winRate: null,
    kd: null,
    battles: null,
    gain: null,
  })
})

test('clanTierCutoffs reads the rating at each filled tier boundary', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(`t${index + 1}`, index + 1))
  assert.deepEqual(clanTierCutoffs(rows), [
    { place: 5, rating: 9_500 },
    { place: 10, rating: 9_000 },
  ])
  const dropped = rows.map((entry) => (entry.rank === 10 ? { ...entry, current: false } : entry))
  assert.deepEqual(clanTierCutoffs(dropped), [{ place: 5, rating: 9_500 }])
})

const crawl = (capturedAt: number, cores: string[], full = false): ClanCrawlRead => ({ capturedAt, full, cores })

test('nearestCrawl picks the read nearest the mark within the shift', () => {
  const times = [100, 200, 400]
  assert.equal(nearestCrawl(times, 290, 50), null, 'nothing within 50')
  assert.equal(nearestCrawl(times, 290, 100), 200)
  assert.equal(nearestCrawl(times, 300, 100), 200, 'the earlier read on a tie')
  assert.equal(nearestCrawl(times, 390, 100), 400)
  assert.equal(nearestCrawl(times, 50, 60), 100, 'before the first read')
  assert.equal(nearestCrawl(times, 460, 60), 400, 'after the last read')
  assert.equal(nearestCrawl([], 100, 1_000), null)
})

test('clanCrawlReads lists the crawls that read each squadron', () => {
  const reads = clanCrawlReads([crawl(10, ['a', 'b'], true), crawl(20, ['a']), crawl(30, ['b', 'a'])])
  assert.deepEqual([...reads], [['a', [10, 20, 30]], ['b', [10, 30]]])
})

test('clanPlacesAt rebuilds the table at a moment, dropped squadrons left out', () => {
  // Full crawl at 10: a b c d; top crawls at 20 and 30 read a and b (c fell out of the top);
  // the full crawl at 40 comes after the moment.
  const crawls = [
    crawl(5, ['a', 'b', 'c', 'x'], true),
    crawl(10, ['a', 'b', 'c', 'd'], true),
    crawl(20, ['a', 'b', 'c']),
    crawl(30, ['b', 'a']),
    crawl(40, ['a', 'b', 'c', 'd', 'e'], true),
  ]
  const ratings: Record<string, number> = { a: 500, b: 600, c: 700, d: 100, x: 900 }
  const places = clanPlacesAt(crawls, 35, (core) => ratings[core] ?? null, () => 0)
  // c's stale 700 stays below the squadrons the latest crawl read; x, missed by the full crawl at
  // 10, holds no place despite its rating; e appeared later.
  assert.deepEqual([...(places ?? [])], [['b', 1], ['a', 2], ['c', 3], ['d', 4]])
  assert.deepEqual([...(clanPlacesAt(crawls, 10, (core) => ratings[core] ?? null, () => 0) ?? [])], [['c', 1], ['b', 2], ['a', 3], ['d', 4]])
  assert.equal(clanPlacesAt(crawls, 4, () => 1, () => 0), null, 'no crawl before the moment')
  assert.equal(clanPlacesAt(crawls.slice(2), 35, () => 1, () => 0), null, 'no full crawl in the log')
  // Equal ratings keep today's order; a squadron without a rating then holds no place.
  const tied = clanPlacesAt([crawl(1, ['p', 'q', 'r'], true)], 1, (core) => (core === 'r' ? null : 5), (core) => (core === 'p' ? 2 : 1))
  assert.deepEqual([...(tied ?? [])], [['q', 1], ['p', 2]])
})

test('squadronBattleCounts counts battles of teams under one squadron tag', () => {
  const counts = squadronBattleCounts([
    { sessionId: 's1', team: 1, core: 'a' },
    { sessionId: 's1', team: 2, core: 'b' },
    { sessionId: 's2', team: 1, core: 'a' },
    { sessionId: 's2', team: 2, core: 'c' },
    // A random battle (several tags on a team) counts for nobody.
    { sessionId: 's3', team: 1, core: 'a' },
    { sessionId: 's3', team: 1, core: 'd' },
    // Two squadrons whose tags share a core: one battle, not two.
    { sessionId: 's4', team: 1, core: 'e' },
    { sessionId: 's4', team: 2, core: 'e' },
  ])
  assert.deepEqual([...counts].sort(), [['a', 2], ['b', 1], ['c', 1], ['e', 1]])
})
