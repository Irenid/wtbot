import { writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

/**
 * Generates the heatmap track palette (src/wrpl/heatmap-palette.ts): for every
 * pair (own players, enemy players), 1..8 each, the colours of both teams.
 *
 *   npx tsx src/analysis/heatmap-palette.ts [--write] [--report]
 *
 * Method (the table is static; rerun only when the rules below change):
 * - candidates: an OKLCH grid kept only if every map colour of the dark khaki
 *   heatmap (MAP_BACKGROUNDS, k-means of 42 cached heatmaps, 2026-10-22) is
 *   at least MIN_MAP_DELTA away, so no track vanishes into the map;
 * - the hue circle is split in two arcs: the image's own team takes the cool
 *   one, the other team the warm one, so a track's team reads from its hue.
 *   The two cuts (green and magenta) move with the team sizes: the bigger
 *   team gets the wider arc, the smaller one is squeezed (8 v 4);
 * - inside an arc a team of k players gets the k colours with the largest
 *   smallest pairwise distance (farthest-point starts + swap search), a set of
 *   its own for every k: nothing nests, so a third player may change the
 *   colours of the first two;
 * - distance: OKLab ΔE, also under protan and deutan simulation (Machado
 *   2009, severity 1) weighted CVD_WEIGHT; every cross-team pair keeps
 *   MIN_CROSS_DELTA under all three vision types;
 * - a split scores min over the teams of min(smallest distance, DISTANCE_CAP),
 *   so a team that is distinct enough stops claiming hue range.
 */

export type Lab = [number, number, number]

const MAP_BACKGROUNDS = ['#595444', '#3a3b34', '#494838', '#727370', '#5c5f64', '#676351', '#87847e', '#4a4c4f', '#2a2a26', '#9a9998']
const MIN_MAP_DELTA = 0.15
const MIN_CROSS_DELTA = 0.12
const DISTANCE_CAP = 0.3
const CVD_WEIGHT = 2
const ENERGY_SCALE = 0.02
const ANCHOR_WEIGHT = 2e-7
const MAX_PLAYERS = 8

const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]] as const
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]] as const

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

export function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)]
}

export function linearToLab([r, g, b]: readonly [number, number, number]): Lab {
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

export interface Swatch {
  hex: string
  hue: number
  chroma: number
  normal: Lab
  protan: Lab
  deutan: Lab
}

export function swatch(hex: string): Swatch {
  const lin = hexToLinear(hex)
  const normal = linearToLab(lin)
  const chroma = Math.hypot(normal[1], normal[2])
  return {
    hex: hex.toUpperCase(),
    hue: ((Math.atan2(normal[2], normal[1]) * 180) / Math.PI + 360) % 360,
    chroma,
    normal,
    protan: linearToLab(simulate(PROTAN, lin)),
    deutan: linearToLab(simulate(DEUTAN, lin)),
  }
}

/** The distance that tells two tracks of one team apart: ΔE, and ΔE under colour blindness weighted. */
export function teamDistance(a: Swatch, b: Swatch): number {
  return Math.min(delta(a.normal, b.normal), CVD_WEIGHT * Math.min(delta(a.protan, b.protan), delta(a.deutan, b.deutan)))
}

/** The distance between the teams' colours: the smallest over all three vision types. */
export function crossDistance(a: Swatch, b: Swatch): number {
  return Math.min(delta(a.normal, b.normal), delta(a.protan, b.protan), delta(a.deutan, b.deutan))
}

export function smallestDistance(colours: readonly string[]): number {
  const sw = colours.map(swatch)
  let min = Infinity
  for (let i = 0; i < sw.length; i++) for (let j = i + 1; j < sw.length; j++) min = Math.min(min, teamDistance(sw[i]!, sw[j]!))
  return min
}

export function smallestCrossDistance(a: readonly string[], b: readonly string[]): number {
  const sa = a.map(swatch)
  const sb = b.map(swatch)
  return Math.min(...sa.flatMap((x) => sb.map((y) => crossDistance(x, y))))
}

export function smallestMapDistance(colours: readonly string[]): number {
  const bg = MAP_BACKGROUNDS.map((hex) => linearToLab(hexToLinear(hex)))
  return Math.min(...colours.flatMap((hex) => bg.map((b) => delta(swatch(hex).normal, b))))
}

function candidatePool(): Swatch[] {
  const bg = MAP_BACKGROUNDS.map((hex) => linearToLab(hexToLinear(hex)))
  const byHex = new Map<string, Swatch>()
  const add = (rgb: [number, number, number]): void => {
    if (!inGamut(rgb)) return
    const s = swatch(toHex(rgb))
    if (bg.some((b) => delta(s.normal, b) < MIN_MAP_DELTA)) return
    byHex.set(s.hex, s)
  }
  for (let h = 0; h < 360; h += 5) {
    for (const L of [0.68, 0.76, 0.84, 0.92]) {
      for (const C of [0.1, 0.16, 0.22]) add(oklchToLinear(L, C, h))
      // The most saturated colour that fits sRGB at this lightness and hue.
      let lo = 0.1
      let hi = 0.4
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (inGamut(oklchToLinear(L, mid, h))) lo = mid
        else hi = mid
      }
      add(oklchToLinear(L, lo, h))
    }
  }
  // Near-white, for the largest teams: hueless, so it belongs to either arc.
  for (const hex of ['#FFFFFF', '#FFE9C9', '#E6E0FF', '#D7F3F5']) byHex.set(hex, swatch(hex))
  return [...byHex.values()].sort((a, b) => a.hex.localeCompare(b.hex))
}

