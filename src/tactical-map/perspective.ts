import type { Team } from './model.js'

/** air_spawn_template's thresholds: below 20 arcade fighters and bombers, from 20 "_hardcore", from 32 "_top". */
export function balanceBucket(balanceLevel: number): number {
  return balanceLevel >= 32 ? 32 : balanceLevel >= 20 ? 20 : 0
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
