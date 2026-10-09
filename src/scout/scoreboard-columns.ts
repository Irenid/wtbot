/**
 * The numbers in the enemy's scoreboard rows. The six columns under the header
 * icons ★ (score), plane (air targets destroyed, scout drones too), tank
 * (ground targets), wreath (assists), diamond (zones captured) and skull
 * (deaths) tell a class where the flags thin out (model.ts killLikelihood: an
 * SPAA shows air kills early, a tank ground kills, a capture rules out
 * aircraft). The timer is not read: knowing the moment moved the backtest by
 * under 0.1 point.
 *
 * Measured 2026-10-09 on the four test screenshots that show the columns
 * (1,919–2,000 px screens and two crops): the header icons stand 0.8–1.75 row
 * pitches above the first row's middle; plane → skull are evenly spaced and
 * ★ → plane is 1.76 of that spacing, while their offsets in pitches vary with
 * the screen width and UI scale (★ 17.4–22.2 pitches right of the middle).
 * Each cell's ink is its brightness over the cell's own background, cropped
 * and set three text heights apart in one line per row, read in one Tesseract
 * call with a digit whitelist; the picture's own zero (the glyph most cells
 * share) overrules a number read off a zero. 192 of 192 enemy cells on the
 * bot image's Tesseract 5.3.0, which on the bot's nick passes read 0 as "o",
 * with one cell per line dropped lone zeros, and read the zeros of the lighter
 * row stripes as 1, 4 or 9.
 */

import { runTesseract } from './ocr.js'
import { encodePgm, type RgbaImage, type ScoreboardRows } from './scoreboard-image.js'

export interface RowColumns {
  score: number | null
  air: number | null
  ground: number | null
  assists: number | null
  captures: number | null
  deaths: number | null
}

export const COLUMN_NAMES = ['score', 'air', 'ground', 'assists', 'captures', 'deaths'] as const

/** Header icons stand this many row pitches above the first row's middle. */
const HEADER_BAND_PITCHES = [0.8, 1.75] as const
/** The enemy's columns start past the row icons (row-icons.ts: 12.5–17 pitches out). */
const COLUMNS_FROM_PITCHES = 16.5
/** ★ → plane, in plane → skull spacings. */
const SCORE_GAP = 1.76
/** A header icon's width in pitches. */
const ICON_WIDTH_PITCHES = [0.25, 1.6] as const
/** Table text scaled to this height for Tesseract. */
const TEXT_PX = 36
const LINE_GAP_PX = 16
/** Cells a row apart by three text heights: closer, Tesseract 5.3.0 ran neighbours together into one number. */
const WORD_GAP_TEXT = 3
const MARGIN_PX = 24
/** A cell holds this many digits at most (★: a whole battle's score). */
const MAX_DIGITS = [5, 2, 2, 2, 2, 2] as const

const isHeaderWhite = (r: number, g: number, b: number): boolean => Math.min(r, g, b) > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 50

function pitchOf(layout: ScoreboardRows): number {
  const mids = layout.rows.map((row) => (row.y0 + row.y1) / 2)
  return mids.length < 2 ? 0 : (mids[mids.length - 1]! - mids[0]!) / (mids.length - 1)
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
}

/** The enemy side's six column centres (x, left to right) from the header icons; null — not all in the picture. */
export function findEnemyColumns(image: RgbaImage, layout: ScoreboardRows, middle: number | null): { centres: number[]; spacing: number } | null {
  const pitch = pitchOf(layout)
  const first = layout.rows[0]
  if (middle === null || !first || !(pitch > 0)) return null
  const mid = (first.y0 + first.y1) / 2
  const y0 = Math.max(0, Math.round(mid - HEADER_BAND_PITCHES[1] * pitch))
  const y1 = Math.max(y0, Math.round(mid - HEADER_BAND_PITCHES[0] * pitch))
  const x0 = Math.max(0, Math.round(middle + COLUMNS_FROM_PITCHES * pitch))
  if (x0 >= image.width || y1 <= y0) return null
  const counts = new Int32Array(image.width - x0)
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4
      if (isHeaderWhite(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!)) counts[x - x0]! += 1
    }
  }
  // Blobs: runs of columns with header pixels, joined across gaps under 0.15 pitch.
  const blobs: { start: number; end: number; mass: number; weighted: number }[] = []
  const join = Math.max(1, Math.round(0.15 * pitch))
  for (let x = 0; x < counts.length; x += 1) {
    if (counts[x]! === 0) continue
    const last = blobs[blobs.length - 1]
    if (last && x - last.end <= join) {
      last.end = x
      last.mass += counts[x]!
      last.weighted += counts[x]! * x
    } else {
      blobs.push({ start: x, end: x, mass: counts[x]!, weighted: counts[x]! * x })
    }
  }
  const centres = blobs
    .filter((blob) => {
      const width = blob.end - blob.start + 1
      return width >= ICON_WIDTH_PITCHES[0] * pitch && width <= ICON_WIDTH_PITCHES[1] * pitch && blob.mass >= 0.05 * pitch * pitch
    })
    .map((blob) => x0 + blob.weighted / blob.mass)
  // The rightmost six that keep the columns' spacing.
  for (let end = centres.length - 1; end >= 5; end -= 1) {
    const six = centres.slice(end - 5, end + 1)
    const gaps = six.slice(2).map((centre, i) => centre - six[i + 1]!)
    const spacing = median(gaps)
    const even = gaps.every((gap) => Math.abs(gap - spacing) <= 0.2 * spacing)
    const scoreGap = six[1]! - six[0]!
    if (spacing > pitch && even && Math.abs(scoreGap - SCORE_GAP * spacing) <= 0.3 * SCORE_GAP * spacing) return { centres: six, spacing }
  }
  return null
}

