/**
 * Vehicle chances given the flags above the enemy team (flags.ts). Every
 * spawned player shows one flag and the line holds each flag once (its order
 * is not used); a player may not have spawned yet, or their flag was missed.
 * The flag a vehicle shows depends on the viewer's setting: its operator's
 * (operator flags on) or its nation's, possibly a variant the viewer picked
 * (off). The posterior is exact: a sum over the sets of flags the players can
 * show (bitmask over the flags read), per setting, the settings mixed by how
 * well each explains the line. Backtest: docs/opponent-scouting.md.
 */

import type { VehicleDict } from '../wrpl/vehicles.js'

/** One flag of the line as read: the flags it may be, relative likelihood (the best 1). */
export type FlagReading = readonly { icon: string; likelihood: number }[]

/** The flags a vehicle shows: operator flags on, and off (its nation's flag or one the viewer picked, by share). */
export interface VehicleFlags {
  operator: string
  tree: readonly { icon: string; share: number }[]
}

export interface FlagEvidence {
  /** The enemy team's flags, left to right. */
  flags: readonly FlagReading[]
  /** Enemy rows on the scoreboard: rows past the recognised players can be anyone. */
  rows: number
  /** Null — a vehicle the dictionary does not know: any flag. */
  flagsOf: (vehicleId: string) => VehicleFlags | null
}

/** A recognised player's vehicle chances; `unseen` — a vehicle not seen from them at this BR. */
export interface FlagRow {
  vehicles: readonly { vehicleId: string; chance: number }[]
  unseen: number
}

// Priors, chosen on the backtest (`npm run scout:backtest -- <copy.db> --known-team`,
// 2026-10-08): over silent 0.05–0.25, operator 0.5–0.9 and nation 0.6–0.9 the
// log loss moved under 0.01.
/** A player not spawned at the screenshot, or a flag not read: their chances stay as they were. */
export const DEFAULT_SILENT_CHANCE = 0.1
/** The viewer's game shows operator flags: 3 of the 4 viewers on the test set. */
export const DEFAULT_OPERATOR_FLAGS_PRIOR = 0.75
/** Operator flags off: a nation shows its own flag, else one the viewer picked among its operators' (Russia for the USSR). */
export const NATION_FLAG_SHARE = 0.8
/** An unknown vehicle's chance of showing a given flag: about a dozen countries play at a BR. */
export const ANY_FLAG_SHARE = 1 / 12
/** Flags a reading may be, over all readings: 2^this states. */
const MAX_ICONS = 14

export interface FlagPosterior {
  players: { vehicles: { vehicleId: string; chance: number }[]; unseen: number }[]
  /** Chance the viewer's game showed operator flags. */
  operatorChance: number
}

interface Move {
  /** Index into the row's options; −1 — silent. */
  option: number
  bit: number
  weight: number
}

/**
 * Conditions the rows (recognised players first, `evidence.rows` in all) on
 * the flags. Null — nothing to condition on (no flags, more flags than rows)
 * or the flags fit no setting.
 */
