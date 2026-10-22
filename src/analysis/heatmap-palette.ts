import { writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'

/**
 * Generates the heatmap track palette (src/wrpl/heatmap-palette.ts): for every
 * pair (own players, enemy players), 1..8 each, the colours of both teams.
 *
 *   npx tsx src/analysis/heatmap-palette.ts [--report] [--write] [--pairs=4-8]
 *
 * Method (the table is static; rerun only when a rule below changes):
 * - candidates: an OKLCH grid (hue HUE_STEP, lightness MIN_LIGHTNESS to
 *   MAX_LIGHTNESS, chroma from the sRGB edge down) that the map cannot swallow:
 *   at least MIN_MAP_DELTA from every MAP_COLOURS entry, dark colours vivid
 *   (minChroma), yellows bright (KHAKI_HUES: dark ones are the maps' olive);
 * - team families by hue, as the game map draws the spawns: the image's own
 *   team cool (cyan, blue, violet, purple), the other team warm (pink, red,
 *   orange, yellow). The families meet at two cuts, in the greens and in the
 *   magentas, and keep half a gap clear of each (GREEN_GAP, MAGENTA_GAP), so
 *   balanced teams use no green or magenta and a track's team reads from its
 *   hue. A cut moves CUT_SHIFT per player of difference toward the smaller
 *   team (cutRanges): the bigger team takes greens or magentas (8 v 4), the
 *   smaller one keeps its core;
 * - per pair, the a + b colours maximise the smallest distance in the whole
 *   picture: inside a team OKLab ΔE, and protan and deutan ΔE (Machado 2009,
 *   severity 1) times CVD_WEIGHT; across the teams the smallest of the three.
 *   Distances count up to DISTANCE_CAP (past it colours are unmistakable and
 *   the hues nearest the team anchors win); ties go to a soft minimum over
 *   every pair (ENERGY_SCALE), which pushes the next closest pairs apart.
 *   Every pair is searched on its own: a third player may move the first two;
 * - search: CHAINS seeded chains per pair, each a local search (every colour
 *   swapped for its team's best candidate) restarted from PERTURBATIONS random
 *   kicks; (pair, chain) tasks spread over one worker per core, so the table
 *   is reproducible on any machine.
 */

type Lab = [number, number, number]

/**
 * The ground under the tracks: k-means (24) of the 193 squadron ground maps as
 * the heatmap draws them, untinted, 2026-10-22: the texture in the game's tone,
 * without the hatch and icons (the team families take the spawns' blue and
 * red); a pixel lies within 0.049 ΔE of its centroid (p99).
 */
const MAP_COLOURS = [
  '#24211C', '#2D3030', '#3C3621', '#3E4144', '#454227', '#514D32', '#535352', '#4A5D37', '#60573B', '#63625F', '#6B6245', '#547040',
  '#8E5B43', '#7D6C4F', '#707374', '#717A55', '#8E795B', '#818963', '#848787', '#A59475', '#A1A1A0', '#B6A98E', '#B8B7B5', '#C9C8C7',
]
const MIN_MAP_DELTA = 0.15
/** Below it a track fades on the darkest maps (L 0.25) even with its dark outline. */
const MIN_LIGHTNESS = 0.6
const MAX_LIGHTNESS = 0.96
/** Paler colours turn whitish on a 3 px line and lose their team's hue; a darker colour needs VIVID_SLOPE more per unit below VIVID_LIGHTNESS. */
const MIN_CHROMA = 0.11
const VIVID_LIGHTNESS = 0.75
const VIVID_SLOPE = 0.4
/** Dark yellows are olive and mustard, the maps' own khaki: amber to yellow-green hues need KHAKI_MIN_LIGHTNESS. */
const KHAKI_HUES = [75, 135] as const
const KHAKI_MIN_LIGHTNESS = 0.8
const HUE_STEP = 2.5
const LIGHTNESS_STEP = 0.02
const CHROMA_STEPS = [0, 0.035, 0.07]
/**
 * Colour-blind distances count three times: dichromats keep a third of the
 * separation, normal vision loses 4% of it (CVD_WEIGHT 2 cost 15%, 2026-10-22).
 */
const CVD_WEIGHT = 3
const DISTANCE_CAP = 0.3
const ENERGY_SCALE = 0.015
const MAX_PLAYERS = 8

/**
 * OKLCH hue degrees. Balanced teams meet at these cuts: the green one between
 * yellow (110°) and aquamarine (166°), the magenta one between purple (313°)
 * and rose (344°). Half a gap on either side stays empty (warm ≤ 112°, cool
 * 168°..310°, warm ≥ 350°): lime, green and spring green read as neither team.
 */
const GREEN_CUT = 140
const MAGENTA_CUT = 330
const GREEN_GAP = 56
const MAGENTA_GAP = 40
/** A cut moves CUT_SLACK either way, and CUT_SHIFT per player of difference toward the smaller team, CUT_LIMIT at most. */
const CUT_SLACK = 3
const CUT_SHIFT = 5
const CUT_LIMIT = 30
/** Single players and ties take the hues nearest these: azure for the own team, red-orange for the other. */
const COOL_ANCHOR = 235
const WARM_ANCHOR = 35

/**
 * Search effort per pair. A sixth of it (16 chains × 120 kicks) found the same
 * palettes for 21 of the 25 ground pairs 4..8 and at most 0.0045 less for the
 * rest (2026-10-22).
 */
const CHAINS = 64
const PERTURBATIONS = 300
/** Near candidates per colour: half the kicks move a colour to one of them. */
const NEARBY = 32

const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]] as const
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]] as const

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)]
}

