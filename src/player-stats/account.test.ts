import assert from 'node:assert/strict'
import test from 'node:test'
import { officialProfileAccount, sanitizePlayerAccount, statSharkAccount } from './account.js'

const profile = {
  Basics: { level: '100', title: '  The Old Guard\u0007 ' },
  Misc: {
    registerDay: 1_373_452_206,
    lastDayOnline: 1_790_650_800,
    SquadronHistory: [
      { ClanID: 1_121_580, ClanTag: '╀FTNDS╀', Date: '2026-08-30 06:48:56' },
      { ClanID: 1_095_692, ClanTag: '╔CH68╕', Date: '2026-09-29 08:05:58' },
      { ClanID: 'x', ClanTag: '', Date: '2026-09-29 08:05:58' },
      { ClanTag: 'BAD', Date: '2026-02-31 00:00:00' },
    ],
    NameHistory: [{ IGN: 'dennis7781', Date: '2026-03-10 02:16:21' }, { IGN: 'x'.repeat(65), Date: '2026-03-10 02:16:21' }],
  },
  Profile: {
    Leaderboard: {
      historical: {
        value_total: {
          each_player_victories: { value_total: 22_259, idx: 3_777 },
          victories_battles: { value_total: 0.7393297, idx: 508 },
          naval_kills: { value_total: 0, idx: -1 },
        },
      },
      tank_realistic: { value_total: { ground_kills_player: { value_total: 90_000, idx: 0 }, air_kills: { value_total: 5, idx: -1 } } },
      air_arcade: true,
      poker_playmoney: { value_total: {} },
    },
  },
}

const leaderboardHistory = [
  { date: '2026-05-19T10:00:00.1234567Z', data: { historical: { t: { each_player_victories: { t: 20_000, idx: 4_000 } } } } },
  { date: '2026-03-10T02:16:21.9768243Z', data: { historical: { t: { each_player_victories: { t: 19_000, idx: 4_500 } } }, tank_arcade: { t: {} } } },
  { date: 'never', data: {} },
]

test('StatShark: уровень, звание, даты, кланы, ники и места', () => {
  const account = statSharkAccount({ profile, leaderboardHistory })
  assert.equal(account.level, 100)
  assert.equal(account.title, 'The Old Guard', 'управляющие символы и пробелы убираются')
  assert.equal(account.registeredAt, 1_373_452_206)
  assert.equal(account.lastOnlineAt, 1_790_650_800)
  assert.deepEqual(account.squadrons.map((squadron) => [squadron.tag, squadron.clanId]), [['╔CH68╕', 1_095_692], ['╀FTNDS╀', 1_121_580]],
    'новые первыми, битые записи пропущены')
  assert.deepEqual(account.names, [{ nick: 'dennis7781', seenAt: 1_773_108_981 }])
  assert.deepEqual(account.ranks, [
    { mode: 'historical', metric: 'victories', value: 22_259, place: 3_778 },
    { mode: 'historical', metric: 'winRate', value: 0.7393297, place: 509 },
    { mode: 'tank_realistic', metric: 'groundKills', value: 90_000, place: 1 },
  ], 'idx считается с нуля; -1 — нет места; режим-заглушка true пропускается')
  assert.deepEqual(account.rankHistory, [
    { at: 1_773_108_981, mode: 'historical', metric: 'victories', place: 4_501 },
    { at: 1_779_184_800, mode: 'historical', metric: 'victories', place: 4_001 },
  ], 'история по времени, запись с битой датой пропущена')
})

test('StatShark без Misc и Leaderboard даёт пустой аккаунт, а не ошибку', () => {
  const account = statSharkAccount({ profile: { Basics: {} } })
  assert.equal(sanitizePlayerAccount(account), null)
})

test('официальный профиль: уровень и дата регистрации «дд.мм.гггг»', () => {
  assert.deepEqual(
    { ...officialProfileAccount({ level: 99, registrationDate: '10.07.2013' }) },
    { level: 99, title: null, registeredAt: 1_373_414_400, lastOnlineAt: null, squadrons: [], names: [], ranks: [], rankHistory: [] },
  )
  assert.equal(officialProfileAccount({ level: 5, registrationDate: '31.02.2020' }).registeredAt, null)
})

test('проверка account_json отбрасывает чужие режимы, метрики и дубли', () => {
  const account = sanitizePlayerAccount({
    level: 7,
    ranks: [
      { mode: 'historical', metric: 'victories', value: 1, place: 2 },
      { mode: 'historical', metric: 'victories', value: 1, place: 3 },
      { mode: 'poker', metric: 'victories', value: 1, place: 2 },
      { mode: 'historical', metric: 'kills', value: 1, place: 2 },
      { mode: 'historical', metric: 'score', value: -1, place: 2 },
    ],
    squadrons: [{ clanId: null, tag: 'CH68', seenAt: 1_773_108_981 }, { tag: 'bad', seenAt: 1 }],
  })
  assert.deepEqual(account?.ranks, [{ mode: 'historical', metric: 'victories', value: 1, place: 2 }])
  assert.deepEqual(account?.squadrons, [{ clanId: null, tag: 'CH68', seenAt: 1_773_108_981 }])
  assert.equal(sanitizePlayerAccount('нет'), null)
})
