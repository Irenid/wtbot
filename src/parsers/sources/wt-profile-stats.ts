import { load, type Cheerio, type CheerioAPI } from 'cheerio'
import type { Element } from 'domhandler'

/**
 * Разбор блоков статистики со страницы профиля warthunder.com.
 *
 * Страница отдаёт четыре независимые строки статистики (общая, авиация,
 * наземная техника, флот), и каждая строка содержит один список заголовков и
 * по одному списку значений на режим. Существующий парсер wt-players берёт
 * только первую строку; здесь сохраняются все, потому что именно они дают
 * разбивку по game_type и категориям техники.
 *
 * Модуль намеренно ничего не нормализует: значения остаются такими же
 * строками, как на странице, чтобы их можно было сохранить в raw snapshot и
 * позже переразобрать другой версией нормализатора.
 */

export const PROFILE_STAT_MODES = ['arcade', 'realistic', 'simulation'] as const
export type ProfileStatMode = (typeof PROFILE_STAT_MODES)[number]

/** Классы вкладок режимов; realisticFightTab оставлен на случай переименования. */
const MODE_SELECTORS: Record<ProfileStatMode, string> = {
  arcade: 'ul.user-stat__list.arcadeFightTab',
  realistic: 'ul.user-stat__list.historyFightTab, ul.user-stat__list.realisticFightTab',
  simulation: 'ul.user-stat__list.simulationFightTab',
}

const MAX_SECTIONS = 12
const MAX_ROWS_PER_SECTION = 64

export class ProfileStatsLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileStatsLayoutError'
  }
}

export interface ProfileStatSection {
  /** Заголовки строки в порядке страницы; они же ключи values. */
  titles: string[]
  /** Режим → заголовок → значение как на странице; null для «N/A» и пустых ячеек. */
  values: Record<ProfileStatMode, Record<string, string | null>>
}

/** Пустое значение и явные «нет данных» дают null, а не 0 и не пустую строку. */
export function cleanStatText(value: string): string | null {
  const text = value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
  if (text === '' || /^(?:n\/a|not available|—|–|-)$/i.test(text)) return null
  return text
}

/**
 * Не используем cheerio .map().get(): он выбрасывает null из результата, и
 * ячейка «N/A» тогда молча сдвигает все последующие значения на один заголовок.
 */
function listItems($: CheerioAPI, list: Cheerio<Element>): Array<string | null> {
  return list.children('li').toArray().map((element) => cleanStatText($(element).text()))
}

function sectionTitles($: CheerioAPI, row: Cheerio<Element>, index: number): string[] {
  const list = row.find('ul.user-stat__list--titles').first()
  if (list.length === 0) {
    throw new ProfileStatsLayoutError(`статистика профиля: в строке ${index + 1} нет списка заголовков`)
  }
  const titles = listItems($, list)
  if (titles.length === 0) {
    throw new ProfileStatsLayoutError(`статистика профиля: строка ${index + 1} без заголовков`)
  }
  if (titles.length > MAX_ROWS_PER_SECTION) {
    throw new ProfileStatsLayoutError(
      `статистика профиля: строка ${index + 1} содержит больше ${MAX_ROWS_PER_SECTION} заголовков`,
    )
  }
  const resolved: string[] = []
  const seen = new Set<string>()
  for (let position = 0; position < titles.length; position += 1) {
    const title = titles[position] ?? null
    if (title === null) {
      throw new ProfileStatsLayoutError(
        `статистика профиля: пустой заголовок ${position + 1} в строке ${index + 1}`,
      )
    }
    // Повтор заголовка внутри одной строки означает смену вёрстки: молча
    // схлопнув такие ключи, мы бы записали в БД чужое значение.
    if (seen.has(title)) {
      throw new ProfileStatsLayoutError(
        `статистика профиля: заголовок «${title}» повторяется в строке ${index + 1}`,
      )
    }
    seen.add(title)
    resolved.push(title)
  }
  return resolved
}

function sectionValues(
  $: CheerioAPI,
  row: Cheerio<Element>,
  titles: string[],
  index: number,
): ProfileStatSection['values'] {
  const values = {} as ProfileStatSection['values']
  for (const mode of PROFILE_STAT_MODES) {
    const list = row.find(MODE_SELECTORS[mode]).first()
    const entries: Record<string, string | null> = {}
    if (list.length > 0) {
      const cells = listItems($, list)
      if (cells.length !== titles.length) {
        throw new ProfileStatsLayoutError(
          `статистика профиля: в строке ${index + 1} режим ${mode} даёт ${cells.length} значений при ${titles.length} заголовках`,
        )
      }
      titles.forEach((title, position) => {
        entries[title] = cells[position] ?? null
      })
    }
    values[mode] = entries
  }
  return values
}

/**
 * Возвращает все строки статистики профиля в порядке страницы.
 * Пустой массив означает, что блока статистики на странице нет.
 */
export function parseProfileStatSections(html: string): ProfileStatSection[] {
  const $ = load(html)
  const rows = $('.user-profile__stat.user-stat .user-stat__list-row')
  if (rows.length > MAX_SECTIONS) {
    throw new ProfileStatsLayoutError(
      `статистика профиля: найдено ${rows.length} строк статистики при лимите ${MAX_SECTIONS}`,
    )
  }
  const sections: ProfileStatSection[] = []
  rows.each((index, element) => {
    const row = $(element)
    const titles = sectionTitles($, row, index)
    sections.push({ titles, values: sectionValues($, row, titles, index) })
  })
  return sections
}