const inArc = (hue: number, from: number, to: number): boolean => {
  const span = (((to - from) % 360) + 360) % 360
  const at = (((hue - from) % 360) + 360) % 360
  return at <= span
}

/**
 * The hue circle in OKLCH degrees. Balanced teams keep their own gamut: cool
 * hues (blue, cyan, purple: from the green cut up to the magenta cut) for the
 * image's own team, warm ones (red, orange, yellow) for the other, with the
 * green and the magenta unused between them (a gap of BALANCED_GAP degrees).
 * A lopsided pair (8 v 4) moves the cuts by CUT_MOVE_PER_PLAYER degrees per
 * player of difference and narrows the gaps down to MIN_GAP, so the bigger
 * team spreads over more of the circle and the smaller one is squeezed.
 * The warm anchor is orange-red, the cool one blue: a small team takes the
 * hues nearest its anchor that are still distinct enough.
 */
const BALANCED_GAP = 60
const MIN_GAP = 10
const GAP_SHRINK_PER_PLAYER = 8
/** A crowded team needs more of the circle: the gap shrinks with every player beyond CROWD_FROM. */
const GAP_SHRINK_PER_CROWD = 12
const CROWD_FROM = 3
const CUT_MOVE_PER_PLAYER = 10
const BALANCED_CUT_MOVE = 30
const DEFAULT_CUTS = { green: 150, magenta: 350 }
const GREEN_RANGE = [110, 190] as const
const MAGENTA_RANGE = [320, 380] as const
const COOL_ANCHOR = 255
const WARM_ANCHOR = 45
/** Hueless colours (white, cream) help only the largest teams. */
const HUELESS_FROM_PLAYERS = 6

interface Arc {
  from: number
  to: number
}

const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360))

function allPairs(): [number, number][] {
  return Array.from({ length: MAX_PLAYERS * MAX_PLAYERS }, (_, i): [number, number] => [Math.floor(i / MAX_PLAYERS) + 1, (i % MAX_PLAYERS) + 1])
}

export interface Palettes {
  own: string[]
  enemy: string[]
}

