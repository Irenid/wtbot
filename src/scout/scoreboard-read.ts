/**
 * Reads a scoreboard screenshot end to end (worker side): table rows
 * (scoreboard-image.ts) → Tesseract passes (ocr.ts) → known players and
 * teams (nick-match.ts). The test set and its scores: `npm run scout:images`.
 */

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
  ms: { layout: number; ocr: number; match: number }
}

export async function readScoreboard(
  bytes: Uint8Array,
  players: readonly IndexedPlayer[],
  tesseract: readonly string[] = ['tesseract'],
): Promise<ScoreboardReadResult> {
  const started = performance.now()
  const image = decodeImage(bytes)
  const layout = findScoreboardRows(image)
  const ms = { layout: performance.now() - started, ocr: 0, match: 0 }
  const empty = { ocrRows: [], enemies: [], allies: [], oneSide: [], unread: [] }
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
  if (split.splitX === null) return { status: split.oneSide.length > 0 ? 'one-side' : 'no-players', unread: [], ...base }
  return { status: 'ok', unread: unreadEnemyRows(readings, split), ...base }
}

const CANDIDATE_TTL_MS = 10 * 60_000
let candidates: { key: string; builtAt: number; index: IndexedPlayer[] } | null = null

/** The matcher's index of known players, rebuilt at most every 10 minutes per worker. */
export function candidateIndex(key: string, load: () => KnownPlayer[]): IndexedPlayer[] {
  if (candidates && candidates.key === key && Date.now() - candidates.builtAt < CANDIDATE_TTL_MS) return candidates.index
  candidates = { key, builtAt: Date.now(), index: indexPlayers(load()) }
  return candidates.index
}
