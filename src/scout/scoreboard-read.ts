/**
 * Reads a scoreboard screenshot end to end (worker side): table rows
 * (scoreboard-image.ts) → Tesseract passes (ocr.ts) → known players and
 * teams (nick-match.ts) → the flags above the table (flags.ts) and the
 * enemy rows' icons (row-icons.ts) and numbers (scoreboard-columns.ts). The
 * test set and its scores:
 * `npm run scout:images`.
 */

import { readScoreboardFlags, tableMiddle, type FlagTemplatePack, type ScoreboardFlags } from './flags.js'
import { readEnemyRowIcons, type RowIcon } from './row-icons.js'
import { readEnemyColumns, type RowColumns } from './scoreboard-columns.js'
import { decodeImage, encodePgm, findScoreboardRows, scoreboardSheet } from './scoreboard-image.js'
import { parseTesseractTsv, runTesseract, OCR_PASSES } from './ocr.js'
import { indexPlayers, matchRows, splitTeams, unreadEnemyRows, type IndexedPlayer, type KnownPlayer, type NickMatch } from './nick-match.js'

export interface ScoreboardReadResult {
  /** no-table — no evenly spaced rows; one-side — one team read, its side unknown; no-players — nobody known. */
  status: 'ok' | 'no-table' | 'one-side' | 'no-players'
  rows: number
  /** Each row's OCR text per pass (OCR_PASSES order), for the saved record. */
  ocrRows: string[][]
  enemies: NickMatch[]
  allies: NickMatch[]
  oneSide: NickMatch[]
  /** OCR text of enemy rows nobody was recognised in. */
  unread: string[]
  /** Their rows (`unread` order). */
  unreadRows: number[]
  /** The teams' flags above the table; null — not read (no templates, no line, or one team). */
  flags: ScoreboardFlags | null
  /** Per row, the icon of a player not in a vehicle on the enemy side; null — none; the whole null — the icon column not in the picture, or one team. */
  enemyIcons: (RowIcon | null)[] | null
  /** Per row, the enemy side's numbers (null — a cell not read); the whole null — the columns are not in the picture. */
  enemyColumns: (RowColumns | null)[] | null
  ms: { layout: number; ocr: number; match: number; flags: number; columns: number }
}

/** `flags.icons` — the flags vehicles show (the vehicle dictionary's trees and operators); null — every template. */
export async function readScoreboard(
  bytes: Uint8Array,
  players: readonly IndexedPlayer[],
  tesseract: readonly string[] = ['tesseract'],
  flags: { pack: FlagTemplatePack; icons: ReadonlySet<string> | null } | null = null,
): Promise<ScoreboardReadResult> {
  const started = performance.now()
  const image = decodeImage(bytes)
  const layout = findScoreboardRows(image)
  const ms = { layout: performance.now() - started, ocr: 0, match: 0, flags: 0, columns: 0 }
  const empty = { ocrRows: [], enemies: [], allies: [], oneSide: [], unread: [], unreadRows: [], flags: null, enemyIcons: null, enemyColumns: null }
  if (!layout) return { status: 'no-table', rows: 0, ...empty, ms }
  const sheet = scoreboardSheet(image, layout)
  const ocrStarted = performance.now()
  const pgm = encodePgm(sheet)
  const readings = await Promise.all(OCR_PASSES.map(async (languages) => parseTesseractTsv(await runTesseract(pgm, languages, tesseract), sheet)))
  ms.ocr = performance.now() - ocrStarted
  const matchStarted = performance.now()
  const split = splitTeams(matchRows(readings, players))
  ms.match = performance.now() - matchStarted
  const ocrRows = layout.rows.map((_, index) => readings.map((reading) => reading[index]!.words.map((word) => word.text).join(' ')))
  const base = { rows: layout.rows.length, ocrRows, enemies: split.enemies, allies: split.allies, oneSide: split.oneSide, ms }
  if (split.splitX === null) {
    return { status: split.oneSide.length > 0 ? 'one-side' : 'no-players', unread: [], unreadRows: [], flags: null, enemyIcons: null, enemyColumns: null, ...base }
  }
  const flagsStarted = performance.now()
  const middle = tableMiddle(split.allyEdge, layout)
  const read = flags ? readScoreboardFlags(image, layout, flags.pack, middle, flags.icons) : null
  const enemyIcons = readEnemyRowIcons(image, layout, middle)
  ms.flags = performance.now() - flagsStarted
  const columnsStarted = performance.now()
  const enemyColumns = await readEnemyColumns(image, layout, middle, tesseract).catch((error: unknown) => {
    // The reply still comes without the kill columns.
    console.warn('[scout] reading the enemy columns failed:', error)
    return null
  })
  ms.columns = performance.now() - columnsStarted
  const unread = unreadEnemyRows(readings, split)
  return { status: 'ok', unread: unread.map((row) => row.text), unreadRows: unread.map((row) => row.row), flags: read, enemyIcons, enemyColumns, ...base }
}

const CANDIDATE_TTL_MS = 10 * 60_000
let candidates: { key: string; builtAt: number; index: IndexedPlayer[] } | null = null

/** The matcher's index of known players, rebuilt at most every 10 minutes per worker. */
export function candidateIndex(key: string, load: () => KnownPlayer[]): IndexedPlayer[] {
  if (candidates && candidates.key === key && Date.now() - candidates.builtAt < CANDIDATE_TTL_MS) return candidates.index
  candidates = { key, builtAt: Date.now(), index: indexPlayers(load()) }
  return candidates.index
}
