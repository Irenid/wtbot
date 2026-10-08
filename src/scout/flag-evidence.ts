/**
 * Vehicle chances given the flags above the enemy team (flags.ts). The game
 * builds the line from its player list (gui.vromfs.bin
 * scripts/statistics/mpstatistics.nut, `getCountriesByTeam`): players in
 * the order of their user ids compared as text (the rows' order while scores
 * tie), only those in a vehicle — not spawned yet or destroyed shows no flag
 * and an icon in the row (row-icons.ts) — each flag appended once. So the
 * first flag is the first player's in a vehicle, and each next one the first
 * the following players bring. The flag a vehicle shows depends on the
 * viewer's setting: its operator's (operator flags on) or its nation's,
 * possibly a variant the viewer picked (off). For one reading of the line the
 * posterior is exact: a chain over the players in that order whose state is
 * how many of the line's flags have appeared; readings, settings and (icons
 * unseen) the share of players in a vehicle are mixed by how well each
 * explains the line. Checks and backtest: docs/opponent-scouting.md.
 */

import type { VehicleDict } from '../wrpl/vehicles.js'

/** One flag of the line as read: the flags it may be, relative likelihood (the best 1). */
export type FlagReading = readonly { icon: string; likelihood: number }[]

/** The flags a vehicle shows: operator flags on, and off (its nation's flag or one the viewer picked, by share). */
export interface VehicleFlags {
  operator: string
  tree: readonly { icon: string; share: number }[]
}

/** An enemy row as the screenshot shows it. */
export interface FlagSeat {
  /** Place in the game's player order: the user id's rank as text, or the row while scores tie; null — unknown, anywhere. */
  place: number | null
  /** Chance the player is in a vehicle (IN_VEHICLE_WITH_ICON / _WITHOUT_ICON); null — the row's icon was not seen. */
  inVehicle: number | null
}

export interface FlagEvidence {
  /** The enemy team's flags, left to right. */
  flags: readonly FlagReading[]
  /** The enemy rows: the recognised players' (conditionOnFlags' `players` order) with a place, then the rows nobody was recognised in. */
  seats: readonly FlagSeat[]
  /** Null — a vehicle the dictionary does not know: any flag. */
  flagsOf: (vehicleId: string) => VehicleFlags | null
}

/** A recognised player's vehicle chances; `unseen` — a vehicle not seen from them at this BR. */
export interface FlagRow {
  vehicles: readonly { vehicleId: string; chance: number }[]
  unseen: number
}

/** A row's icon seen (row-icons.ts): a misread icon, or a player who left in a vehicle, still shows a flag. */
export const IN_VEHICLE_WITH_ICON = 0.02
/** No icon in a row whose icon column is in the picture: an icon the reader missed. */
export const IN_VEHICLE_WITHOUT_ICON = 0.98

// Chosen on the backtest (`npm run scout:backtest -- <copy.db> --known-team`, 2026-10-08):
// operator prior 0.6 gains 0.08 points under nation flags and loses 0.02 under operator
// flags; a missed flag and one out of turn at 0.005 gain 0.06 on readings without error.
/** The viewer's game shows operator flags: 3 of the 4 viewers on the test set. */
export const DEFAULT_OPERATOR_FLAGS_PRIOR = 0.75
/** Operator flags off: a nation shows its own flag, else one the viewer picked among its operators' (Russia for the USSR). */
export const NATION_FLAG_SHARE = 0.8
/** An unknown vehicle's chance of showing a given flag: about a dozen countries play at a BR. */
export const ANY_FLAG_SHARE = 1 / 12
/** A flag of a player in a vehicle that the line lacks: a flag the reader missed (kept above 0.005 for misreads). */
const MISSED_FLAG = 0.02
/** A flag ahead of its turn: a player's place or the line's order misread. */
const OUT_OF_TURN = 0.02
/**
 * Icons not seen: the share of players in a vehicle, mixed by prior. Squadron
 * battles from the first spawn: 84% in a vehicle at 10 s, 92–93% at 30–60 s,
 * 81% at 2 min, 58% at 3 min, 36% at 5 min (losses); a scouting screenshot is
 * mostly early. Against one share of 0.95 the mix holds 0.3 points at 3 min.
 */
