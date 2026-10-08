/**
 * Finds known players in OCR'd scoreboard rows and splits them into teams.
 * Each row comes as several readings, one per OCR pass (ocr.ts); a nick's
 * best find over them counts. OCR misreads letters and drops underscores, so
 * a nick is located by approximate substring search (Sellers) over
 * normalised text: letters and digits only, accents dropped, Cyrillic and
 * digit look-alikes folded to Latin. Short nicks hide anywhere, so a find
 * counts when its squadron tag precedes it, or it is long and exact, or its
 * squadron already holds that side. The layout decides the side: in a row
 * the right-hand nick is the enemy (the game always shows the own team on
 * the left).
 */

import type { OcrRow } from './ocr.js'

export interface KnownPlayer {
  userId: string
  nick: string
  clanTag: string
}

export interface NickMatch extends KnownPlayer {
  row: number
  /** Source-image x of the matched text's centre. */
  x: number
  /** Edits between the nick and the OCR text. */
  distance: number
  /** The player's stored squadron tag was read right before the nick. */
  tagSeen: boolean
  /** Squadron core (tag letters, lower case) as the screenshot shows it, else the stored one: players change squadrons. */
  squadron: string
}

/** Look-alikes OCR swaps freely: Cyrillic, Greek, digits and letters without a separable accent to one Latin letter. */
const FOLD: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'α': 'a', 'ι': 'i',
  '0': 'o', '1': 'i', l: 'i', '|': 'i', '!': 'i', ł: 'i', ı: 'i', đ: 'd', ø: 'o',
}

/** Letters and digits only, lower case, accents dropped, look-alikes folded. */
export function foldForMatch(text: string): string {
  let out = ''
  // NFKD splits accents off (no pass reads "Loupák" with its á); NFC joins Hangul jamo back into syllables.
  for (const char of text.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase()) {
    const folded = FOLD[char] ?? char
    if (/[\p{L}\p{N}]/u.test(folded)) out += folded
  }
  return out
}

const isWide = (char: string): boolean => /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)

/** A CJK character tells as much as two Latin ones. */
export function nickWeight(chars: readonly string[]): number {
  return chars.reduce((sum, char) => sum + (isWide(char) ? 2 : 1), 0)
}

/** Edits a nick may differ by: none up to weight 6, then 1, 2 from 11, 3 from 16. */
export function allowedDistance(weight: number): number {
  return weight <= 6 ? 0 : weight <= 10 ? 1 : weight <= 15 ? 2 : 3
}

/** A long exact find needs no other evidence. */
const SELF_EVIDENT_WEIGHT = 8

/** Sellers' DP: per end position j of `text`, the fewest edits of `pattern` against a substring ending at j, and its start. */
function sellers(pattern: readonly string[], text: readonly string[]): { distances: number[]; starts: number[] } {
  let previous = new Array<number>(text.length + 1).fill(0)
  let previousStart = Array.from({ length: text.length + 1 }, (_, j) => j)
  for (let i = 1; i <= pattern.length; i += 1) {
    const current = new Array<number>(text.length + 1)
    const currentStart = new Array<number>(text.length + 1)
    current[0] = i
    currentStart[0] = 0
    for (let j = 1; j <= text.length; j += 1) {
      const substitute = previous[j - 1]! + (pattern[i - 1] === text[j - 1] ? 0 : 1)
      const remove = previous[j]! + 1
      const insert = current[j - 1]! + 1
      if (substitute <= remove && substitute <= insert) {
        current[j] = substitute
        currentStart[j] = previousStart[j - 1]!
      } else if (remove <= insert) {
        current[j] = remove
        currentStart[j] = previousStart[j]!
      } else {
        current[j] = insert
        currentStart[j] = currentStart[j - 1]!
      }
    }
    previous = current
    previousStart = currentStart
  }
  return { distances: previous, starts: previousStart }
}

