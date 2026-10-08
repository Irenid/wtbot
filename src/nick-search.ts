/**
 * Typo-tolerant nick search: the site's player search (searchSitePlayers with
 * the worker task search-player-nicks) and the /scout player autocomplete.
 *
 * A query and a nick are compared in three views, the best one counting:
 * - look: as written in Latin letters. Cyrillic and Greek look-alikes become
 *   Latin ("Zоroaster", the most active nick of 2026-10-08, holds a Cyrillic
 *   о); a letter typed for a nick's lone digit costs a quarter edit ("vadim"
 *   for "Vad1m").
 * - read: as a Russian reads it. Latin look-alikes and volapuk digraphs become
 *   Cyrillic ("AKYJIA" is "акула", "4ert_Ha_CB9I3u" is "чертнасвязи").
 * - sound: transliterated with spelling variants merged (zh/j, kh/h, ya/ja,
 *   ts/c): "veterok" finds "Ветерок", "зороастр" finds "Zоroaster".
 * A query typed in the other keyboard layout is matched in the look view.
 * Accents, separators and the "@psn" suffix go in every view. A nick matches
 * whole, by its start or inside it within maxEdits(query length) edits; a
 * match in another view or layout, or a fuzzy one inside a nick, ranks about
 * an edit lower. The weights are fitted on the stored nicks: docs/nick-search.md.
 */

/** The nick_search key of the database: NFKC, locale-neutral lower case, never COLLATE NOCASE. */
export function normalizePlayerSearchKey(nick: string): string {
  return nick.normalize('NFKC').toLocaleLowerCase('und')
}

/** One edit; look-alikes cost a fraction of it. */
const Q = 4
/** A letter doubled on one side ("Killler"). */
const DOUBLED = 2
/** Added to a fuzzy match inside a nick: a whole nick or its start an edit away ranks before it. */
const INSIDE = 3

/** Edits a query of `length` view characters may differ by: none below 4, 1 up to 7, then 2. */
export function maxEdits(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2
}

/** Edits a match inside a nick may have: inside a longer nick a short query finds too much. */
export function maxInfixEdits(length: number): number {
  return length < 6 ? 0 : length < 12 ? 1 : 2
}

/** Cost limit: the edits plus one look-alike, from 3 characters. */
const costLimit = (edits: number, length: number): number => (length < 3 ? 0 : Q * edits + 1)

/** Lower case, no accents (ё is е, й is и) and no "@psn"; NFC joins Hangul jamo back into syllables. */
function plain(text: string): string {
  return text
    .trim()
    .replace(/@\w+$/u, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLocaleLowerCase('und')
}

const isLetterOrDigit = (char: string): boolean => /[\p{L}\p{N}]/u.test(char)
const isCyrillic = (char: string): boolean => char >= 'Ѐ' && char <= 'ӿ'

// ---------- look: Latin look-alikes ----------

/** Letters drawn like a Latin one in some case (keys are lower case: Σ is σ, read as E). */
const LOOK: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', һ: 'h', ү: 'y', ҳ: 'x',
  α: 'a', β: 'b', γ: 'y', δ: 'a', ε: 'e', ζ: 'z', η: 'n', θ: 'o', ι: 'i', κ: 'k', λ: 'a', μ: 'm', ν: 'v',
  ξ: 'e', ο: 'o', π: 'n', ρ: 'p', σ: 'e', ς: 's', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  ø: 'o', ł: 'l', đ: 'd', ħ: 'h', ŧ: 't', ı: 'i', ŀ: 'l', ð: 'd', þ: 'p', ƒ: 'f', ɑ: 'a', ɡ: 'g',
}

function lookOf(text: string): string {
  let out = ''
  for (const char of text) {
    const look = LOOK[char] ?? char
    if (isLetterOrDigit(look)) out += look
  }
  return out
}

// ---------- read: as Russian ----------

