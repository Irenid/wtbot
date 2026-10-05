import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLAN_CRAWL_KEEP_SEC,
  closeDb,
  getClanCrawls,
  getSiteClanDictionary,
  getSiteClanOfficialRatingAt,
  getSiteClanOfficialStatsAt,
  getSiteClanProfile,
  getSiteClanOfficialRatingEvents,
  initDb,
  saveClanLeaderboard,
  type ClanLeaderboardEntry,
} from './index.js'

const NO_EXTRAS = {
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
}

function entry(tag: string, name: string, rating: number, extra: Partial<ClanLeaderboardEntry> = {}): ClanLeaderboardEntry {
  return { tag, name, rating, position: 1, members: 100, battles: 10, wins: 7, ...extra }
}

test('saveClanLeaderboard пишет статистику клана и историю рейтинга только при изменении', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([entry('[AVR]', 'AVANGARD', 48_000)], 1_000)
    saveClanLeaderboard([entry('[AVR]', 'AVANGARD', 48_000, { position: 2 })], 2_000)
    // Новые украшения тега — та же история по ядру «avr».
    saveClanLeaderboard([entry('╍AVR╎', 'AVANGARD', 48_300, { members: 101 })], 3_000)

    const dictionary = new Map(getSiteClanDictionary().map((row) => [row.tag, row]))
    assert.deepEqual(dictionary.get('[AVR]'), {
      tag: '[AVR]', name: 'AVANGARD', rating: 48_000, position: 2, members: 100, battles: 10, wins: 7, ratingAt: 2_000, ...NO_EXTRAS,
    })
    assert.deepEqual(dictionary.get('╍AVR╎'), {
      tag: '╍AVR╎', name: 'AVANGARD', rating: 48_300, position: 1, members: 101, battles: 10, wins: 7, ratingAt: 3_000, ...NO_EXTRAS,
    })

    assert.deepEqual(getSiteClanOfficialRatingEvents('avr', 0, 10_000), {
      events: [
        { capturedAt: 1_000, rating: 48_000, battles: 10, wins: 7 },
        { capturedAt: 3_000, rating: 48_300, battles: 10, wins: 7 },
      ],
      truncated: false,
    })
    assert.deepEqual(getSiteClanOfficialRatingEvents('avr', 1_000, 10_000).events, [{ capturedAt: 3_000, rating: 48_300, battles: 10, wins: 7 }])
    assert.deepEqual(getSiteClanOfficialRatingAt('avr', 0, 2_500), { capturedAt: 1_000, rating: 48_000 })
    assert.equal(getSiteClanOfficialRatingAt('avr', 1_500, 2_500), null, 'изменение до начала периода не базис')
    assert.deepEqual(getSiteClanOfficialStatsAt('avr', 0, 3_000), { capturedAt: 3_000, rating: 48_300, battles: 10, wins: 7 })
    assert.equal(getSiteClanOfficialStatsAt('', 0, 3_000), null)
    assert.throws(() => getSiteClanOfficialStatsAt('avr', -1, 3_000), RangeError)
  } finally {
    closeDb()
  }
})

test('saveClanLeaderboard logs the core tags each crawl read and prunes old crawls', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([
      entry('[AVR]', 'AVANGARD', 48_000),
      entry('[B]', 'Bravo', 900, { position: 2 }),
      // A decorated variant of a core read above keeps the higher place.
      entry('╍AVR╎', 'AVANGARD', 800, { position: 3 }),
      { tag: '[N]', name: 'No rating', rating: null, position: null, members: null, battles: null, wins: null },
    ], 1_000, { full: true })
    saveClanLeaderboard([entry('[B]', 'Bravo', 950)], 2_000)
    assert.deepEqual(getClanCrawls(0), [
      { capturedAt: 1_000, full: true, cores: ['avr', 'b'] },
      { capturedAt: 2_000, full: false, cores: ['b'] },
    ])
    assert.deepEqual(getClanCrawls(1_500).map((crawl) => crawl.capturedAt), [2_000])
    // A rerun at the same moment replaces its row.
    saveClanLeaderboard([entry('[C]', 'Charlie', 10)], 2_000, { full: true })
    assert.deepEqual(getClanCrawls(1_500), [{ capturedAt: 2_000, full: true, cores: ['c'] }])
    const later = 1_000 + CLAN_CRAWL_KEEP_SEC + 1
    saveClanLeaderboard([entry('[B]', 'Bravo', 960)], later)
    assert.deepEqual(getClanCrawls(0).map((crawl) => crawl.capturedAt), [2_000, later], 'a crawl past the keep window is pruned')
    assert.throws(() => getClanCrawls(-1), RangeError)
  } finally {
    closeDb()
  }
})

