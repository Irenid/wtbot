import {
  getBattleTeamPsr,
  getClanSeasonContext,
  getPlayerBattleResults,
  getPsrReadings,
  normalizeWtNick,
  type PsrReading,
} from '../db/index.js'
import { PSR_K, PSR_REFERENCE, psrAfterBattle, psrBeforeBattle } from '../psr.js'
import type { ReplayPlayerResult } from './replay.js'

/**
 * The battle image's PSR column: each player's points for the battle by the
 * guides' formula (src/psr.ts) and their PSR after it.
 *
 * The formula needs the PSR the player had when the battle began and the
 * enemy team's average PSR, and the squadron page (clan-info.ts) lags:
 * warthunder.com rebuilds it on request once its copy is 15 min old, so a
 * result shows 0.6–14.7 min after the battle (guides/measurements.ts TIMING),
 * and the bot reads it right after the battle. A read lacks this battle and
 * often the previous one or two. So the PSR before the battle is a reading
 * carried forward by the formula over the player's stored battles it does not
 * count yet. Which battles a reading counts follows from the read time (a
 * battle that ended d s before a read is counted with probability
 * d / PSR_PAGE_MAX_AGE_SEC) and from the values: the chain between two
 * readings must give the later one. The most likely assignment over the last
 * readings is a Viterbi path. The enemy team of the drawn battle averages its
 * players' PSR found this way; an earlier battle's, their readings before it
 * began (getBattleTeamPsr). Once a reading counts exactly this battle, the
 * column shows the page's own PSR: the post is redrawn after the page has
 * certainly counted the battle (PSR_RECHECK_AFTER_SEC, bot/commands/battle.ts).
 *
 * Measured on the 5,909 battles of 2026-10-03..07 drawn as at the
 * announcement, against the page's PSR once a reading of the next hour
 * counted exactly the battle (41,580 players): equal in 77%, within 1 point in
 * 97.5% (a fixed 1500 opponent and no page value, as before 2026-10-07: 63%
 * and 90.5%); the recheck makes them all equal and redraws 65% of posts (13% of
 * players; 17% of posts by over a point). Against readings whose counts the
 * read times alone fix (1,177): within 1 point 98.0% (88.5%).
 */

/** warthunder.com rebuilds a squadron page on request once its copy is this old, s. */
const PSR_PAGE_MAX_AGE_SEC = 15 * 60
/**
 * A page read this long after a battle's end has counted it: its copy is at
 * most PSR_PAGE_MAX_AGE_SEC old, and the game records a result within 36 s
 * (TIMING.delay.min), s.
 */
export const PSR_RECHECK_AFTER_SEC = PSR_PAGE_MAX_AGE_SEC + 60
/** Readings before the battle the path starts from; with fewer, the season start (PSR 0) anchors it when it fits. */
const READINGS_BEFORE = 10
/** Readings after the battle still used: a battle drawn later (/battle <id>) is pinned down from both sides. */
const READINGS_AFTER_SEC = 60 * 60
/**
 * Spread of a reading around the chain, points per battle: the site rounds
 * PSR, the formula misses a single battle by over 1 point in 3% (FIT). Fitted
 * with the measurement above.
 */
const READING_SIGMA = 0.4

export interface PsrBattle {
  /** End, unix s. */
  endAt: number
  /** null — the result is unknown: the chain leaves PSR as it was. */
  won: boolean | null
  /** The enemy team's average PSR before the battle; null — unknown, scored as PSR_REFERENCE. */
  readonly enemyPsr: number | null
}

export interface BattlePsr {
  /** After the battle (the page's own once a reading counts exactly this battle); before it while its result is unknown. Unrounded. */
  psr: number
  /** The battle's points, signed and unrounded; null — the result is unknown. */
  change: number | null
  /**
   * The page's change over this battle minus the formula's, when one reading
   * counts the battles before it and a later one counts it too; null otherwise.
   */
  formulaMiss: number | null
}

export interface BattlePsrInput {
  sessionId: string
  /** Start (WRPL header) and length (results-BLK timePlayed), s. */
  startTime: number
  duration: number
  players: readonly Pick<ReplayPlayerResult, 'userId' | 'name' | 'clanTag' | 'team'>[]
  /** null or ≤ 0 — not known yet. */
  winnerTeam: number | null
}