/** Volapuk: Latin letters and digits drawing a Cyrillic letter, in this order ("aiiostoji" is "апостол"). */
const READ_DIGRAPHS: [RegExp, string][] = [
  [/[il1|]{3}/gu, 'ш'],
  [/j[il1|]/gu, 'л'],
  [/[bь][il1|]/gu, 'ы'],
  [/ii/gu, 'п'],
  [/i[o0]/gu, 'ю'],
  [/9[il1|]/gu, 'я'],
]

/** A Latin letter or digit as a Russian reads it: by look where one is alike (n is п, u is и), else by sound. */
const READ: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'н', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м',
  n: 'п', o: 'о', p: 'р', q: 'к', r: 'р', s: 'с', t: 'т', u: 'и', v: 'в', w: 'ш', x: 'х', y: 'у', z: 'з',
  '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '8': 'в', ъ: 'ь',
}

/** Cyrillic stays; Greek and stroked letters read through their Latin look. */
function readOf(text: string): string {
  let out = ''
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    let read = ''
    for (const char of word) read += isCyrillic(char) ? char : LOOK[char] ?? char
    for (const [pattern, letter] of READ_DIGRAPHS) read = read.replace(pattern, letter)
    for (const char of read) out += READ[char] ?? char
  }
  return out
}

// ---------- sound: Latin by sound ----------

const SOUND: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', є: 'ye', ґ: 'g', ў: 'u',
  '0': 'o', '3': 'z', '4': 'ch', '6': 'b',
}

/** Spellings of one sound, applied to both sides in order: GOST, ICAO, gamer and English spellings meet. */
const SOUND_RULES: [RegExp, string][] = [
  [/shch|sch/gu, 'sh'],
  [/tch/gu, 'ch'],
  [/zh/gu, 'j'],
  [/kh/gu, 'h'],
  [/x/gu, 'ks'],
  [/ts|tz/gu, 'c'],
  [/ph/gu, 'f'],
  [/th/gu, 't'],
  [/gh/gu, 'g'],
  [/ck|q/gu, 'k'],
  [/wh|w/gu, 'v'],
  [/ee/gu, 'i'],
  [/oo/gu, 'u'],
  [/y(?=[aeiou])/gu, 'j'],
  [/y/gu, 'i'],
  [/(\p{L})\1+/gu, '$1'],
]

function soundOf(text: string): string {
  let out = ''
  for (const char of text) {
    const sound = SOUND[char] ?? LOOK[char] ?? char
    if (sound === '' || isLetterOrDigit(sound)) out += sound
  }
  for (const [pattern, replacement] of SOUND_RULES) out = out.replace(pattern, replacement)
  return out
}

/** The look view of a text: see the module comment. */
export const foldNick = (text: string): string => lookOf(plain(text))
/** The read view of a text: see the module comment. */
export const foldRead = (text: string): string => readOf(plain(text))
/** The sound view of a text: see the module comment. */
export const foldSound = (text: string): string => soundOf(plain(text))

// ---------- keyboard layout ----------

const QWERTY = "`qwertyuiop[]asdfghjkl;'zxcvbnm,."
const JCUKEN = 'ёйцукенгшщзхъфывапролджэячсмитьбю'
const TO_CYRILLIC = new Map([...QWERTY].map((char, index) => [char, JCUKEN[index]!]))
const TO_LATIN = new Map([...JCUKEN].map((char, index) => [char, QWERTY[index]!]))

/** The keys of `literal` (lower case) in the other layout; null — it holds Latin and Cyrillic letters, or neither. */
export function switchLayout(literal: string): string | null {
  const latin = /[a-z]/.test(literal)
  if (latin === /[а-яё]/.test(literal)) return null
  const map = latin ? TO_CYRILLIC : TO_LATIN
  let out = ''
  for (const char of literal) out += map.get(char) ?? char
  return out
}

// ---------- costs ----------

const LOOK_VIEW = 0
const READ_VIEW = 1
const SOUND_VIEW = 2

