/**
 * The nation flags above the scoreboard (Tab): the countries each team has
 * spawned. The game draws one flag per country in use and only for spawned
 * players (a loading screen has none). Which flag a vehicle gets is the
 * viewer's setting: its operator's (Norway for the Swedish tree's K9 Vidar)
 * with operator flags on, its research tree's nation (or the flag the viewer
 * picked for it: Russia for the USSR) with them off. Allies' flags stand left
 * of the table's middle, the enemy's right of it. The templates are the
 * game's own flags (flag-templates.ts), compared colour by colour. Pure CPU
 * work on the decoded screenshot (worker side); measured on the test set in
 * docs/opponent-scouting.md.
 */

import type { RgbaImage, ScoreboardRows } from './scoreboard-image.js'

export interface FlagTemplatePack {
  /** Flag names (`usa`, `norway`, `republic_china`), one image each. */
  icons: string[]
  width: number
  height: number
  /** RGB, icons × height × width × 3: each flag on the scoreboard's dark background. */
  rgb: Uint8Array
}

/** The atlas flags are 100×66. */
export const FLAG_ASPECT = 100 / 66
/** The scoreboard's background behind the flags, for the templates' anti-aliased edges. */
export const FLAG_BACKGROUND: readonly [number, number, number] = [32, 36, 42]

export interface FlagLine {
  y0: number
  /** Exclusive. */
  y1: number
  /** Flag-shaped boxes, left to right. */
  boxes: { x0: number; x1: number }[]
}

export interface FlagCandidate {
  icon: string
  /** Relative to the best candidate (1). */
  likelihood: number
  /** RMS colour distance per pixel. */
  distance: number
}

export interface ReadFlag {
  x0: number
  x1: number
  /** Most likely first. */
  candidates: FlagCandidate[]
}

export interface ScoreboardFlags {
  allies: ReadFlag[]
  enemies: ReadFlag[]
}

/**
 * The flag line's middle stood 2.33–2.49 row pitches above the first row's
 * on four screenshots (1,919–2,158 px wide); its height was 0.6–0.7 pitch.
 */
const LINE_SEARCH_PITCHES: readonly [number, number] = [3.6, 1.2]
const LINE_HEIGHT_PITCHES: readonly [number, number] = [0.35, 0.95]
/**
 * The table's middle (where the flags part) is this many row pitches right of
 * the own nicks' right edge: 1.40–1.53 on four screenshots. Halfway to the
 * enemy nicks was 30–60 px off: their squadron tags differ in length.
 */
const TABLE_MIDDLE_PITCHES = 1.46
/** A pixel this far (RGB distance) from its window's median colour is not background. */
const BACKGROUND_DISTANCE = 35
/** Horizontal runs as wide as one or two flags (in pitches): text strokes are shorter, separator lines longer. */
const SOLID_RUN_PITCHES: readonly [number, number] = [0.5, 2.6]
/** Gaps between flags: 0.1–0.2 flag widths within a team, 0.6–0.7 between the teams. */
const TEAM_GAP_WIDTHS = 0.4
/** A box whose best template is farther than this is no flag (right flags: 9–69 on the test set). */
const MAX_FLAG_DISTANCE = 80
/** Candidates kept per flag: a likelihood floor and a count cap. */
const MIN_LIKELIHOOD = 0.05
const MAX_CANDIDATES = 4
/** Templates compared pixel by pixel after the coarse grid. */
const FINE_CANDIDATES = 6
const GRID_W = 10
const GRID_H = 6

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function channelMedian(histogram: Uint32Array, count: number): number {
  let seen = 0
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value]!
    if (seen * 2 >= count) return value
  }
  return 255
}