const IN_VEHICLE_GRID = [
  { chance: 0.97, prior: 0.55 },
  { chance: 0.8, prior: 0.25 },
  { chance: 0.55, prior: 0.12 },
  { chance: 0.3, prior: 0.08 },
] as const
/** Readings of the line kept: within this factor of the likeliest, at most MAX_LINE_READINGS. */
const MIN_LINE_READING = 0.01
const MAX_LINE_READINGS = 64

export interface FlagPosterior {
  players: { vehicles: { vehicleId: string; chance: number }[]; unseen: number }[]
  /** Chance the viewer's game showed operator flags. */
  operatorChance: number
  /** The line's likeliest reading given the players, left to right (each flag once). */
  line: string[]
}

/** A flag share: `any` for every flag, plus named flags. */
interface Shown {
  any: number
  icons: ReadonlyMap<string, number>
}

/** A seat's options (a player's vehicles, then unseen; anyone for a row nobody was recognised in) with their chances. */
interface SeatOptions {
  chances: readonly number[]
  shown: (setting: Setting) => readonly Shown[]
}

type Setting = 'operator' | 'tree'

/** Per state j (flags of the line seen so far): the weight of staying and of bringing flag j. */
interface Steps {
  stay: Float64Array
  bring: Float64Array
}

/** The line's readings as icon lists (each flag once), weighted by likelihood, likeliest first. */
function lineReadings(flags: readonly FlagReading[]): { icons: string[]; weight: number }[] {
  const sorted = flags.map((reading) => reading.filter((c) => c.likelihood > 0).sort((a, b) => b.likelihood - a.likelihood))
  if (sorted.some((reading) => reading.length === 0)) return []
  // The most the remaining readings can add: prunes the search.
  const bound = new Array<number>(sorted.length + 1).fill(1)
  for (let i = sorted.length - 1; i >= 0; i -= 1) bound[i] = bound[i + 1]! * sorted[i]![0]!.likelihood
  const out: { icons: string[]; weight: number }[] = []
  const icons: string[] = []
  let best = 0
  const walk = (index: number, weight: number): void => {
    if (weight * bound[index]! < MIN_LINE_READING * best) return
    if (index === sorted.length) {
      out.push({ icons: [...icons], weight })
      best = Math.max(best, weight)
      return
    }
    for (const { icon, likelihood } of sorted[index]!) {
      if (icons.includes(icon)) continue
      icons.push(icon)
      walk(index + 1, weight * likelihood)
      icons.pop()
    }
  }
  walk(0, 1)
  return out.filter((reading) => reading.weight >= MIN_LINE_READING * best).sort((a, b) => b.weight - a.weight).slice(0, MAX_LINE_READINGS)
}

/** Each option's stay and bring weights for one reading of the line (`index`: icon → its place in the line). */
function optionSteps(shown: Shown, inVehicle: number, index: ReadonlyMap<string, number>, k: number): Steps {
  const share = new Float64Array(k)
  for (let x = 0; x < k; x += 1) share[x] = shown.any
  for (const [icon, value] of shown.icons) {
    const x = index.get(icon)
    if (x !== undefined) share[x]! += value
  }
  let inLine = 0
  for (let x = 0; x < k; x += 1) inLine += share[x]!
  const outside = Math.max(0, 1 - inLine)
  const stay = new Float64Array(k + 1)
  const bring = new Float64Array(k + 1)
  let before = 0
  for (let j = 0; j <= k; j += 1) {
    const ahead = inLine - before - (j < k ? share[j]! : 0)
    stay[j] = 1 - inVehicle + inVehicle * (before + MISSED_FLAG * outside + OUT_OF_TURN * ahead)
    if (j < k) {
      bring[j] = inVehicle * share[j]!
      before += share[j]!
    }
  }
  return { stay, bring }
}

function sumSteps(parts: readonly Steps[], weights: readonly number[], k: number): Steps {
  const stay = new Float64Array(k + 1)
  const bring = new Float64Array(k + 1)
  parts.forEach((part, o) => {
    for (let j = 0; j <= k; j += 1) {
      stay[j]! += weights[o]! * part.stay[j]!
      bring[j]! += weights[o]! * part.bring[j]!
    }
  })
  return { stay, bring }
}

/**
 * Conditions the players' vehicle chances on the flags. Null — nothing to
 * condition on (no flags, more flags than rows) or no reading fits.
 */
