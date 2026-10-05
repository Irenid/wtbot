import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIN_RATE_BATTLES,
  clanPlaceChanges,
  clanRecords,
  clanTierCutoffs,
  defaultClanSortDirection,
  filterClanRows,
  sortClanRows,
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

test('filterClanRows combines the top, live and tag filters', () => {
  const rows = [
    row('a', 1, { recentBattles: 2 }),
    row('b', 4),
    row('c', 6, { recentBattles: 1 }),
    row('d', 7, { current: false, recentBattles: 3 }),
  ]
  assert.deepEqual(tags(filterClanRows(rows, {})), ['a', 'b', 'c', 'd'])
  assert.deepEqual(tags(filterClanRows(rows, { top: 5 })), ['a', 'b'])
  assert.deepEqual(tags(filterClanRows(rows, { top: 10 })), ['a', 'b', 'c'], 'a squadron out of the table holds no tier')
  assert.deepEqual(tags(filterClanRows(rows, { live: true })), ['a', 'c', 'd'])
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

test('clanPlaceChanges ranks the earlier ratings and skips rows without one', () => {
  const changes = clanPlaceChanges([
    { coreTag: 'a', rank: 1, earlierRating: 900 },
    { coreTag: 'b', rank: 2, earlierRating: 1_000 },
    { coreTag: 'c', rank: 3, earlierRating: null },
    { coreTag: 'd', rank: 4, earlierRating: 900 },
  ])
  // c entered the table within the day: d was third among the earlier ratings and is fourth now.
  assert.deepEqual([...changes], [['b', -1], ['a', 1], ['d', -1]])
})