export function generatePalettes(pairs: [number, number][] = allPairs()): Map<string, Palettes> {
  const pool = candidatePool()
  const n = pool.length
  const within = new Float32Array(n * n)
  const cross = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const d = Math.min(DISTANCE_CAP, teamDistance(pool[i]!, pool[j]!))
      const c = crossDistance(pool[i]!, pool[j]!)
      within[i * n + j] = within[j * n + i] = d
      cross[i * n + j] = cross[j * n + i] = c
    }
  }
  const hueless = (i: number): boolean => pool[i]!.chroma < 0.05
  const arcMembers = (arc: Arc, k: number): number[] =>
    pool.flatMap((sw, i) => (hueless(i) ? (k >= HUELESS_FROM_PLAYERS ? [i] : []) : inArc(sw.hue, arc.from % 360, arc.to % 360) ? [i] : []))

  const smallest = (set: number[]): number => {
    let m = Infinity
    for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) m = Math.min(m, within[set[a]! * n + set[b]!]!)
    return m
  }
  const preference = (i: number, anchor: number): number => (hueless(i) ? 1 : hueGap(pool[i]!.hue, anchor) / 180)
  const meanPreference = (set: number[], anchor: number): number => set.reduce((sum, i) => sum + preference(i, anchor), 0) / Math.max(1, set.length)

  /** A soft minimum over the pairs: close pairs dominate, so reducing the smallest distance always pays. */
  const energyOf = (i: number, set: number[]): number => set.reduce((sum, o) => sum + Math.exp(-within[i * n + o]! / ENERGY_SCALE), 0)
  const setEnergy = (set: number[]): number => set.reduce((sum, i, idx) => sum + energyOf(i, set.slice(idx + 1)), 0)

  /**
   * The k colours of `allowed` with the largest smallest distance (a soft
   * minimum, distances capped at DISTANCE_CAP); a set that is distinct enough
   * everywhere takes the hues nearest the team's anchor.
   */
  const solve = (k: number, allowed: number[], anchor: number): number[] => {
    if (allowed.length <= k) return allowed.slice()
    const cost = (set: number[]): number => setEnergy(set) + ANCHOR_WEIGHT * set.reduce((sum, i) => sum + preference(i, anchor), 0)
    const byPreference = allowed.slice().sort((a, b) => preference(a, anchor) - preference(b, anchor) || a - b)
    const seeds = [...new Set([...byPreference.slice(0, 24), ...allowed.filter((_, idx) => idx % 9 === 0)])]
    let best: number[] = []
    let bestCost = Infinity
    let bestSmallest = -1
    for (const seed of seeds) {
      const set = [seed]
      while (set.length < k) {
        let pick = -1
        let pickCost = Infinity
        for (const i of allowed) {
          if (set.includes(i)) continue
          const c = energyOf(i, set) + ANCHOR_WEIGHT * preference(i, anchor)
          if (c < pickCost) { pickCost = c; pick = i }
        }
        set.push(pick)
      }
      let current = cost(set)
      let improved = true
      while (improved) {
        improved = false
        for (let p = 0; p < k; p++) {
          const rest = set.filter((_, idx) => idx !== p)
          let swapTo = -1
          for (const i of allowed) {
            if (set.includes(i)) continue
            const c = cost([...rest, i])
            if (c < current - 1e-12) { current = c; swapTo = i }
          }
          if (swapTo >= 0) { set[p] = swapTo; improved = true }
        }
      }
      // The smallest distance decides between seeds; the soft cost breaks ties.
      const smallestHere = smallest(set)
      if (smallestHere > bestSmallest + 1e-6 || (smallestHere > bestSmallest - 1e-6 && current < bestCost - 1e-12)) {
        bestSmallest = smallestHere
        bestCost = current
        best = set.slice()
      }
    }
    return best
  }

  const crossOk = (i: number, others: number[]): boolean => others.every((o) => cross[i * n + o]! >= MIN_CROSS_DELTA)

  const splitsFor = (difference: number, largest: number): { green: number; magenta: number; cool: Arc; warm: Arc }[] => {
    const gap = Math.max(MIN_GAP, BALANCED_GAP - GAP_SHRINK_PER_PLAYER * difference - GAP_SHRINK_PER_CROWD * Math.max(0, largest - CROWD_FROM))
    const reach = BALANCED_CUT_MOVE + CUT_MOVE_PER_PLAYER * difference
    const cuts = (centre: number, [low, high]: readonly [number, number]): number[] => {
      const out: number[] = []
      for (let cut = Math.max(low, centre - reach); cut <= Math.min(high, centre + reach); cut += 10) out.push(cut)
      return out
    }
    return cuts(DEFAULT_CUTS.green, GREEN_RANGE).flatMap((green) => cuts(DEFAULT_CUTS.magenta, MAGENTA_RANGE).map((magenta) => ({
      green,
      magenta,
      cool: { from: green + gap / 2, to: magenta - gap / 2 },
      warm: { from: magenta + gap / 2, to: green - gap / 2 + 360 },
    })))
  }
  const splitCost = (split: { green: number; magenta: number }): number =>
    (Math.abs(split.green - DEFAULT_CUTS.green) + Math.abs(split.magenta - DEFAULT_CUTS.magenta)) / 10

  const solved = new Map<string, number[]>()
  const solveCached = (cool: boolean, arc: Arc, k: number): number[] => {
    const key = `${cool ? 'c' : 'w'}/${arc.from}/${arc.to}/${k}`
    let set = solved.get(key)
    if (!set) {
      set = solve(k, arcMembers(arc, k), cool ? COOL_ANCHOR : WARM_ANCHOR)
      solved.set(key, set)
    }
    return set
  }

  const order = (set: number[]): string[] => {
    // Farthest-point order: the first colours are the most distinct, so the top scorers get them.
    const rest = set.slice()
    let first = rest[0]!
    let firstMean = -1
    for (const i of rest) {
      const mean = rest.reduce((sum, o) => sum + (o === i ? 0 : within[i * n + o]!), 0) / Math.max(1, rest.length - 1)
      if (mean > firstMean) { firstMean = mean; first = i }
    }
    const out = [first]
    rest.splice(rest.indexOf(first), 1)
    while (rest.length > 0) {
      let pick = rest[0]!
      let pickScore = -1
      for (const i of rest) {
        const s = Math.min(...out.map((o) => within[i * n + o]!))
        if (s > pickScore) { pickScore = s; pick = i }
      }
      out.push(pick)
      rest.splice(rest.indexOf(pick), 1)
    }
    return out.map((i) => pool[i]!.hex)
  }

  const table = new Map<string, Palettes>()
  {
    for (const [a, b] of pairs) {
      let chosen: Palettes | null = null
      let chosenScore = -Infinity
      for (const split of splitsFor(Math.abs(a - b), Math.max(a, b))) {
        const own0 = solveCached(true, split.cool, a)
        const enemy0 = solveCached(false, split.warm, b)
        const options: [number[], number[]][] = [[own0, enemy0]]
        if (!own0.every((i) => crossOk(i, enemy0))) {
          // The arcs touch at a cut: re-solve one team clear of the other, either way round.
          options.length = 0
          for (const ownFirst of [true, false]) {
            let own = own0
            let enemy = enemy0
            for (let round = 0; round < 3 && !own.every((i) => crossOk(i, enemy)); round++) {
              if (ownFirst) {
                enemy = solve(b, arcMembers(split.warm, b).filter((i) => crossOk(i, own)), WARM_ANCHOR)
                if (enemy.length < b) break
              } else {
                own = solve(a, arcMembers(split.cool, a).filter((i) => crossOk(i, enemy)), COOL_ANCHOR)
                if (own.length < a) break
              }
              if (!own.every((i) => crossOk(i, enemy))) {
                if (ownFirst) own = solve(a, arcMembers(split.cool, a).filter((i) => crossOk(i, enemy)), COOL_ANCHOR)
                else enemy = solve(b, arcMembers(split.warm, b).filter((i) => crossOk(i, own)), WARM_ANCHOR)
              }
            }
            options.push([own, enemy])
          }
        }
        for (const [own, enemy] of options) {
          if (own.length < a || enemy.length < b || !own.every((i) => crossOk(i, enemy))) continue
          const sa = smallest(own)
          const sb = smallest(enemy)
          // The smaller distance first, the sum second; leaving the default cuts costs a little.
          const score = Math.min(sa, sb) + 0.1 * (sa + sb) - 0.004 * splitCost(split) -
            0.01 * (meanPreference(own, COOL_ANCHOR) + meanPreference(enemy, WARM_ANCHOR))
          if (score > chosenScore) { chosenScore = score; chosen = { own: order(own), enemy: order(enemy) } }
        }
      }
      if (!chosen) throw new Error(`no palette for ${a} v ${b}`)
      table.set(`${a}/${b}`, chosen)
    }
  }
  return table
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