/** The row of flags above the table: solid flag-wide boxes in a band 0.35–0.95 pitches tall. */
export function findFlagLine(image: RgbaImage, layout: ScoreboardRows): FlagLine | null {
  const mids = layout.rows.map((row) => (row.y0 + row.y1) / 2)
  if (mids.length < 2) return null
  const pitch = median(mids.slice(1).map((mid, i) => mid - mids[i]!))
  const top = Math.max(0, Math.round(mids[0]! - LINE_SEARCH_PITCHES[0] * pitch))
  const bottom = Math.max(0, Math.round(mids[0]! - LINE_SEARCH_PITCHES[1] * pitch))
  const height = bottom - top
  const { width, data } = image
  if (height < pitch || pitch < 6) return null
  const background = new Uint8Array(width * height)
  const window = Math.max(8, Math.round(pitch * 4))
  for (let x0 = 0; x0 < width; x0 += window) {
    const x1 = Math.min(width, x0 + window)
    const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
    for (let y = top; y < bottom; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4
        histograms[0]![data[i]!]! += 1
        histograms[1]![data[i + 1]!]! += 1
        histograms[2]![data[i + 2]!]! += 1
      }
    }
    const count = (x1 - x0) * height
    const [r, g, b] = histograms.map((histogram) => channelMedian(histogram, count)) as [number, number, number]
    const limit = BACKGROUND_DISTANCE * BACKGROUND_DISTANCE
    for (let y = top; y < bottom; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4
        const dr = data[i]! - r
        const dg = data[i + 1]! - g
        const db = data[i + 2]! - b
        if (dr * dr + dg * dg + db * db <= limit) background[(y - top) * width + x] = 1
      }
    }
  }
  const solid = new Uint8Array(width * height)
  const rowCounts = new Array<number>(height).fill(0)
  const [minRun, maxRun] = [SOLID_RUN_PITCHES[0] * pitch, SOLID_RUN_PITCHES[1] * pitch]
  for (let y = 0; y < height; y += 1) {
    let x = 0
    while (x < width) {
      if (background[y * width + x]) {
        x += 1
        continue
      }
      const start = x
      while (x < width && !background[y * width + x]) x += 1
      if (x - start >= minRun && x - start <= maxRun) {
        solid.fill(1, y * width + start, y * width + x)
        rowCounts[y]! += x - start
      }
    }
  }
  // The line: the tallest run of pixel rows holding 30% of the busiest row's solid pixels.
  const busiest = Math.max(...rowCounts)
  if (busiest < pitch * 0.5) return null
  let line: [number, number] | null = null
  for (let y = 0; y < height; y += 1) {
    if (rowCounts[y]! < busiest * 0.3) continue
    let end = y
    while (end < height && rowCounts[end]! >= busiest * 0.3) end += 1
    const tall = end - y
    if (tall >= LINE_HEIGHT_PITCHES[0] * pitch && tall <= LINE_HEIGHT_PITCHES[1] * pitch && (!line || tall > line[1] - line[0])) line = [y, end]
    y = end
  }
  if (!line) return null
  const [ly0, ly1] = line
  const lineHeight = ly1 - ly0
  const flagWidth = lineHeight * FLAG_ASPECT
  // Columns solid in 60% of the line's rows; a stretch several flags wide is touching flags.
  const boxes: FlagLine['boxes'] = []
  const columnSolid = (x: number): boolean => {
    let count = 0
    for (let y = ly0; y < ly1; y += 1) count += solid[y * width + x]!
    return count >= lineHeight * 0.6
  }
  for (let x = 0; x < width; x += 1) {
    if (!columnSolid(x)) continue
    const start = x
    while (x < width && columnSolid(x)) x += 1
    const stretch = x - start
    if (stretch < flagWidth * 0.6) continue
    const count = Math.max(1, Math.round(stretch / flagWidth))
    for (let k = 0; k < count; k += 1) boxes.push({ x0: start + (stretch * k) / count, x1: start + (stretch * (k + 1)) / count })
  }
  return boxes.length > 0 ? { y0: top + ly0, y1: top + ly1, boxes } : null
}

