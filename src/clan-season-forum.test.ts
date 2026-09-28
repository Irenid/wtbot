import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stageAt } from './clan-season.js'
import { parseForumSeasonPost } from './clan-season-forum.js'
import { closeDb, getClanSeasonContext, initDb, syncForumClanSeasons } from './db/index.js'

// Текст первого поста темы 2509 на 2026-09-28 (/raw/2509/1), «мах» — кириллица.
const POST_2026_AUTUMN = `В этой теме публикуется расписание и порядок доступных Боевых Рейтингов в полковых боях с плавающим БР внутри сезона. Полковые бои доступны ежедневно в двух периодах:

> * С 17:00 МСК по 01:00 МСК
> * С 04:00 МСК по 10:00 МСК

[size=4]Сезон 01.09.2026 — 31.10.2026[/size]

Сезон полковых боёв имеет следующую ротацию: высокие доступные БР в начале и наименьшие БР в конце сезона. Понижение БР будет производиться раз в неделю следующим образом:

1 неделя мах БР 14.7 (01.09 — 07.09)
2 неделя мах БР 12.0 (08.09 — 14.09)
3 неделя мах БР 11.0 (15.09 — 21.09)
4 неделя мах БР 10.0 (22.09 — 28.09)
5 неделя мах БР 9.0 (29.09 — 05.10)
6 неделя мах БР 8.0 (06.10 — 12.10)
7 неделя мах БР 7.0 (13.10 — 19.10)
8 неделя мах БР 6.0 (20.10 — 26.10)
До конца сезона мах БР 5.0 (27.10 — 31.10)
`

const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1_000

test('пост форума превращается в сезон с включительными датами форума', () => {
  const [season, ...rest] = parseForumSeasonPost(POST_2026_AUTUMN)
  assert.equal(rest.length, 0)
  assert.equal(season!.id, 'forum-2026-09-01')
  assert.equal(season!.name, 'Сезон 01.09.2026 — 31.10.2026')
  assert.equal(season!.startsAt, utc('2026-09-01'))
  assert.equal(season!.endsAt, utc('2026-11-01'))
  assert.deepEqual(season!.stages.map((stage) => stage.maxBr), [14.7, 12, 11, 10, 9, 8, 7, 6, 5])
  // 28.09 — последний день 4-й недели, 29.09 — уже 5-я.
  assert.equal(stageAt(season!, utc('2026-09-29') - 1)?.maxBr, 10)
  assert.equal(stageAt(season!, utc('2026-09-29'))?.week, 5)
  assert.equal(stageAt(season!, season!.endsAt), null)
})

test('сезон через Новый год получает правильный год у январских этапов', () => {
  const [season] = parseForumSeasonPost(`Сезон 15.12.2026 — 10.01.2027
1 неделя max БР 14.7 (15.12 — 28.12)
До конца сезона макс. БР 9,7 (29.12 — 10.01)`)
  assert.equal(season!.stages[1]!.endsAt, utc('2027-01-11'))
  assert.equal(season!.stages[1]!.maxBr, 9.7)
})

test('странный пост отклоняется целиком, а не превращается в частичный сезон', () => {
  const week = (n: number, br: string, from: string, to: string) => `${n} неделя мах БР ${br} (${from} — ${to})`
  const post = (...lines: string[]) => ['Сезон 01.09.2026 — 14.09.2026', ...lines].join('\n')
  assert.throws(() => parseForumSeasonPost('расписание скоро'), /не найдено строки/)
  assert.throws(() => parseForumSeasonPost('Сезон 01.09.2026 — 14.09.2026\nподробности позже'), /ни одного этапа/)
  assert.throws(() => parseForumSeasonPost(post(week(1, '14.7', '01.09', '06.09'), week(2, '12.0', '08.09', '14.09'))), /дыра/)
  assert.throws(() => parseForumSeasonPost(post(week(1, '14.7', '01.09', '07.09'), week(3, '12.0', '08.09', '14.09'))), /неделя 3/)
  assert.throws(() => parseForumSeasonPost(post(week(1, '14.7', '01.09', '07.09'), week(2, '12.0', '08.09', '20.09'))), /вне сезона/)
  assert.throws(() => parseForumSeasonPost(post(week(1, '0.5', '01.09', '14.09'))), /вне диапазона/)
  assert.throws(() => parseForumSeasonPost('Сезон 31.02.2026 — 14.03.2026\n1 неделя мах БР 5.0 (01.03 — 14.03)'), /несуществующая/)
  assert.throws(() => parseForumSeasonPost('x'.repeat(70_000)), /слишком большой/)
})

test('синхронизация с форумом: вставка, повтор без изменений, правка и сдвиг начала', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wtbot-forum-season-'))
  try {
    initDb(path.join(dir, 'season.db'), { allowCreate: true })
    const schedules = parseForumSeasonPost(POST_2026_AUTUMN)
    assert.deepEqual(syncForumClanSeasons(schedules).inserted, ['forum-2026-09-01'])
    assert.deepEqual(syncForumClanSeasons(schedules).unchanged, ['forum-2026-09-01'])

    const context = getClanSeasonContext(utc('2026-09-28'))
    assert.equal(context.season?.id, 'forum-2026-09-01')
    assert.equal(context.season?.active, true)
    assert.equal(context.currentStage?.maxBr, 10)
    assert.equal(context.stages.length, 9)

    const edited = parseForumSeasonPost(POST_2026_AUTUMN.replace('мах БР 11.0', 'мах БР 11.3'))
    assert.deepEqual(syncForumClanSeasons(edited).updated, ['forum-2026-09-01'])
    assert.equal(getClanSeasonContext(utc('2026-09-16')).currentStage?.maxBr, 11.3)

    // Модераторы сдвинули начало на день: прежняя forum-запись заменяется, а не дублируется.
    const shifted = parseForumSeasonPost(POST_2026_AUTUMN
      .replace('Сезон 01.09.2026', 'Сезон 02.09.2026')
      .replace('(01.09 — 07.09)', '(02.09 — 07.09)'))
    const result = syncForumClanSeasons(shifted)
    assert.deepEqual(result.inserted, ['forum-2026-09-02'])
    assert.deepEqual(result.replaced, ['forum-2026-09-01'])
    assert.equal(getClanSeasonContext(utc('2026-09-28')).season?.id, 'forum-2026-09-02')

    // Встроенный летний сезон из кода не перетирается данными форума.
    const clash = parseForumSeasonPost('Сезон 20.08.2026 — 31.08.2026\n1 неделя мах БР 5.0 (20.08 — 31.08)')
    assert.throws(() => syncForumClanSeasons(clash), /встроенным сезоном 2026-summer/)
    assert.equal(getClanSeasonContext(utc('2026-08-25')).season?.id, '2026-summer')
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})
