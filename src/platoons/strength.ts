/**
 * How useful a player is to a squadron-battle team at the current BR cap: a
 * logit contribution, so a team's chance against another is the logistic of
 * its eight values' sum minus the enemy's (docs/platoons.md, "Strength").
 *
 * From the player's stored squadron battles, any squadron's, newest first:
 * wins (0/1 per decided battle), kills (air + ground + naval), deaths and
 * assists, each battle weighted 2^(−j / halfLifeBattles) for the j-th latest
 * (j = 1 the last one); the overall rate shrinks to the population's prior by
 * shrinkBattles, the rate at the current cap to the overall one by
 * capShrinkBattles; plus the season's PSR and a penalty for a player new to
 * the cap or to squadron battles. Fitted 2026-10-21 on 64,290 squadron
 * battles of 2026-07-15 – 10-21, walk-forward over the 4 weeks after the
 * storage gap (37,681 battles): the two teams' sums name the winner with AUC
 * 0.797, log loss 0.544, calibrated within 1.5 points in every decile (the
 * rating of rulebot's candidate report, updated the same way: 0.790, 0.553).
 * Within one squadron at one cap the slope is 0.74 of the pooled one, and a
 * squadron's best 8 of its week's players beat a random 8 by 0.56 logit
 * (+8 points of win chance against its real opponents); the lineups squadrons
 * field now are as good as random.
 */
import { stageAt } from '../clan-season.js'
import { vehicleChances, vehicleChoiceFeatures, type PlayerVehicleHistory } from '../scout/model.js'

export const STRENGTH = {
  halfLifeBattles: 100,
  shrinkBattles: 15,
  capShrinkBattles: 200,
  /** Per-battle rates of the population (wins per decided battle). */
  priors: { win: 0.5002, kills: 0.7422, deaths: 0.7116, assists: 0.2017 },
  /** Logit weights of the rates at the cap and of the season PSR (0 without a snapshot, as fitted). */
  weights: { win: 0.4105, kills: 0.4781, deaths: -0.304, assists: 0.3787, psrPerThousand: 0.058, psrAbove1400PerHundred: 0.0439 },
  /**
   * Below the rating's own estimate (95% CIs in docs/platoons.md): no battle at the cap yet, one or two
   * there (from FEW_BATTLES stored battles on), or fewer than FEW_BATTLES stored battles at all.
   */
  penalties: { noCapBattle: 0.04, fewCapBattles: 0.02, fewBattles: 0.075 },
} as const

/** Below this many stored battles the rates say little: STRENGTH.penalties.fewBattles. */
const FEW_BATTLES = 10

export interface StrengthRow {
  startTime: number
  /** null — no winner stored: the battle is left out. */
  won: boolean | null
  kills: number
  deaths: number
  assists: number
  vehicle: string | null
  lineup: readonly string[]
}

export interface Stage {
  startsAt: number
  endsAt: number
  maxBr: number
}

export interface PlayerStrength {
  /** Logit units; only differences between players mean something. */
  value: number
  /** Decided battles stored. */
  battles: number
  /** Of them at the current cap. */
  capBattles: number
}

type Rates = { win: number; kills: number; deaths: number; assists: number }
const RATES = ['win', 'kills', 'deaths', 'assists'] as const

/** `rows` newest first; `cap` — the max BR playing now (stageAt), null when no stage is known. */
export function playerStrength(rows: readonly StrengthRow[], stages: readonly Stage[], cap: number | null, psr: number | null): PlayerStrength {
  const { halfLifeBattles, shrinkBattles, capShrinkBattles, priors, weights } = STRENGTH
  const all = { n: 0, win: 0, kills: 0, deaths: 0, assists: 0 }
  const atCap = { n: 0, win: 0, kills: 0, deaths: 0, assists: 0 }
  let battles = 0
  let capBattles = 0
  for (const row of rows) {
    if (row.won === null) continue
    const weight = 2 ** (-(battles + 1) / halfLifeBattles)
    const values: Rates = { win: row.won ? 1 : 0, kills: row.kills, deaths: row.deaths, assists: row.assists }
    all.n += weight
    for (const key of RATES) all[key] += weight * values[key]
    if (cap !== null && stageAt(stages, row.startTime)?.maxBr === cap) {
      atCap.n += weight
      for (const key of RATES) atCap[key] += weight * values[key]
      capBattles += 1
    }
    battles += 1
  }
  let value = 0
  for (const key of RATES) {
    const overall = (all[key] + shrinkBattles * priors[key]) / (all.n + shrinkBattles)
    value += weights[key] * (atCap[key] + capShrinkBattles * overall) / (atCap.n + capShrinkBattles)
  }
  const rating = psr ?? 0
  value += weights.psrPerThousand * rating / 1000 + weights.psrAbove1400PerHundred * Math.max(0, rating - 1400) / 100
  const { penalties } = STRENGTH
  value -= battles < FEW_BATTLES ? penalties.fewBattles : capBattles === 0 ? penalties.noCapBattle : capBattles <= 2 ? penalties.fewCapBattles : 0
  return { value, battles, capBattles }
}

/** The vehicle a player most likely takes at the cap (/scout's vehicle model); null without a battle there. */
export function likelyVehicle(rows: readonly StrengthRow[], stages: readonly Stage[], cap: number | null, now: number): { vehicleId: string; chance: number } | null {
  if (cap === null) return null
  // The model reads oldest first.
  const history: PlayerVehicleHistory[] = rows
    .filter((row): row is StrengthRow & { vehicle: string } => row.vehicle !== null && stageAt(stages, row.startTime)?.maxBr === cap)
    .map((row) => ({ endTime: row.startTime, vehicle: row.vehicle, lineup: row.lineup }))
    .reverse()
  const features = vehicleChoiceFeatures(history, now)
  return features === null ? null : vehicleChances(features).vehicles[0] ?? null
}
