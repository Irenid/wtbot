import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProfileStatSection } from '../parsers/sources/wt-profile-stats.js'
import {
  normalizeOfficialProfile,
  parseProfileCount,
  parseProfilePlayTime,
  PlayerStatsSchemaError,
} from './normalizer.js'

/** Строки взяты со страниц профилей Venukbr и ТУМ4Н (английская и русская локали). */

function section(titles: string[], arcade: Array<string | null>, realistic: Array<string | null>): ProfileStatSection {
  const pair = (values: Array<string | null>): Record<string, string | null> =>
    Object.fromEntries(titles.map((title, index) => [title, values[index] ?? null]))
  return {
    titles,
    values: { arcade: pair(arcade), realistic: pair(realistic), simulation: {} },
  }
}

const generalSection = section(
  [
    'Statistics',
    'Victories',
    'Completed missions',
    'Victories/battles ratio',
    'Deaths',
    'Lions earned',
    'Play time',
    'Air targets destroyed',
    'Ground targets destroyed',
    'Naval targets destroyed',
  ],
  ['Arcade battles', '477', '954', '50%', '2,442', '3,655,382', '4d 10h', '2704', '755', '38'],
  ['Realistic battles', '7533', '15064', '50%', '19,637', '157,728,170', '1.6 M', '6228', '23974', '3'],
)

const airSection = section(
  [
    'Air battles',
    'Air battles in fighters',
    'Air battles in bombers',
    'Air battles in attackers',
    'Time played in air battles',
    'Time played in fighter',
    'Time played in bomber',
    'Time played in attackers',
    'Total targets destroyed',
    'Air targets destroyed',
    'Ground targets destroyed',
    'Naval targets destroyed',
  ],
  ['1644', '1644', null, null, '2d 8h', '2d 8h', null, null, '2732', '2559', '150', '23'],
  ['4545', '3905', null, '640', '11d 6h', '9d 20h', null, '1d 9h', '5170', '4590', '579', '1'],
)

const groundSection = section(
  [
    'Ground battles',
    'Ground battles in tanks',
    'Ground battles in SPGs',
    'Ground battles in heavy tanks',
    'Ground battles in SPAA',
    'Time played in ground battles',
    'Tank battle time',
    'Tank Destroyer battle time',
    'Heavy Tank battle time',
    'SPAA battle time',
    'Total targets destroyed',
    'Air targets destroyed',
    'Ground targets destroyed',
    'Naval targets destroyed',
  ],
  ['1064', '638', '24', '297', '105', '1d 23h', '1d 2h', '0h 40m', '16h 31m', '3h 55m', '750', '145', '605', null],
  ['16891', '10758', '2801', '2400', '932', '1.2 M', '23d 11h', '5d 16h', '6d 22h', '1d 19h', '25033', '1638', '23395', null],
)

test('числа профиля читаются с разделителями тысяч, N/A остаётся null', () => {
  assert.equal(parseProfileCount('2,442'), 2442)
  assert.equal(parseProfileCount('157728170'), 157_728_170)
  assert.equal(parseProfileCount('1 644'), 1644)
  assert.equal(parseProfileCount(null), null)
  assert.equal(parseProfileCount(''), null)
  // Проценты и мусор не должны превращаться в числа.
  assert.equal(parseProfileCount('50%'), null)
  assert.equal(parseProfileCount('Arcade battles'), null)
})

test('длительность разбирается во всех форматах страницы, включая месяцы', () => {
  assert.equal(parseProfilePlayTime('1h 52m'), 6720)
  assert.equal(parseProfilePlayTime('5h 0m'), 18_000)
  assert.equal(parseProfilePlayTime('4d 10h'), 4 * 86_400 + 10 * 3_600)
  assert.equal(parseProfilePlayTime('0h 8m'), 480)
  // «M» — месяц, «m» — минута; регистр значим.
  assert.equal(parseProfilePlayTime('1.6 M'), Math.round(1.6 * 30 * 86_400))
  assert.notEqual(parseProfilePlayTime('1 M'), parseProfilePlayTime('1 m'))
  // Русская локаль: «м» — месяц, «мин» — минуты.
  assert.equal(parseProfilePlayTime('1ч 52мин'), 6720)
  assert.equal(parseProfilePlayTime('1д 11ч'), 86_400 + 11 * 3_600)
  assert.equal(parseProfilePlayTime('1.9 м'), Math.round(1.9 * 30 * 86_400))
  // Неизвестный формат не должен молча становиться нулём.
  assert.equal(parseProfilePlayTime('1.6 X'), null)
  assert.equal(parseProfilePlayTime('какая-то строка'), null)
  assert.equal(parseProfilePlayTime(null), null)
})