test('saveClanLeaderboard без рейтинга обновляет только имя и не затирает статистику', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([entry('[A]', 'Old', 500)], 1_000)
    saveClanLeaderboard([{ tag: '[A]', name: 'New', rating: null, position: null, members: null, battles: null, wins: null }], 2_000)

    assert.deepEqual(getSiteClanDictionary(), [
      { tag: '[A]', name: 'New', rating: 500, position: 1, members: 100, battles: 10, wins: 7, ratingAt: 1_000, ...NO_EXTRAS },
    ])
    assert.equal(getSiteClanOfficialRatingEvents('a', 0, 10_000).events.length, 1)
  } finally {
    closeDb()
  }
})

test('saveClanLeaderboard отклоняет некорректный момент обхода', () => {
  initDb(':memory:')
  try {
    assert.throws(() => saveClanLeaderboard([entry('[A]', 'A', 1)], 0), RangeError)
    assert.throws(() => saveClanLeaderboard([entry('[A]', 'A', 1)], 1.5), RangeError)
  } finally {
    closeDb()
  }
})

test('saveClanLeaderboard пишет точку истории при новом бое без изменения рейтинга', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([entry('[AVR]', 'AVANGARD', 48_307, { deaths: 8_307 })], 1_000)
    saveClanLeaderboard([entry('[AVR]', 'AVANGARD', 48_307, { deaths: 8_307 })], 2_000)
    saveClanLeaderboard([entry('[AVR]', 'AVANGARD', 48_307, { battles: 11, deaths: 8_315 })], 3_000)

    assert.deepEqual(getSiteClanOfficialRatingEvents('avr', 0, 10_000).events.map((event) => [event.capturedAt, event.battles]), [
      [1_000, 10],
      [3_000, 11],
    ])
    assert.equal(getSiteClanDictionary()[0]?.deaths, 8_315)
  } finally {
    closeDb()
  }
})

test('saveClanLeaderboard хранит профиль клана: описание, условия вступления, приём и тег без украшений', () => {
  initDb(':memory:')
  try {
    const requirements = {
      ranks: { mode: 'or' as const, items: [{ unitType: 'Tank', rank: 8, count: 1 }] },
      battles: [{ difficulty: 'historical', count: 1000 }],
    }
    saveClanLeaderboard([
      entry('╆LVUA╇', 'LVTeam', 45_673, {
        clanId: 1_070_535,
        description: 'Вступ через Discord\nВимоги: 1.5+ К/Б',
        announcement: null,
        requirements,
        status: 'open',
        autoAccept: false,
        plainTag: '.LVUA.',
        regalia: 'place3',
      }),
      entry('[OLD]', 'Old', 10),
    ], 1_790_000_000)

    assert.deepEqual(getSiteClanProfile('╆LVUA╇'), {
      clanId: 1_070_535,
      description: 'Вступ через Discord\nВимоги: 1.5+ К/Б',
      announcement: null,
      requirements,
      status: 'open',
      autoAccept: false,
      plainTag: '.LVUA.',
      regalia: 'place3',
    })
    assert.equal(getSiteClanProfile('[OLD]')?.requirements, null)
    assert.equal(getSiteClanProfile('[NONE]'), null)
  } finally {
    closeDb()
  }
})