/** Mean colours of a GRID_W × GRID_H grid over a box's inner part (its edge may be a pixel off). */
function colourGrid(
  data: ArrayLike<number>,
  stride: number,
  rowLength: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  offset = 0,
): Float32Array {
  const out = new Float32Array(GRID_W * GRID_H * 3)
  const mx = w * 0.08
  const my = h * 0.1
  for (let gy = 0; gy < GRID_H; gy += 1) {
    const ay = y0 + my + ((h - 2 * my) * gy) / GRID_H
    const by = y0 + my + ((h - 2 * my) * (gy + 1)) / GRID_H
    for (let gx = 0; gx < GRID_W; gx += 1) {
      const ax = x0 + mx + ((w - 2 * mx) * gx) / GRID_W
      const bx = x0 + mx + ((w - 2 * mx) * (gx + 1)) / GRID_W
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = Math.floor(ay); y < Math.ceil(by); y += 1) {
        const wy = Math.min(by, y + 1) - Math.max(ay, y)
        for (let x = Math.floor(ax); x < Math.ceil(bx); x += 1) {
          const weight = wy * (Math.min(bx, x + 1) - Math.max(ax, x))
          if (weight <= 0) continue
          const i = offset + (y * rowLength + x) * stride
          r += data[i]! * weight
          g += data[i + 1]! * weight
          b += data[i + 2]! * weight
          n += weight
        }
      }
      const o = (gy * GRID_W + gx) * 3
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
    }
  }
  return out
}

function gridDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += (a[i]! - b[i]!) ** 2
  return Math.sqrt(sum / (a.length / 3))
}

/**
 * RMS colour distance per pixel between the box and a template area-sampled
 * onto the box's pixels, the best of half-pixel shifts. A coarse grid alone
 * mistook Israel for Argentina on a 17 px flag.
 */
function fineDistance(image: RgbaImage, x0: number, y0: number, w: number, h: number, pack: FlagTemplatePack, index: number): number {
  const { width: tw, height: th, rgb } = pack
  const base = index * tw * th * 3
  let best = Number.POSITIVE_INFINITY
  for (const dy of [-0.5, 0, 0.5]) {
    for (const dx of [-0.5, 0, 0.5]) {
      const bx = x0 + dx
      const by = y0 + dy
      let sum = 0
      let n = 0
      for (let y = Math.ceil(by) + 1; y < Math.floor(by + h) - 1; y += 1) {
        if (y < 0 || y >= image.height) continue
        const ty0 = ((y - by) / h) * th
        const ty1 = ((y + 1 - by) / h) * th
        for (let x = Math.ceil(bx) + 1; x < Math.floor(bx + w) - 1; x += 1) {
          if (x < 0 || x >= image.width) continue
          const tx0 = ((x - bx) / w) * tw
          const tx1 = ((x + 1 - bx) / w) * tw
          let r = 0
          let g = 0
          let b = 0
          let area = 0
          for (let ty = Math.max(0, Math.floor(ty0)); ty < Math.min(th, Math.ceil(ty1)); ty += 1) {
            const wy = Math.min(ty1, ty + 1) - Math.max(ty0, ty)
            for (let tx = Math.max(0, Math.floor(tx0)); tx < Math.min(tw, Math.ceil(tx1)); tx += 1) {
              const weight = wy * (Math.min(tx1, tx + 1) - Math.max(tx0, tx))
              if (weight <= 0) continue
              const t = base + (ty * tw + tx) * 3
              r += rgb[t]! * weight
              g += rgb[t + 1]! * weight
              b += rgb[t + 2]! * weight
              area += weight
            }
          }
          if (area === 0) continue
          const i = (y * image.width + x) * 4
          const dr = image.data[i]! - r / area
          const dg = image.data[i + 1]! - g / area
          const db = image.data[i + 2]! - b / area
          sum += dr * dr + dg * dg + db * db
          n += 1
        }
      }
      if (n > 0) best = Math.min(best, Math.sqrt(sum / n))
    }
  }
  return best
}

/**
 * The flags a box may be: the coarse grid shortlists templates, the fine
 * comparison ranks them; likelihood exp(−(d² − best²) / 2σ²), σ growing with
 * the best distance (small and JPEG flags are farther from every template).
 * Null — no template is near: not a flag.
 */