interface Cell { row: number; column: number; x0: number; x1: number; y0: number; y1: number }

/**
 * The enemy rows' numbers as text lines for one Tesseract call: per row its
 * cells cropped to their ink and set a word apart ("226 0 0 0 1 0"), digits
 * black on white. Tesseract 5.3.0 (the bot image's) lost lone zeros with one
 * cell per line, and misread whole cells set far apart.
 */
export function columnStrip(image: RgbaImage, layout: ScoreboardRows, columns: { centres: number[]; spacing: number }): {
  width: number
  height: number
  pixels: Uint8Array
  cells: (Cell & { left: number; width: number; glyph: Float32Array; aspect: number })[]
  lineHeight: number
  scale: number
} {
  const pitch = pitchOf(layout)
  const scale = TEXT_PX / Math.max(1, layout.textHeight)
  const halves = columns.centres.map((_, column) => (column === 0 ? 0.8 : 0.45) * columns.spacing)
  const lineHeight = Math.round(pitch * scale) + LINE_GAP_PX
  const wordGap = Math.round(TEXT_PX * WORD_GAP_TEXT)
  const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)
  const placed: { cell: Cell; ink: Float32Array; cw: number; bx0: number; bx1: number; left: number; width: number; glyph: Float32Array; aspect: number }[] = []
  const lineWidths: number[] = []
  layout.rows.forEach((band, row) => {
    const mid = (band.y0 + band.y1) / 2
    const rowCells: Cell[] = columns.centres.map((centre, column) => ({
      row,
      column,
      x0: Math.max(0, Math.round(centre - halves[column]!)),
      x1: Math.min(image.width, Math.round(centre + halves[column]!)),
      y0: Math.max(0, Math.round(mid - pitch / 2)),
      y1: Math.min(image.height, Math.round(mid + pitch / 2)),
    }))
    let cursor = MARGIN_PX
    for (const cell of rowCells) {
      const cw = cell.x1 - cell.x0
      const ch = cell.y1 - cell.y0
      if (cw <= 0 || ch <= 0) continue
      // Brightness over the cell's own background (its 30th percentile): JPEG's half-resolution colour
      // washed the hue out of thin strokes on the lighter row stripes, and a colour mask lost them.
      const ink = new Float32Array(cw * ch)
      for (let y = 0; y < ch; y += 1) {
        for (let x = 0; x < cw; x += 1) {
          const i = ((cell.y0 + y) * image.width + cell.x0 + x) * 4
          ink[y * cw + x] = Math.max(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!) / 255
        }
      }
      const background = [...ink].sort((a, b) => a - b)[Math.floor(ink.length * 0.3)]!
      let bx0 = cw
      let bx1 = -1
      let by0 = ch
      let by1 = -1
      for (let y = 0; y < ch; y += 1) {
        for (let x = 0; x < cw; x += 1) {
          const value = clamp01((ink[y * cw + x]! - background - 0.12) / 0.18)
          ink[y * cw + x] = value
          if (value >= 0.3) {
            bx0 = Math.min(bx0, x)
            bx1 = Math.max(bx1, x)
            by0 = Math.min(by0, y)
            by1 = Math.max(by1, y)
          }
        }
      }
      if (bx1 < bx0) continue // no ink: the cell stays unread
      const left = cursor
      const width = Math.round((bx1 - bx0 + 3) * scale)
      placed.push({
        cell, ink, cw, bx0: Math.max(0, bx0 - 1), bx1: Math.min(cw - 1, bx1 + 1), left, width,
        glyph: glyphVector(ink, cw, bx0, bx1, by0, by1),
        aspect: (bx1 - bx0 + 1) / (by1 - by0 + 1),
      })
      cursor = left + width + wordGap
    }
    lineWidths.push(cursor)
  })
  const width = Math.max(MARGIN_PX * 2, ...lineWidths) + MARGIN_PX
  const height = layout.rows.length * lineHeight + LINE_GAP_PX
  const pixels = new Uint8Array(width * height).fill(255)
  for (const { cell, ink, cw, bx0, bx1, left } of placed) {
    const ch = cell.y1 - cell.y0
    const top = cell.row * lineHeight + LINE_GAP_PX / 2
    const w = Math.round((bx1 - bx0 + 1) * scale)
    const h = Math.round(ch * scale)
    for (let y = 0; y < h; y += 1) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / scale - 0.5))
      const y0 = Math.floor(fy)
      const y1 = Math.min(ch - 1, y0 + 1)
      const dy = fy - y0
      for (let x = 0; x < w; x += 1) {
        const fx = Math.min(bx1, Math.max(bx0, bx0 + (x + 0.5) / scale - 0.5))
        const x0 = Math.floor(fx)
        const x1 = Math.min(bx1, x0 + 1)
        const dx = fx - x0
        const value = ink[y0 * cw + x0]! * (1 - dx) * (1 - dy) + ink[y0 * cw + x1]! * dx * (1 - dy) + ink[y1 * cw + x0]! * (1 - dx) * dy + ink[y1 * cw + x1]! * dx * dy
        pixels[(top + y) * width + left + x] = Math.round(255 * (1 - value))
      }
    }
  }
  return {
    width,
    height,
    pixels,
    cells: placed.map(({ cell, left, width: cellWidth, glyph, aspect }) => ({ ...cell, left, width: cellWidth, glyph, aspect })),
    lineHeight,
    scale,
  }
}

