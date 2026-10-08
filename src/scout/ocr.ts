/**
 * Tesseract OCR of the scoreboard sheet (scoreboard-image.ts): one process
 * per pass, the sheet on stdin as PGM, words with boxes back as TSV. The
 * Docker image ships the models of OCR_PASSES (Dockerfile); without the
 * binary /scout images answer that reading is unavailable.
 */

import { spawn } from 'node:child_process'
import type { ScoreboardSheet } from './scoreboard-image.js'

/**
 * One pass per model, run in parallel, each reading every word in its own
 * script. A mixed model (eng+rus+chi_sim) picks one per word and read Latin
 * nicks in Cyrillic ("Azadx5x" → "Агадх5х"), Chinese ones as Latin noise.
 * Measured 2026-10-08 (docs/opponent-scouting.md): of 51 known enemies on 8
 * screenshots the mixed model found 34, eng + rus + chi_sim 48, with HanS
 * (the script model reads other Chinese nicks than the language one) 50, none
 * false; of 48 kana-decorated nicks on synthetic tables 19 without jpn, 35
 * with it. CPU per 42 px sheet: eng and rus 0.35 s, the others 0.5 s each.
 */
export const OCR_PASSES: readonly string[] = ['eng', 'rus', 'chi_sim', 'HanS', 'jpn']
const OCR_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface OcrWord {
  text: string
  /** Source-image x range. */
  x0: number
  x1: number
  confidence: number
}

/** One table row's words, left to right. */
export interface OcrRow {
  words: OcrWord[]
}

export class OcrUnavailableError extends Error {}

/** `command` — the binary and leading arguments (tests and tools run it in a container). */
export function runTesseract(input: Uint8Array, languages: string, command: readonly string[] = ['tesseract']): Promise<string> {
  return new Promise((resolve, reject) => {
    const [binary, ...prefix] = command
    const child = spawn(binary!, [...prefix, 'stdin', 'stdout', '-l', languages, '--psm', '6', 'tsv'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OMP_THREAD_LIMIT: '2' },
    })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), OCR_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? new OcrUnavailableError('tesseract is not installed') : error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(`tesseract exited with ${signal ?? code}: ${stderr.trim().slice(0, 300)}`))
    })
    child.stdin.on('error', () => {
      // The process died early; 'close' reports why.
    })
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.length))
  })
}

/** TSV words (level 5) placed into sheet rows by their vertical centre; x back in source pixels. */
export function parseTesseractTsv(tsv: string, sheet: Pick<ScoreboardSheet, 'scale' | 'rowSpans'>): OcrRow[] {
  const rows: OcrRow[] = sheet.rowSpans.map(() => ({ words: [] }))
  const lines = tsv.split('\n')
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    if (cells.length < 12 || cells[0] !== '5') continue
    const text = cells.slice(11).join('\t').trim()
    if (text === '') continue
    const left = Number(cells[6])
    const top = Number(cells[7])
    const width = Number(cells[8])
    const height = Number(cells[9])
    const confidence = Number(cells[10])
    if (![left, top, width, height].every(Number.isFinite)) continue
    const centre = top + height / 2
    const index = sheet.rowSpans.findIndex((span) => centre >= span.top - 4 && centre <= span.bottom + 4)
    if (index < 0) continue
    rows[index]!.words.push({ text, x0: left / sheet.scale, x1: (left + width) / sheet.scale, confidence })
  }
  for (const row of rows) row.words.sort((a, b) => a.x0 - b.x0)
  return rows
}
