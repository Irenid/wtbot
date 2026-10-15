/**
 * Plural forms by CLDR category (Intl.PluralRules): English needs `one` and
 * `other`, Russian `one`, `few`, `many` and `other` (fractions); a missing
 * category falls back to `other`.
 */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

/** The form of `count` in the language of `intl` (a BCP 47 tag). */
export function pluralizer(intl: string): (count: number, forms: PluralForms) => string {
  const rules = new Intl.PluralRules(intl)
  return (count, forms) => forms[rules.select(count)] ?? forms.other
}