interface ViewModel {
  fold: (plainText: string) => string
  /** Substitutions cheaper than Q, both ways. */
  pairs: readonly (readonly [string, string, number])[]
  /** Insertions and deletions cheaper than Q (a doubled letter costs DOUBLED in every view). */
  gaps: Readonly<Record<string, number>>
}

const VIEWS: readonly ViewModel[] = [
  {
    fold: lookOf,
    pairs: [
      // A letter typed for a nick's lone digit (leet; see leetSlot); a digit typed for a letter is an edit.
      ['o', '0', 1], ['i', '1', 1], ['l', '1', 1], ['e', '3', 1], ['a', '4', 1], ['s', '5', 1], ['t', '7', 1],
      ['b', '8', 1], ['b', '6', 1], ['g', '9', 1], ['z', '2', 1], ['з', '3', 1], ['ч', '4', 1], ['б', '6', 1],
      // Capital I and small l are drawn alike; small Cyrillic letters drawn like a Latin one.
      ['l', 'i', 3], ['ь', 'b', 1], ['и', 'u', 1], ['п', 'n', 1], ['г', 'r', 1],
    ],
    gaps: {},
  },
  {
    fold: readOf,
    pairs: [['е', 'э', 2], ['и', 'ы', 2], ['ш', 'щ', 2], ['а', 'о', 2]],
    // The soft sign is often left out.
    gaps: { ь: 1 },
  },
  {
    fold: soundOf,
    pairs: [
      ['i', 'j', 1], ['c', 'k', 1], ['c', 's', 2], ['s', 'z', 2], ['e', 'i', 2], ['o', 'a', 2],
      ['b', 'p', 2], ['d', 't', 2], ['g', 'k', 2], ['v', 'f', 2],
    ],
    // A glide or the h of a digraph differs between spellings (ya/a, kh/k).
    gaps: { j: 2, h: 2 },
  },
]

/** Cost tables cover ASCII and Cyrillic; any other character compares by code point. */
const OTHER = 0x180
const slotOf = (point: number): number =>
  point < 0x80 ? point : point >= 0x400 && point < 0x500 ? point - 0x380 : OTHER
/** A nick's lone digit before a letter ("Vad1m", "4ert") stands for a letter: its own slot. Numbers ("2008") do not. */
const leetSlot = (digit: number): number => OTHER + 1 + digit - 0x30
const SLOTS = OTHER + 11
const isDigitPoint = (point: number): boolean => point >= 0x30 && point <= 0x39
const isLetterPoint = (point: number | undefined): boolean => point !== undefined && point > 0x40 && !isDigitPoint(point)

