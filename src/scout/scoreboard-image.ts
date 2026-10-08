/**
 * The scoreboard (Tab) screenshot for /scout: finds the table rows and builds
 * a grey "sheet" of them for OCR. Colours are never assumed (players change
 * team colours): text is where colour changes sharply along a pixel row, rows
 * are the longest run of evenly spaced text bands. The layout is the only
 * given: allies on the left, enemies on the right (nick-match.ts).
 * Pure CPU work on untrusted bytes: runs in a worker, sizes are bounded.
 */

import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

export interface RgbaImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array
}

/** 8K screenshots at most: 33 Mpx × 4 bytes. */
export const MAX_IMAGE_PIXELS = 7680 * 4320
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export function decodeImage(bytes: Uint8Array): RgbaImage {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image too large')
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) {
    // IHDR right after the signature: check the size before inflating.
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    if (width * height > MAX_IMAGE_PIXELS) throw new Error('Image too large')
    const png = PNG.sync.read(buffer)
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: MAX_IMAGE_PIXELS / 1e6, maxMemoryUsageInMB: 512 })
    return { width: decoded.width, height: decoded.height, data: decoded.data }
  }
  throw new Error('Not a PNG or JPEG image')
}

/**
 * Per pixel row, the pixels whose colour differs from the pixel `step` px to
 * the right by more than `threshold` (any hue). Text strokes give many; gaps
 * between rows, the own row's frame line and smooth backgrounds give none. A
 * local-mean mask haloed dense CJK text and merged three rows into one band.
 */
export function edgeProfile(image: RgbaImage, step: number, threshold = 40): number[] {
  const { width, height, data } = image
  const t2 = threshold * threshold
  const profile = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    let count = 0
    for (let i = y * width * 4, end = i + (width - step) * 4; i < end; i += 4) {
      const j = i + step * 4
      const dr = data[i]! - data[j]!
      const dg = data[i + 1]! - data[j + 1]!
      const db = data[i + 2]! - data[j + 2]!
      if (dr * dr + dg * dg + db * db > t2) count += 1
    }
    profile[y] = count
  }
  return profile
}

export interface Band {
  y0: number
  /** Exclusive. */
  y1: number
}

function bandsAt(profile: readonly number[], threshold: number): Band[] {
  const bands: Band[] = []
  let y = 0
  while (y < profile.length) {
    if (profile[y]! > threshold) {
      const y0 = y
      while (y < profile.length && profile[y]! > threshold) y += 1
      if (y - y0 >= 5 && y - y0 <= 90) bands.push({ y0, y1: y })
    }
    y += 1
  }
  return bands
}

/**
 * The longest run of bands with one pitch (±15%) and similar heights (the own
 * highlighted row's band may be twice as tall). Up to two missing rows are
 * filled in at the expected position: a row whose text blends into its
 * background still gets read.
 */
function regularRun(bands: readonly Band[]): Band[] {
  const mids = bands.map((band) => (band.y0 + band.y1) / 2)
  let best: Band[] = []
  let bestReal = 0
  for (let i = 0; i < bands.length; i += 1) {
    const height = bands[i]!.y1 - bands[i]!.y0
    for (let j = i + 1; j < Math.min(i + 3, bands.length); j += 1) {
      const pitch = mids[j]! - mids[i]!
      if (pitch < height * 1.05) continue
      const run: Band[] = [bands[i]!, bands[j]!]
      let last = j
      let lastMid = mids[j]!
      let filled = 0
      for (;;) {
        const find = (target: number) => {
          for (let k = last + 1; k < bands.length; k += 1) {
            const ratio = (bands[k]!.y1 - bands[k]!.y0) / height
            if (Math.abs(mids[k]! - target) <= pitch * 0.15 && ratio >= 0.6 && ratio <= 2.2) return k
          }
          return -1
        }
        let k = find(lastMid + pitch)
        if (k >= 0) {
          run.push(bands[k]!)
        } else if (filled < 2 && (k = find(lastMid + 2 * pitch)) >= 0) {
          const mid = lastMid + pitch
          run.push({ y0: Math.round(mid - height / 2), y1: Math.round(mid + height / 2) }, bands[k]!)
          filled += 1
        } else {
          break
        }
        last = k
        lastMid = mids[k]!
      }
      trimEnds(run)
      const real = run.length - filled
      if (real > bestReal) {
        best = run
        bestReal = real
      }
    }
  }
  return best
}

/**
 * A run's first pitch is its first two bands' distance, and later bands only
 * need to be near the previous one: a header line 1.2 pitches above the table
 * (the column icons) could start it. End rows more than 10% off the median
 * pitch go.
 */
function trimEnds(run: Band[]): void {
  const mid = (band: Band) => (band.y0 + band.y1) / 2
  while (run.length > 3) {
    const gaps = run.slice(1).map((band, i) => mid(band) - mid(run[i]!)).sort((a, b) => a - b)
    const pitch = gaps[Math.floor(gaps.length / 2)]!
    const off = (gap: number) => Math.abs(gap - pitch) > pitch * 0.1
    if (off(mid(run[1]!) - mid(run[0]!))) run.shift()
    else if (off(mid(run.at(-1)!) - mid(run.at(-2)!))) run.pop()
    else break
  }
}

export interface ScoreboardRows {
  rows: Band[]
  /** Median band height, px. */
  textHeight: number
}