/** Best approximate occurrence of `pattern` in `text` (both char arrays): edits and the [start, end) span. */
export function approximateFind(pattern: readonly string[], text: readonly string[]): { distance: number; start: number; end: number } {
  const { distances, starts } = sellers(pattern, text)
  let best = { distance: Number.POSITIVE_INFINITY, start: 0, end: 0 }
  for (let j = 0; j <= text.length; j += 1) {
    if (distances[j]! < best.distance) best = { distance: distances[j]!, start: starts[j]!, end: j }
  }
  return best
}

/** Tag edits forgiven: one from 4 characters, none below. */
const tagDistance = (tag: readonly string[]): number => (tag.length >= 4 ? 1 : 0)
/** Characters OCR may leave between a tag and the nick: the frame's tail read as letters ("WLILYeE", "WLILY#"). */
const TAG_GAP_CHARS = 3

/**
 * The tag ends right before the nick: `text` ends with the nick's first
 * character (a fuzzy find may start one early). Anywhere in a window it gave
 * false tags: the plane icon read "ANA" before "SIZGOY" held "nasi", one
 * edit from NASHI.
 */
export function tagJustBefore(tag: readonly string[], text: readonly string[]): boolean {
  if (tag.length < 2) return false
  const window = text.slice(-(tag.length + TAG_GAP_CHARS + 2))
  const { distances } = sellers(tag, window)
  for (let j = Math.max(0, window.length - TAG_GAP_CHARS - 1); j <= window.length; j += 1) {
    if (distances[j]! <= tagDistance(tag)) return true
  }
  return false
}

/** Plain edit distance of two strings' code points. */
function editDistance(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = Math.min(previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1), previous[j]! + 1, current[j - 1]! + 1)
    }
    previous = current
  }
  return previous[y.length]!
}

/** Case and underscores kept: tells apart nicks that fold alike ("__MAVERiCK__", "__Maverick____"). */
const rawForm = (text: string): string => text.normalize('NFKC').replace(/[^\p{L}\p{N}_]/gu, '')

interface NickPattern {
  chars: string[]
  weight: number
  bigrams: string[]
}

export interface IndexedPlayer extends KnownPlayer, NickPattern {
  tagChars: string[]
  /** The Latin and Cyrillic letters of a nick decorated with kana or CJK ("GRIMッ", "Felonメ"): the passes read either part, rarely both. */
  plain: NickPattern | null
}

const bigramsOf = (chars: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!)
  return out
}

/** The game shows a nick without the platform suffix ("@psn", "@live") the replays carry. */
export const displayedNick = (nick: string): string => nick.replace(/@\w+$/u, '')

/** Too short, digits only or under 3 distinct characters ("ooooooox" matched score zeros read as Cyrillic о): noise matches it anywhere. */
const matchable = (chars: readonly string[]): boolean =>
  chars.length >= 3 && chars.some((char) => /\p{L}/u.test(char)) && new Set(chars).size >= 3

const pattern = (chars: string[]): NickPattern => ({ chars, weight: nickWeight(chars), bigrams: bigramsOf(chars) })

export function indexPlayers(players: readonly KnownPlayer[]): IndexedPlayer[] {
  const out: IndexedPlayer[] = []
  for (const player of players) {
    const chars = [...foldForMatch(displayedNick(player.nick))]
    if (!matchable(chars)) continue
    // Decorations only: "青春爆二不会遇到T90学姐" is no "T90".
    const narrow = chars.filter((char) => !isWide(char))
    const wide = chars.length - narrow.length
    const plain = wide > 0 && narrow.length >= 1.5 * wide && matchable(narrow) ? pattern(narrow) : null
    out.push({ ...player, ...pattern(chars), tagChars: [...foldForMatch(player.clanTag)], plain })
  }
  return out
}

interface Candidate extends NickMatch {
  /** Source x of the first and last matched character. */
  left: number
  right: number
  weight: number
  tagChars: string[]
  /** Per reading the nick was found in: the folded text before it, where a squadron tag stands. */
  before: string[][]
  /** The find ends a word in some reading: not the head of a longer nick. */
  endsWord: boolean
  /** Edits between the displayed nick and the words read there, case and underscores kept. */
  rawDistance: number
}