function afterBattle(psr: number, battle: PsrBattle): number {
  return battle.won === null ? psr : psrAfterBattle(psr, battle.won, battle.enemyPsr ?? PSR_REFERENCE)
}

function applyBattles(psr: number, battles: readonly PsrBattle[], from: number, to: number): number {
  let value = psr
  for (let index = from; index < to; index += 1) value = afterBattle(value, battles[index]!)
  return value
}

/**
 * Probability that a page read at `at` counts exactly the first `count`
 * battles: the page's cutoff is uniform over the PSR_PAGE_MAX_AGE_SEC before
 * the read, and a battle counts when it ended before the cutoff.
 */
function countPrior(battles: readonly PsrBattle[], at: number, count: number): number {
  const from = Math.max(at - PSR_PAGE_MAX_AGE_SEC, count > 0 ? battles[count - 1]!.endAt : -Infinity)
  const to = Math.min(at, count < battles.length ? battles[count]!.endAt : Infinity)
  return Math.max(0, to - from) / PSR_PAGE_MAX_AGE_SEC
}

interface PathState {
  count: number
  score: number
  /** Index of the previous reading's state. */
  from: number
}

/**
 * How many of `battles` each reading counts: the most likely assignment (log
 * prior + Gaussian misses); null — no assignment (readings out of time order).
 */
function countedBattles(battles: readonly PsrBattle[], readings: readonly PsrReading[]): number[] | null {
  const rows: PathState[][] = []
  for (const [index, reading] of readings.entries()) {
    const row: PathState[] = []
    for (let count = 0; count <= battles.length; count += 1) {
      const prior = countPrior(battles, reading.at, count)
      if (prior === 0) continue
      if (index === 0) {
        row.push({ count, score: Math.log(prior), from: -1 })
        continue
      }
      const previous = readings[index - 1]!
      let best: PathState | null = null
      for (const [from, state] of rows[index - 1]!.entries()) {
        // A later read never counts fewer battles: readings come in time order.
        if (state.count > count) continue
        const miss = applyBattles(previous.psr, battles, state.count, count) - reading.psr
        const variance = READING_SIGMA ** 2 * (1 + count - state.count)
        const score = state.score + Math.log(prior) - (miss * miss) / (2 * variance)
        if (best === null || score > best.score) best = { count, score, from }
      }
      if (best !== null) row.push(best)
    }
    if (row.length === 0) return null
    rows.push(row)
  }
  const last = rows.at(-1) ?? []
  let state = last.reduce((best, candidate, index) => (candidate.score > last[best]!.score ? index : best), 0)
  const counts = new Array<number>(readings.length)
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const chosen = rows[index]![state]!
    counts[index] = chosen.count
    state = chosen.from
  }
  return counts
}

/**
 * Whether the formula from PSR 0 over the first battles gives `reading`
 * within PSR_K for a count its read time allows. A battle missing from the
 * database since the season start breaks this chain, and the season start
 * would then drag every count of the reading.
 */
function seasonChainReaches(battles: readonly PsrBattle[], reading: PsrReading): boolean {
  let psr = 0
  for (let count = 0; count <= battles.length; count += 1) {
    if (count > 0) {
      const battle = battles[count - 1]!
      if (battle.endAt >= reading.at) break
      psr = afterBattle(psr, battle)
    }
    if (countPrior(battles, reading.at, count) > 0 && Math.abs(psr - reading.psr) <= PSR_K) return true
  }
  return false
}

export interface PsrEstimate {
  /** PSR right before the battle, unrounded. */
  before: number
  /** The page's PSR while it counted exactly the battles before this one; null — no reading did. */
  siteBefore: number | null
  /** The page's PSR once it counted exactly the battles up to this one; null — no reading did. */
  siteAfter: number | null
}

/**
 * PSR around `battles[target]`. `battles`: the player's battles of the season
 * by end, oldest first; `readings`: their squadron page readings of the
 * season, oldest first; `seasonStart`: when every PSR was 0, null outside a
 * season. null — no reading near the battle or no assignment of battles to
 * the readings.
 */
