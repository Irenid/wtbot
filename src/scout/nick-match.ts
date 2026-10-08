/**
 * Finds known players in OCR'd scoreboard rows and splits them into teams.
 * OCR misreads letters and drops underscores, so a nick is located by
 * approximate substring search (Sellers) over normalised text: letters and
 * digits only, Cyrillic and digit look-alikes folded to Latin. Short nicks
 * hide anywhere, so a find counts when its squadron tag precedes it, or it is
 * long and exact, or its squadron already holds that side. The layout decides
 * the side: in a row the right-hand nick is the enemy (the game always shows
 * the own team on the left).
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
  /** The squadron tag was read right before the nick. */
  tagSeen: boolean
}

/** Look-alikes OCR swaps freely: Cyrillic, Greek and digits to one Latin letter. */
const FOLD: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'α': 'a', 'ι': 'i',
  '0': 'o', '1': 'i', l: 'i', '|': 'i', '!': 'i',
}

/** Letters and digits only, lower case, look-alikes folded. */
export function foldForMatch(text: string): string {
  let out = ''
  for (const char of text.normalize('NFKC').toLowerCase()) {
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

/** Best approximate occurrence of `pattern` in `text` (both char arrays): edits and the [start, end) span. */
export function approximateFind(pattern: readonly string[], text: readonly string[]): { distance: number; start: number; end: number } {
  const m = pattern.length
  let previous = new Array<number>(text.length + 1).fill(0)
  let previousStart = Array.from({ length: text.length + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
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
  let best = { distance: Number.POSITIVE_INFINITY, start: 0, end: 0 }
  for (let j = 0; j <= text.length; j += 1) {
    if (previous[j]! < best.distance) best = { distance: previous[j]!, start: previousStart[j]!, end: j }
  }
  return best
}

export interface IndexedPlayer extends KnownPlayer {
  chars: string[]
  weight: number
  bigrams: string[]
  tagChars: string[]
}

const bigramsOf = (chars: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!)
  return out
}

/** The game shows a nick without the platform suffix ("@psn", "@live") the replays carry. */
export const displayedNick = (nick: string): string => nick.replace(/@\w+$/u, '')

export function indexPlayers(players: readonly KnownPlayer[]): IndexedPlayer[] {
  const out: IndexedPlayer[] = []
  for (const player of players) {
    const chars = [...foldForMatch(displayedNick(player.nick))]
    // Too short or digits only: noise matches them anywhere.
    if (chars.length < 3 || !chars.some((char) => /\p{L}/u.test(char))) continue
    out.push({ ...player, chars, weight: nickWeight(chars), bigrams: bigramsOf(chars), tagChars: [...foldForMatch(player.clanTag)] })
  }
  return out
}

interface Candidate extends NickMatch {
  start: number
  end: number
  weight: number
}

/** Every known player found in each row; overlapping finds resolved best-first, a player in one row at most. */
export function matchRows(rows: readonly OcrRow[], players: readonly IndexedPlayer[]): Candidate[][] {
  const found: Candidate[] = []
  rows.forEach((row, rowIndex) => {
    // The row as folded characters, each mapped back to its word's x; score columns (digits only) left out.
    const chars: string[] = []
    const xs: number[] = []
    for (const word of row.words) {
      if (!/\p{L}/u.test(word.text)) continue
      const folded = [...foldForMatch(word.text)]
      folded.forEach((char, k) => {
        chars.push(char)
        xs.push(word.x0 + ((word.x1 - word.x0) * (k + 0.5)) / folded.length)
      })
    }
    if (chars.length < 3) return
    const rowBigrams = new Set(bigramsOf(chars))
    for (const player of players) {
      const allowed = allowedDistance(player.weight)
      let shared = 0
      for (const bigram of player.bigrams) if (rowBigrams.has(bigram)) shared += 1
      // k edits break at most 2k bigrams.
      if (shared === 0 || shared < player.bigrams.length - 2 * allowed) continue
      const hit = approximateFind(player.chars, chars)
      if (hit.distance > allowed) continue
      // The tag sits right before the nick: look a tag's length plus decorations back.
      let tagSeen = false
      if (player.tagChars.length >= 2) {
        const before = chars.slice(Math.max(0, hit.start - player.tagChars.length - 4), hit.start + 1)
        tagSeen = approximateFind(player.tagChars, before).distance <= (player.tagChars.length >= 4 ? 1 : 0)
      }
      found.push({
        userId: player.userId,
        nick: player.nick,
        clanTag: player.clanTag,
        row: rowIndex,
        x: (xs[hit.start]! + xs[Math.max(hit.start, hit.end - 1)]!) / 2,
        distance: hit.distance,
        tagSeen,
        start: hit.start,
        end: hit.end,
        weight: player.weight,
      })
    }
  })
  // Best first: confirmed by the tag, fewer edits per weight, then heavier nicks (a long nick beats one inside it).
  found.sort((a, b) =>
    Number(b.tagSeen) - Number(a.tagSeen)
    || a.distance / a.weight - b.distance / b.weight
    || b.weight - a.weight)
  const taken = new Set<string>()
  const spans = rows.map(() => [] as { start: number; end: number }[])
  const result = rows.map(() => [] as Candidate[])
  for (const match of found) {
    if (taken.has(match.userId)) continue
    if (spans[match.row]!.some((span) => match.start < span.end && span.start < match.end)) continue
    taken.add(match.userId)
    spans[match.row]!.push({ start: match.start, end: match.end })
    result[match.row]!.push(match)
  }
  for (const row of result) row.sort((a, b) => a.x - b.x)
  return result
}

const core = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

export interface TeamSplit {
  allies: NickMatch[]
  enemies: NickMatch[]
  /** The x between the teams; null — one team only, its side unknown. */
  splitX: number | null
  /** Per row: whether an enemy was found. */
  enemyRows: boolean[]
  /** Without a split: the strong finds (one team, side unknown). */
  oneSide: NickMatch[]
}

const strip = ({ start: _s, end: _e, weight: _w, ...match }: Candidate): NickMatch => match

/**
 * Strong finds (tag before the nick, or long and exact) set the split: rows
 * with two of them directly (left ally, right enemy), else two squadrons side
 * by side (the right one is the enemy). Weaker finds join a side when their
 * squadron already holds it.
 */
export function splitTeams(rows: readonly Candidate[][]): TeamSplit {
  const strong = rows.map((row) => row.filter((m) => m.tagSeen || (m.distance === 0 && m.weight >= SELF_EVIDENT_WEIGHT)))
  const midpoints = strong.filter((row) => row.length >= 2).map((row) => (row[0]!.x + row[row.length - 1]!.x) / 2).sort((a, b) => a - b)
  let splitX: number | null = midpoints.length > 0 ? midpoints[Math.floor(midpoints.length / 2)]! : null
  const byCore = new Map<string, number[]>()
  for (const match of strong.flat()) {
    const list = byCore.get(core(match.clanTag))
    if (list) list.push(match.x)
    else byCore.set(core(match.clanTag), [match.x])
  }
  if (splitX === null) {
    const groups = [...byCore.values()].filter((xs) => xs.length >= 2).sort((a, b) => b.length - a.length).slice(0, 2)
    if (groups.length === 2) {
      const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
      splitX = (mean(groups[0]!) + mean(groups[1]!)) / 2
    }
  }
  if (splitX === null) return { allies: [], enemies: [], splitX: null, enemyRows: rows.map(() => false), oneSide: strong.flat().map(strip) }
  const cut = splitX
  // Each side's squadron: the most frequent among its strong finds.
  const sideCore = (right: boolean): string | null => {
    const counts = new Map<string, number>()
    for (const m of strong.flat()) if ((m.x >= cut) === right) counts.set(core(m.clanTag), (counts.get(core(m.clanTag)) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  const enemyCore = sideCore(true)
  const allyCore = sideCore(false)
  const allies: NickMatch[] = []
  const enemies: NickMatch[] = []
  const enemyRows = rows.map(() => false)
  rows.forEach((row, index) => {
    const strongIds = new Set(strong[index]!.map((m) => m.userId))
    for (const match of row) {
      const right = match.x >= cut
      if (!strongIds.has(match.userId) && core(match.clanTag) !== (right ? enemyCore : allyCore)) continue
      if (right) {
        // One enemy per row: the first kept (best) one.
        if (enemyRows[index]) continue
        enemyRows[index] = true
        enemies.push(strip(match))
      } else {
        allies.push(strip(match))
      }
    }
  })
  return { allies, enemies, splitX, enemyRows, oneSide: [] }
}

/** OCR text right of the split in rows where no enemy was found: shown as "not recognised". */
export function unreadEnemyRows(rows: readonly OcrRow[], split: TeamSplit): string[] {
  const out: string[] = []
  if (split.splitX === null) return out
  const cut = split.splitX
  rows.forEach((row, index) => {
    if (split.enemyRows[index]) return
    // Text words only: the score columns are digits.
    const words = row.words.filter((word) => word.x0 >= cut && /\p{L}/u.test(word.text)).map((word) => word.text)
    if (words.length > 0) out.push(words.join(' ').slice(0, 60))
  })
  return out
}