/** Score columns: digit-only words, and words folding to o and i alone (a Cyrillic pass reads zeros as "о"). */
const isScoreWord = (text: string): boolean => !/\p{L}/u.test(text) || [...foldForMatch(text)].every((char) => char === 'o' || char === 'i')

/** A reading as folded characters with their word's x and index, score columns left out. */
function readingText(row: OcrRow): { chars: string[]; xs: number[]; words: number[] } {
  const chars: string[] = []
  const xs: number[] = []
  const words: number[] = []
  row.words.forEach((word, index) => {
    if (isScoreWord(word.text)) return
    const folded = [...foldForMatch(word.text)]
    folded.forEach((char, k) => {
      chars.push(char)
      xs.push(word.x0 + ((word.x1 - word.x0) * (k + 0.5)) / folded.length)
      words.push(index)
    })
  })
  return { chars, xs, words }
}

const core = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

/** Chars of text kept before a find: a 5-character tag, decorations and a space. */
const BEFORE_CHARS = 12

/** Text a find explains: a long nick with an edit beats an exact short one inside it ("ace" took "ЯсельныйГенералヅ"). */
const explained = (match: Candidate): number => match.weight - 2 * match.distance

/**
 * Every known player found in each row: `readings[pass][row]`, a nick's best
 * find over the passes (the most text explained; its tag read in any). A player in one
 * row at most; finds over the same text (another reading of it, or a nick
 * inside a longer one) resolved best-first.
 */
export function matchRows(readings: readonly (readonly OcrRow[])[], players: readonly IndexedPlayer[]): Candidate[][] {
  const rowCount = Math.max(0, ...readings.map((reading) => reading.length))
  const best = new Map<string, Candidate>()
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (const reading of readings) {
      const row = reading[rowIndex]
      if (!row) continue
      const { chars, xs, words } = readingText(row)
      if (chars.length < 3) continue
      const rowBigrams = new Set(bigramsOf(chars))
      for (const player of players) {
        let found: { nick: NickPattern; hit: ReturnType<typeof approximateFind> } | null = null
        for (const nick of player.plain ? [player, player.plain] : [player]) {
          const allowed = allowedDistance(nick.weight)
          let shared = 0
          for (const bigram of nick.bigrams) if (rowBigrams.has(bigram)) shared += 1
          // k edits break at most 2k bigrams.
          if (shared === 0 || shared < nick.bigrams.length - 2 * allowed) continue
          const hit = approximateFind(nick.chars, chars)
          if (hit.distance > allowed) continue
          found = { nick, hit }
          break
        }
        if (!found) continue
        const { hit } = found
        const before = chars.slice(Math.max(0, hit.start - BEFORE_CHARS), hit.start + 1)
        const last = Math.max(hit.start, hit.end - 1)
        const candidate: Candidate = {
          userId: player.userId,
          nick: player.nick,
          clanTag: player.clanTag,
          row: rowIndex,
          x: (xs[hit.start]! + xs[last]!) / 2,
          distance: hit.distance,
          tagSeen: tagJustBefore(player.tagChars, before),
          squadron: core(player.clanTag),
          left: xs[hit.start]!,
          right: xs[last]!,
          weight: found.nick.weight,
          tagChars: player.tagChars,
          before: [before],
          endsWord: hit.end >= chars.length || words[hit.end] !== words[last],
          rawDistance: editDistance(
            rawForm(displayedNick(player.nick)),
            rawForm(row.words.slice(words[hit.start], words[last]! + 1).map((word) => word.text).join('')),
          ),
        }
        const key = `${rowIndex}:${player.userId}`
        const previous = best.get(key)
        if (!previous) {
          best.set(key, candidate)
        } else {
          const kept = explained(candidate) > explained(previous) ? candidate : previous
          best.set(key, {
            ...kept,
            tagSeen: previous.tagSeen || candidate.tagSeen,
            before: [...previous.before, ...candidate.before],
            endsWord: previous.endsWord || candidate.endsWord,
            rawDistance: Math.min(previous.rawDistance, candidate.rawDistance),
          })
        }
      }
    }
  }
  // Best first: confirmed by the tag, the most text explained, fewer edits, then the spelling.
  const found = [...best.values()].sort((a, b) =>
    Number(b.tagSeen) - Number(a.tagSeen)
    || explained(b) - explained(a)
    || a.distance - b.distance
    || a.rawDistance - b.rawDistance)
  const taken = new Set<string>()
  const result = Array.from({ length: rowCount }, () => [] as Candidate[])
  for (const match of found) {
    if (taken.has(match.userId)) continue
    if (result[match.row]!.some((other) => Math.min(match.right, other.right) >= Math.max(match.left, other.left))) continue
    taken.add(match.userId)
    result[match.row]!.push(match)
  }
  for (const row of result) row.sort((a, b) => a.x - b.x)
  return result
}

