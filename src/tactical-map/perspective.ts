import type { Team } from './model.js'

/**
 * The balance levels at which a squadron map changes: helipads from 20
 * (rankRange [20,50]), the mid-rank airfields from 21 ([21,50]; the low-rank
 * ones [0,20]), UCAV spawns from 26 (ucav_min_mrank). All 193 missions built at
 * 0–50 (2026-10-13) change at these and no other; buildTacticalMapSpec warns
 * when a mission changes inside a bucket.
 */
export const BALANCE_LEVEL_THRESHOLDS: readonly number[] = [20, 21, 26]
/** The upper end of the last bucket: the rankRange bound of the mission files. */
const MAX_BALANCE_LEVEL = 50

/** The level a map is built and cached for: the highest threshold not above the battle's, else 0. */
export function balanceBucket(balanceLevel: number): number {
  return BALANCE_LEVEL_THRESHOLDS.findLast((threshold) => balanceLevel >= threshold) ?? 0
}

/** The balance levels sharing the bucket of `balanceLevel`: [first, last]. */
export function balanceBucketRange(balanceLevel: number): [number, number] {
  const first = balanceBucket(balanceLevel)
  const next = BALANCE_LEVEL_THRESHOLDS.find((threshold) => threshold > first)
  return [first, next === undefined ? Math.max(first, MAX_BALANCE_LEVEL) : next - 1]
}

/** The battle's balance level from its BR cap: the economic rank, (BR − 1) × 3. */
export function balanceLevelOfBr(maxBr: number): number {
  return Math.max(0, Math.round((maxBr - 1) * 3))
}

/**
 * The mission team whose tank bases are nearest to these points (a team's
 * first positions): the perspective in which that team's bases are blue. Which
 * replay team stands at which mission team's spawn differs from battle to
 * battle (40 recent battles: 18 and 22). Null on a tie or without bases.
 */
export function pickPerspective(map: { spawns: readonly { team: Team; kind: string; x: number; z: number }[] }, points: readonly { x: number; z: number }[]): Team | null {
  const tanks = map.spawns.filter((spawn) => spawn.kind === 'tank')
  if (tanks.length === 0 || points.length === 0) return null
  const score: Record<Team, number> = { A: 0, B: 0 }
  for (const point of points) {
    let best: { team: Team; d: number } | null = null
    for (const spawn of tanks) {
      const d = Math.hypot(spawn.x - point.x, spawn.z - point.z)
      if (!best || d < best.d) best = { team: spawn.team, d }
    }
    if (best) score[best.team]++
  }
  return score.A === score.B ? null : score.A > score.B ? 'A' : 'B'
}