function linearToLab([r, g, b]: readonly [number, number, number]): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklchToLinear(L: number, C: number, hDeg: number): [number, number, number] {
  const a = C * Math.cos((hDeg * Math.PI) / 180)
  const b = C * Math.sin((hDeg * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: readonly number[]): boolean => rgb.every((c) => c >= -0.0004 && c <= 1.0004)
const toHex = (rgb: readonly number[]): string =>
  '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()

const simulate = (m: readonly (readonly number[])[], [r, g, b]: readonly [number, number, number]): [number, number, number] => [
  m[0]![0]! * r + m[0]![1]! * g + m[0]![2]! * b,
  m[1]![0]! * r + m[1]![1]! * g + m[1]![2]! * b,
  m[2]![0]! * r + m[2]![1]! * g + m[2]![2]! * b,
]

const delta = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const minChroma = (lightness: number): number => MIN_CHROMA + VIVID_SLOPE * Math.max(0, VIVID_LIGHTNESS - lightness)

export interface Swatch {
  hex: string
  /** OKLCH hue, degrees. */
  hue: number
  lightness: number
  chroma: number
  normal: Lab
  protan: Lab
  deutan: Lab
}

export function swatch(hex: string): Swatch {
  const lin = hexToLinear(hex)
  const normal = linearToLab(lin)
  return {
    hex: hex.toUpperCase(),
    hue: ((Math.atan2(normal[2], normal[1]) * 180) / Math.PI + 360) % 360,
    lightness: normal[0],
    chroma: Math.hypot(normal[1], normal[2]),
    normal,
    protan: linearToLab(simulate(PROTAN, lin)),
    deutan: linearToLab(simulate(DEUTAN, lin)),
  }
}

/** The distance that tells two tracks of one team apart: ΔE, and ΔE under colour blindness weighted. */
function teamDistance(a: Swatch, b: Swatch): number {
  return Math.min(delta(a.normal, b.normal), CVD_WEIGHT * Math.min(delta(a.protan, b.protan), delta(a.deutan, b.deutan)))
}

/** The distance between the teams' colours: the smallest over all three vision types. */
function crossDistance(a: Swatch, b: Swatch): number {
  return Math.min(delta(a.normal, b.normal), delta(a.protan, b.protan), delta(a.deutan, b.deutan))
}

/** The smallest within-team distance (teamDistance) of a team's colours. */
export function smallestDistance(colours: readonly string[]): number {
  const sw = colours.map(swatch)
  let min = Infinity
  for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) min = Math.min(min, teamDistance(sw[i]!, sw[j]!))
  return min
}

/** The smallest plain ΔE inside a team: what a viewer with normal colour vision tells apart. */
export function smallestNormalDistance(colours: readonly string[]): number {
  const sw = colours.map(swatch)
  let min = Infinity
  for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) min = Math.min(min, delta(sw[i]!.normal, sw[j]!.normal))
  return min
}

export function smallestCrossDistance(a: readonly string[], b: readonly string[]): number {
  const sa = a.map(swatch)
  const sb = b.map(swatch)
  return Math.min(...sa.flatMap((x) => sb.map((y) => crossDistance(x, y))))
}