export interface TeamSplit {
  allies: NickMatch[]
  enemies: NickMatch[]
  /** The x between the teams; null — one team only, its side unknown. */
  splitX: number | null
  /** Per row: whether an enemy was found. */
  enemyRows: boolean[]
  /** Without a split: the strong finds (one team, side unknown). */
  oneSide: NickMatch[]
  /** The enemy squadron's tag as read before a nick, folded; null — none read. */
  enemyTag: string[] | null
}

const strip = ({ left: _l, right: _r, weight: _w, tagChars: _t, before: _b, endsWord: _e, rawDistance: _d, ...match }: Candidate, squadron = match.squadron): NickMatch =>
  ({ ...match, squadron })

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * Strong finds (their stored tag before the nick, or long and exact) set the
 * split: rows with two of them directly (left ally, right enemy), else two
 * squadrons side by side (the right one is the enemy). A find's squadron is
 * the tag read before it: its stored one, or one read before another nick of
 * this screenshot (players change squadrons: dennis7781's last stored battle
 * was for CH68, the screenshot shows =FTNDS=), else the stored one. Weaker
 * finds join a side when their squadron holds it and they stand in its
 * column: the own team's nicks end at one x, the enemy's start at one (a
 * Discord voice overlay over the table lists squadron mates too).
 */