const GLYPH_W = 12
const GLYPH_H = 16

/** A cell's ink inside its box, resampled to GLYPH_W × GLYPH_H, mean-centred and of unit length (for correlations). */
function glyphVector(ink: Float32Array, cw: number, bx0: number, bx1: number, by0: number, by1: number): Float32Array {
  const out = new Float32Array(GLYPH_W * GLYPH_H)
  const sw = (bx1 - bx0 + 1) / GLYPH_W
  const sh = (by1 - by0 + 1) / GLYPH_H
  for (let y = 0; y < GLYPH_H; y += 1) {
    for (let x = 0; x < GLYPH_W; x += 1) {
      // Box average over the source pixels this cell of the grid covers.
      let sum = 0
      let n = 0
      for (let sy = Math.floor(by0 + y * sh); sy < Math.max(Math.floor(by0 + y * sh) + 1, Math.floor(by0 + (y + 1) * sh)); sy += 1) {
        for (let sx = Math.floor(bx0 + x * sw); sx < Math.max(Math.floor(bx0 + x * sw) + 1, Math.floor(bx0 + (x + 1) * sw)); sx += 1) {
          sum += ink[sy * cw + sx]!
          n += 1
        }
      }
      out[y * GLYPH_W + x] = sum / n
    }
  }
  const mean = out.reduce((a, b) => a + b, 0) / out.length
  let norm = 0
  for (let i = 0; i < out.length; i += 1) {
    out[i]! -= mean
    norm += out[i]! * out[i]!
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i += 1) out[i]! /= norm
  return out
}

const correlation = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!
  return sum
}

/** Glyphs this alike are one shape when finding the picture's zero (the shape most cells share: a table is mostly zeros). */
const SAME_GLYPH = 0.75
/** Cells the zero's shape needs before it is trusted, and the share of them Tesseract must read as 0. */
const MIN_ZERO_CELLS = 6
const ZERO_READ_SHARE = 0.6
/**
 * A single glyph this alike to the zero is a zero, whatever Tesseract read:
 * the test set's zeros correlated 0.34–1.00 with their picture's zero, its
 * ones and fives −0.18–0.19, the zeros Tesseract 5.3.0 read as 1, 4 or 9 0.38–0.83.
 */
const ZERO_LIKE = 0.3

