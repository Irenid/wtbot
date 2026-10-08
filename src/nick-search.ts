/**
 * Typo-tolerant nick search: the site's player search (searchSitePlayers with
 * the worker task search-player-nicks) and the /scout player autocomplete.
 *
 * Both sides are folded first: accents dropped, lower case, Cyrillic and
 * Greek letters drawn like Latin ones made Latin ("Zоroaster" with a
 * Cyrillic о, the most active nick of 2026-10-08, is "zoroaster"), letters
 * and digits only: separators and the "@psn" suffix go. A nick then matches
 * whole, by its start or inside it, with up to maxEdits(query length) edits
 * of OSA distance (a swap of two adjacent letters is one edit). A query typed
 * in the wrong keyboard layout (ЙЦУКЕН and QWERTY) matches whole or by the
 * start, ranked as one edit.
 */

/** The nick_search key of the database: NFKC, locale-neutral lower case, never COLLATE NOCASE. */
export function normalizePlayerSearchKey(nick: string): string {
  return nick.normalize('NFKC').toLocaleLowerCase('und')
}

/** Lower-case Cyrillic and Greek letters whose upper or lower case is drawn like a Latin letter; nicks mix them unseen. */
const LOOK_ALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  α: 'a', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** The form a query and a nick are compared in: see the module comment. */
export function foldNick(text: string): string {
  let out = ''
  // NFKD splits accents off (ё is е, й is и); NFC joins Hangul jamo back into syllables.
  const plain = text.trim().replace(/@\w+$/u, '').normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC')
  for (const char of plain.toLocaleLowerCase('und')) {
    const folded = LOOK_ALIKES[char] ?? char
    if (LETTER_OR_DIGIT.test(folded)) out += folded
  }
  return out
}

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

/** Edits a query of `length` folded characters may differ by: none below 4, 1 up to 7, then 2. */
export function maxEdits(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2
}

/** Edits a match inside a nick may have: inside a longer nick a short query finds too much. */
export function maxInfixEdits(length: number): number {
  return length < 6 ? 0 : length < 12 ? 1 : 2
}

/** How a nick matched; lower is better on every field, compared in compareNickScores order. */
export interface NickScore {
  /** Edits between the query and the matched part. */
  edits: number
  /** 0: the whole nick, 1: its start, 2: inside it. */
  kind: 0 | 1 | 2
  /** Matched as typed (the nick_search key), not only folded. */
  literal: boolean
  /** Matched only in the other keyboard layout. */
  layout: boolean
}

/** A layout switch counts as one edit; then whole before start before inside; then as typed before folded. */
export function compareNickScores(a: NickScore, b: NickScore): number {
  return a.edits + Number(a.layout) - (b.edits + Number(b.layout))
    || a.kind - b.kind
    || Number(b.literal) - Number(a.literal)
}

interface Folded {
  /** nick_search key. */
  key: string
  folded: string
  points: Int32Array
  /** Bits of its characters (charBit): a query character whose bit the nick lacks costs an edit. */
  mask: number
}

interface Variant extends Folded {
  edits: number
  infixEdits: number
  layout: boolean
}

export interface NickQuery {
  variants: Variant[]
}

const charBit = (point: number): number => 1 << (Math.imul(point, 0x9e3779b1) >>> 27)

/** `key` stays as stored: an index entry maps back to its nick_search rows. */
function folded(text: string, key = normalizePlayerSearchKey(text)): Folded {
  const fold = foldNick(text)
  const points = Int32Array.from(fold, (char) => char.codePointAt(0)!)
  let mask = 0
  for (const point of points) mask |= charBit(point)
  return { key, folded: fold, points, mask }
}

export function prepareNickQuery(query: string): NickQuery {
  const typed = folded(query.trim())
  // Digits only, or a symbol: an edit there is a different number, not a typo.
  const fuzzy = /\p{L}/u.test(typed.folded)
  const variants: Variant[] = [{
    ...typed,
    edits: fuzzy ? maxEdits(typed.points.length) : 0,
    infixEdits: fuzzy ? maxInfixEdits(typed.points.length) : 0,
    layout: false,
  }]
  const switched = switchLayout(typed.key)
  if (switched !== null) {
    const other = folded(switched)
    // Three letters at least: two of the other layout start too many nicks by chance.
    if (other.points.length >= 3) variants.push({ ...other, edits: 0, infixEdits: -1, layout: true })
  }
  return { variants }
}

let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]

/**
 * OSA distance of `pattern` to `text` (anchored) or to the best substring of
 * it (freeStart: Sellers). Returns [whole, best prefix or substring]; a value
 * above `limit` comes back as limit + 1.
 */
