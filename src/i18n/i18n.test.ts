import assert from 'node:assert/strict'
import test from 'node:test'
import { logVerbFits } from '../wrpl/render-battle-log.js'
import { botText, isLocale, LOCALES } from './index.js'

interface Text {
  path: string
  text: string
}

/** Every plural category of English and Russian: zero, one, few, many. */
const COUNTS = [0, 1, 2, 5, 11, 21] as const

/** Arguments of the functions that take more than numbers and text. */
const SAMPLES: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  ping: [[42], [null]],
  'heatmap.date': [[new Date(Date.UTC(2026, 9, 15, 12, 30))]],
  'scout.images.oneSide': [['WLILY'], [null]],
  'settings.battlesAdded': [['<#1>', 'WLILY'], ['<#1>', null]],
  'settings.battlesExists': [['<#1>', 'WLILY'], ['<#1>', null]],
  'settings.scoutAdded': [['<#1>', true], ['<#1>', false]],
  'settings.voiceAdded': [['<#1>', true, false], ['<#1>', false, true]],
  'settings.voiceRemoved': [['<#1>', true], ['<#1>', false]],
  'settings.statsPlaceName': [[12], [null]],
  'settings.statsMembersName': [[12], [null]],
  'settings.statsBrName': [['11.7'], [null]],
  'settings.statsSet': [['WLILY', '<#1>'], ['WLILY', null]],
  'settings.statsNeedsPermissions': [['View Channel, Manage Channels, Connect']],
  'settings.show.languageValue': [['English', true], ['English', false]],
  'settings.platoonsSet': [['<#1>', 'WLILY', '<#2>']],
  'settings.show.platoonsValue': [['<#1>', 'WLILY', '<#2>']],
  'platoons.title': [[6], [null]],
  'platoons.room': [['Platoon 1', 6]],
  'platoons.newPlatoon': [[null], [2]],
  'platoons.swap': [['**Strong**', '**Weak**']],
  'platoons.tags.guessed': [['Venukbr']],
  'platoons.tags.from': [['<#1>']],
  'platoons.tags.to': [['<#1>'], ['new platoon']],
}

/** Every text of a catalog: strings as they are, functions called with sample arguments. */
function texts(value: unknown, path = '', out: Text[] = []): Text[] {
  if (typeof value === 'string') {
    out.push({ path, text: value })
  } else if (typeof value === 'function') {
    const fn = value as (...args: readonly unknown[]) => unknown
    const calls = SAMPLES[path] ?? COUNTS.map((count) => Array.from({ length: fn.length }, () => count))
    for (const args of calls) {
      const text = fn(...args)
      assert.equal(typeof text, 'string', path)
      out.push({ path, text: text as string })
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) texts(item, path === '' ? key : `${path}.${key}`, out)
  } else {
    assert.fail(`${path} is ${typeof value}`)
  }
  return out
}

test('every catalog text is filled in and has no unformatted value', () => {
  for (const locale of LOCALES) {
    for (const { path, text } of texts(botText(locale))) {
      assert.notEqual(text.trim(), '', `${locale} ${path}`)
      assert.doesNotMatch(text, /undefined|NaN|null|\[object/u, `${locale} ${path}`)
    }
  }
})

test('the English catalog has no Cyrillic', () => {
  for (const { path, text } of texts(botText('en'))) assert.doesNotMatch(text, /\p{Script=Cyrillic}/u, path)
})

test('every catalog keeps Discord\'s and the images\' length limits', () => {
  for (const locale of LOCALES) {
    const t = botText(locale)
    for (const { path, text } of texts(t.commands, 'commands')) assert.ok(text.length <= 100, `${locale} ${path}: ${text.length}`)
    for (const { path, text } of texts(t.battle.buttons, 'battle.buttons')) assert.ok(text.length <= 80, `${locale} ${path}`)
    assert.ok(t.scoreboard.botDriven.length <= 6, `${locale} scoreboard.botDriven`)
    for (const text of Object.values(t.heatmap.causes)) assert.ok(text.length <= 5, `${locale} heatmap.causes: ${text}`)
    for (const text of Object.values(t.heatmap.legend)) assert.ok(text.length <= 20, `${locale} heatmap.legend: ${text}`)
    for (const verb of Object.values(t.battleLog.verbs).flat()) assert.ok(logVerbFits(verb), `${locale} battleLog.verbs: ${verb}`)
  }
})

test('plurals and numbers follow each language\'s rules', () => {
  const en = botText('en')
  const ru = botText('ru')
  assert.equal(en.heatmap.teamSummary(1, 2, 1), '1 player · 2 kills · 1 survived')
  assert.equal(ru.heatmap.teamSummary(21, 2, 5), '21 игрок · 2 фрага · 5 выжили')
  assert.equal(ru.heatmap.teamSummary(11, 1, 1), '11 игроков · 1 фраг · 1 выжил')
  assert.equal(en.number(1234567.4), '1,234,567')
  assert.match(ru.number(1234567.4), /^1\s234\s567$/u)
})

test('each catalog names its language in that language, once', () => {
  const names = LOCALES.map((locale) => botText(locale).languageName)
  assert.equal(new Set(names).size, LOCALES.length)
  assert.equal(botText('ru').languageName, 'Русский')
})

test('WT_BOT_LOCALE accepts only a catalog\'s own key', () => {
  for (const locale of LOCALES) assert.ok(isLocale(locale), locale)
  for (const value of ['', 'EN', 'en-GB', 'xx', 'toString', '__proto__']) assert.equal(isLocale(value), false, value)
})