export function smallestMapDistance(colours: readonly string[]): number {
  const map = MAP_COLOURS.map((hex) => linearToLab(hexToLinear(hex)))
  return Math.min(...colours.flatMap((hex) => map.map((m) => delta(swatch(hex).normal, m))))
}

/** A warm hue unrolled past 0° on the green side (−180..180) and on the magenta side (180..540). */
const warmGreenSide = (hue: number): number => (hue >= 180 ? hue - 360 : hue)
const warmMagentaSide = (hue: number): number => (hue < 180 ? hue + 360 : hue)

/** Where the two cuts may lie for a pair of team sizes, [low, high] each. */
export interface CutRanges {
  green: [number, number]
  magenta: [number, number]
}

/**
 * The bigger team's side grows by CUT_SHIFT per player of difference: the
 * cool side's green edge moves down and its magenta edge up, the warm side's
 * the other way; the smaller team keeps its core hues (8 v 4: 20°).
 */
export function cutRanges(own: number, enemy: number): CutRanges {
  const shift = Math.min(CUT_LIMIT, CUT_SHIFT * Math.abs(own - enemy))
  const cool = own > enemy ? shift : 0
  const warm = enemy > own ? shift : 0
  return {
    green: [GREEN_CUT - CUT_SLACK - cool, GREEN_CUT + CUT_SLACK + warm],
    magenta: [MAGENTA_CUT - CUT_SLACK - warm, MAGENTA_CUT + CUT_SLACK + cool],
  }
}

/** Whether a hue may belong to the own (cool) team under these ranges. */
function isCoolHue(hue: number, ranges: CutRanges): boolean {
  return hue >= ranges.green[0] + GREEN_GAP / 2 && hue <= ranges.magenta[1] - MAGENTA_GAP / 2
}

/** Whether a hue may belong to the other (warm) team under these ranges. */
function isWarmHue(hue: number, ranges: CutRanges): boolean {
  const unrolled = warmMagentaSide(hue)
  return unrolled >= ranges.magenta[0] + MAGENTA_GAP / 2 && unrolled <= ranges.green[1] - GREEN_GAP / 2 + 360
}

/**
 * The cuts that keep both teams on their sides, or null: the green cut lies
 * half a gap past the warm team's greenest hue and short of the cool team's,
 * the magenta cut likewise, each inside its range.
 */
export function cutsFor(own: readonly number[], enemy: readonly number[], ranges: CutRanges): CutRanges | null {
  const greenLow = Math.max(ranges.green[0], Math.max(...enemy.map(warmGreenSide)) + GREEN_GAP / 2)
  const greenHigh = Math.min(ranges.green[1], Math.min(...own) - GREEN_GAP / 2)
  const magentaLow = Math.max(ranges.magenta[0], Math.max(...own) + MAGENTA_GAP / 2)
  const magentaHigh = Math.min(ranges.magenta[1], Math.min(...enemy.map(warmMagentaSide)) - MAGENTA_GAP / 2)
  if (greenLow > greenHigh + 1e-9 || magentaLow > magentaHigh + 1e-9) return null
  return { green: [greenLow, greenHigh], magenta: [magentaLow, magentaHigh] }
}

function candidatePool(): Swatch[] {
  const map = MAP_COLOURS.map((hex) => linearToLab(hexToLinear(hex)))
  const byHex = new Map<string, Swatch>()
  for (let h = 0; h < 360; h += HUE_STEP) {
    for (let L = MIN_LIGHTNESS; L <= MAX_LIGHTNESS + 1e-9; L += LIGHTNESS_STEP) {
      // The most saturated colour that fits sRGB at this lightness and hue.
      let lo = 0
      let hi = 0.4
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2
        if (inGamut(oklchToLinear(L, mid, h))) lo = mid
        else hi = mid
      }
      for (const step of CHROMA_STEPS) {
        const C = lo - step
        if (C < MIN_CHROMA) continue
        const s = swatch(toHex(oklchToLinear(L, C, h)))
        if (s.chroma < minChroma(s.lightness) || s.lightness < MIN_LIGHTNESS - 0.005) continue
        if (s.hue >= KHAKI_HUES[0] && s.hue <= KHAKI_HUES[1] && s.lightness < KHAKI_MIN_LIGHTNESS) continue
        if (map.some((m) => delta(s.normal, m) < MIN_MAP_DELTA)) continue
        byHex.set(s.hex, s)
      }
    }
  }
  return [...byHex.values()].sort((a, b) => a.hex.localeCompare(b.hex))
}