export function conditionOnFlags(
  players: readonly FlagRow[],
  evidence: FlagEvidence,
  options: { silentChance?: number; operatorPrior?: number } = {},
): FlagPosterior | null {
  const silentChance = options.silentChance ?? DEFAULT_SILENT_CHANCE
  const operatorPrior = options.operatorPrior ?? DEFAULT_OPERATOR_FLAGS_PRIOR
  const k = evidence.flags.length
  const rows = Math.max(evidence.rows, players.length)
  if (k === 0 || k > rows) return null
  // The flags the readings may be, the likeliest kept when there are too many.
  const best = new Map<string, number>()
  for (const reading of evidence.flags) for (const { icon, likelihood } of reading) best.set(icon, Math.max(best.get(icon) ?? 0, likelihood))
  const icons = [...best].sort((a, b) => b[1] - a[1]).slice(0, MAX_ICONS).map(([icon]) => icon)
  if (icons.length < k) return null
  const bitOf = new Map(icons.map((icon, i) => [icon, 1 << i]))
  const readings = evidence.flags.map((reading) => reading.flatMap(({ icon, likelihood }) => {
    const bit = bitOf.get(icon)
    return bit === undefined ? [] : [{ bit, likelihood }]
  }))
  const size = 1 << icons.length
  const popcount = new Uint8Array(size)
  for (let mask = 1; mask < size; mask += 1) popcount[mask] = popcount[mask >> 1]! + (mask & 1)
  const permanents = new Map<number, number>()
  /** Σ over assignments of the flags read to the set's flags (one each) of Π likelihood. */
  const permanent = (mask: number): number => {
    const cached = permanents.get(mask)
    if (cached !== undefined) return cached
    const assign = (index: number, used: number): number => {
      if (index === k) return 1
      let sum = 0
      for (const { bit, likelihood } of readings[index]!) {
        if ((mask & bit) === 0 || (used & bit) !== 0) continue
        sum += likelihood * assign(index + 1, used | bit)
      }
      return sum
    }
    const value = assign(0, 0)
    permanents.set(mask, value)
    return value
  }

  /** A vehicle not known: any flag; a player's new vehicle leans to their own vehicles' flags. */
  const anyFlag = (moves: Move[], option: number, weight: number, own: ReadonlyMap<string, number> | null) => {
    for (const [icon, bit] of bitOf) {
      const share = own && own.size > 0 ? 0.5 * (own.get(icon) ?? 0) + 0.5 * ANY_FLAG_SHARE : ANY_FLAG_SHARE
      moves.push({ option, bit, weight: weight * share })
    }
  }
  const solve = (setting: 'operator' | 'tree') => {
    const shown = (vehicleId: string): readonly { icon: string; share: number }[] | null => {
      const flags = evidence.flagsOf(vehicleId)
      if (!flags) return null
      return setting === 'operator' ? [{ icon: flags.operator, share: 1 }] : flags.tree
    }
    const moves: Move[][] = []
    for (let r = 0; r < rows; r += 1) {
      const player = players[r]
      const list: Move[] = [{ option: -1, bit: 0, weight: silentChance }]
      if (!player) {
        anyFlag(list, 0, 1 - silentChance, null)
        moves.push(list)
        continue
      }
      // The flags of the player's own vehicles: a new vehicle is likely one of their nations'.
      const own = new Map<string, number>()
      for (const vehicle of player.vehicles) {
        for (const { icon, share } of shown(vehicle.vehicleId) ?? []) own.set(icon, (own.get(icon) ?? 0) + share / player.vehicles.length)
      }
      player.vehicles.forEach((vehicle, option) => {
        const flags = shown(vehicle.vehicleId)
        if (!flags) {
          anyFlag(list, option, (1 - silentChance) * vehicle.chance, null)
          return
        }
        for (const { icon, share } of flags) {
          const bit = bitOf.get(icon)
          if (bit !== undefined) list.push({ option, bit, weight: (1 - silentChance) * vehicle.chance * share })
        }
      })
      anyFlag(list, player.vehicles.length, (1 - silentChance) * player.unseen, own)
      moves.push(list)
    }
    const forward: Float64Array[] = [new Float64Array(size)]
    forward[0]![0] = 1
    for (let r = 0; r < rows; r += 1) {
      const current = forward[r]!
      const next = new Float64Array(size)
      for (let mask = 0; mask < size; mask += 1) {
        const f = current[mask]!
        if (f === 0) continue
        for (const move of moves[r]!) {
          const to = mask | move.bit
          if (popcount[to]! <= k) next[to]! += f * move.weight
        }
      }
      forward.push(next)
    }
    const end = new Float64Array(size)
    let total = 0
    for (let mask = 0; mask < size; mask += 1) {
      if (popcount[mask] !== k || forward[rows]![mask] === 0) continue
      end[mask] = permanent(mask)
      total += forward[rows]![mask]! * end[mask]!
    }
    if (!(total > 0)) return null
    const backward: Float64Array[] = new Array<Float64Array>(rows + 1)
    backward[rows] = end
    for (let r = rows - 1; r >= 0; r -= 1) {
      const after = backward[r + 1]!
      const here = new Float64Array(size)
      for (let mask = 0; mask < size; mask += 1) {
        if (forward[r]![mask] === 0) continue
        let sum = 0
        for (const move of moves[r]!) sum += move.weight * after[mask | move.bit]!
        here[mask] = sum
      }
      backward[r] = here
    }
    // Per row: the posterior weight of each option, silence spread by the row's own chances.
    const posteriors = players.map((player, r) => {
      const weights = new Float64Array(player.vehicles.length + 1)
      let silent = 0
      for (let mask = 0; mask < size; mask += 1) {
        const f = forward[r]![mask]!
        if (f === 0) continue
        for (const move of moves[r]!) {
          const w = f * move.weight * backward[r + 1]![mask | move.bit]!
          if (move.option < 0) silent += w
          else weights[move.option]! += w
        }
      }
      player.vehicles.forEach((vehicle, option) => { weights[option]! += silent * vehicle.chance })
      weights[player.vehicles.length]! += silent * player.unseen
      return weights.map((w) => w / total)
    })
    return { total, posteriors }
  }

  const operator = solve('operator')
  const tree = solve('tree')
  if (!operator && !tree) return null
  const evidenceOperator = operatorPrior * (operator?.total ?? 0)
  const evidenceTree = (1 - operatorPrior) * (tree?.total ?? 0)
  const operatorChance = evidenceOperator / (evidenceOperator + evidenceTree)
  return {
    operatorChance,
    players: players.map((player, r) => {
      const mixed = (option: number) => operatorChance * (operator?.posteriors[r]![option] ?? 0) + (1 - operatorChance) * (tree?.posteriors[r]![option] ?? 0)
      return {
        vehicles: player.vehicles.map((vehicle, option) => ({ vehicleId: vehicle.vehicleId, chance: mixed(option) })),
        unseen: mixed(player.vehicles.length),
      }
    }),
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