/** Every pair runs independently: one worker thread per core takes its share of the 64 pairs. */
async function generateInParallel(): Promise<Map<string, Palettes>> {
  const pairs = allPairs()
  const threads = Math.max(1, Math.min(pairs.length, availableParallelism()))
  const shares = Array.from({ length: threads }, (_, t) => pairs.filter((_, i) => i % threads === t))
  const parts = await Promise.all(shares.map((share) => new Promise<[string, Palettes][]>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: share })
    worker.once('message', resolve)
    worker.once('error', reject)
  })))
  return new Map(parts.flat().sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true })))
}

if (!isMainThread) {
  parentPort!.postMessage([...generatePalettes(workerData as [number, number][])])
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now()
  const table = await generateInParallel()
  if (process.argv.includes('--report')) {
    for (const [key, p] of table) {
      console.log(key.padEnd(4), 'own', smallestDistance(p.own).toFixed(3), 'enemy', smallestDistance(p.enemy).toFixed(3),
        'cross', smallestCrossDistance(p.own, p.enemy).toFixed(3), 'map', Math.min(smallestMapDistance(p.own), smallestMapDistance(p.enemy)).toFixed(3),
        p.own.join(' '), '|', p.enemy.join(' '))
    }
  }
  if (process.argv.includes('--write')) writeFileSync(new URL('../wrpl/heatmap-palette.ts', import.meta.url), render(table))
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