/** A seeded PRNG (mulberry32): the same chain always runs the same search. */
function random(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

interface Palettes {
  own: string[]
  enemy: string[]
}

interface Score {
  /** The smallest distance anywhere in the picture, capped at DISTANCE_CAP. */
  smallest: number
  /** Σ exp(−d / ENERGY_SCALE) over every pair: the next closest pairs. */
  energy: number
  /** Hue distance from the team anchors, for ties. */
  anchor: number
}

/** Lexicographic: the smallest distance, then the soft minimum, then the anchors. */
function betterScore(a: Score, b: Score): boolean {
  if (a.smallest > b.smallest + 1e-9) return true
  if (a.smallest < b.smallest - 1e-9) return false
  const scale = Math.max(a.energy, b.energy, 1e-300)
  if (a.energy < b.energy - scale * 1e-9) return true
  if (a.energy > b.energy + scale * 1e-9) return false
  return a.anchor < b.anchor - 1e-12
}

const anchorOf = (hue: number, team: number): number => hueGap(hue, team === 0 ? COOL_ANCHOR : WARM_ANCHOR) / 180

/** A palette's score from its hex colours: every thread computes the same. */
function paletteScore({ own, enemy }: Palettes): Score {
  const sw = [...own, ...enemy].map(swatch)
  let smallest = DISTANCE_CAP
  let energy = 0
  let anchor = 0
  for (let p = 0; p < sw.length; p++) {
    anchor += anchorOf(sw[p]!.hue, p < own.length ? 0 : 1)
    for (let q = p + 1; q < sw.length; q++) {
      const same = (p < own.length) === (q < own.length)
      const d = Math.min(DISTANCE_CAP, same ? teamDistance(sw[p]!, sw[q]!) : crossDistance(sw[p]!, sw[q]!))
      smallest = Math.min(smallest, d)
      energy += Math.exp(-d / ENERGY_SCALE)
    }
  }
  return { smallest, energy, anchor }
}

/** One search chain of a pair, seeded by (own, enemy, chain): a random start, then local search from random kicks. */
function searchChain(own: number, enemy: number, chain: number, pool: readonly Swatch[]): Palettes {
  const n = pool.length
  const lab = new Float64Array(n * 9)
  pool.forEach((s, i) => lab.set([...s.normal, ...s.protan, ...s.deutan], i * 9))
  const hue = pool.map((s) => s.hue)
  // Math.hypot is several times slower than the plain root: this is the search's inner loop.
  const distance = (i: number, j: number, sameTeam: boolean): number => {
    const x = i * 9
    const y = j * 9
    let u = lab[x]! - lab[y]!
    let v = lab[x + 1]! - lab[y + 1]!
    let w = lab[x + 2]! - lab[y + 2]!
    const dn = Math.sqrt(u * u + v * v + w * w)
    u = lab[x + 3]! - lab[y + 3]!
    v = lab[x + 4]! - lab[y + 4]!
    w = lab[x + 5]! - lab[y + 5]!
    const dp = Math.sqrt(u * u + v * v + w * w)
    u = lab[x + 6]! - lab[y + 6]!
    v = lab[x + 7]! - lab[y + 7]!
    w = lab[x + 8]! - lab[y + 8]!
    const dd = Math.sqrt(u * u + v * v + w * w)
    return Math.min(DISTANCE_CAP, sameTeam ? Math.min(dn, CVD_WEIGHT * Math.min(dp, dd)) : Math.min(dn, dp, dd))
  }
  const ranges = cutRanges(own, enemy)
  const pools = [
    pool.flatMap((s, i) => (isCoolHue(s.hue, ranges) ? [i] : [])),
    pool.flatMap((s, i) => (isWarmHue(s.hue, ranges) ? [i] : [])),
  ]
  // The cores: hues no cut can reach, so any start drawn from them is feasible.
  const cores = [
    pools[0]!.filter((i) => hue[i]! >= ranges.green[1] + GREEN_GAP / 2 && hue[i]! <= ranges.magenta[0] - MAGENTA_GAP / 2),
    pools[1]!.filter((i) => warmMagentaSide(hue[i]!) >= ranges.magenta[1] + MAGENTA_GAP / 2 && warmMagentaSide(hue[i]!) <= ranges.green[0] - GREEN_GAP / 2 + 360),
  ]
  const near = nearbyCandidates(pool, ranges, pools)
  const k = own + enemy
  const team = Array.from({ length: k }, (_, i) => (i < own ? 0 : 1))
  const next = random(Math.imul((own * 31 + enemy) * 1009 + chain, 2654435761))

  const score = (set: readonly number[]): Score => {
    let smallest = DISTANCE_CAP
    let energy = 0
    let anchor = 0
    for (let p = 0; p < k; p++) {
      anchor += anchorOf(hue[set[p]!]!, team[p]!)
      for (let q = p + 1; q < k; q++) {
        const d = distance(set[p]!, set[q]!, team[p] === team[q])
        smallest = Math.min(smallest, d)
        energy += Math.exp(-d / ENERGY_SCALE)
      }
    }
    return { smallest, energy, anchor }
  }

  /** Whether the set stays on its sides with candidate c in place of colour p (p = −1: as it is). */
  const feasibleWith = (set: readonly number[], p: number, c: number): boolean => {
    let ownLow = Infinity
    let ownHigh = -Infinity
    let warmGreen = -Infinity
    let warmMagenta = Infinity
    for (let x = 0; x < k; x++) {
      const h = hue[x === p ? c : set[x]!]!
      if (x < own) {
        ownLow = Math.min(ownLow, h)
        ownHigh = Math.max(ownHigh, h)
      } else {
        warmGreen = Math.max(warmGreen, warmGreenSide(h))
        warmMagenta = Math.min(warmMagenta, warmMagentaSide(h))
      }
    }
    return Math.max(ranges.green[0], warmGreen + GREEN_GAP / 2) <= Math.min(ranges.green[1], ownLow - GREEN_GAP / 2) + 1e-9 &&
      Math.max(ranges.magenta[0], ownHigh + MAGENTA_GAP / 2) <= Math.min(ranges.magenta[1], warmMagenta - MAGENTA_GAP / 2) + 1e-9
  }

  /** Swaps each colour for the best candidate of its team until no swap helps. */
  const improve = (set: number[]): Score => {
    let current = score(set)
    let changed = true
    while (changed) {
      changed = false
      for (let p = 0; p < k; p++) {
        // The picture without colour p: its smallest pair, energy and anchor cost.
        let restSmallest = DISTANCE_CAP
        let restEnergy = 0
        let restAnchor = 0
        for (let x = 0; x < k; x++) {
          if (x === p) continue
          restAnchor += anchorOf(hue[set[x]!]!, team[x]!)
          for (let y = x + 1; y < k; y++) {
            if (y === p) continue
            const d = distance(set[x]!, set[y]!, team[x] === team[y])
            restSmallest = Math.min(restSmallest, d)
            restEnergy += Math.exp(-d / ENERGY_SCALE)
          }
        }
        let bestCandidate = -1
        let bestScore = current
        for (const c of pools[team[p]!]!) {
          if (set.includes(c)) continue
          // The smallest distance first: most candidates fail it, and only survivors pay for the energy.
          let smallest = restSmallest
          for (let x = 0; x < k && smallest > bestScore.smallest - 1e-9; x++) {
            if (x !== p) smallest = Math.min(smallest, distance(c, set[x]!, team[x] === team[p]))
          }
          if (smallest < bestScore.smallest - 1e-9) continue
          let energy = restEnergy
          for (let x = 0; x < k; x++) if (x !== p) energy += Math.exp(-distance(c, set[x]!, team[x] === team[p]) / ENERGY_SCALE)
          const candidate = { smallest, energy, anchor: restAnchor + anchorOf(hue[c]!, team[p]!) }
          if (!betterScore(candidate, bestScore) || !feasibleWith(set, p, c)) continue
          bestScore = candidate
          bestCandidate = c
        }
        if (bestCandidate >= 0) {
          set[p] = bestCandidate
          current = bestScore
          changed = true
        }
      }
    }
    return current
  }

  /** A new candidate for colour p: half the time one of its near neighbours, else any of its team's. */
  const kick = (set: readonly number[], p: number): number => {
    const local = near[set[p]!]!
    const side = pools[team[p]!]!
    for (;;) {
      const c = next() < 0.5 && local.length > 0 ? local[Math.floor(next() * local.length)]! : side[Math.floor(next() * side.length)]!
      if (!set.includes(c)) return c
    }
  }

  let best: number[] = []
  for (let p = 0; p < k; p++) {
    const core = cores[team[p]!]!
    let pick = core[Math.floor(next() * core.length)]!
    while (best.includes(pick)) pick = core[Math.floor(next() * core.length)]!
    best.push(pick)
  }
  let bestScore = improve(best)
  for (let round = 0; round < PERTURBATIONS; round++) {
    const trial = best.slice()
    const moves = 1 + Math.floor(next() * Math.min(3, k))
    for (let m = 0; m < moves; m++) {
      const p = Math.floor(next() * k)
      trial[p] = kick(trial, p)
    }
    if (!feasibleWith(trial, -1, -1)) continue
    const trialScore = improve(trial)
    if (betterScore(trialScore, bestScore)) {
      best = trial
      bestScore = trialScore
    }
  }
  return { own: best.slice(0, own).map((i) => pool[i]!.hex), enemy: best.slice(own).map((i) => pool[i]!.hex) }
}

const nearbyCache = new WeakMap<readonly Swatch[], Map<string, Int32Array[]>>()

/** Each candidate's NEARBY closest candidates (plain ΔE) on each side it belongs to, per cut ranges. */
function nearbyCandidates(pool: readonly Swatch[], ranges: CutRanges, pools: readonly (readonly number[])[]): Int32Array[] {
  const byRanges = nearbyCache.get(pool) ?? new Map<string, Int32Array[]>()
  nearbyCache.set(pool, byRanges)
  const key = JSON.stringify(ranges)
  const cached = byRanges.get(key)
  if (cached) return cached
  const lists: Int32Array[] = Array.from({ length: pool.length }, () => new Int32Array(0))
  for (const members of pools) {
    for (const i of members) {
      const byDistance = members.filter((j) => j !== i).map((j) => [j, delta(pool[i]!.normal, pool[j]!.normal)] as const)
      byDistance.sort((a, b) => a[1] - b[1])
      const merged = new Int32Array(lists[i]!.length + Math.min(NEARBY, byDistance.length))
      merged.set(lists[i]!)
      merged.set(byDistance.slice(0, NEARBY).map(([j]) => j), lists[i]!.length)
      lists[i] = merged
    }
  }
  byRanges.set(key, lists)
  return lists
}

/** Farthest-point order: the colour farthest from its team's others first, so the top scorers get the most distinct. */
function order(colours: readonly string[]): string[] {
  const sw = new Map(colours.map((hex) => [hex, swatch(hex)]))
  const nearest = (hex: string, among: readonly string[]): number =>
    Math.min(Infinity, ...among.filter((o) => o !== hex).map((o) => teamDistance(sw.get(hex)!, sw.get(o)!)))
  const rest = colours.slice()
  let first = rest[0]!
  for (const hex of rest) if (nearest(hex, rest) > nearest(first, rest) + 1e-12) first = hex
  const out = [first]
  rest.splice(rest.indexOf(first), 1)
  while (rest.length > 0) {
    let pick = rest[0]!
    for (const hex of rest) if (nearest(hex, out) > nearest(pick, out) + 1e-12) pick = hex
    out.push(pick)
    rest.splice(rest.indexOf(pick), 1)
  }
  return out
}

function allPairs(low = 1, high = MAX_PLAYERS): [number, number][] {
  const pairs: [number, number][] = []
  for (let a = low; a <= high; a++) for (let b = low; b <= high; b++) pairs.push([a, b])
  return pairs
}

function render(table: Map<string, Palettes>): string {
  const rows: string[] = []
  for (let a = 1; a <= MAX_PLAYERS; a++) {
    for (let b = 1; b <= MAX_PLAYERS; b++) {
      const p = table.get(`${a}/${b}`)!
      rows.push(`  '${a}/${b}': [[${p.own.map((h) => `'${h}'`).join(', ')}], [${p.enemy.map((h) => `'${h}'`).join(', ')}]],`)
    }
  }
  return `// Generated by src/analysis/heatmap-palette.ts (method in its header): do not edit by hand.
// Static track colours of the heatmap for every pair (own players, enemy players), 1..${MAX_PLAYERS} each.

/** [own team's colours, other team's colours], the most distinct first. */
type Palette = readonly [readonly string[], readonly string[]]

const PALETTES: Record<string, Palette> = {
${rows.join('\n')}
}

/**
 * The colours of the image's own team (cool hues) and the other team (warm
 * hues) for the numbers of players drawn in this mode. A team beyond
 * ${MAX_PLAYERS} players cycles the ${MAX_PLAYERS}-player set.
 */
export function heatmapPalette(own: number, enemy: number): Palette {
  const clamp = (count: number): number => Math.min(${MAX_PLAYERS}, Math.max(1, count))
  return PALETTES[\`\${clamp(own)}/\${clamp(enemy)}\`]!
}
`
}

/**
 * Every (pair, chain) is a task for a pool of one worker per core, the largest
 * pairs first; a pair keeps its best chain (equal scores: the lower chain), so
 * the table does not depend on the thread count.
 */
async function generateInParallel(pairs: readonly [number, number][]): Promise<Map<string, Palettes>> {
  const tasks = pairs.flatMap(([a, b]) => Array.from({ length: CHAINS }, (_, c): [number, number, number] => [a, b, c]))
    .sort((x, y) => y[0] + y[1] - (x[0] + x[1]))
  const best = new Map<string, { palettes: Palettes; score: Score; chain: number }>()
  const threads = Math.max(1, Math.min(tasks.length, availableParallelism()))
  await Promise.all(Array.from({ length: threads }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url))
    const feed = (): void => {
      const task = tasks.shift()
      if (task) worker.postMessage(task)
      else void worker.terminate().then(() => resolve())
    }
    worker.on('message', ([a, b, chain, palettes]: [number, number, number, Palettes]) => {
      const key = `${a}/${b}`
      const score = paletteScore(palettes)
      const held = best.get(key)
      if (!held || betterScore(score, held.score) || (!betterScore(held.score, score) && chain < held.chain)) best.set(key, { palettes, score, chain })
      feed()
    })
    worker.once('error', reject)
    feed()
  })))
  return new Map([...best]
    .sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true }))
    .map(([key, { palettes }]) => [key, { own: order(palettes.own), enemy: order(palettes.enemy) }]))
}

