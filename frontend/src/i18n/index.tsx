// Лёгкая локализация без зависимостей: словари-модули, фолбэк на русский,
// плюрализация через Intl.PluralRules, выбор языка в localStorage.
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

/** Неполный словарь допустим: отсутствующий ключ падает на русский канон. */
const DICTS: Record<Locale, Partial<Record<MessageKey, string>>> = { ru, en, de, fr, es }

const STORAGE_KEY = 'wtbot-locale'

function detectLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && LOCALES.some((entry) => entry.value === saved)) return saved as Locale
  } catch { /* приватный режим */ }
  const nav = (navigator.language || 'ru').slice(0, 2).toLowerCase()
  return LOCALES.some((entry) => entry.value === nav) ? (nav as Locale) : 'en'
}

// Модульное состояние синхронизировано с провайдером: чистые функции
// форматирования (format.ts) читают локаль без обращения к React-контексту.
let currentLocale: Locale = 'ru'

/** Текущая локаль для Intl-форматирования чисел и дат. */
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

/** Перевод по ключу с подстановками {x}; неизвестный язык/ключ → русский. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTS[currentLocale][key] ?? ru[key]
  return interpolate(template, params)
}

/**
 * Множественная форма: base + категория CLDR (one/few/many/other) c фолбэком
 * на other. Значение {n} подставляется автоматически.
 */
export function tp(base: string, n: number, params?: Record<string, string | number>): string {
  const category = new Intl.PluralRules(localeTag()).select(n)
  const exact = DICTS[currentLocale][`${base}.${category}` as MessageKey]
    ?? ru[`${base}.${category}` as MessageKey]
  const fallback = DICTS[currentLocale][`${base}.other` as MessageKey]
    ?? ru[`${base}.other` as MessageKey]
  return interpolate(exact ?? fallback ?? base, { n: n.toLocaleString(localeTag()), ...params })
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
  // Язык документа и заголовок вкладки идут за интерфейсом — включая первый рендер,
  // когда язык взят из localStorage или из navigator, а не из разметки index.html.
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }, [locale])
  const setLocale = useCallback((next: Locale) => {
    currentLocale = next
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* приватный режим */ }
    setLocaleState(next)
  }, [])
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLocale(): I18nContextValue {
  return useContext(I18nContext)
}
