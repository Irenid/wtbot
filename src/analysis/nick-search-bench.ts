// Quality of the player search matcher (src/nick-search.ts) on a copy of the
// database: for every stored nick family, queries a person would type are
// simulated from real nicks (typos, look-alikes, leet, transliteration by
// several schemes, Cyrillic by ear, the wrong layout) and the rank of the
// intended nick is measured. A seeded generator makes runs comparable; the
// volapuk pairs are read by hand. Results: docs/nick-search.md.
// Run: npm run bench:nick-search -- <copy.db> [--seed N] [--cases N] [--misses]
// Read-only; never point it at the live data/wtbot.db while the bot writes it.
import { DatabaseSync } from 'node:sqlite'
import { NickIndex, prepareNickQuery } from '../nick-search.js'

const args = process.argv.slice(2)
const dbPath = args.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg))
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(name)
  return index >= 0 ? Number(args[index + 1]) : fallback
}
if (!dbPath) {
  console.error('Usage: npm run bench:nick-search -- <copy.db> [--seed N] [--cases N] [--misses]')
  process.exit(1)
}
const casesPerFamily = option('--cases', 600)
const showMisses = args.includes('--misses')

interface Row {
  key: string
  nick: string
  battles: number
}

const database = new DatabaseSync(dbPath, { readOnly: true })
const rows = database.prepare(`
  SELECT nick_search AS key, MAX(nick) AS nick, COUNT(*) AS battles
  FROM battle_players WHERE user_id <> '' AND nick_search NOT GLOB 'coop/bot*'
  GROUP BY nick_search
`).all() as unknown as Row[]
database.close()
const buildStarted = performance.now()
const index = new NickIndex(rows.map((row) => ({ key: row.key, battles: row.battles })))
const buildMs = performance.now() - buildStarted
const byKey = new Map(rows.map((row) => [row.key, row]))

// xorshift32: the same cases for the same seed.
let state = option('--seed', 1) >>> 0 || 1
const random = (): number => {
  state ^= state << 13
  state >>>= 0
  state ^= state >>> 17
  state ^= state << 5
  state >>>= 0
  return state / 2 ** 32
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
function weighted(options: readonly (readonly [string, number])[]): string {
  let roll = random() * options.reduce((sum, [, weight]) => sum + weight, 0)
  for (const [value, weight] of options) {
    roll -= weight
    if (roll <= 0) return value
  }
  return options[options.length - 1]![0]
}

const plainNick = (nick: string): string =>
  nick.replace(/@\w+$/u, '').normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase()
/** Half the people type the separators. */
const maybeJoined = (text: string): string => (random() < 0.5 ? text.replace(/[^\p{L}\p{N}]+/gu, '') : text)

// Keys around each key (staggered rows) in both layouts: where a finger slips.
const QWERTY = "`qwertyuiop[]asdfghjkl;'zxcvbnm,."
const JCUKEN = 'ёйцукенгшщзхъфывапролджэячсмитьбю'
const toCyrillic = new Map([...QWERTY].map((char, i) => [char, JCUKEN[i]!]))
const toLatin = new Map([...JCUKEN].map((char, i) => [char, QWERTY[i]!]))
const near = new Map<string, string[]>()
const KEY_ROWS = ['1234567890', 'qwertyuiop[]', "asdfghjkl;'", 'zxcvbnm,.']
KEY_ROWS.forEach((row, r) => [...row].forEach((key, c) => {
  const around = [[r, c - 1], [r, c + 1], [r - 1, c], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c]]
    .map(([rr, cc]) => KEY_ROWS[rr!]?.[cc!])
    .filter((other): other is string => other !== undefined)
  near.set(key, around.filter((other) => /[a-z0-9]/.test(other)))
  const cyrillic = toCyrillic.get(key)
  if (cyrillic) near.set(cyrillic, around.map((other) => toCyrillic.get(other) ?? other))
}))