export function conditionOnFlags(
  players: readonly FlagRow[],
  evidence: FlagEvidence,
  options: { operatorPrior?: number } = {},
): FlagPosterior | null {
  const operatorPrior = options.operatorPrior ?? DEFAULT_OPERATOR_FLAGS_PRIOR
  const k = evidence.flags.length
  const seats = Array.from({ length: Math.max(evidence.seats.length, players.length) }, (_, i): FlagSeat => evidence.seats[i] ?? { place: null, inVehicle: null })
  if (k === 0 || k > seats.length) return null
  const readings = lineReadings(evidence.flags)
  if (readings.length === 0) return null

  const any: Shown = { any: ANY_FLAG_SHARE, icons: new Map() }
  const shownBy = (setting: Setting, vehicleId: string): Shown | null => {
    const flags = evidence.flagsOf(vehicleId)
    if (!flags) return null
    return setting === 'operator'
      ? { any: 0, icons: new Map([[flags.operator, 1]]) }
      : { any: 0, icons: new Map(flags.tree.map(({ icon, share }) => [icon, share])) }
  }
  const seatOptions: SeatOptions[] = seats.map((_, index) => {
    const player = players[index]
    if (!player) return { chances: [1], shown: () => [any] }
    const cache = new Map<Setting, Shown[]>()
    return {
      chances: [...player.vehicles.map((vehicle) => vehicle.chance), player.unseen],
      shown: (setting) => {
        let list = cache.get(setting)
        if (list) return list
        const known = player.vehicles.map((vehicle) => shownBy(setting, vehicle.vehicleId))
        // A vehicle not seen from the player leans to the flags of their own vehicles.
        const own = new Map<string, number>()
        for (const shown of known) for (const [icon, share] of shown?.icons ?? []) own.set(icon, (own.get(icon) ?? 0) + share / player.vehicles.length)
        const unseen: Shown = own.size > 0
          ? { any: ANY_FLAG_SHARE / 2, icons: new Map([...own].map(([icon, share]) => [icon, share / 2])) }
          : any
        list = [...known.map((shown) => shown ?? any), unseen]
        cache.set(setting, list)
        return list
      },
    }
  })
  // The chain runs over the seats with a place in the game's order; the rest may stand anywhere in it.
  const placed = seats.map((seat, index) => ({ seat, index }))
    .filter(({ seat, index }) => seat.place !== null || index < players.length)
    .sort((a, b) => (a.seat.place ?? Infinity) - (b.seat.place ?? Infinity) || a.index - b.index)
    .map(({ index }) => index)
  const floating = seats.map((_, index) => index).filter((index) => !placed.includes(index))
  const m = placed.length
  const f = floating.length
  const grid = seats.some((seat) => seat.inVehicle === null) ? IN_VEHICLE_GRID : [{ chance: 1, prior: 1 }]
  const at = (i: number, r: number, j: number) => (i * (f + 1) + r) * (k + 1) + j

  let total = 0
  let operatorTotal = 0
  const readingTotals = new Float64Array(readings.length)
  const through = players.map((player) => new Float64Array(player.vehicles.length + 1))
  for (const setting of ['operator', 'tree'] as const) {
    const settingPrior = setting === 'operator' ? operatorPrior : 1 - operatorPrior
    for (const { chance: unseenInVehicle, prior: gridPrior } of grid) {
      readings.forEach((reading, readingIndex) => {
        const index = new Map(reading.icons.map((icon, x) => [icon, x]))
        const optionStepsOf = (seat: number): Steps[] => {
          const inVehicle = seats[seat]!.inVehicle ?? unseenInVehicle
          return seatOptions[seat]!.shown(setting).map((shown) => optionSteps(shown, inVehicle, index, k))
        }
        const perOption = placed.map(optionStepsOf)
        const steps = perOption.map((parts, i) => sumSteps(parts, seatOptions[placed[i]!]!.chances, k))
        // Rows standing anywhere: their average steps (they differ only by the icon read).
        const floatSteps = f > 0
          ? sumSteps(floating.map((seat) => sumSteps(optionStepsOf(seat), seatOptions[seat]!.chances, k)), floating.map(() => 1 / f), k)
          : null
        const size = (m + 1) * (f + 1) * (k + 1)
        const forward = new Float64Array(size)
        forward[at(0, 0, 0)] = 1
        for (let i = 0; i <= m; i += 1) {
          for (let r = 0; r <= f; r += 1) {
            for (let j = 0; j <= k; j += 1) {
              const value = forward[at(i, r, j)]!
              if (value === 0) continue
              if (i < m) {
                forward[at(i + 1, r, j)]! += value * steps[i]!.stay[j]!
                if (j < k) forward[at(i + 1, r, j + 1)]! += value * steps[i]!.bring[j]!
              }
              if (r < f) {
                forward[at(i, r + 1, j)]! += value * floatSteps!.stay[j]!
                if (j < k) forward[at(i, r + 1, j + 1)]! += value * floatSteps!.bring[j]!
              }
            }
          }
        }
        const likelihood = forward[at(m, f, k)]!
        if (!(likelihood > 0)) return
        const backward = new Float64Array(size)
        backward[at(m, f, k)] = 1
        for (let i = m; i >= 0; i -= 1) {
          for (let r = f; r >= 0; r -= 1) {
            if (i === m && r === f) continue
            for (let j = 0; j <= k; j += 1) {
              let sum = 0
              if (i < m) sum += steps[i]!.stay[j]! * backward[at(i + 1, r, j)]! + (j < k ? steps[i]!.bring[j]! * backward[at(i + 1, r, j + 1)]! : 0)
              if (r < f) sum += floatSteps!.stay[j]! * backward[at(i, r + 1, j)]! + (j < k ? floatSteps!.bring[j]! * backward[at(i, r + 1, j + 1)]! : 0)
              backward[at(i, r, j)] = sum
            }
          }
        }
        const weight = settingPrior * gridPrior * reading.weight
        total += weight * likelihood
        readingTotals[readingIndex]! += weight * likelihood
        if (setting === 'operator') operatorTotal += weight * likelihood
        placed.forEach((seat, i) => {
          if (seat >= players.length) return
          const chances = seatOptions[seat]!.chances
          perOption[i]!.forEach((option, o) => {
            let sum = 0
            for (let r = 0; r <= f; r += 1) {
              for (let j = 0; j <= k; j += 1) {
                const before = forward[at(i, r, j)]!
                if (before === 0) continue
                sum += before * (option.stay[j]! * backward[at(i + 1, r, j)]! + (j < k ? option.bring[j]! * backward[at(i + 1, r, j + 1)]! : 0))
              }
            }
            through[seat]![o]! += weight * chances[o]! * sum
          })
        })
      })
    }
  }
  if (!(total > 0)) return null
  let likeliest = 0
  readingTotals.forEach((value, i) => { if (value > readingTotals[likeliest]!) likeliest = i })
  return {
    operatorChance: operatorTotal / total,
    line: readings[likeliest]!.icons,
    players: players.map((player, seat) => ({
      vehicles: player.vehicles.map((vehicle, o) => ({ vehicleId: vehicle.vehicleId, chance: through[seat]![o]! / total })),
      unseen: through[seat]![player.vehicles.length]! / total,
    })),
  }
}