/** Per view: substitution costs by pair, gap costs, and the class of each character (pairs cheaper than Q join one). */
const VIEW_TABLES = VIEWS.map((view) => {
  const pairs = new Map<number, Map<number, number>>()
  const parent = new Map<number, number>()
  const find = (point: number): number => {
    let root = point
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  for (const [a, b, cost] of view.pairs) {
    const x = a.codePointAt(0)!
    const y = b.codePointAt(0)!
    for (const [from, to] of [[x, y], [y, x]] as const) {
      const row = pairs.get(from) ?? new Map<number, number>()
      row.set(to, Math.min(cost, row.get(to) ?? Q))
      pairs.set(from, row)
    }
    const rootX = find(x)
    const rootY = find(y)
    if (rootX !== rootY) parent.set(rootX, rootY)
  }
  const gaps = new Map(Object.entries(view.gaps).map(([char, cost]) => [char.codePointAt(0)!, cost]))
  return { pairs, gaps, classOf: find }
})

const bitOf = (point: number): number => 1 << (Math.imul(point, 0x9e3779b1) >>> 27)

/** One view of a text: its characters, cost-table slots, gap costs and class bits. */
interface Folded {
  folded: string
  points: Int32Array
  slots: Uint16Array
  /** Cost of this character standing beyond the other side: DOUBLED when it repeats the one before. */
  gaps: Uint8Array
  mask: number
}

function foldedOf(folded: string, view: number): Folded {
  const { gaps, classOf } = VIEW_TABLES[view]!
  const points = Int32Array.from(folded, (char) => char.codePointAt(0)!)
  const slots = Uint16Array.from(points, (point, index) =>
    view === LOOK_VIEW && isDigitPoint(point) && !isDigitPoint(points[index - 1] ?? 0) && isLetterPoint(points[index + 1])
      ? leetSlot(point)
      : slotOf(point))
  const gapCosts = Uint8Array.from(points, (point, index) =>
    index > 0 && points[index - 1] === point ? DOUBLED : gaps.get(point) ?? Q)
  let mask = 0
  for (const point of points) mask |= bitOf(classOf(point))
  return { folded, points, slots, gaps: gapCosts, mask }
}

/** A prepared view of the query: substitution costs per character and its limits. */
interface QueryView extends Folded {
  view: number
  /** Per query character: substitution cost by nick slot. */
  costs: Uint8Array[]
  /** Class bits of characters that cost an edit to fix when the nick lacks them. */
  required: number
  limit: number
  /** 0: no fuzzy match inside a nick in this view. */
  infixLimit: number
  penalty: number
}

function queryView(text: string, view: number, penalty: number, fuzzy: boolean, inside: boolean): QueryView | null {
  const { pairs, classOf } = VIEW_TABLES[view]!
  const base = foldedOf(VIEWS[view]!.fold(text), view)
  const length = base.points.length
  if (length === 0) return null
  const lower = (table: Uint8Array, slot: number, cost: number): void => {
    if (slot !== OTHER) table[slot] = Math.min(table[slot]!, cost)
  }
  const costs = Array.from(base.points, (point) => {
    const table = new Uint8Array(SLOTS).fill(Q)
    lower(table, slotOf(point), 0)
    if (isDigitPoint(point)) {
      lower(table, leetSlot(point), 0)
      return table
    }
    for (const [other, cost] of pairs.get(point) ?? []) lower(table, isDigitPoint(other) ? leetSlot(other) : slotOf(other), cost)
    return table
  })
  let required = 0
  base.points.forEach((point, index) => {
    if (base.gaps[index]! >= Q) required |= bitOf(classOf(point))
  })
  return {
    ...base,
    view,
    costs,
    required,
    limit: fuzzy ? costLimit(maxEdits(length), length) : 0,
    infixLimit: fuzzy && inside ? costLimit(maxInfixEdits(length), length) : 0,
    penalty,
  }
}

/** How a nick matched, compared in compareNickScores order. */
export interface NickScore {
  /** Quarter edits (4 per edit) between the query and the matched part, with the view's rank cost. */
  cost: number
  /** 0: the whole nick, 1: its start, 2: inside it. */
  kind: 0 | 1 | 2
  /** Matched as typed (the nick_search key). */
  literal: boolean
}

/** The cheaper match first, then whole before start before inside, then as typed before folded. */
export function compareNickScores(a: NickScore, b: NickScore): number {
  return a.cost - b.cost || a.kind - b.kind || Number(b.literal) - Number(a.literal)
}

export interface NickQuery {
  key: string
  views: QueryView[]
}

export function prepareNickQuery(query: string): NickQuery {
  const typed = query.trim()
  const key = normalizePlayerSearchKey(typed)
  const text = plain(typed)
  // Digits only, or a symbol: an edit there is a different number, not a typo.
  const fuzzy = /\p{L}/u.test(key)
  const views = [queryView(text, LOOK_VIEW, 0, fuzzy, true)]
  if (fuzzy) views.push(queryView(text, READ_VIEW, Q, true, false), queryView(text, SOUND_VIEW, Q, true, false))
  const switched = switchLayout(key)
  if (switched !== null) {
    const switchedText = plain(switched)
    // Three letters at least: two of the other layout start too many nicks by chance.
    if (lookOf(switchedText).length >= 3) views.push(queryView(switchedText, LOOK_VIEW, Q, true, false))
  }
  return { key, views: views.filter((view): view is QueryView => view !== null) }
}

let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]
/** align's results: the whole nick and the best prefix (or substring). */
let alignedWhole = 0
let alignedBest = 0

