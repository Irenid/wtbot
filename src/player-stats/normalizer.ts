import type {
  ProfileStatMode,
  ProfileStatSection,
} from '../parsers/sources/wt-profile-stats.js'
import type {
  NormalizedPlayerExternalTotal,
  NormalizedPlayerStats,
} from './types.js'

/**
 * Нормализация статистики со страницы профиля warthunder.com.
 *
 * Страница отдаёт четыре строки статистики: общую и по трём веткам техники
 * (авиация, наземная техника, флот), каждую в трёх режимах. Значения приходят
 * строками в том виде, в каком их видит игрок («2,442», «4d 10h», «1.9 M»,
 * «N/A»), поэтому разбор вынесен в отдельные проверяемые функции.
 *
 * Важное различие, которое видно только в русской локали: «Air battles» на
 * самом деле «Выходы на задания в авиации», то есть spawn-и, а не бои. Поэтому
 * метрики веток пишутся в respawns, а battles остаётся только у общей строки —
 * складывать их нельзя (у активного игрока сумма веток заметно больше общего
 * числа боёв, потому что в одном бою он летает и ездит).
 */

export const OFFICIAL_PROFILE_PARSER_VERSION = 'wt-official-profile-v1'
export const OFFICIAL_PROFILE_SOURCE = 'official-profile'

/** Профиль не публикует длительность точнее двух значащих цифр для крупных единиц. */
const SECONDS_PER_UNIT: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:y|г|год|года|лет)$/i, 365 * 24 * 60 * 60],
  // Латинская «M» — месяц, «m» — минута, поэтому регистр здесь значим.
  [/^M$/, 30 * 24 * 60 * 60],
  [/^(?:мес|месяц|месяца|месяцев|м)$/, 30 * 24 * 60 * 60],
  [/^(?:d|д|дн|день|дня|дней)$/i, 24 * 60 * 60],
  [/^(?:h|ч|час|часа|часов)$/i, 60 * 60],
  [/^m$/, 60],
  [/^(?:min|мин|минут|минута|минуты)$/i, 60],
  [/^(?:s|сек|секунд|секунда|секунды|с)$/i, 1],
]

const MODE_NAMES: Record<ProfileStatMode, string> = {
  arcade: 'arcade',
  realistic: 'realistic',
  simulation: 'simulation',
}

type SectionKind = 'general' | 'air' | 'ground' | 'naval'

const SECTION_KINDS: ReadonlyArray<readonly [SectionKind, RegExp]> = [
  ['general', /^(?:statistics|статистика)$/i],
  ['air', /(?:air battles|в авиации)/i],
  ['ground', /(?:ground battles|на наземной технике)/i],
  ['naval', /(?:naval battles|на морской технике)/i],
]

/** Классы техники внутри ветки; порядок важен — частные шаблоны идут первыми. */
const CATEGORY_PATTERNS: Record<Exclude<SectionKind, 'general'>, ReadonlyArray<readonly [string, RegExp]>> = {
  air: [
    ['fighters', /(?:fighter|истребител)/i],
    ['bombers', /(?:bomber|бомбардировщ)/i],
    ['attackers', /(?:attacker|штурмовик)/i],
  ],
  ground: [
    ['heavy_tanks', /(?:heavy tank|тяжел)/i],
    ['spaa', /(?:spaa|зсу)/i],
    ['spg', /(?:spg|tank destroyer|сау)/i],
    ['tanks', /(?:tank|танк)/i],
  ],
  naval: [
    ['motor_torpedo_gun_boats', /(?:torpedo gun boat|торпедно-артил)/i],
    ['motor_torpedo_boats', /(?:torpedo boat|торпедн\w* катер)/i],
    ['motor_gun_boats', /(?:gun boat|артиллерийск\w* катер)/i],
    ['sub_chasers', /(?:sub-chaser|охотник)/i],
    ['destroyers', /(?:destroyer|эсминц)/i],
    ['naval_ferry_barges', /(?:ferry barge|баржа|баржах)/i],
    ['ships', /(?:\bship\b|корабл)/i],
  ],
}

const GENERAL_METRICS: ReadonlyArray<readonly [keyof GeneralValues, RegExp]> = [
  ['victories', /^(?:victories|победы)$/i],
  ['battles', /^(?:completed missions|законченные миссии)$/i],
  ['deaths', /^(?:deaths|смертей)$/i],
  ['timePlayed', /^(?:play time|время игры)$/i],
  ['airKills', /^(?:air targets destroyed|воздушных целей уничтожено)$/i],
  ['groundKills', /^(?:ground targets destroyed|наземных целей уничтожено)$/i],
  ['navalKills', /^(?:naval targets destroyed|морских целей уничтожено)$/i],
]