export function splitTeams(rows: readonly Candidate[][]): TeamSplit {
  const all = rows.flat()
  const shownTags = new Map<string, string[]>()
  for (const match of all) if (match.tagSeen) shownTags.set(core(match.clanTag), match.tagChars)
  const shown = new Map<Candidate, string>()
  for (const match of all) {
    if (match.tagSeen) {
      shown.set(match, core(match.clanTag))
      continue
    }
    // A shown tag alone also stands before the head of a longer unknown nick ("kexik" in "kexik1234").
    if (!match.endsWord) continue
    for (const [tagCore, tag] of shownTags) {
      if (match.before.some((text) => tagJustBefore(tag, text))) {
        shown.set(match, tagCore)
        break
      }
    }
  }
  const squadronOf = (match: Candidate): string => shown.get(match) ?? match.squadron
  const strong = rows.map((row) => row.filter((m) => m.tagSeen || (m.distance === 0 && m.weight >= SELF_EVIDENT_WEIGHT)))
  const midpoints = strong.filter((row) => row.length >= 2).map((row) => (row[0]!.x + row[row.length - 1]!.x) / 2)
  let splitX: number | null = midpoints.length > 0 ? median(midpoints) : null
  const byCore = new Map<string, number[]>()
  for (const match of strong.flat()) {
    const list = byCore.get(squadronOf(match))
    if (list) list.push(match.x)
    else byCore.set(squadronOf(match), [match.x])
  }
  if (splitX === null) {
    const groups = [...byCore.values()].filter((xs) => xs.length >= 2).sort((a, b) => b.length - a.length).slice(0, 2)
    if (groups.length === 2) {
      const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
      splitX = (mean(groups[0]!) + mean(groups[1]!)) / 2
    }
  }
  if (splitX === null) {
    return { allies: [], enemies: [], splitX: null, enemyRows: rows.map(() => false), oneSide: strong.flat().map((m) => strip(m, squadronOf(m))), enemyTag: null }
  }
  const cut = splitX
  const strongSide = (right: boolean) => strong.flat().filter((m) => (m.x >= cut) === right)
  // Each side's squadron: the most frequent among its strong finds.
  const sideCore = (right: boolean): string | null => {
    const counts = new Map<string, number>()
    for (const m of strongSide(right)) counts.set(squadronOf(m), (counts.get(squadronOf(m)) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  const enemyCore = sideCore(true)
  const allyCore = sideCore(false)
  // The column edge: own nicks are right-aligned before the rank badge, enemy nicks start after one tag.
  const edge = (m: Candidate, right: boolean) => (right ? m.left : m.right)
  const column = (right: boolean): { at: number; slack: number } | null => {
    const side = strongSide(right)
    if (side.length < 2) return null
    const charWidth = median(side.map((m) => (m.right - m.left) / Math.max(1, m.weight - 1)))
    return { at: median(side.map((m) => edge(m, right))), slack: Math.max(4, 3 * charWidth) }
  }
  const enemyColumn = column(true)
  const allyColumn = column(false)
  const allies: NickMatch[] = []
  const enemies: NickMatch[] = []
  const enemyRows = rows.map(() => false)
  rows.forEach((row, index) => {
    const strongIds = new Set(strong[index]!.map((m) => m.userId))
    for (const match of row) {
      const right = match.x >= cut
      if (!strongIds.has(match.userId)) {
        if (squadronOf(match) !== (right ? enemyCore : allyCore)) continue
        const side = right ? enemyColumn : allyColumn
        if (side && Math.abs(edge(match, right) - side.at) > side.slack) continue
      }
      if (right) {
        // One enemy per row: the first kept (best) one.
        if (enemyRows[index]) continue
        enemyRows[index] = true
        enemies.push(strip(match, squadronOf(match)))
      } else {
        allies.push(strip(match, squadronOf(match)))
      }
    }
  })
  return { allies, enemies, splitX, enemyRows, oneSide: [], enemyTag: enemyCore === null ? null : shownTags.get(enemyCore) ?? null }
}

const WIDE_GAP = /(?<=[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]) (?=[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}])/gu

/**
 * Text right of the split in rows where no enemy was found, from the reading
 * with the most confident words there: shown as "not recognised". The enemy
 * tag goes (the split may fall before or after it), and so do the spaces the
 * Chinese passes put between characters.
 */
export function unreadEnemyRows(readings: readonly (readonly OcrRow[])[], split: TeamSplit): string[] {
  const out: string[] = []
  if (split.splitX === null) return out
  const cut = split.splitX
  const tag = split.enemyTag
  const isTag = (text: string): boolean => {
    const chars = [...foldForMatch(text)]
    return tag !== null && chars.length > 0 && chars.length <= tag.length + TAG_GAP_CHARS && tagJustBefore(tag, [...chars, ' '])
  }
  split.enemyRows.forEach((found, index) => {
    if (found) return
    let best: { text: string; confidence: number } | null = null
    for (const reading of readings) {
      const words = (reading[index]?.words ?? []).filter((word) => word.x0 >= cut && !isScoreWord(word.text))
      while (words.length > 0 && isTag(words[0]!.text)) words.shift()
      if (words.length === 0) continue
      const confidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length
      if (!best || confidence > best.confidence) best = { text: words.map((word) => word.text).join(' ').replace(WIDE_GAP, '').slice(0, 60), confidence }
    }
    if (best) out.push(best.text)
  })
  return out
}
