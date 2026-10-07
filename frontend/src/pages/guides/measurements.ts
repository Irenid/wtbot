// Facts measured once from the bot's database and a live poll of warthunder.com
// pages; the guide texts take them as arguments, so a refresh edits only this
// file. Refresh every number together with MEASURED_AT (method: guide "method").

/** Last day of the data behind every number below (UTC). */
export const MEASURED_AT = Date.UTC(2026, 9, 3) / 1000

/**
 * Squadron battles whose ingest finished by 2026-10-03 21:04 UTC: all 8 vs 8,
 * Realistic, Domination. BATTLE_FLOW, PACE and ACTIVITY count the same set.
 */
export const BATTLES = { total: 44_853, team1Won: 22_442, team2Won: 22_400 }

/** Days with battles in the database (the bot collected nothing in between), UTC. */
export const DATA_PERIODS = [
  { from: Date.UTC(2026, 6, 15) / 1000, to: Date.UTC(2026, 7, 2) / 1000 },
  { from: Date.UTC(2026, 8, 23) / 1000, to: MEASURED_AT },
] as const

/**
 * How the BATTLES with a winner went, from their replays: spawns, the kill
 * feed (team kills left out) and zone captures. Shares are of battles unless
 * the name says otherwise; times in seconds, medians.
 */
export const BATTLE_FLOW = {
  /** Planes and helicopters among the vehicles that went into battle (a player spawns once: 99.99%). */
  aircraftShare: 0.252,
  /** Teams without aircraft and with four; more than four — 19 teams of 89,680. */
  teamsNoAircraft: 0.3,
  teamsFourAircraft: 0.286,
  duration: 337,
  /** Nine battles in ten end sooner. */
  durationP90: 501,
  over10Minutes: 0.028,
  /** From the start to the first kill. */
  firstKill: 115,
  /** The losing team destroyed to the last vehicle; the rest lost with vehicles left. */
  wiped: 0.816,
  /** Of the battles lost with vehicles left: only aircraft left; the winners captured more zones. */
  onlyAircraftLeft: 0.613,
  winnersCapturedMore: 0.895,
  /** Players of the winning team alive at the end. */
  winnerSurvivors: 4,
  firstKillWins: 0.691,
  /** A squadron's win rate with the first kill above its own average, and as much below without it. */
  firstKillLift: 0.17,
  moreKillsWins: 0.946,
  fewerKillsWins: 0.026,
  /** Of the kills: made from planes and helicopters. */
  aircraftKills: 0.325,
  /** Largest gap between a squadron's win rate at 0–4 aircraft per team and its own average. */
  aircraftWinSpread: 0.01,
}

/** Pace: a player's battles less than 30 minutes apart form one series. */
export const PACE = {
  /** Seconds from the end of a battle to the start of the next one, median. */
  gap: 65,
  /** Battles in a series, median. */
  series: 8,
  /** Battles per hour of a series, pauses included. */
  perHour: 7.5,
}

/**
 * This season's activity, medians over the full days `from`–`to` (UTC); the
 * ten most active squadrons and repeat opponents — over all its days in the
 * data, `seasonFrom`–MEASURED_AT.
 */
export const ACTIVITY = {
  from: Date.UTC(2026, 8, 24) / 1000,
  to: Date.UTC(2026, 9, 2) / 1000,
  battles: { median: 1_690, low: 1_397, high: 2_466 },
  squadrons: 193,
  players: 2_463,
  /** Battles on a day a squadron or a player played. */
  squadronDay: 15,
  playerDay: 10,
  seasonFrom: Date.UTC(2026, 8, 23) / 1000,
  /** The ten squadrons with the most battles: battles per day they played, different players. */
  topPerDay: { low: 32, high: 61 },
  topPlayers: { low: 57, high: 102 },
  /** A squadron's battles in one battle window against a squadron it already met in that window. */
  repeatOpponent: 0.272,
  /** Different opponents in 10 battles of one window. */
  opponentsPer10: 7.5,
}

export interface GapRow {
  from: number
  /** null — open upper bound. */
  to: number | null
  /** Share of these battles the side with the higher rating won. */
  higherWins: number
  battles: number
}

/**
 * Team average PSR gap (≥ 6 of 8 ratings known, snapshots ≤ 2 days old).
 * `elo` — the share the PSR formula predicts for the same battles.
 */
export const TEAM_PSR_GAP: readonly (GapRow & { elo: number })[] = [
  { from: 0, to: 100, higherWins: 0.524, elo: 0.571, battles: 3_568 },
  { from: 100, to: 200, higherWins: 0.568, elo: 0.701, battles: 3_198 },
  { from: 200, to: 300, higherWins: 0.585, elo: 0.805, battles: 2_680 },
  { from: 300, to: 400, higherWins: 0.645, elo: 0.880, battles: 2_106 },
  { from: 400, to: null, higherWins: 0.701, elo: 0.953, battles: 3_311 },
]