export function estimatePsr(
  battles: readonly PsrBattle[],
  readings: readonly PsrReading[],
  target: number,
  seasonStart: number | null,
): PsrEstimate | null {
  const endAt = battles[target]!.endAt
  const before = readings.filter((reading) => reading.at <= endAt).slice(-READINGS_BEFORE)
  const after = readings.filter((reading) => reading.at > endAt && reading.at <= endAt + READINGS_AFTER_SEC)
  const used = [...before, ...after]
  if (used.length === 0) return null
  if (seasonStart !== null && before.length < READINGS_BEFORE && seasonChainReaches(battles, used[0]!)) {
    used.unshift({ at: seasonStart, psr: 0 })
  }
  const counts = countedBattles(battles, used)
  if (counts === null) return null
  const siteBefore = counts.lastIndexOf(target)
  const siteAfter = counts.indexOf(target + 1)
  const estimate = (psr: number): PsrEstimate => ({
    before: psr,
    siteBefore: siteBefore < 0 ? null : used[siteBefore]!.psr,
    siteAfter: siteAfter < 0 ? null : used[siteAfter]!.psr,
  })
  // The latest reading that does not count the target yet, carried forward to it.
  for (let index = used.length - 1; index >= 0; index -= 1) {
    const count = counts[index]!
    if (count <= target) return estimate(applyBattles(used[index]!.psr, battles, count, target))
  }
  // Every reading counts the target already: undo the battles back from the first one.
  let psr = used[0]!.psr
  for (let index = counts[0]! - 1; index >= target; index -= 1) {
    const battle = battles[index]!
    if (battle.won !== null) psr = psrBeforeBattle(psr, battle.won, battle.enemyPsr ?? PSR_REFERENCE)
  }
  return estimate(psr)
}

const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * PSR of every player with squadron page readings, by user id; the others are
 * left out. Reads SQLite on the calling thread: per player the season's
 * readings (covering index) and battles, and the team averages of the earlier
 * battles the paths reach (0.03 ms each, cached): 3.7 ms a battle on average,
 * 14 ms at most (600 battles of 2026-10-06, production database).
 */
export function battlePsr(input: BattlePsrInput): Map<string, BattlePsr> {
  const season = getClanSeasonContext(input.startTime).season
  const since = season?.startsAt ?? 0
  // Every PSR starts a season at 0; between seasons nothing anchors it.
  const seasonStart = season !== null && input.startTime < season.endsAt ? season.startsAt : null
  const endAt = input.startTime + input.duration
  // Until the players' own estimates are in, the drawn battle's enemy is their readings before it.
  const readTeams = getBattleTeamPsr(input.sessionId, input.startTime, since)
  const enemyTeam = (team: number): number => (team === 1 ? 2 : 1)

  const estimates: { userId: string; team: number; won: boolean | null; estimate: PsrEstimate }[] = []
  for (const player of input.players) {
    if (player.userId === '' || player.clanTag === '' || player.name.startsWith('coop/')) continue
    // The squadron page lists a console player with or without the platform suffix.
    let readings = getPsrReadings(player.clanTag, player.name, since)
    const base = normalizeWtNick(player.name)
    if (readings.length === 0 && base !== player.name) readings = getPsrReadings(player.clanTag, base, since)
    if (readings.length === 0) continue

    const battles: PsrBattle[] = []
    for (const row of getPlayerBattleResults(player.userId, since)) {
      if (row.sessionId === input.sessionId) continue
      // Looked up on first use: the path reaches only the battles near its readings.
      let enemyPsr: number | null | undefined
      battles.push({
        endAt: row.endAt,
        won: row.won,
        get enemyPsr() {
          if (enemyPsr === undefined) {
            enemyPsr = row.team > 0
              ? getBattleTeamPsr(row.sessionId, row.startAt, since).get(enemyTeam(row.team)) ?? null
              : null
          }
          return enemyPsr
        },
      })
    }
    // The battle as drawn: it may not be stored yet, and its winner may be newer than the row.
    const won = input.winnerTeam !== null && input.winnerTeam > 0 && player.team > 0
      ? player.team === input.winnerTeam
      : null
    let target = battles.findIndex((battle) => battle.endAt > endAt)
    if (target < 0) target = battles.length
    battles.splice(target, 0, { endAt, won, enemyPsr: player.team > 0 ? readTeams.get(enemyTeam(player.team)) ?? null : null })

    const estimate = estimatePsr(battles, readings, target, seasonStart)
    if (estimate !== null) estimates.push({ userId: player.userId, team: player.team, won, estimate })
  }

  // The drawn battle's enemy: the average of its players' PSR before it.
  const teamPsr = new Map<number, number[]>()
  for (const { team, estimate } of estimates) {
    if (team > 0) teamPsr.set(team, [...(teamPsr.get(team) ?? []), estimate.before])
  }
  const result = new Map<string, BattlePsr>()
  for (const { userId, team, won, estimate } of estimates) {
    const enemyPsr = average(teamPsr.get(enemyTeam(team)) ?? []) ?? readTeams.get(enemyTeam(team)) ?? PSR_REFERENCE
    result.set(userId, psrColumn(estimate, won, enemyPsr))
  }
  return result
}