const TIME_TITLE = /(?:^time played|^время игры|battle time$)/i
const KILLS_TITLE = /(?:targets destroyed|целей уничтожено|всего уничтожено)/i
const TOTAL_KILLS_TITLE = /(?:^total targets destroyed$|^всего уничтожено$)/i
const AIR_KILLS_TITLE = /(?:^air targets destroyed$|^воздушных целей уничтожено$)/i
const GROUND_KILLS_TITLE = /(?:^ground targets destroyed$|^наземных целей уничтожено$)/i
const NAVAL_KILLS_TITLE = /(?:^naval targets destroyed$|^морских целей уничтожено$)/i

interface GeneralValues {
  battles: number | null
  victories: number | null
  deaths: number | null
  timePlayed: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

interface BranchCategory {
  respawns: number | null
  timePlayedSec: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

export class PlayerStatsSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlayerStatsSchemaError'
  }
}

/**
 * Разбирает целое число в том виде, как его печатает сайт: с разделителями
 * тысяч (запятая, пробел, неразрывный пробел) и без них. «N/A» приходит сюда
 * уже как null и остаётся null — нулём такие значения делать нельзя.
 */
export function parseProfileCount(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const cleaned = value.replace(/[\s  ,]/g, '')
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null
  const parsed = Number(cleaned)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Разбирает длительность профиля: «1h 52m», «4d 10h», «1.9 M», «1ч 52мин».
 * Крупные единицы округлены самим сайтом до двух значащих цифр, поэтому месяц
 * считается за 30 дней, а год за 365 — точнее исходные данные всё равно не
 * позволяют. Неизвестная единица даёт null, а не молчаливый ноль.
 */
export function parseProfilePlayTime(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const text = value.replace(/[  ]/g, ' ').trim()
  if (text === '') return null
  const pattern = /(\d+(?:[.,]\d+)?)\s*([A-Za-zА-Яа-яЁё]+)/g
  const tokens = [...text.matchAll(pattern)]
  if (tokens.length === 0) return null
  // Остаток, не разобранный на пары «число + единица», означает незнакомый
  // формат: лучше отдать null, чем занизить время.
  if (text.replace(pattern, '').trim() !== '') return null

  let seconds = 0
  for (const token of tokens) {
    const amount = Number(token[1]?.replace(',', '.') ?? '')
    const unit = token[2] ?? ''
    if (!Number.isFinite(amount) || amount < 0) return null
    const factor = SECONDS_PER_UNIT.find(([pattern]) => pattern.test(unit))?.[1]
    if (factor === undefined) return null
    seconds += amount * factor
  }
  const rounded = Math.round(seconds)
  return Number.isSafeInteger(rounded) ? rounded : null
}

function sectionKind(section: ProfileStatSection): SectionKind | null {
  const first = section.titles[0]
  if (first === undefined) return null
  return SECTION_KINDS.find(([, pattern]) => pattern.test(first))?.[0] ?? null
}

function categoryOf(kind: Exclude<SectionKind, 'general'>, title: string): string {
  return CATEGORY_PATTERNS[kind].find(([, pattern]) => pattern.test(title))?.[0] ?? 'all'
}

function generalValues(section: ProfileStatSection, mode: ProfileStatMode): GeneralValues {
  const values = section.values[mode]
  const result: GeneralValues = {
    battles: null,
    victories: null,
    deaths: null,
    timePlayed: null,
    airKills: null,
    groundKills: null,
    navalKills: null,
  }
  for (const title of section.titles) {
    const metric = GENERAL_METRICS.find(([, pattern]) => pattern.test(title))?.[0]
    if (metric === undefined) continue
    const raw = values[title] ?? null
    result[metric] = metric === 'timePlayed' ? parseProfilePlayTime(raw) : parseProfileCount(raw)
  }
  return result
}

function emptyBranchCategory(): BranchCategory {
  return { respawns: null, timePlayedSec: null, airKills: null, groundKills: null, navalKills: null }
}

function branchCategories(
  section: ProfileStatSection,
  kind: Exclude<SectionKind, 'general'>,
  mode: ProfileStatMode,
): Map<string, BranchCategory> {
  const values = section.values[mode]
  const categories = new Map<string, BranchCategory>()
  const ensure = (category: string): BranchCategory => {
    const known = categories.get(category)
    if (known !== undefined) return known
    const fresh = emptyBranchCategory()
    categories.set(category, fresh)
    return fresh
  }

  for (const title of section.titles) {
    const raw = values[title] ?? null
    if (KILLS_TITLE.test(title)) {
      // Фраги публикуются только на уровне ветки; «всего уничтожено» — это
      // сумма трёх строк ниже, отдельной колонки для неё нет.
      if (TOTAL_KILLS_TITLE.test(title)) continue
      const branch = ensure('all')
      if (AIR_KILLS_TITLE.test(title)) branch.airKills = parseProfileCount(raw)
      else if (GROUND_KILLS_TITLE.test(title)) branch.groundKills = parseProfileCount(raw)
      else if (NAVAL_KILLS_TITLE.test(title)) branch.navalKills = parseProfileCount(raw)
      continue
    }
    const category = ensure(categoryOf(kind, title))
    if (TIME_TITLE.test(title)) category.timePlayedSec = parseProfilePlayTime(raw)
    else category.respawns = parseProfileCount(raw)
  }
  return categories
}

function sumMetric(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return null
  return known.reduce((sum, value) => sum + value, 0)
}

/**
 * Победы и поражения профиль публикует только суммарно по режиму, поэтому
 * поражения выводятся как дополнение побед до числа законченных миссий: сайт
 * сам считает «victories/battles ratio» именно так.
 */
function defeatsFrom(battles: number | null, victories: number | null): number | null {
  if (battles === null || victories === null) return null
  return battles >= victories ? battles - victories : null
}

function generalTotal(
  values: GeneralValues,
  mode: string | null,
  category: string | null,
): NormalizedPlayerExternalTotal {
  return {
    gameType: null,
    mode,
    category,
    battles: values.battles,
    victories: values.victories,
    defeats: defeatsFrom(values.battles, values.victories),
    deaths: values.deaths,
    timePlayedSec: values.timePlayed,
    respawns: null,
    airKills: values.airKills,
    groundKills: values.groundKills,
    navalKills: values.navalKills,
  }
}

export interface OfficialProfilePayload {
  nick: string
  clan: string | null
  level: number | null
  registrationDate: string | null
  sections: readonly ProfileStatSection[]
}

/**
 * Превращает разобранные строки профиля в строки player_external_totals.
 * Техника (player_external_vehicles) остаётся пустой: публичный профиль
 * War Thunder не публикует статистику по отдельным машинам.
 */
export function normalizeOfficialProfile(payload: OfficialProfilePayload): NormalizedPlayerStats {
  const nick = payload.nick.trim()
  if (nick === '') throw new PlayerStatsSchemaError('профиль: пустой ник')
  if (payload.sections.length === 0) {
    throw new PlayerStatsSchemaError('профиль: на странице нет блоков статистики')
  }

  const totals: NormalizedPlayerExternalTotal[] = []
  const generalByMode = new Map<ProfileStatMode, GeneralValues>()
  let generalSeen = false

  for (const section of payload.sections) {
    const kind = sectionKind(section)
    // Незнакомый блок пропускаем: игра добавляет разделы, и это не повод
    // терять весь snapshot.
    if (kind === null) continue
    for (const mode of Object.keys(MODE_NAMES) as ProfileStatMode[]) {
      if (Object.keys(section.values[mode]).length === 0) continue
      if (kind === 'general') {
        generalSeen = true
        const values = generalValues(section, mode)
        generalByMode.set(mode, values)
        totals.push(generalTotal(values, MODE_NAMES[mode], 'all'))
        continue
      }
      for (const [category, metrics] of branchCategories(section, kind, mode)) {
        totals.push({
          gameType: kind,
          mode: MODE_NAMES[mode],
          category,
          battles: null,
          victories: null,
          defeats: null,
          deaths: null,
          timePlayedSec: metrics.timePlayedSec,
          respawns: metrics.respawns,
          airKills: metrics.airKills,
          groundKills: metrics.groundKills,
          navalKills: metrics.navalKills,
        })
      }
    }
  }

  if (!generalSeen) {
    throw new PlayerStatsSchemaError('профиль: не найден общий блок статистики')
  }

  // Сводная строка по всему аккаунту. Режимы — непересекающиеся части одной
  // выборки одного источника, поэтому их сложение корректно (в отличие от
  // сложения веток техники).
  const modes = [...generalByMode.values()]
  const battles = sumMetric(modes.map((values) => values.battles))
  const victories = sumMetric(modes.map((values) => values.victories))
  totals.unshift({
    gameType: null,
    mode: null,
    category: null,
    battles,
    victories,
    defeats: defeatsFrom(battles, victories),
    deaths: sumMetric(modes.map((values) => values.deaths)),
    timePlayedSec: sumMetric(modes.map((values) => values.timePlayed)),
    respawns: null,
    airKills: sumMetric(modes.map((values) => values.airKills)),
    groundKills: sumMetric(modes.map((values) => values.groundKills)),
    navalKills: sumMetric(modes.map((values) => values.navalKills)),
  })

  return { totals, vehicles: [] }
}