/** One typing slip: a neighbouring key 45%, a dropped key 25%, an extra one 15%, a swap 15%; rarely the first letter. */
function typo(text: string): string {
  const chars = [...text]
  const positions = chars.flatMap((char, i) => (/[\p{L}\p{N}]/u.test(char) ? [i] : []))
  if (positions.length < 2) return text
  const i = random() < 0.05 ? positions[0]! : pick(positions.slice(1))
  const around = near.get(chars[i]!) ?? []
  const kind = weighted([['near', 45], ['drop', 25], ['extra', 15], ['swap', 15]])
  if (kind === 'near' && around.length > 0) chars[i] = pick(around)
  else if (kind === 'drop') chars.splice(i, 1)
  else if (kind === 'extra') chars.splice(i, 0, around.length > 0 && random() < 0.6 ? pick(around) : chars[i]!)
  else if (i + 1 < chars.length) [chars[i], chars[i + 1]] = [chars[i + 1]!, chars[i]!]
  else chars.splice(i, 1)
  return chars.join('')
}

const switchLayout = (text: string): string => [...text].map((char) => toLatin.get(char) ?? toCyrillic.get(char) ?? char).join('')

// How a viewer reads a mixed nick: all of it as Latin letters, or as Russian.
const AS_LATIN: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i',
  α: 'a', ο: 'o', ρ: 'p', ν: 'v', τ: 't', υ: 'u', ε: 'e', λ: 'a', σ: 'e', ξ: 'e', δ: 'a', μ: 'm', η: 'n', ι: 'i', κ: 'k', χ: 'x',
}
const AS_RUSSIAN: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', r: 'г', n: 'п',
}
const asLatin = (text: string): string => [...text].map((char) => AS_LATIN[char] ?? char).join('')
const asRussian = (text: string): string => [...text].map((char) => AS_RUSSIAN[char] ?? char).join('')

/** The letters a nick's lone digits stand for, as typed by someone who does not remember the digits. */
function deLeet(text: string): string {
  const chars = [...text]
  return chars.map((char, i) => {
    if (!/\d/.test(char)) return char
    const before = chars[i - 1] ?? ''
    const after = chars[i + 1] ?? ''
    if (/\d/.test(before) || /\d/.test(after) || !(/\p{L}/u.test(before) || /\p{L}/u.test(after))) return char
    const cyrillic = /\p{Script=Cyrillic}/u.test(before + after)
    const letters: Record<string, string> = {
      '0': cyrillic ? 'о' : 'o', '1': pick(['i', 'l']), '2': 'z', '3': cyrillic ? 'з' : 'e', '4': cyrillic ? 'ч' : pick(['a', 'a', 'ch']),
      '5': 's', '6': cyrillic ? 'б' : 'b', '7': 't', '8': cyrillic ? 'в' : 'b', '9': 'g',
    }
    return letters[char] ?? char
  }).join('')
}

// Russian in Latin letters, each letter by one of the schemes people use (GOST, ICAO, gamer).
const TRANSLIT: Record<string, readonly (readonly [string, number])[]> = {
  а: [['a', 1]], б: [['b', 1]], в: [['v', 9], ['w', 1]], г: [['g', 1]], д: [['d', 1]], е: [['e', 1]],
  ж: [['zh', 50], ['j', 35], ['g', 10], ['x', 5]], з: [['z', 1]], и: [['i', 9], ['y', 1]], й: [['y', 5], ['j', 3], ['i', 2]],
  к: [['k', 1]], л: [['l', 1]], м: [['m', 1]], н: [['n', 1]], о: [['o', 1]], п: [['p', 1]], р: [['r', 1]],
  с: [['s', 85], ['c', 15]], т: [['t', 1]], у: [['u', 8], ['y', 2]], ф: [['f', 9], ['ph', 1]], х: [['h', 50], ['kh', 25], ['x', 25]],
  ц: [['c', 40], ['ts', 45], ['tz', 15]], ч: [['ch', 80], ['4', 15], ['tch', 5]], ш: [['sh', 9], ['w', 1]],
  щ: [['sch', 40], ['shch', 30], ['sh', 30]], ъ: [['', 1]], ы: [['y', 6], ['i', 4]], ь: [['', 1]], э: [['e', 1]],
  ю: [['yu', 50], ['ju', 25], ['iu', 15], ['u', 10]], я: [['ya', 55], ['ja', 25], ['ia', 15], ['a', 5]],
  ё: [['yo', 4], ['jo', 2], ['e', 4]], і: [['i', 1]], ї: [['i', 1]], є: [['e', 1]],
}
const translit = (nick: string): string =>
  [...nick.replace(/@\w+$/u, '').toLowerCase()].map((char) => (TRANSLIT[char] ? weighted(TRANSLIT[char]) : char)).join('')