test('общий блок даёт бои, победы, выведенные поражения и смерти по режимам', () => {
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: '┾WLILY┿',
    level: 100,
    registrationDate: '03.03.2019',
    sections: [generalSection],
  })

  const arcade = stats.totals.find((row) => row.mode === 'arcade' && row.gameType === null)
  assert.ok(arcade)
  assert.equal(arcade.battles, 954)
  assert.equal(arcade.victories, 477)
  assert.equal(arcade.defeats, 477)
  assert.equal(arcade.deaths, 2442)
  assert.equal(arcade.airKills, 2704)
  assert.equal(arcade.groundKills, 755)
  assert.equal(arcade.navalKills, 38)
  assert.equal(arcade.timePlayedSec, 4 * 86_400 + 10 * 3_600)
  // Выходы на задания — метрика веток, у общей строки её нет.
  assert.equal(arcade.respawns, null)
})

test('сводная строка складывает режимы и находится по ключу (null, null, null)', () => {
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [generalSection],
  })

  const aggregate = stats.totals.find(
    (row) => row.gameType === null && row.mode === null && row.category === null,
  )
  assert.ok(aggregate)
  assert.equal(aggregate.battles, 954 + 15_064)
  assert.equal(aggregate.victories, 477 + 7_533)
  assert.equal(aggregate.deaths, 2_442 + 19_637)
  assert.equal(aggregate.airKills, 2_704 + 6_228)
  // Win rate считается именно по этой строке.
  assert.ok(Math.abs(aggregate.victories! / aggregate.battles! - 0.5) < 0.01)
})

test('ветки пишут выходы на задания и время по классам техники, а фраги — только у ветки', () => {
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [generalSection, airSection, groundSection],
  })

  const airAll = stats.totals.find(
    (row) => row.gameType === 'air' && row.mode === 'realistic' && row.category === 'all',
  )
  assert.ok(airAll)
  assert.equal(airAll.respawns, 4545)
  assert.equal(airAll.timePlayedSec, 11 * 86_400 + 6 * 3_600)
  assert.equal(airAll.airKills, 4590)
  assert.equal(airAll.groundKills, 579)
  // Бои и победы у веток неизвестны и не должны выдумываться.
  assert.equal(airAll.battles, null)
  assert.equal(airAll.victories, null)

  const attackers = stats.totals.find(
    (row) => row.gameType === 'air' && row.mode === 'realistic' && row.category === 'attackers',
  )
  assert.ok(attackers)
  assert.equal(attackers.respawns, 640)
  assert.equal(attackers.timePlayedSec, 86_400 + 9 * 3_600)
  assert.equal(attackers.airKills, null)

  const bombers = stats.totals.find(
    (row) => row.gameType === 'air' && row.mode === 'arcade' && row.category === 'bombers',
  )
  assert.ok(bombers)
  assert.equal(bombers.respawns, null)
  assert.equal(bombers.timePlayedSec, null)
})

test('классы наземной техники не путаются между собой', () => {
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [generalSection, groundSection],
  })
  const ground = (category: string) => stats.totals.find(
    (row) => row.gameType === 'ground' && row.mode === 'arcade' && row.category === category,
  )

  assert.equal(ground('tanks')?.respawns, 638)
  assert.equal(ground('spg')?.respawns, 24)
  assert.equal(ground('heavy_tanks')?.respawns, 297)
  assert.equal(ground('spaa')?.respawns, 105)
  assert.equal(ground('all')?.respawns, 1064)
  // «Tank Destroyer battle time» не должно попасть ни в танки, ни в эсминцы.
  assert.equal(ground('spg')?.timePlayedSec, 40 * 60)
  assert.equal(ground('tanks')?.timePlayedSec, 86_400 + 2 * 3_600)
  assert.equal(ground('heavy_tanks')?.timePlayedSec, 16 * 3_600 + 31 * 60)
})

