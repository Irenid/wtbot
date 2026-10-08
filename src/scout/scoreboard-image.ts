/**
 * The scoreboard (Tab) screenshot for /scout: finds the table rows and builds
 * a grey "sheet" of them for OCR. Colours are never assumed (players change
 * team colours): text is whatever stands out from its local background, rows
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

/** Separable box blur of one channel plane (edges clamped), radius r. */
function boxBlur(plane: Float32Array, width: number, height: number, r: number): Float32Array {
  const tmp = new Float32Array(plane.length)
  const out = new Float32Array(plane.length)
  const span = 2 * r + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let k = -r; k <= r; k += 1) sum += plane[row + Math.min(width - 1, Math.max(0, k))]!
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / span
      sum += plane[row + Math.min(width - 1, x + r + 1)]! - plane[row + Math.max(0, x - r)]!
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let k = -r; k <= r; k += 1) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x]!
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / span
      sum += tmp[Math.min(height - 1, y + r + 1) * width + x]! - tmp[Math.max(0, y - r) * width + x]!
    }
  }
  return out
}

/** Text pixels: colour distance from the local mean (radius r) above the threshold, any hue. */
export function textMask(image: RgbaImage, r: number, threshold = 50): Uint8Array {
  const { width, height, data } = image
  const n = width * height
  const planes = [0, 1, 2].map((c) => {
    const plane = new Float32Array(n)
    for (let i = 0; i < n; i += 1) plane[i] = data[i * 4 + c]!
    return plane
  })
  const blurred = planes.map((plane) => boxBlur(plane, width, height, r))
  const mask = new Uint8Array(n)
  const t2 = threshold * threshold
  for (let i = 0; i < n; i += 1) {
    let d = 0
    for (let c = 0; c < 3; c += 1) {
      const v = planes[c]![i]! - blurred[c]![i]!
      d += v * v
    }
    if (d > t2) mask[i] = 1
  }
  return mask
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
      const real = run.length - filled
      if (real > bestReal) {
        best = run
        bestReal = real
      }
    }
  }
  return best
}

export interface ScoreboardRows {
  rows: Band[]
  /** Median band height, px. */
  textHeight: number
}

/** Table rows: the threshold and blur radius giving the longest evenly spaced run (3–16 rows). */
export function findScoreboardRows(image: RgbaImage): ScoreboardRows | null {
  let best: Band[] = []
  // A 1080p table has ~15 px text; an upscaled crop needs a wider background window.
  for (const radius of [12, 24]) {
    const mask = textMask(image, radius)
    const profile = new Array<number>(image.height).fill(0)
    for (let y = 0; y < image.height; y += 1) {
      let count = 0
      for (let x = 0; x < image.width; x += 1) count += mask[y * image.width + x]!
      profile[y] = count
    }
    const top = [...profile].sort((a, b) => a - b)[Math.floor(profile.length * 0.995)] ?? 0
    for (const fraction of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
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

/** Text height the sheet is scaled to: Tesseract reads 20–40 px text best. */
const SHEET_TEXT_PX = 30
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