// A Latin nick spelt in Cyrillic by ear.
const BY_EAR_PAIRS: Record<string, readonly (readonly [string, number])[]> = {
  sh: [['ш', 1]], ch: [['ч', 1]], zh: [['ж', 1]], th: [['т', 6], ['з', 2], ['с', 2]], ph: [['ф', 1]], kh: [['х', 1]],
  ts: [['ц', 5], ['тс', 5]], ck: [['к', 1]], oo: [['у', 1]], ee: [['и', 1]], ea: [['и', 6], ['еа', 4]],
  ya: [['я', 1]], yu: [['ю', 1]], yo: [['ё', 3], ['йо', 7]], ye: [['е', 5], ['йе', 5]],
}
function byEar(text: string): string {
  const s = text.toLowerCase()
  let out = ''
  for (let i = 0; i < s.length;) {
    const pair = BY_EAR_PAIRS[s.slice(i, i + 2)]
    if (pair) {
      out += weighted(pair)
      i += 2
      continue
    }
    const char = s[i]!
    const next = s[i + 1] ?? ''
    if (char === next && /[a-z]/.test(char) && random() < 0.6) {
      i += 1
      continue
    }
    const soft = /[eiy]/.test(next)
    const single: Record<string, readonly (readonly [string, number])[]> = {
      a: [['а', 1]], b: [['б', 1]], c: soft ? [['с', 1]] : [['к', 1]], d: [['д', 1]], e: i === 0 ? [['э', 5], ['е', 5]] : [['е', 1]],
      f: [['ф', 1]], g: soft ? [['дж', 3], ['г', 7]] : [['г', 1]], h: [['х', 1]], i: [['и', 1]], j: [['дж', 6], ['й', 2], ['ж', 2]],
      k: [['к', 1]], l: [['л', 1]], m: [['м', 1]], n: [['н', 1]], o: [['о', 1]], p: [['п', 1]], q: [['к', 1]], r: [['р', 1]],
      s: [['с', 1]], t: [['т', 1]], u: [['у', 7], ['а', 2], ['ю', 1]], v: [['в', 1]], w: [['в', 8], ['у', 2]], x: [['кс', 7], ['х', 3]],
      y: /[aeiou]/.test(next) ? [['й', 1]] : [['и', 5], ['й', 5]], z: [['з', 1]],
    }
    const options = single[char]
    out += options ? weighted(options) : char
    i += 1
  }
  return out
}

// Volapuk nicks of the database (Russian drawn with Latin letters and digits) and their reading.
const VOLAPUK: readonly (readonly [string, string])[] = [
  ['akyjia_n3_nken', 'акула'], ['padukyjiutka', 'радикулитка'], ['4ert_ha_cb9i3u', 'черт на связи'],
  ['koctojiom_kz', 'костолом'], ['ahajibhbiu_cna3m', 'анальный спазм'], ['xapjlu_qween', 'харли'],
  ['jiux0padka', 'лихорадка'], ['_6jioxodab_', 'блоходав'], ['__3jiodey__', 'злодей'], ['__xуjiugаh__', 'хулиган'],
  ['_beji3ebyji_', 'вельзевул'], ['_kh9i3b_butobt_', 'князь витовт'], ['_tiujiopama_', 'пилорама'],
  ['ahajiьhblu_kot', 'анальный кот'], ['ahgeji_b_kedax', 'ангел в кедах'], ['aiiostoji1985top', 'апостол'],
  ['bblmblceji', 'вымысел'], ['bez_cmbicjia', 'без смысла'], ['caxaphbiu', 'сахарный'], ['6ajltuka', 'балтика'],
  ['apmatyp_6atbip', 'арматур батыр'], ['am0pajiьhblu_kot', 'аморальный кот'], ['_majiellika_ttv_', 'малешка'],
  ['taptblga', 'тартыга'], ['аpaxuc', 'арахис'], ['taнгаж', 'тангаж'], ['шaх', 'шах'], ['bojlshebnik', 'волшебник'],
  ['__хyjiugaн__', 'хулиган'], ['zоroaster', 'зороастр'], ['ветерок', 'veterok'], ['шурупавёрт', 'shurupavert'],
]