test('русская локаль разбирается теми же правилами', () => {
  const ruGeneral = section(
    [
      'Статистика',
      'Победы',
      'Законченные миссии',
      'Соотношение побед/битв',
      'Смертей',
      'Заработано Львов',
      'Время игры',
      'Воздушных целей уничтожено',
      'Наземных целей уничтожено',
      'Морских целей уничтожено',
    ],
    ['Аркадные бои', '36', '43', '84%', '81', '233,804', '1ч 52мин', '36', '31', '12'],
    ['Реалистичные бои', '7498', '13855', '54%', '22,965', '301,085,767', '1.9 м', '8471', '29807', '30'],
  )
  const ruAir = section(
    [
      'Выходы на задания в авиации',
      'Выходы на задания на истребителях',
      'Время игры в авиации',
      'Время игры на истребителях',
      'Воздушных целей уничтожено',
    ],
    ['17', '13', '0ч 35мин', '0ч 27мин', '29'],
    ['10430', '6236', '28д 12ч', '16д 22ч', '6672'],
  )

  const stats = normalizeOfficialProfile({
    nick: 'ТУМ4Н',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [ruGeneral, ruAir],
  })

  const arcade = stats.totals.find((row) => row.gameType === null && row.mode === 'arcade')
  assert.equal(arcade?.battles, 43)
  assert.equal(arcade?.victories, 36)
  assert.equal(arcade?.timePlayedSec, 6720)

  const fighters = stats.totals.find(
    (row) => row.gameType === 'air' && row.mode === 'realistic' && row.category === 'fighters',
  )
  assert.equal(fighters?.respawns, 6236)
  assert.equal(fighters?.timePlayedSec, 16 * 86_400 + 22 * 3_600)
})

test('морская ветка: «ships» во множественном числе и незнакомая строка не затирают итог', () => {
  const navalSection = section(
    [
      'Naval battles',
      'Naval battles in ships',
      'Naval battles in submarines',
      'Time played in naval battles',
      'Time played in ships',
      'Total targets destroyed',
      'Naval targets destroyed',
    ],
    ['520', '71', '9', '10h 0m', '8h 0m', '300', '120'],
    [null, null, null, null, null, null, null],
  )
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [generalSection, navalSection],
  })
  const naval = (category: string) => stats.totals.find(
    (row) => row.gameType === 'naval' && row.mode === 'arcade' && row.category === category,
  )
  // Итог ветки берётся из первой строки, а не из последней похожей.
  assert.equal(naval('all')?.respawns, 520)
  assert.equal(naval('all')?.timePlayedSec, 10 * 3_600)
  assert.equal(naval('all')?.navalKills, 120)
  assert.equal(naval('ships')?.respawns, 71)
  assert.equal(naval('ships')?.timePlayedSec, 8 * 3_600)
  // Незнакомая категория не попадает ни в итог, ни в выдуманную категорию.
  assert.ok(stats.totals.every((row) => row.category !== 'submarines'))
})

test('сводный win rate считается только по режимам с известными боями и победами', () => {
  const partialGeneral = section(
    [
      'Statistics',
      'Victories',
      'Completed missions',
      'Deaths',
    ],
    ['Arcade battles', null, '3000', '100'],
    ['Realistic battles', '410', '1020', '50'],
  )
  const stats = normalizeOfficialProfile({
    nick: 'Venukbr',
    clan: null,
    level: null,
    registrationDate: null,
    sections: [partialGeneral],
  })
  const aggregate = stats.totals.find(
    (row) => row.gameType === null && row.mode === null && row.category === null,
  )
  assert.ok(aggregate)
  // Аркада без побед исключена из обеих частей дроби: 410 / 1020, а не 410 / 4020.
  assert.equal(aggregate.battles, 1020)
  assert.equal(aggregate.victories, 410)
  assert.equal(aggregate.defeats, 610)
  assert.equal(aggregate.deaths, 150)
})

test('нереалистично большое время игры считается ошибкой разбора', () => {
  assert.equal(parseProfilePlayTime('14 y'), 14 * 365 * 86_400)
  assert.equal(parseProfilePlayTime('16 y'), null)
  assert.equal(parseProfilePlayTime('500 M'), null)
})

test('страница без общего блока считается сменой вёрстки', () => {
  assert.throws(
    () => normalizeOfficialProfile({
      nick: 'Venukbr',
      clan: null,
      level: null,
      registrationDate: null,
      sections: [airSection],
    }),
    PlayerStatsSchemaError,
  )
  assert.throws(
    () => normalizeOfficialProfile({
      nick: 'Venukbr',
      clan: null,
      level: null,
      registrationDate: null,
      sections: [],
    }),
    PlayerStatsSchemaError,
  )
})
