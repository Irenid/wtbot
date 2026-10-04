import type { Locale } from '../index'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ru } from './ru'
import type { GuideText } from './types'

// Every locale ships inside the lazy guides chunk (37 KB gzip with the pages,
// 2026-10-04): a per-locale import would save ~25 KB but add a second request
// after the chunk and a loading state on every language switch.
const TEXTS: Readonly<Record<Locale, GuideText>> = { ru, en, de, fr, es }

export function guideText(locale: Locale): GuideText {
  return TEXTS[locale]
}

export type { DecideRow, GuideAudience, GuideSlug, GuideText, QuickId, QuickNums } from './types'