/** The picture's zero: the glyph most cells match, a ring (ink round an empty middle) that Tesseract mostly reads as 0; null — none. */
export function zeroPrototype(cells: readonly { glyph: Float32Array; aspect: number }[], reads: readonly (number | null)[]): { glyph: Float32Array; aspect: number } | null {
  let best = -1
  let bestCount = 0
  cells.forEach((cell, i) => {
    let count = 0
    for (const other of cells) if (correlation(cell.glyph, other.glyph) >= SAME_GLYPH) count += 1
    if (count > bestCount) {
      best = i
      bestCount = count
    }
  })
  if (best < 0 || bestCount < MIN_ZERO_CELLS) return null
  const prototype = cells[best]!
  let middle = 0
  let sides = 0
  for (let y = 0; y < GLYPH_H; y += 1) {
    for (let x = 0; x < GLYPH_W; x += 1) {
      const value = prototype.glyph[y * GLYPH_W + x]!
      if (x >= GLYPH_W / 3 && x < (2 * GLYPH_W) / 3 && y >= GLYPH_H / 3 && y < (2 * GLYPH_H) / 3) middle += value
      else if (x < GLYPH_W / 4 || x >= (3 * GLYPH_W) / 4) sides += value
    }
  }
  if (middle >= 0 || sides <= 0) return null
  const members = cells.map((_, i) => i).filter((i) => correlation(cells[i]!.glyph, prototype.glyph) >= SAME_GLYPH)
  const read = members.filter((i) => reads[i] !== null)
  return read.length > 0 && read.filter((i) => reads[i] === 0).length / read.length >= ZERO_READ_SHARE ? prototype : null
}

/**
 * A cell's number from Tesseract's read and the picture's zero. A 0 read
 * stands; a number read off one glyph shaped like the zero is a misread zero;
 * an unread glyph like the zero is 0. Doubt falls to 0 — no kill, which the
 * model takes as no evidence without the moment — never to a kill: a real 6,
 * 8 or 9 (rarer counts) may fall to 0 too.
 */
export function cellValue(read: number | null, cell: { glyph: Float32Array; aspect: number }, zero: { glyph: Float32Array; aspect: number } | null): number | null {
  const zeroLike = zero !== null && cell.aspect <= 1.3 * zero.aspect && correlation(cell.glyph, zero.glyph) >= ZERO_LIKE
  if (read === null) return zeroLike ? 0 : null
  return read !== 0 && zeroLike ? 0 : read
}

/** Each placed cell's number as read: one centred word of digits, else null. */
export function parseColumnTsv(tsv: string, strip: { cells: readonly { row: number; column: number; left: number; width: number }[]; lineHeight: number }): (number | null)[] {
  const words: { line: number; text: string; centre: number }[] = []
  for (const line of tsv.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] !== '5' || parts.length < 12) continue
    const text = parts[11]!.trim()
    if (text === '') continue
    const left = Number(parts[6])
    const top = Number(parts[7])
    const width = Number(parts[8])
    const height = Number(parts[9])
    words.push({ line: Math.floor((top + height / 2) / strip.lineHeight), text, centre: left + width / 2 })
  }
  return strip.cells.map((cell) => {
    // The box placed for the cell, widened by half the gap on each side.
    const found = words.filter((word) => word.line === cell.row && word.centre >= cell.left - TEXT_PX && word.centre < cell.left + cell.width + TEXT_PX)
    const word = found.length === 1 ? found[0]! : null
    return word && /^\d+$/.test(word.text) && word.text.length <= MAX_DIGITS[cell.column]! ? Number(word.text) : null
  })
}

/** The enemy rows' numbers; null — the columns are not in the picture (a crop) or the middle is unknown. */
export async function readEnemyColumns(
  image: RgbaImage,
  layout: ScoreboardRows,
  middle: number | null,
  tesseract: readonly string[],
): Promise<(RowColumns | null)[] | null> {
  const columns = findEnemyColumns(image, layout, middle)
  if (!columns) return null
  const strip = columnStrip(image, layout, columns)
  const tsv = await runTesseract(encodePgm(strip), 'eng', tesseract, ['--psm', '6', '-c', 'tessedit_char_whitelist=0123456789'])
  const reads = parseColumnTsv(tsv, strip)
  const zero = zeroPrototype(strip.cells, reads)
  const out: (RowColumns | null)[] = layout.rows.map(() => null)
  strip.cells.forEach((cell, i) => {
    const row = (out[cell.row] ??= { score: null, air: null, ground: null, assists: null, captures: null, deaths: null })
    row[COLUMN_NAMES[cell.column]!] = cellValue(reads[i] ?? null, cell, zero)
  })
  return out
}