/**
 * Weighted OSA distance of the query to the nick (anchored) or to its best
 * substring (freeStart: Sellers), into alignedWhole and alignedBest; a value
 * above `limit` comes back as limit + 1.
 */
function align(query: QueryView, nick: Folded, limit: number, freeStart: boolean): void {
  const m = query.points.length
  const n = nick.points.length
  if (rows[0]!.length <= n) rows = rows.map(() => new Int32Array(n + 1))
  let before = rows[0]!
  let previous = rows[1]!
  let current = rows[2]!
  const { points: queryPoints, costs: queryCosts, gaps: deletes } = query
  const { points, slots, gaps: inserts } = nick
  previous[0] = 0
  for (let j = 1; j <= n; j += 1) previous[j] = freeStart ? 0 : previous[j - 1]! + inserts[j - 1]!
  let previousMin = 0
  for (let i = 1; i <= m; i += 1) {
    const costs = queryCosts[i - 1]!
    const p = queryPoints[i - 1]!
    const pBefore = i > 1 ? queryPoints[i - 2]! : -1
    const remove = deletes[i - 1]!
    current[0] = previous[0]! + remove
    let rowMin = current[0]!
    for (let j = 1; j <= n; j += 1) {
      const slot = slots[j - 1]!
      let d = previous[j - 1]! + (slot === OTHER ? (points[j - 1] === p ? 0 : Q) : costs[slot]!)
      const up = previous[j]! + remove
      if (up < d) d = up
      const left = current[j - 1]! + inserts[j - 1]!
      if (left < d) d = left
      if (j > 1 && p === points[j - 2] && pBefore === points[j - 1]) {
        const swap = before[j - 2]! + Q
        if (swap < d) d = swap
      }
      current[j] = d
      if (d < rowMin) rowMin = d
    }
    // A row's minimum never drops below the smaller of the two rows before it.
    if (rowMin > limit && previousMin > limit) {
      alignedWhole = limit + 1
      alignedBest = limit + 1
      return
    }
    previousMin = rowMin
    const spare = before
    before = previous
    previous = current
    current = spare
  }
  let best = previous[0]!
  for (let j = 1; j <= n; j += 1) if (previous[j]! < best) best = previous[j]!
  alignedWhole = Math.min(previous[n]!, limit + 1)
  alignedBest = Math.min(best, limit + 1)
}

function popcount(bits: number): number {
  let count = 0
  for (let rest = bits >>> 0; rest !== 0; rest &= rest - 1) count += 1
  return count
}

function better(candidate: NickScore | null, best: NickScore | null): NickScore | null {
  return candidate && (!best || compareNickScores(candidate, best) < 0) ? candidate : best
}

const viewHit = (query: QueryView, cost: number, kind: NickScore['kind']): NickScore =>
  ({ cost: cost + query.penalty, kind, literal: false })

/** Exact finds in rank order first, then edits (maxEdits never below maxInfixEdits). */
function scoreView(query: QueryView, nick: Folded): NickScore | null {
  if (nick.folded === query.folded) return viewHit(query, 0, 0)
  if (nick.folded.startsWith(query.folded)) return viewHit(query, 0, 1)
  if (nick.folded.includes(query.folded)) return viewHit(query, 0, 2)
  const { limit, infixLimit } = query
  // Every query character beyond the nick costs at least 1.
  if (limit === 0 || query.points.length - nick.points.length > limit) return null
  // Each class the nick lacks costs an edit.
  const missing = popcount(query.required & ~nick.mask) * Q
  if (missing > limit) return null
  align(query, nick, limit, false)
  // The best prefix is never worse than the whole nick: the whole only when equal.
  let best = alignedBest <= limit ? viewHit(query, alignedBest, alignedWhole === alignedBest ? 0 : 1) : null
  // Inside the nick only when it can rank higher: exact finds inside were taken above.
  if (infixLimit > 0 && missing <= infixLimit && (best === null || best.cost - query.penalty > INSIDE + 1)) {
    align(query, nick, infixLimit, true)
    if (alignedBest <= infixLimit) best = better(viewHit(query, alignedBest + INSIDE, 2), best)
  }
  return best
}