/**
 * A player's column entry: the formula's points from the PSR before the
 * battle; the page's PSR after it once a reading counts exactly this battle;
 * the page's change when two readings isolate the battle and the formula
 * misses it beyond the page's rounding (1 point). Without the reading before
 * it the estimate before carries the formula over earlier battles, so the page
 * change could hold their misses.
 */
export function psrColumn(estimate: PsrEstimate, won: boolean | null, enemyPsr: number): BattlePsr {
  const { before, siteBefore, siteAfter } = estimate
  if (won === null) return { psr: before, change: null, formulaMiss: null }
  const change = psrAfterBattle(before, won, enemyPsr) - before
  if (siteAfter === null) return { psr: before + change, change, formulaMiss: null }
  if (siteBefore === null) return { psr: siteAfter, change, formulaMiss: null }
  // The reading before the battle is the estimate itself: the latest that does not count it.
  const formulaMiss = siteAfter - siteBefore - change
  return { psr: siteAfter, change: Math.abs(formulaMiss) <= 1 ? change : siteAfter - siteBefore, formulaMiss }
}

/** Formula checks kept: the share is over the last this many. */
const FORMULA_CHECK_WINDOW = 1_000
/** A share below this over at least FORMULA_CHECK_MIN checks logs a warning, at most every FORMULA_WARN_MS. */
const FORMULA_CHECK_ALERT = 0.9
const FORMULA_CHECK_MIN = 300
const FORMULA_WARN_MS = 6 * 60 * 60_000
/** |formulaMiss| ≤ 1 of the last rechecked players, newest last. */
const formulaChecks: boolean[] = []
let formulaWarnedAt = 0

/**
 * Counts the formula's misses of the players whose battle two readings
 * isolate, once per post: called when the post is redrawn after the page has
 * counted the battle. A miss within 1 point is the page's rounding. Measured
 * share: 98.6% of 11,240 (2026-10-03..07); a drop means Gaijin changed the
 * rule.
 */
export function notePsrFormulaChecks(psr: ReadonlyMap<string, BattlePsr>): void {
  for (const entry of psr.values()) {
    if (entry.formulaMiss === null) continue
    formulaChecks.push(Math.abs(entry.formulaMiss) <= 1)
    if (formulaChecks.length > FORMULA_CHECK_WINDOW) formulaChecks.shift()
  }
  const { checked, withinOne } = psrFormulaCheck()
  if (withinOne === null || checked < FORMULA_CHECK_MIN || withinOne >= FORMULA_CHECK_ALERT) return
  if (Date.now() - formulaWarnedAt < FORMULA_WARN_MS) return
  formulaWarnedAt = Date.now()
  console.warn(
    `[psr] the formula matches the squadron pages within 1 point in ${(withinOne * 100).toFixed(1)}% ` +
      `of the last ${checked} isolated battles (usually 98.6%): the rule may have changed (src/psr.ts)`,
  )
}

/** The formula against the squadron pages since start: rechecked players whose battle two readings isolate. */
export function psrFormulaCheck(): { checked: number; withinOne: number | null } {
  const matched = formulaChecks.filter(Boolean).length
  return { checked: formulaChecks.length, withinOne: formulaChecks.length === 0 ? null : matched / formulaChecks.length }
}