/** Squadron rating gap (both ratings from the leaderboard ≤ 1 day before the battle). */
export const SQUADRON_GAP: readonly GapRow[] = [
  { from: 0, to: 1_000, higherWins: 0.503, battles: 557 },
  { from: 1_000, to: 4_000, higherWins: 0.570, battles: 1_408 },
  { from: 4_000, to: 8_000, higherWins: 0.681, battles: 1_440 },
  { from: 8_000, to: null, higherWins: 0.760, battles: 2_731 },
]

/** Median gap in battles vs two random teams that played within the same 2 hours. */
export const MATCHMAKING = {
  psr: { real: 221, random: 296 },
  squadron: { real: 7_040, random: 9_422 },
}

/**
 * A player who did not load in (empty lineup in the results; a bot took the
 * slot in 91% of cases): wins of the team with one more such player, and of a
 * team whose slot a bot took.
 */
export const NOT_LOADED = {
  oneMore: { wins: 0.154, battles: 527 },
  bot: { wins: 76, battles: 326 },
}

/** Side 1 win share on every map with more than `minBattles` battles. */
export const MAP_SIDES = { maps: 55, minBattles: 400, low: 0.452, high: 0.566 }

/**
 * Battle windows in UTC hours [start, end), measured from battle start times.
 * `share` — part of all battles, `medianTeamPsr` — median team average PSR.
 * The season panel's header says whether one is open now: until when, or the next start.
 */
export const BATTLE_WINDOWS = [
  { start: 14, end: 22, share: 0.87, medianTeamPsr: 991 },
  { start: 1, end: 7, share: 0.13, medianTeamPsr: 1_030 },
] as const
/** Busiest hours, UTC [start, end). */
export const PEAK_HOURS = { start: 18, end: 20 }

/** PSR of squadron members seen this season (claninfo snapshots). */
export const PSR_DISTRIBUTION = {
  players: 36_325,
  zeroShare: 0.607,
  /** Share of players with PSR > 0 at or above `psr`. */
  atLeast: [
    { psr: 500, share: 0.597 },
    { psr: 1_000, share: 0.417 },
    { psr: 1_300, share: 0.31 },
    { psr: 1_500, share: 0.16 },
    { psr: 1_800, share: 0.015 },
    { psr: 2_000, share: 0.001 },
  ],
  median: 739,
  top10: 1_569,
  top1: 1_813,
  max: 2_046,
}

/** How the PSR rule was fitted and checked. */
export const FIT = {
  /** Battles after which a player's PSR changed by exactly one battle. */
  singleBattles: 1_168,
  changes: 71_901,
  /** Share of single-battle changes the formula matches within 1 point. */
  withinOnePoint: 0.972,
  /** Share of multi-battle changes explained, lowest and highest PSR band. */
  chain: { low: 0.8, high: 1 },
  live: { matched: 113, total: 120 },
  k: 32.0,
  reference: { low: 1_500, high: 1_501 },
  scale: { low: 398, high: 402 },
  /** Squadron formula vs squadron pages: page states and error range in points. */
  squadron: { states: 12, errorLow: 0.4, errorHigh: 2.9 },
}

/**
 * The opponent in the PSR rule, measured 2026-10-07 on the squadron battles
 * of 2026-10-03..07: PSR changes of a single battle (two page readings around
 * it) where the PSR of at least 6 players of each team is known, each
 * player's before the battle reconstructed from the readings around it.
 * Shares within 1 point of the page.
 */
export const OPPONENT = {
  changes: 11_114,
  /** Changes against an enemy team averaging above 1500: a fixed 1500 vs the enemy average as the opponent. */
  strong: { changes: 796, fixed: 0.484, enemy: 0.886 },
  /** Against weaker teams both are the same rule. */
  weaker: 0.981,
}

/** Live poll of squadron pages during their battles. */
export const TIMING = {
  pollFrom: Date.UTC(2026, 9, 3, 18, 53) / 1000,
  pollTo: Date.UTC(2026, 9, 3, 20, 8) / 1000,
  pollSeconds: 16,
  squadrons: 3,
  battles: 27,
  /** Minutes from the battle end until the page showed the new PSR. */
  delay: { min: 0.6, max: 14.7, median: 7.2 },
  /** Share of first requests after a pause that got fresh data, and the share a fixed timer would give. */
  freshFirst: 0.48,
  freshTimer: 0.04,
}
