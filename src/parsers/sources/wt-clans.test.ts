import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeaderboardPage } from './wt-clans.js'

function page(data: unknown[], status = 'ok'): string {
  return JSON.stringify({ status, data })
}

const EMPTY_EXTRAS = {
  airKills: null,
  groundKills: null,
  deaths: null,
  flightTime: null,
  activity: null,
  region: null,
  clanType: null,
  foundedAt: null,
  slogan: null,
  rewards: null,
}

test('parseLeaderboardPage читает полную статистику клана, награды и сезон', () => {
  const parsed = parseLeaderboardPage(page([
    {
      pos: 20,
      tag: '[AVR]',
      name: 'AVANGARD',
      members_cnt: 121,
      region: ' WINNERS ',
      type: 'normal',
      slogan: 'The House',
      cdate: { $date: 1_557_650_605_621 },
      astat: {
        dr_era5_hist: 48_307,
        battles_hist: 2_545,
        wins_hist: 2_274,
        akills_hist: 7_880,
        gkills_hist: 11_728,
        deaths_hist: 8_307,
        ftime_hist: 51_481,
        activity: 86_926,
      },
      clanBestRewards: [
        { seasonName: 'seasonId57_top5', title: 'place1@historical' },
        { seasonName: 'странный', title: 'place9@historical' },
      ],
      clanRewardLog: {
        seasonId22_till100: { seasonId: 22, titles: ['top100@historical'] },
        seasonId57_top5: { seasonId: 57, titles: ['place1@historical'] },
        seasonId40_top5: { seasonId: 40, titles: 'не массив' },
      },
      clanSeasonRatingRewards: {
        seasonId: 62,
        seasonStartTimestamp: { $date: 1_788_220_800_000 },
        seasonEndTimestamp: { $date: 1_793_491_199_000 },
      },
    },
    { pos: 21, tag: '╍Nrst╎', name: 'North_Steel', members_cnt: 124, astat: { dr_era5_hist: 0 } },
  ]), 2)

  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.size, 2)
  assert.equal(parsed.hasActive, true)
  assert.deepEqual(parsed.season, { seasonId: 62, startsAt: 1_788_220_800, endsAt: 1_793_491_200 })
  assert.deepEqual(parsed.clans, [
    {
      tag: '[AVR]',
      name: 'AVANGARD',
      rating: 48_307,
      position: 21,
      members: 121,
      battles: 2_545,
      wins: 2_274,
      airKills: 7_880,
      groundKills: 11_728,
      deaths: 8_307,
      flightTime: 51_481,
      activity: 86_926,
      region: 'WINNERS',
      clanType: 'normal',
      foundedAt: 1_557_650_605,
      slogan: 'The House',
      rewards: { best: [[57, 'place1@historical']], log: [[57, ['place1@historical']], [22, ['top100@historical']]] },
    },
    { tag: '╍Nrst╎', name: 'North_Steel', rating: 0, position: 22, members: 124, battles: null, wins: null, ...EMPTY_EXTRAS },
  ])
})

test('parseLeaderboardPage восстанавливает место по странице и пропускает клан без тега', () => {
  const parsed = parseLeaderboardPage(page([
    { name: 'Без тега', astat: { dr_era5_hist: 10 } },
    { tag: '-X-', name: 'Clan X' },
  ]), 3)

  assert.equal(parsed.size, 2)
  assert.equal(parsed.hasActive, true, 'рейтинг клана без тега тоже говорит об активной странице')
  assert.equal(parsed.season, null)
  assert.deepEqual(parsed.clans, [
    { tag: '-X-', name: 'Clan X', rating: null, position: 42, members: null, battles: null, wins: null, ...EMPTY_EXTRAS },
  ])
})

test('parseLeaderboardPage: страница из нулевых рейтингов — конец активных кланов', () => {
  const parsed = parseLeaderboardPage(page([{ pos: 0, tag: '[Z]', name: 'Zero', astat: { dr_era5_hist: 0 } }]), 1)
  assert.equal(parsed.hasActive, false)
  assert.equal(parsed.clans.length, 1)
})

test('parseLeaderboardPage отклоняет нечисловую статистику и чужую схему', () => {
  assert.throws(
    () => parseLeaderboardPage(page([{ tag: '[A]', name: 'A', astat: { dr_era5_hist: '48307' } }]), 1),
    /dr_era5_hist/,
  )
  assert.throws(() => parseLeaderboardPage(page([{ tag: '[A]', name: 'A', members_cnt: -1 }]), 1), /members_cnt/)
  assert.throws(() => parseLeaderboardPage(page([{ tag: '[A]', name: 'A', pos: 1.5 }]), 1), /pos/)
  assert.throws(
    () => parseLeaderboardPage(page([{ tag: '[A]', name: 'A', astat: { dr_era5_hist: 1, akills_hist: 'x' } }]), 1),
    /akills_hist/,
  )
  assert.throws(() => parseLeaderboardPage('{"status":"ok"}', 1), /схема/)
  assert.throws(() => parseLeaderboardPage('<html>', 1), /JSON/)
})