const script = (row: Row): { latin: boolean; cyrillic: boolean; cjk: boolean } => ({
  latin: /\p{Script=Latin}/u.test(row.nick),
  cyrillic: /\p{Script=Cyrillic}/u.test(row.nick),
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(row.nick),
})
const latinOnly = rows.filter((row) => { const s = script(row); return s.latin && !s.cyrillic && !s.cjk })
const cyrillicOnly = rows.filter((row) => { const s = script(row); return s.cyrillic && !s.latin })
const mixed = rows.filter((row) => /\p{Script=Latin}/u.test(row.nick) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(row.nick))
const leet = rows.filter((row) => /\p{L}\d\p{L}|\p{L}\d(?!\d)|(?<!\d)\d\p{L}/u.test(row.nick.replace(/@\w+$/u, '')))
const plainLatin = latinOnly.filter((row) => /^[a-z _-]{4,14}$/.test(plainNick(row.nick)))

interface Case {
  query: string
  target: string
}
const draw = (pool: readonly Row[], make: (row: Row) => string): Case[] =>
  Array.from({ length: casesPerFamily }, () => {
    const row = pick(pool)
    return { query: make(row), target: row.key }
  })
const asSeen = (row: Row): string => maybeJoined(random() < 0.5 ? asLatin(plainNick(row.nick)) : asRussian(plainNick(row.nick)))

const families: Record<string, () => Case[]> = {
  exact: () => draw(rows, (row) => row.nick),
  typo: () => draw(latinOnly, (row) => typo(maybeJoined(plainNick(row.nick)))),
  typoCyrillic: () => draw(cyrillicOnly, (row) => typo(maybeJoined(plainNick(row.nick)))),
  lookAlike: () => draw(mixed, asSeen),
  lookAlikeTypo: () => draw(mixed, (row) => typo(asSeen(row))),
  leet: () => draw(leet, (row) => maybeJoined(deLeet(plainNick(row.nick)))),
  leetTypo: () => draw(leet, (row) => typo(maybeJoined(deLeet(plainNick(row.nick))))),
  translit: () => draw(cyrillicOnly, (row) => maybeJoined(translit(row.nick))),
  byEar: () => draw(plainLatin, (row) => byEar(maybeJoined(plainNick(row.nick)))),
  layoutTypo: () => draw(cyrillicOnly, (row) => switchLayout(typo(maybeJoined(plainNick(row.nick))))),
  volapuk: () => VOLAPUK.filter(([key]) => byKey.has(key)).map(([key, reading]) => ({ query: reading, target: key })),
}

console.log(`${rows.length} nick keys · index built in ${buildMs.toFixed(0)} ms · seed ${option('--seed', 1)}`)
console.log('family          cases   first  top 5  top 20  results  ms/query')
const misses: string[] = []
for (const [name, make] of Object.entries(families)) {
  const cases = make().filter((item) => item.query.trim().length >= 2 && item.query.trim().length <= 64)
  let first = 0
  let top5 = 0
  let top20 = 0
  let results = 0
  let ms = 0
  for (const item of cases) {
    const query = prepareNickQuery(item.query)
    const started = performance.now()
    const hits = index.find(query, 20)
    ms += performance.now() - started
    results += hits.length
    const rank = hits.findIndex((hit) => hit.key === item.target)
    if (rank === 0) first += 1
    if (rank >= 0 && rank < 5) top5 += 1
    if (rank >= 0) top20 += 1
    if (showMisses && rank !== 0) {
      const shown = hits.slice(0, 3).map((hit) => byKey.get(hit.key)?.nick ?? hit.key).join(', ')
      misses.push(`${name} rank ${rank}: ${item.query} -> ${byKey.get(item.target)?.nick} | first: ${shown}`)
    }
  }
  const share = (count: number): string => `${((100 * count) / cases.length).toFixed(1)}%`.padStart(7)
  console.log(`${name.padEnd(14)} ${String(cases.length).padStart(6)} ${share(first)}${share(top5)} ${share(top20)} ${(results / cases.length).toFixed(1).padStart(8)} ${(ms / cases.length).toFixed(2).padStart(9)}`)
}
if (showMisses) console.log(misses.join('\n'))