export function classifyFlag(
  image: RgbaImage,
  y0: number,
  y1: number,
  box: { x0: number; x1: number },
  pack: FlagTemplatePack,
  templateGrids: readonly Float32Array[],
  allowed: ReadonlySet<string> | null,
): ReadFlag | null {
  const w = box.x1 - box.x0
  const h = y1 - y0
  const grid = colourGrid(image.data, 4, image.width, box.x0, y0, w, h)
  const shortlist = pack.icons
    .map((icon, index) => ({ icon, index, coarse: gridDistance(grid, templateGrids[index]!) }))
    .filter((item) => allowed === null || allowed.has(item.icon))
    .sort((a, b) => a.coarse - b.coarse)
    .slice(0, FINE_CANDIDATES)
    .map((item) => ({ icon: item.icon, distance: fineDistance(image, box.x0, y0, w, h, pack, item.index) }))
    .sort((a, b) => a.distance - b.distance)
  const best = shortlist[0]?.distance ?? Number.POSITIVE_INFINITY
  if (!(best <= MAX_FLAG_DISTANCE)) return null
  const sigma = Math.max(15, 0.4 * best)
  const candidates = shortlist
    .map((item) => ({ ...item, likelihood: Math.exp(-(item.distance ** 2 - best ** 2) / (2 * sigma * sigma)) }))
    .filter((item) => item.likelihood >= MIN_LIKELIHOOD)
    .slice(0, MAX_CANDIDATES)
  return { x0: box.x0, x1: box.x1, candidates }
}

/** Coarse grids of every template, computed once per screenshot. */
export function templateGrids(pack: FlagTemplatePack): Float32Array[] {
  const size = pack.width * pack.height * 3
  return pack.icons.map((_, index) => colourGrid(pack.rgb, 3, pack.width, 0, 0, pack.width, pack.height, index * size))
}

/**
 * Splits the line at its widest gap over TEAM_GAP_WIDTHS flags (allies left);
 * one team's flags only (the other has not spawned) take the side of the
 * table's middle they stand on. `middle` — between the teams' nick columns;
 * null — unknown, a lone group is not placed.
 */
export function splitFlagSides<T extends { x0: number; x1: number }>(flags: readonly T[], middle: number | null): { allies: T[]; enemies: T[] } {
  if (flags.length === 0) return { allies: [], enemies: [] }
  const flagWidth = median(flags.map((flag) => flag.x1 - flag.x0))
  let cut = -1
  let widest = TEAM_GAP_WIDTHS * flagWidth
  for (let i = 1; i < flags.length; i += 1) {
    const gap = flags[i]!.x0 - flags[i - 1]!.x1
    if (gap > widest) {
      widest = gap
      cut = i
    }
  }
  // The teams' gap is at the table's middle (±3 px on the test set); a gap far from it is a flag missing inside one team.
  if (cut > 0 && (middle === null || Math.abs((flags[cut - 1]!.x1 + flags[cut]!.x0) / 2 - middle) <= flagWidth)) {
    return { allies: flags.slice(0, cut), enemies: flags.slice(cut) }
  }
  if (middle === null) return { allies: [], enemies: [] }
  const allies = flags.filter((flag) => flag.x1 <= middle + 0.25 * flagWidth)
  const enemies = flags.filter((flag) => flag.x0 >= middle - 0.25 * flagWidth)
  // A flag astride the middle: the line is not where the teams' columns say.
  return allies.length + enemies.length === flags.length ? { allies, enemies } : { allies: [], enemies: [] }
}

/** The x between the teams' halves from the own nicks' right edge (nick-match.ts splitTeams); null — unknown. */
export function tableMiddle(allyEdge: number | null, layout: ScoreboardRows): number | null {
  if (allyEdge === null) return null
  const mids = layout.rows.map((row) => (row.y0 + row.y1) / 2)
  return allyEdge + TABLE_MIDDLE_PITCHES * median(mids.slice(1).map((mid, i) => mid - mids[i]!))
}

/** Both teams' flags as read; null — no flag line above the table (a crop, or nobody has spawned). */
export function readScoreboardFlags(
  image: RgbaImage,
  layout: ScoreboardRows,
  pack: FlagTemplatePack,
  middle: number | null,
  allowed: ReadonlySet<string> | null = null,
): ScoreboardFlags | null {
  const line = findFlagLine(image, layout)
  if (!line) return null
  const grids = templateGrids(pack)
  const sides = splitFlagSides(line.boxes, middle)
  const read = (boxes: readonly { x0: number; x1: number }[]) => boxes
    .map((box) => classifyFlag(image, line.y0, line.y1, box, pack, grids, allowed))
    .filter((flag): flag is ReadFlag => flag !== null)
  return { allies: read(sides.allies), enemies: read(sides.enemies) }
}