interface Entry {
  key: string
  views: Folded[]
}

function entryOf(key: string, text = key): Entry {
  const plainText = plain(text)
  return { key, views: VIEWS.map((view, index) => foldedOf(view.fold(plainText), index)) }
}

function scoreEntry(query: NickQuery, nick: Entry): NickScore | null {
  if (query.key !== '') {
    if (nick.key === query.key) return { cost: 0, kind: 0, literal: true }
    if (nick.key.startsWith(query.key)) return { cost: 0, kind: 1, literal: true }
  }
  let best: NickScore | null = query.key !== '' && nick.key.includes(query.key)
    ? { cost: 0, kind: 2, literal: true }
    : null
  for (const view of query.views) {
    if (best && view.penalty > best.cost) continue
    best = better(scoreView(view, nick.views[view.view]!), best)
    if (best?.cost === 0 && best.kind === 0) break
  }
  return best
}

/** How `nick` matches the query; null: it does not. */
export function scoreNick(query: NickQuery, nick: string): NickScore | null {
  return scoreEntry(query, entryOf(normalizePlayerSearchKey(nick), nick))
}

/** The nicks that match `query`, best first; equal matches keep their order. An empty query keeps them all. */
export function rankNicks(query: string, nicks: readonly string[]): string[] {
  if (query.trim() === '') return [...nicks]
  const prepared = prepareNickQuery(query)
  return nicks
    .map((nick, index) => ({ nick, index, score: scoreNick(prepared, nick) }))
    .filter((item): item is { nick: string; index: number; score: NickScore } => item.score !== null)
    .sort((a, b) => compareNickScores(a.score, b.score) || a.index - b.index)
    .map((item) => item.nick)
}

export interface NickHit {
  key: string
  battles: number
  score: NickScore
}

/** Every searchable nick key in its three views: a query scans ~20,000 keys (2026-10-08). */
export class NickIndex {
  private readonly entries: (Entry & { battles: number })[]

  constructor(keys: readonly { key: string; battles: number }[]) {
    this.entries = keys.map(({ key, battles }) => ({ ...entryOf(key), battles }))
  }

  get size(): number {
    return this.entries.length
  }

  /** The best `limit` keys: by score, then by battles, then by key. */
  find(query: NickQuery, limit: number): NickHit[] {
    const hits: NickHit[] = []
    for (const entry of this.entries) {
      const score = scoreEntry(query, entry)
      if (score) hits.push({ key: entry.key, battles: entry.battles, score })
    }
    hits.sort((a, b) => compareNickScores(a.score, b.score) || b.battles - a.battles || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return hits.slice(0, limit)
  }
}

/** How long a worker reuses its index; searchSitePlayers' prefix matches stay live meanwhile. */
export const NICK_INDEX_TTL_MS = 10 * 60_000

let cached: { key: string; builtAt: number; index: NickIndex } | null = null

/** The index of `key` (a database path), rebuilt from `load` once older than NICK_INDEX_TTL_MS. */
export function cachedNickIndex(key: string, load: () => readonly { key: string; battles: number }[]): NickIndex {
  if (cached && cached.key === key && Date.now() - cached.builtAt < NICK_INDEX_TTL_MS) return cached.index
  cached = { key, builtAt: Date.now(), index: new NickIndex(load()) }
  return cached.index
}
