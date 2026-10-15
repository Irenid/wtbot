/**
 * The bot's languages. A new language is one catalog file implementing
 * BotText (copy en.ts, translate every value) plus its entry in CATALOGS,
 * keyed by its lowercase language code: servers then choose it with
 * /language, and users whose Discord language it is get it in what only they
 * see (src/bot/locale.ts). English is canonical: add a text there first.
 */
import { en } from './en.js'
import { ru } from './ru.js'
import type { BotText } from './types.js'

export type { BotText, PlayerFetchError, SpawnDirection } from './types.js'

const CATALOGS = { en, ru } as const satisfies Record<string, BotText>

export type Locale = keyof typeof CATALOGS
export const LOCALES = Object.keys(CATALOGS) as Locale[]
export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(CATALOGS, value)
}

/** The texts of `locale`; the default language without one (tests, CLIs). */
export function botText(locale: Locale = DEFAULT_LOCALE): BotText {
  return CATALOGS[locale]
}
