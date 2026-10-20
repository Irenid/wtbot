// Light localization without dependencies: dictionary modules, the Russian fallback,
// plurals by Intl.PluralRules, the chosen language in localStorage.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ru, type MessageKey } from './ru'
import { en } from './en'
import { de } from './de'
import { fr } from './fr'
import { es } from './es'

export type Locale = 'ru' | 'en' | 'de' | 'fr' | 'es'

export const LOCALES: readonly { value: Locale; label: string }[] = [
  { value: 'ru', label: 'RU' },
  { value: 'en', label: 'EN' },
  { value: 'de', label: 'DE' },
  { value: 'fr', label: 'FR' },
  { value: 'es', label: 'ES' },
]

/** A dictionary may be incomplete: a missing key falls back to the Russian canon. */
const DICTS: Record<Locale, Partial<Record<MessageKey, string>>> = { ru, en, de, fr, es }

const STORAGE_KEY = 'wtbot-locale'

function detectLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && LOCALES.some((entry) => entry.value === saved)) return saved as Locale
  } catch { /* private mode */ }
  const nav = (navigator.language || 'ru').slice(0, 2).toLowerCase()
  return LOCALES.some((entry) => entry.value === nav) ? (nav as Locale) : 'en'
}

// Module state follows the provider: the pure formatting functions
// (format.ts) read the locale without the React context.
let currentLocale: Locale = 'ru'

/** The current locale for Intl formatting of numbers and dates. */
export function localeTag(): string {
  return currentLocale === 'ru' ? 'ru-RU' : currentLocale
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** The translation of a key with {x} substitutions; an unknown language or key gives Russian. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTS[currentLocale][key] ?? ru[key]
  return interpolate(template, params)
}

/**
 * A plural form: base + the CLDR category (one/few/many/other), falling back
 * to other (pluralTemplate). {n} is substituted automatically.
 */
export function tp(base: string, n: number, params?: Record<string, string | number>): string {
  const category = new Intl.PluralRules(localeTag()).select(n)
  return interpolate(pluralTemplate(DICTS[currentLocale], base, category) ?? base, { n: n.toLocaleString(localeTag()), ...params })
}

/**
 * A plural form's template: the language's own form, else its "other" (French
 * and Spanish "many" of exact millions has no entry), and only then the
 * Russian canon's.
 */
export function pluralTemplate(dict: Partial<Record<MessageKey, string>>, base: string, category: string): string | undefined {
  return dict[`${base}.${category}` as MessageKey]
    ?? dict[`${base}.other` as MessageKey]
    ?? ru[`${base}.${category}` as MessageKey]
    ?? ru[`${base}.other` as MessageKey]
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue>({ locale: 'ru', setLocale: () => undefined })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const detected = detectLocale()
    currentLocale = detected
    return detected
  })
  // The document language and the tab title follow the interface, the first render included,
  // when the language comes from localStorage or navigator, not from index.html.
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }, [locale])
  const setLocale = useCallback((next: Locale) => {
    currentLocale = next
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* private mode */ }
    setLocaleState(next)
  }, [])
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLocale(): I18nContextValue {
  return useContext(I18nContext)
}