function osa(pattern: Int32Array, text: Int32Array, limit: number, freeStart: boolean): [number, number] {
  const m = pattern.length
  const n = text.length
  if (rows[0]!.length <= n) rows = rows.map(() => new Int32Array(n + 1))
  let [before, previous, current] = rows as [Int32Array, Int32Array, Int32Array]
  for (let j = 0; j <= n; j += 1) previous[j] = freeStart ? 0 : j
  let previousMin = 0
  for (let i = 1; i <= m; i += 1) {
    const p = pattern[i - 1]!
    current[0] = i
    let rowMin = i
    for (let j = 1; j <= n; j += 1) {
      const t = text[j - 1]!
      let d = previous[j - 1]! + (p === t ? 0 : 1)
      if (previous[j]! + 1 < d) d = previous[j]! + 1
      if (current[j - 1]! + 1 < d) d = current[j - 1]! + 1
      if (i > 1 && j > 1 && p === text[j - 2] && pattern[i - 2] === t && before[j - 2]! + 1 < d) d = before[j - 2]! + 1
      current[j] = d
      if (d < rowMin) rowMin = d
    }
    // A row's minimum never drops below the smaller of the two rows before it.
    if (rowMin > limit && previousMin > limit) return [limit + 1, limit + 1]
    previousMin = rowMin
    ;[before, previous, current] = [previous, current, before]
  }
  let best = previous[0]!
  for (let j = 1; j <= n; j += 1) if (previous[j]! < best) best = previous[j]!
  return [Math.min(previous[n]!, limit + 1), Math.min(best, limit + 1)]
}

function popcount(bits: number): number {
  let count = 0
  for (let rest = bits >>> 0; rest !== 0; rest &= rest - 1) count += 1
  return count
}

function better(candidate: NickScore | null, best: NickScore | null): NickScore | null {
  return candidate && (!best || compareNickScores(candidate, best) < 0) ? candidate : best
}

/** Exact finds in rank order first, then edits (maxEdits never below maxInfixEdits). */
function scoreVariant(query: Variant, nick: Folded): NickScore | null {
  const { layout } = query
  const typed = query.key !== ''
  const m = query.points.length
  if (typed && nick.key === query.key) return { edits: 0, kind: 0, literal: true, layout }
  if (m > 0 && nick.folded === query.folded) return { edits: 0, kind: 0, literal: false, layout }
  if (typed && nick.key.startsWith(query.key)) return { edits: 0, kind: 1, literal: true, layout }
  if (m > 0 && nick.folded.startsWith(query.folded)) return { edits: 0, kind: 1, literal: false, layout }
  if (query.infixEdits >= 0) {
    if (typed && nick.key.includes(query.key)) return { edits: 0, kind: 2, literal: true, layout }
    if (m > 0 && nick.folded.includes(query.folded)) return { edits: 0, kind: 2, literal: false, layout }
  }
  const limit = query.edits
  // Each query character the nick lacks costs an edit; so does each one past the nick's length.
  if (limit === 0 || m - nick.points.length > limit || popcount(query.mask & ~nick.mask) > limit) return null
  const [whole, prefix] = osa(query.points, nick.points, limit, false)
  // The best prefix is never worse than the whole nick: the whole only when equal.
  let best: NickScore | null = prefix <= limit ? { edits: prefix, kind: whole === prefix ? 0 : 1, literal: false, layout } : null
  // Inside the nick only with fewer edits than at its start: exact finds inside were taken above.
  if (query.infixEdits > 0 && (best === null || best.edits > 1)) {
    const [, inside] = osa(query.points, nick.points, query.infixEdits, true)
    if (inside <= query.infixEdits) best = better({ edits: inside, kind: 2, literal: false, layout }, best)
  }
  return best
}

function scoreFolded(query: NickQuery, nick: Folded): NickScore | null {
  let best: NickScore | null = null
  for (const variant of query.variants) best = better(scoreVariant(variant, nick), best)
  return best
}

/** How `nick` matches the query; null: it does not. */
export function scoreNick(query: NickQuery, nick: string): NickScore | null {
  return scoreFolded(query, folded(nick))
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

/** Every searchable nick key, folded once: a query scans ~20,000 keys (2026-10-08) in a few milliseconds. */
export class NickIndex {
  private readonly entries: (Folded & { battles: number })[]

  constructor(keys: readonly { key: string; battles: number }[]) {
    this.entries = keys.map(({ key, battles }) => ({ ...folded(key, key), battles }))
  }

  get size(): number {
    return this.entries.length
  }

  /** The best `limit` keys: by score, then by battles, then by key. */
  find(query: NickQuery, limit: number): NickHit[] {
    const hits: NickHit[] = []
    for (const entry of this.entries) {
      const score = scoreFolded(query, entry)
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