if (!isMainThread) {
  const pool = candidatePool()
  parentPort!.on('message', ([own, enemy, chain]: [number, number, number]) => {
    parentPort!.postMessage([own, enemy, chain, searchChain(own, enemy, chain, pool)])
  })
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now()
  const range = /^--pairs=(\d)-(\d)$/.exec(process.argv.find((arg) => arg.startsWith('--pairs=')) ?? '')
  if (range && process.argv.includes('--write')) throw new Error('--write needs the whole table: drop --pairs')
  const table = await generateInParallel(range ? allPairs(Number(range[1]), Number(range[2])) : allPairs())
  if (process.argv.includes('--report')) {
    // From the best picture to the worst: the smallest distance anywhere in it.
    const rows = [...table].map(([key, p]) => {
      const own = p.own.length > 1 ? smallestNormalDistance(p.own) : Infinity
      const enemy = p.enemy.length > 1 ? smallestNormalDistance(p.enemy) : Infinity
      const cross = smallestCrossDistance(p.own, p.enemy)
      const cuts = cutsFor(p.own.map((h) => swatch(h).hue), p.enemy.map((h) => swatch(h).hue), cutRanges(p.own.length, p.enemy.length))
      return { key, own, enemy, cross, smallest: paletteScore(p).smallest, p, cuts }
    }).sort((x, y) => y.smallest - x.smallest)
    for (const r of rows) {
      console.log(r.key.padEnd(4), 'smallest', r.smallest.toFixed(3), 'own ΔE', r.own.toFixed(3), 'enemy ΔE', r.enemy.toFixed(3), 'cross', r.cross.toFixed(3),
        'map', Math.min(smallestMapDistance(r.p.own), smallestMapDistance(r.p.enemy)).toFixed(3),
        'cuts', r.cuts ? `${r.cuts.green.map((v) => v.toFixed(0)).join('-')}/${r.cuts.magenta.map((v) => v.toFixed(0)).join('-')}` : 'none',
        r.p.own.join(' '), '|', r.p.enemy.join(' '))
    }
  }
  if (process.argv.includes('--write')) writeFileSync(new URL('../wrpl/heatmap-palette.ts', import.meta.url), render(table))
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
