import { PNG } from 'pngjs'

/**
 * The datamine's vehicle tiles are cropped by the game's atlas: a long aircraft or ship runs off
 * the tile (27 of 1,476 icons on 2026-10-22: Pe-2, Canberra, Tu-14T, battleships), and the cut shows
 * as a hard edge. The lost pixels are not in any source, so such an edge fades out instead.
 */

/** Opaque pixels along a tile edge that make it a cut rather than a silhouette brushing the border. */
const CUT_MIN_PIXELS = 8
const OPAQUE_ALPHA = 100
/** Tile pixels over which a cut edge fades to transparent (about 6 px on the 56 px row icon). */
const FADE_PIXELS = 8

/** The PNG with every cut edge faded; the same buffer when no edge is cut or the data is not a readable PNG. */
export function fadeCutEdges(data: Buffer): Buffer {
  let png: PNG
  try {
    png = PNG.sync.read(data)
  } catch {
    return data
  }
  const { width, height } = png
  const alphaAt = (x: number, y: number): number => png.data[(y * width + x) * 4 + 3]!
  const count = (length: number, at: (i: number) => number): number => {
    let opaque = 0
    for (let i = 0; i < length; i++) if (at(i) > OPAQUE_ALPHA) opaque++
    return opaque
  }
  const left = count(height, (y) => alphaAt(0, y)) >= CUT_MIN_PIXELS
  const right = count(height, (y) => alphaAt(width - 1, y)) >= CUT_MIN_PIXELS
  const top = count(width, (x) => alphaAt(x, 0)) >= CUT_MIN_PIXELS
  const bottom = count(width, (x) => alphaAt(x, height - 1)) >= CUT_MIN_PIXELS
  if (!left && !right && !top && !bottom) return data

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = 1
      if (left) keep = Math.min(keep, (x + 0.5) / FADE_PIXELS)
      if (right) keep = Math.min(keep, (width - x - 0.5) / FADE_PIXELS)
      if (top) keep = Math.min(keep, (y + 0.5) / FADE_PIXELS)
      if (bottom) keep = Math.min(keep, (height - y - 0.5) / FADE_PIXELS)
      if (keep >= 1) continue
      const index = (y * width + x) * 4 + 3
      png.data[index] = Math.round(png.data[index]! * keep)
    }
  }
  return PNG.sync.write(png)
}