/**
 * Each vehicle's flags from the dictionary: its operator's, and its nation's
 * with the nation's other flags (the operators of its tree) as picks.
 */
export function dictionaryFlags(dict: VehicleDict, nationShare = NATION_FLAG_SHARE): (vehicleId: string) => VehicleFlags | null {
  const nationFlags = new Map<string, Set<string>>()
  for (const info of Object.values(dict)) {
    if (info.country === '?') continue
    let flags = nationFlags.get(info.country)
    if (!flags) nationFlags.set(info.country, (flags = new Set([info.country])))
    if (info.operator) flags.add(info.operator)
  }
  const tree = new Map<string, { icon: string; share: number }[]>()
  for (const [nation, flags] of nationFlags) {
    const picks = [...flags].filter((flag) => flag !== nation)
    tree.set(nation, picks.length === 0
      ? [{ icon: nation, share: 1 }]
      : [{ icon: nation, share: nationShare }, ...picks.map((icon) => ({ icon, share: (1 - nationShare) / picks.length }))])
  }
  return (vehicleId) => {
    const info = dict[vehicleId]
    if (!info || info.country === '?') return null
    return { operator: info.operator ?? info.country, tree: tree.get(info.country)! }
  }
}

/** The flags vehicles show: every nation and operator of the dictionary (the flag reader's candidates). */
export function dictionaryFlagIcons(dict: VehicleDict): string[] {
  const icons = new Set<string>()
  for (const info of Object.values(dict)) {
    if (info.country !== '?') icons.add(info.country)
    if (info.operator) icons.add(info.operator)
  }
  return [...icons].sort()
}
