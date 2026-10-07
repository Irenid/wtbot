import {
  getClanSeasonContext,
  getPlayerBattleResults,
  getPsrReadings,
  normalizeWtNick,
  type PsrReading,
} from '../db/index.js'
import { PSR_K, psrAfterBattle, psrBeforeBattle } from '../psr.js'
import type { ReplayPlayerResult } from './replay.js'

/**
 * The battle image's PSR column: each player's points for the battle by the
 * guides' formula (src/psr.ts) and their PSR after it.
 *
 * The formula needs the PSR the player had when the battle began, and the
 * squadron page (clan-info.ts) lags: warthunder.com rebuilds it on request
 * once its copy is 15 min old, so a result shows 0.6–14.7 min after the
 * battle (guides/measurements.ts TIMING), and the bot reads it right after the
 * battle. A read lacks this battle and often the previous one or two. So the
 * PSR before the battle is a reading carried forward by the formula over the
 * player's stored battles it does not count yet. Which battles a reading
 * counts follows from the read time (a battle that ended d s before a read is
 * counted with probability d / PSR_PAGE_MAX_AGE_SEC) and from the values: the
 * chain between two readings must give the later one. The most likely
 * assignment over the last readings is a Viterbi path.
 *
 * Measured on 74k player-battles of 2026-10-03..07, drawn as at the
 * announcement: the points match those computed with the next hour's readings
 * too in 99.0% (the latest reading taken as the PSR before the battle: 81%);
 * the PSR after the battle is within 1 of a later unambiguous reading in 88.5%
 * (63%), and 94% of the misses are changes the formula does not reproduce
 * even with every reading.
 */

/** warthunder.com rebuilds a squadron page on request once its copy is this old, s. */
const PSR_PAGE_MAX_AGE_SEC = 15 * 60
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
}

export interface BattlePsr {
  /** After the battle; before it while its result is unknown. Unrounded. */
  psr: number
  /** The battle's points, signed and unrounded; null — the result is unknown. */
  change: number | null
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

function applyBattles(psr: number, battles: readonly PsrBattle[], from: number, to: number): number {
  let value = psr
  for (let index = from; index < to; index += 1) {
    const won = battles[index]!.won
    if (won !== null) value = psrAfterBattle(value, won)
  }
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
      if (battle.won !== null) psr = psrAfterBattle(psr, battle.won)
    }
    if (countPrior(battles, reading.at, count) > 0 && Math.abs(psr - reading.psr) <= PSR_K) return true
  }
  return false
}

/**
 * PSR right before `battles[target]`. `battles`: the player's battles of the
 * season by end, oldest first; `readings`: their squadron page readings of the
 * season, oldest first; `seasonStart`: when every PSR was 0, null outside a
 * season. null — no reading near the battle or no assignment of battles to
 * the readings.
 */
export function psrBefore(
  battles: readonly PsrBattle[],
  readings: readonly PsrReading[],
  target: number,
  seasonStart: number | null,
): number | null {
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
  // The latest reading that does not count the target yet, carried forward to it.
  for (let index = used.length - 1; index >= 0; index -= 1) {
    const count = counts[index]!
    if (count <= target) return applyBattles(used[index]!.psr, battles, count, target)
  }
  // Every reading counts the target already: undo the battles back from the first one.
  let psr = used[0]!.psr
  for (let index = counts[0]! - 1; index >= target; index -= 1) {
    const won = battles[index]!.won
    if (won !== null) psr = psrBeforeBattle(psr, won)
  }
  return psr
}

/**
 * PSR of every player with squadron page readings, by user id; the others are
 * left out. Reads SQLite on the calling thread: per player the season's
 * readings (covering index) and battles, ~2 ms for 16 players (production
 * database, 2026-10-07).
 */
export function battlePsr(input: BattlePsrInput): Map<string, BattlePsr> {
  const result = new Map<string, BattlePsr>()
  const season = getClanSeasonContext(input.startTime).season
  const since = season?.startsAt ?? 0
  // Every PSR starts a season at 0; between seasons nothing anchors it.
  const seasonStart = season !== null && input.startTime < season.endsAt ? season.startsAt : null
  const endAt = input.startTime + input.duration
  for (const player of input.players) {
    if (player.userId === '' || player.clanTag === '' || player.name.startsWith('coop/')) continue
    // The squadron page lists a console player with or without the platform suffix.
    let readings = getPsrReadings(player.clanTag, player.name, since)
    const base = normalizeWtNick(player.name)
    if (readings.length === 0 && base !== player.name) readings = getPsrReadings(player.clanTag, base, since)
    if (readings.length === 0) continue

    const battles: PsrBattle[] = getPlayerBattleResults(player.userId, since).filter(
      (battle) => battle.sessionId !== input.sessionId,
    )
    // The battle as drawn: it may not be stored yet, and its winner may be newer than the row.
    const won = input.winnerTeam !== null && input.winnerTeam > 0 && player.team > 0
      ? player.team === input.winnerTeam
      : null
    let target = battles.findIndex((battle) => battle.endAt > endAt)
    if (target < 0) target = battles.length
    battles.splice(target, 0, { endAt, won })

    const psr = psrBefore(battles, readings, target, seasonStart)
    if (psr === null) continue
    if (won === null) {
      result.set(player.userId, { psr, change: null })
    } else {
      const afterBattle = psrAfterBattle(psr, won)
      result.set(player.userId, { psr: afterBattle, change: afterBattle - psr })
    }
  }
  return result
}
