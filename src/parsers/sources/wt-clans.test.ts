import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, getClanNameByTag, initDb, setBotState } from '../../db/index.js'
import { resetClanInfoState } from '../../wrpl/clan-info.js'
import { resetWtTransportState } from './wt-request.js'
import {
  leaderboardMultilineText,
  leaderboardText,
  parseClanRequirements,
  parseLeaderboardPage,
  pickRostersToRefresh,
  requestFullClanCrawl,
  wtClans,
} from './wt-clans.js'

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
  clanId: null,
  description: null,
  announcement: null,
  requirements: null,
  status: null,
  autoAccept: null,
  plainTag: null,
  regalia: null,
}

test('parseLeaderboardPage читает полную статистику клана, награды и сезон', () => {
  const parsed = parseLeaderboardPage(page([
    {
      pos: 20,
      _id: 1_031_031,
      tag: '╆AVR╇',
      lastPaidTag: '[AVR]',
      currentTagRegalia: 'place1',
      status: 'open',
      autoaccept: false,
      desc: '&lt;color=#3556ca&gt;Вступление через Discord&lt;/color&gt;\n\n\n  Требования:   KD 1.5+  ',
      announcement: '',
      membership_req: {
        ranks: {
          rank_Aircraft: { type: 'rank', rank: 9, count: 1, unitType: 'Aircraft' },
          rank_Tank: { type: 'rank', rank: 8, count: 1, unitType: 'Tank' },
          type: 'or',
        },
        battles_historical: { type: 'battles', difficulty: 'historical', count: 1000 },
        type: 'and',
      },
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
      tag: '╆AVR╇',
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
      clanId: 1_031_031,
      description: 'Вступление через Discord\n\nТребования: KD 1.5+',
      announcement: null,
      requirements: {
        ranks: {
          mode: 'or',
          items: [
            { unitType: 'Aircraft', rank: 9, count: 1 },
            { unitType: 'Tank', rank: 8, count: 1 },
          ],
        },
        battles: [{ difficulty: 'historical', count: 1000 }],
      },
      status: 'open',
      autoAccept: false,
      plainTag: '[AVR]',
      regalia: 'place1',
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

test('leaderboardText снимает HTML-экранирование и разметку игры, не трогая прочий текст', () => {
  assert.equal(
    leaderboardText('&lt;color=#FF0000&gt;HUN&lt;/color&gt;GA&lt;color=#49BD00&gt;RY&lt;/color&gt;'),
    'HUNGARY',
  )
  assert.equal(leaderboardText('&lt;b&gt;╍https://discord.gg/abc╎&lt;/b&gt;'), '╍https://discord.gg/abc╎')
  assert.equal(leaderboardText('North America &amp; European Union'), 'North America & European Union')
  assert.equal(leaderboardText('&quot;Nur wer wagt&quot; L&#039;escadron'), '"Nur wer wagt" L\'escadron')
  assert.equal(leaderboardText('строка&lt;br&gt;вторая'), 'строка вторая')
  // Не разметка игры: ссылка в угловых скобках и двойное экранирование остаются текстом.
  assert.equal(leaderboardText('&lt;https://example.net&gt;'), '<https://example.net>')
  assert.equal(leaderboardText('&amp;lt;b&amp;gt;'), '&lt;b&gt;')
  assert.equal(leaderboardText('&#99999999; ok'), '&#99999999; ok')
  assert.equal(leaderboardText('&lt;color=#fff&gt; &lt;/color&gt;'), null)
  assert.equal(leaderboardText(7), null)
})

test('parseLeaderboardPage кладёт регион и слоган чистым текстом', () => {
  const parsed = parseLeaderboardPage(page([{
    pos: 0,
    tag: '╍REIZ╎',
    name: 'REIZ',
    region: '&lt;color=#00df01&gt;СНГ (16+)&lt;/color&gt;',
    slogan: 'BEST&lt;color=#FF4500&gt; ARABIC &lt;/color&gt;SQUADRON',
    astat: { dr_era5_hist: 43_293 },
  }]), 1)
  assert.equal(parsed.clans[0]?.region, 'СНГ (16+)')
  assert.equal(parsed.clans[0]?.slogan, 'BEST ARABIC SQUADRON')
  // Тег и имя — ключи сопоставления с боями и URL claninfo: их не меняем.
  assert.equal(parsed.clans[0]?.tag, '╍REIZ╎')
})

test('pickRostersToRefresh берёт лидеров с устаревшим ростером по месту, не больше лимита', () => {
  const clan = (tag: string, position: number, rating: number | null = 1_000) => ({
    tag, name: tag, rating, position, members: 100, battles: 10, wins: 5, ...EMPTY_EXTRAS,
  })
  const now = 2_000_000
  const clans = [clan('[C]', 3), clan('[A]', 1), clan('[B]', 2), clan('[D]', 4), clan('[Z]', 5, 0), clan('[N]', 6, null)]
  const refreshed = new Map([['[B]', now - 3_600], ['[D]', now - 25 * 3_600]])
  // [B] обновлён час назад, [Z] и [N] без рейтинга сезона.
  assert.deepEqual(pickRostersToRefresh(clans, refreshed, now), ['[A]', '[C]', '[D]'])
  assert.deepEqual(pickRostersToRefresh(clans, refreshed, now, 2), ['[A]', '[C]'])
  assert.deepEqual(pickRostersToRefresh([], refreshed, now), [])
})

test('leaderboardMultilineText сохраняет переносы строк и снимает разметку игры', () => {
  assert.equal(leaderboardMultilineText('строка&lt;br&gt;вторая'), 'строка\nвторая')
  assert.equal(leaderboardMultilineText(' a \r\n\r\n\r\n b\t c '), 'a\n\nb c')
  assert.equal(leaderboardMultilineText('&lt;b&gt;&lt;/b&gt;\n '), null)
  assert.equal(leaderboardMultilineText('x'.repeat(3_000))?.length, 2_048)
  assert.equal(leaderboardMultilineText(null), null)
})

test('parseClanRequirements: пустой массив — условий нет, незнакомое пропускается', () => {
  assert.equal(parseClanRequirements([]), null)
  assert.equal(parseClanRequirements({ type: 'and' }), null)
  assert.deepEqual(
    parseClanRequirements({
      ranks: {
        rank_Tank: { type: 'rank', rank: 7, count: 1, unitType: 'Tank' },
        rank_Bad: { type: 'rank', rank: -1, count: 1, unitType: 'Tank' },
        rank_Odd: { type: 'rank', rank: 5, count: 1, unitType: '<script>' },
        type: 'and',
      },
      battles_arcade: { type: 'battles', difficulty: 'arcade', count: '10' },
      type: 'and',
    }),
    { ranks: { mode: 'and', items: [{ unitType: 'Tank', rank: 7, count: 1 }] }, battles: [] },
  )
})

test('requestFullClanCrawl makes the next run read past the top pages while a tag is unknown', async () => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const pages: number[] = []
  // Pages 1–6 hold one rated clan each, page 7 a zero-rated one: the active list ends there.
  globalThis.fetch = async (input) => {
    const url = String(input)
    const page = /\/page\/(\d+)\//.exec(url)
    if (!page) {
      // claninfo of the leaders whose roster the run refreshes
      return new Response(`
        <div class="squadrons-members">
          <a href="en/community/userinfo/?nick=Member">Member</a>
          <div class="squadrons-members__grid-item">100</div>
        </div>
      `)
    }
    const n = Number(page[1])
    pages.push(n)
    const data = n <= 7 ? [{ pos: n - 1, tag: `T${n}`, name: `Clan ${n}`, astat: { dr_era5_hist: n < 7 ? 1_000 - n : 0 } }] : []
    return new Response(JSON.stringify({ status: 'ok', data }), { headers: { 'content-type': 'application/json' } })
  }
  console.log = () => undefined
  resetWtTransportState({ waitSlot: async () => undefined, browserEnabled: () => false })
  resetClanInfoState({ wait: async () => undefined, defer: () => undefined })
  initDb(':memory:')
  const signal = new AbortController().signal

  try {
    setBotState('wt-clans:full-crawl-at', String(Math.floor(Date.now() / 1_000)))
    await wtClans.run(signal)
    assert.deepEqual(pages, [1, 2, 3, 4, 5])
    assert.equal(getClanNameByTag('T6'), null)

    pages.length = 0
    requestFullClanCrawl(['T6'])
    const full = await wtClans.run(signal)
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7])
    assert.match(full.summary, /full crawl for an unknown tag/)
    assert.equal(getClanNameByTag('T6'), 'Clan 6')

    // A tag an earlier run already found needs no crawl: only the top pages.
    pages.length = 0
    requestFullClanCrawl(['T6'])
    await wtClans.run(signal)
    assert.deepEqual(pages, [1, 2, 3, 4, 5])
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    resetWtTransportState()
    resetClanInfoState()
    closeDb()
  }
})