/** Table rows: the edge step and threshold giving the longest evenly spaced run (3–16 rows). */
export function findScoreboardRows(image: RgbaImage): ScoreboardRows | null {
  let best: Band[] = []
  // Step 2 also catches the soft edges of an upscaled, blurred crop.
  for (const step of [1, 2]) {
    const profile = edgeProfile(image, step)
    const top = [...profile].sort((a, b) => a - b)[Math.floor(profile.length * 0.995)] ?? 0
    // Highest first: on a tie its bands hug the letters (the sheet's scale) rather than the taller icons.
    for (const fraction of [0.4, 0.3, 0.2, 0.1, 0.05]) {
      const run = regularRun(bandsAt(profile, top * fraction))
      if (run.length > best.length) best = run
    }
    if (best.length >= 6) break
  }
  if (best.length < 3) return null
  const heights = best.map((band) => band.y1 - band.y0).sort((a, b) => a - b)
  return { rows: best.slice(0, 16), textHeight: heights[Math.floor(heights.length / 2)]! }
}

export interface ScoreboardSheet {
  width: number
  height: number
  /** Grey, 1 byte per pixel: dark text on white. */
  pixels: Uint8Array
  /** Sheet pixels per source pixel. */
  scale: number
  /** Sheet y range of each row, in row order. */
  rowSpans: { top: number; bottom: number }[]
}

/** Text height the sheet is scaled to: on the test set 30 px found 49 of 51 enemies and 46 of 47 allies, 36 px 50 and 46, 42 and 48 px 50 and 47. */
const SHEET_TEXT_PX = 42
const MAX_SHEET_PIXELS = 40_000_000

function channelMedian(values: Uint32Array, count: number): number {
  let seen = 0
  for (let v = 0; v < 256; v += 1) {
    seen += values[v]!
    if (seen * 2 >= count) return v
  }
  return 255
}

/**
 * The rows stacked into one grey image: each pixel's colour distance from the
 * median colour of its row strip in windows four text heights wide (a local
 * box blur would hollow out dense CJK strokes), scaled to SHEET_TEXT_PX.
 */
export function scoreboardSheet(image: RgbaImage, layout: ScoreboardRows): ScoreboardSheet {
  const th = layout.textHeight
  const pad = Math.round(th * 0.5)
  const window = Math.max(8, th * 4)
  const scale = Math.max(1, Math.min(4, SHEET_TEXT_PX / th))
  const strips = layout.rows.map(({ y0, y1 }) => {
    const top = Math.max(0, y0 - pad)
    const bottom = Math.min(image.height, y1 + pad)
    const height = bottom - top
    const out = new Float32Array(height * image.width)
    for (let x0 = 0; x0 < image.width; x0 += window) {
      const x1 = Math.min(image.width, x0 + window)
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
      for (let y = top; y < bottom; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * image.width + x) * 4
          hist[0]![image.data[i]!]! += 1
          hist[1]![image.data[i + 1]!]! += 1
          hist[2]![image.data[i + 2]!]! += 1
        }
      }
      const count = (x1 - x0) * height
      const median = hist.map((h) => channelMedian(h, count))
      for (let y = top; y < bottom; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * image.width + x) * 4
          const dr = image.data[i]! - median[0]!
          const dg = image.data[i + 1]! - median[1]!
          const db = image.data[i + 2]! - median[2]!
          out[(y - top) * image.width + x] = Math.sqrt(dr * dr + dg * dg + db * db)
        }
      }
    }
    return { out, height }
  })
  const gap = 8
  const sourceHeight = strips.reduce((sum, strip) => sum + strip.height + gap, 0)
  let factor = scale
  while (Math.round(image.width * factor) * Math.round(sourceHeight * factor) > MAX_SHEET_PIXELS && factor > 1) factor *= 0.9
  const width = Math.round(image.width * factor)
  const height = Math.round(sourceHeight * factor)
  const pixels = new Uint8Array(width * height).fill(255)
  const rowSpans: { top: number; bottom: number }[] = []
  let offset = 0
  for (const strip of strips) {
    const top = Math.round((offset + gap / 2) * factor)
    const bottom = Math.round((offset + gap / 2 + strip.height) * factor)
    rowSpans.push({ top, bottom })
    for (let sy = top; sy < bottom; sy += 1) {
      // Bilinear sample of the strip.
      const fy = Math.min(strip.height - 1, Math.max(0, (sy + 0.5) / factor - (offset + gap / 2) - 0.5))
      const y0 = Math.floor(fy)
      const y1 = Math.min(strip.height - 1, y0 + 1)
      const wy = fy - y0
      for (let sx = 0; sx < width; sx += 1) {
        const fx = Math.min(image.width - 1, Math.max(0, (sx + 0.5) / factor - 0.5))
        const x0 = Math.floor(fx)
        const x1 = Math.min(image.width - 1, x0 + 1)
        const wx = fx - x0
        const a = strip.out[y0 * image.width + x0]! * (1 - wx) + strip.out[y0 * image.width + x1]! * wx
        const b = strip.out[y1 * image.width + x0]! * (1 - wx) + strip.out[y1 * image.width + x1]! * wx
        const d = a * (1 - wy) + b * wy
        pixels[sy * width + sx] = 255 - Math.max(0, Math.min(255, Math.round((d - 20) * 2.5)))
      }
    }
    offset += strip.height + gap
  }
  return { width, height, pixels, scale: factor, rowSpans }
}

/** Binary PGM (P5): Tesseract reads it from stdin through Leptonica. */
export function encodePgm(sheet: Pick<ScoreboardSheet, 'width' | 'height' | 'pixels'>): Uint8Array {
  const header = Buffer.from(`P5\n${sheet.width} ${sheet.height}\n255\n`, 'ascii')
  const out = new Uint8Array(header.length + sheet.pixels.length)
  out.set(header, 0)
  out.set(sheet.pixels, header.length)
  return out
}
