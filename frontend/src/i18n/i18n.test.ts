import { describe, expect, it } from 'vitest'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { pluralTemplate } from './index'
import { ru, type MessageKey } from './ru'

const DICTS = { en, de, fr, es } as const
const placeholders = (text: string): string[] => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort()

describe('catalogs', () => {
  it('every translation keeps the placeholders of the Russian canon', () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict) as [MessageKey, string][]) {
        expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders(ru[key]))
      }
    }
  })

  it('the squadron page is translated in every language', () => {
    const plural = /\.(zero|one|two|few|many|other)$/
    for (const [locale, dict] of Object.entries(DICTS)) {
      const missing = (Object.keys(ru) as MessageKey[])
        .filter((key) => key.startsWith('clan.') && !plural.test(key) && dict[key] === undefined)
      expect(missing, locale).toEqual([])
    }
  })
})

describe('plural forms', () => {
  it("a language's missing form takes its own \"other\", never Russian's", () => {
    // French and Spanish "many" (exact millions) has no entry in the catalogs.
    expect(pluralTemplate(fr, 'common.battles', 'many')).toBe(fr['common.battles.other'])
    expect(pluralTemplate(es, 'common.battles', 'many')).toBe(es['common.battles.other'])
    expect(new Intl.PluralRules('fr').select(1_000_000)).toBe('many')
  })

  it('takes the exact form when there is one, and Russian only for a key the language lacks', () => {
    expect(pluralTemplate(de, 'common.battles', 'one')).toBe(de['common.battles.one'])
    expect(pluralTemplate(ru, 'common.battles', 'few')).toBe(ru['common.battles.few'])
    expect(pluralTemplate({}, 'common.battles', 'few')).toBe(ru['common.battles.few'])
    expect(pluralTemplate({}, 'no.such.key', 'one')).toBeUndefined()
  })
})
