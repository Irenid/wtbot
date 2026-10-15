import { validateClanSeasonSchedules, type ClanSeasonSchedule, type ClanSeasonStage } from './clan-season.js'

/**
 * Разбор расписания полковых боёв из первого поста темы форума
 * forum.warthunder.ru/t/2509. Модераторы переписывают пост к каждому сезону:
 *
 *   [size=4]Сезон 01.09.2026 — 31.10.2026[/size]
 *   1 неделя мах БР 14.7 (01.09 — 07.09)
 *   …
 *   До конца сезона мах БР 5.0 (27.10 — 31.10)
 *
 * Даты на форуме включительные и без часового пояса; как и у встроенного
 * сезона, границы считаются по UTC-полуночи, конец — начало следующего дня.
 * Пост — недоверенный текст: любая странность (дыра между неделями, БР вне
 * диапазона, неделя вне сезона) — ошибка разбора, а не частичный сезон.
 */

export const FORUM_SEASON_ID_PREFIX = 'forum-'
export const MAX_FORUM_POST_CHARS = 64 * 1024

const DAY_SEC = 86_400
const MAX_SEASON_DAYS = 200
const MAX_STAGES = 30
const MIN_BR = 1
const MAX_BR = 20

const DASH = '[—–-]'
const SEASON_RE = new RegExp(
  String.raw`Сезон\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s*${DASH}\s*(\d{1,2})\.(\d{1,2})\.(\d{4})`,
  'giu',
)
// «мах» на форуме набран кириллицей; принимаем и латиницу, и «макс».
const STAGE_RE = new RegExp(
  String.raw`^\s*(?:(\d{1,2})\s*недел[яи]|до\s+конца\s+сезона)\s+(?:[мm][аa][хx]|макс)\.?\s*БР\s*(\d{1,2}(?:[.,]\d)?)\s*\(\s*(\d{1,2})\.(\d{1,2})\s*${DASH}\s*(\d{1,2})\.(\d{1,2})\s*\)`,
  'iu',
)

function utcDay(year: number, month: number, day: number, label: string): number {
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label}: no such date ${day}.${month}.${year}`)
  }
  return ms / 1_000
}

/** A stage date without a year: the year that puts it inside the season (a season may cross New Year). */
function stageDay(
  day: number,
  month: number,
  season: { startsAt: number; endsAt: number; startYear: number },
  label: string,
): number {
  for (const year of [season.startYear, season.startYear + 1]) {
    const at = utcDay(year, month, day, label)
    if (at >= season.startsAt && at < season.endsAt) return at
  }
  throw new Error(`${label}: date ${day}.${month} is outside the season`)
}

function formatDay(sec: number): string {
  return new Date(sec * 1_000).toISOString().slice(0, 10)
}

function formatRuDay(sec: number): string {
  const [year, month, day] = formatDay(sec).split('-')
  return `${day}.${month}.${year}`
}

function parseSeasonBlock(header: RegExpExecArray, body: string): ClanSeasonSchedule {
  const [, d1, m1, y1, d2, m2, y2] = header.map(Number) as [number, number, number, number, number, number, number]
  const label = `season ${header[0]}`
  const startsAt = utcDay(y1, m1, d1, label)
  const endsAt = utcDay(y2, m2, d2, label) + DAY_SEC
  if (endsAt <= startsAt) throw new Error(`${label}: the end is before the start`)
  if ((endsAt - startsAt) / DAY_SEC > MAX_SEASON_DAYS) throw new Error(`${label}: the season is longer than ${MAX_SEASON_DAYS} days`)
  const season = { startsAt, endsAt, startYear: y1 }

  const stages: ClanSeasonStage[] = []
  for (const line of body.split(/\r?\n|<br\s*\/?>/iu)) {
    const match = STAGE_RE.exec(line)
    if (!match) continue
    const week = stages.length + 1
    const stageLabel = `${label}, stage ${week}`
    if (week > MAX_STAGES) throw new Error(`${label}: more than ${MAX_STAGES} stages`)
    if (match[1] !== undefined && Number(match[1]) !== week) {
      throw new Error(`${stageLabel}: the forum says week ${match[1]}`)
    }
    const maxBr = Number(match[2]!.replace(',', '.'))
    if (!(maxBr >= MIN_BR && maxBr <= MAX_BR)) throw new Error(`${stageLabel}: BR ${match[2]} is out of range`)
    const stageStart = stageDay(Number(match[3]), Number(match[4]), season, stageLabel)
    const stageEnd = stageDay(Number(match[5]), Number(match[6]), season, stageLabel) + DAY_SEC
    stages.push({ week, startsAt: stageStart, endsAt: stageEnd, maxBr })
  }
  if (stages.length === 0) throw new Error(`${label}: no stage found`)

  const schedule: ClanSeasonSchedule = {
    id: `${FORUM_SEASON_ID_PREFIX}${formatDay(startsAt)}`,
    name: `Сезон ${formatRuDay(startsAt)} — ${formatRuDay(endsAt - DAY_SEC)}`,
    startsAt,
    endsAt,
    stages,
  }
  validateClanSeasonSchedules([schedule])
  return schedule
}

/** Every season of the post in order. A post without a season is an error: the format changed. */
export function parseForumSeasonPost(text: string): ClanSeasonSchedule[] {
  if (text.length > MAX_FORUM_POST_CHARS) throw new Error('the schedule post is too large')
  const headers = [...text.matchAll(SEASON_RE)] as RegExpExecArray[]
  if (headers.length === 0) throw new Error('the post has no "Сезон DD.MM.YYYY — DD.MM.YYYY" line')
  const schedules = headers.map((header, index) => {
    const bodyStart = header.index + header[0].length
    const bodyEnd = headers[index + 1]?.index ?? text.length
    return parseSeasonBlock(header, text.slice(bodyStart, bodyEnd))
  })
  validateClanSeasonSchedules(schedules)
  return schedules
}
