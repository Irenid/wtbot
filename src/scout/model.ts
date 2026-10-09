/**
 * Predicts a squadron's team in its next squadron battle: who plays and which
 * vehicle each player spawns. A squadron battle gives one life (0 or 1 deaths
 * in 99.99% of 795,063 rows, 2026-10-08), so the eight spawned vehicles are
 * the whole setup. The models are logistic regressions whose weights
 * `npm run scout:backtest` fits on stored battles (`--known-team` the picture
 * path's); accuracy, calibration and the dead ends (map, cold start) are in
 * docs/opponent-scouting.md.
 *
 * Pure functions over plain rows: the database reader (`readScoutHistory`)
 * and the backtest feed the same code.
 */

import type { VehicleClass } from '../wrpl/vehicles.js'
import { conditionOnFlags, type FlagEvidence } from './flag-evidence.js'

export interface ScoutPlayerRow {
  userId: string
  nick: string
  /** The spawned vehicle; null — never spawned. */
  vehicle: string | null
  /** The lineup the player brought (results `crafts_info`). */
  lineup: readonly string[]
}

/** One battle of the squadron: its team's members only. */
export interface ScoutBattle {
  sessionId: string
  startTime: number
  endTime: number
  /** When the bot had it stored (ingested_at); the backtest simulates live ingest. */
  availableAt: number
  players: readonly ScoutPlayerRow[]
}

export interface ScoutStage {
  startsAt: number
  endsAt: number
  maxBr: number
}

/**
 * The cap changes on the stage's first day between the two windows, not at the
 * schedule's 00:00 UTC: battles of 01:00–07:00 UTC still play the previous cap
 * (70–96% of spawns above the new one on four stage changes), those from
 * 14:00 UTC the new one (0%). Measured 2026-10-08.
 */
export const STAGE_SWITCH_DELAY_SEC = 10 * 3600
/** Battles less than this apart are one session (93.4% of a squadron's next battles start within it). */
export const SESSION_GAP_SEC = 1800
/** Roster candidates: everyone who played for the squadron in this window. */
export const ROSTER_WINDOW_SEC = 14 * 86_400
export const MAX_ROSTER_BATTLES = 400
/** A player's battles at the current cap the vehicle model reads (older weigh < 1%). */
export const MAX_VEHICLE_HISTORY = 60
/** Two battles share this many players — the same group (a full team is 8). */
export const GROUP_MIN_SHARED = 4
export const TEAM_SIZE = 8

/** Feature order of ROSTER_WEIGHTS. */
export const ROSTER_FEATURES = [
  'bias', 'inLast', 'inLastByGap', 'inLast2', 'sessionShare', 'prevSessionShare', 'logAgeHours',
  'share7d', 'logBattles14d', 'sameHoursShare', 'daysActive14d',
] as const

/** Feature order of VEHICLE_WEIGHTS; the last three score the "not seen at this cap" option. */
export const VEHICLE_FEATURES = [
  'last1', 'last1AfterBreak', 'last2', 'last3', 'inLastLineup', 'decayedShare', 'neverSpawned',
  'unseen', 'unseenLogBattles', 'unseenAfterBreak',
] as const

/**
 * Fitted by `npm run scout:backtest -- <copy.db> --fit-all` on the 99,326
 * squadron team-battles of 2026-07-15 – 2026-10-08 (in a session: the
 * squadron's last battle ended under SESSION_GAP_SEC ago; after a break:
 * longer). The calibrations below come from the same run.
 */
export const ROSTER_WEIGHTS: Record<'session' | 'break', readonly number[]> = {
  session: [-3.401, 6.604, -1.299, 1.415, 0.313, 0.217, -0.418, 0.814, -0.304, 0.43, 1.941],
  break: [-2.015, 0.411, 0.009, -0.075, 0, 0.359, -0.248, 1.763, -0.032, 0.905, 1.149],
}
export const VEHICLE_WEIGHTS: readonly number[] = [1.12, -1.321, 0.396, 0.299, 1.576, 1.066, -1.57, 1.843, -0.456, 0.531]

/**
 * Teammates choose together, so the independent product misjudges team-level
 * chances (backtest: "at least one aircraft" said 38%, happened 23%).
 * Platt scaling over logit(independent chance) and whether the anchor battle's
 * team spawned an aircraft or helicopter; compositions over logit(chance).
 */
export const AIR_CALIBRATION: readonly number[] = [-1.392, 0.371, 2.134]
export const COMPOSITION_CALIBRATION: readonly number[] = [0.228, 0.938]

/** First spawns of all squadron teams at cap 8.0 (2026-10-06/08): a player without history at the cap. */
export const DEFAULT_CLASS_SHARES: Readonly<Record<ScoutClass, number>> = { T: 0.462, F: 0.242, AA: 0.167, L: 0.124, H: 0.005 }

export type ScoutClass = Exclude<VehicleClass, '?'>
export const SCOUT_CLASSES: readonly ScoutClass[] = ['F', 'H', 'T', 'L', 'AA']

export function stageAt(stages: readonly ScoutStage[], ts: number): ScoutStage | null {
  const shifted = ts - STAGE_SWITCH_DELAY_SEC
  return stages.find((stage) => shifted >= stage.startsAt && shifted < stage.endsAt) ?? null
}

/** The BR period's bounds as battle start times: [startsAt, endsAt) shifted by the switch delay. */
export function periodBounds(stage: ScoutStage): { from: number; to: number } {
  return { from: stage.startsAt + STAGE_SWITCH_DELAY_SEC, to: stage.endsAt + STAGE_SWITCH_DELAY_SEC }
}

const dot = (weights: readonly number[], x: readonly number[]): number => {
  let sum = 0
  for (let i = 0; i < x.length; i += 1) sum += (weights[i] ?? 0) * x[i]!
  return sum
}
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value))
const hourOfDay = (ts: number): number => (((ts % 86_400) + 86_400) % 86_400) / 3600
const hourDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 24
  return Math.min(d, 24 - d)
}

/** Battles known at `now`, oldest first by end. */
export function knownBattles(battles: readonly ScoutBattle[], now: number): ScoutBattle[] {
  return battles
    .filter((battle) => battle.availableAt <= now && battle.endTime <= now && battle.endTime >= now - ROSTER_WINDOW_SEC)
    .sort((a, b) => a.endTime - b.endTime || a.startTime - b.startTime)
    .slice(-MAX_ROSTER_BATTLES)
}

/** The chain of battles ending at `history[lastIndex]`, each under SESSION_GAP_SEC before the next. */
function sessionChain(history: readonly ScoutBattle[], lastIndex: number): ScoutBattle[] {
  const chain: ScoutBattle[] = []
  for (let i = lastIndex; i >= 0; i -= 1) {
    const battle = history[i]!
    if (chain.length > 0 && chain[chain.length - 1]!.startTime - battle.endTime > SESSION_GAP_SEC) break
    chain.push(battle)
  }
  return chain
}

export interface RosterCandidate {
  userId: string
  nick: string
  features: number[]
}

/**
 * Roster features of everyone in `history` (known battles, oldest first) for a
 * battle starting at `now`; the last battle of `history` is the anchor.
 */
export function rosterCandidates(history: readonly ScoutBattle[], now: number): {
  regime: 'session' | 'break'
  candidates: RosterCandidate[]
} {
  const last = history[history.length - 1]
  if (!last) return { regime: 'break', candidates: [] }
  const gap = now - last.endTime
  const inSession = gap <= SESSION_GAP_SEC
  const chain = sessionChain(history, history.length - 1)
  const current = inSession ? chain : []
  const previous = inSession
    ? (history.length - chain.length - 1 >= 0 ? sessionChain(history, history.length - chain.length - 1) : [])
    : chain
  const weekBattles = history.filter((battle) => battle.endTime >= now - 7 * 86_400).length
  const lastIds = new Set(last.players.map((player) => player.userId))
  const last2 = history[history.length - 2]
  const last2Ids = new Set(last2 ? last2.players.map((player) => player.userId) : [])
  const count = (battles: readonly ScoutBattle[]) => {
    const counts = new Map<string, number>()
    for (const battle of battles) for (const player of battle.players) counts.set(player.userId, (counts.get(player.userId) ?? 0) + 1)
    return counts
  }
  const currentCounts = count(current)
  const previousCounts = count(previous)
  const stats = new Map<string, { nick: string; n: number; n7: number; lastEnd: number; near: number; days: Set<number> }>()
  const nowHour = hourOfDay(now)
  for (const battle of history) {
    const near = hourDistance(hourOfDay(battle.startTime), nowHour) <= 3 ? 1 : 0
    for (const player of battle.players) {
      let entry = stats.get(player.userId)
      if (!entry) {
        entry = { nick: player.nick, n: 0, n7: 0, lastEnd: 0, near: 0, days: new Set() }
        stats.set(player.userId, entry)
      }
      entry.nick = player.nick
      entry.n += 1
      if (battle.endTime >= now - 7 * 86_400) entry.n7 += 1
      entry.lastEnd = Math.max(entry.lastEnd, battle.endTime)
      entry.near += near
      entry.days.add(Math.floor(battle.startTime / 86_400))
    }
  }
  const gapFeature = Math.log1p(gap / 60)
  const candidates: RosterCandidate[] = []
  for (const [userId, entry] of stats) {
    const inLast = lastIds.has(userId) ? 1 : 0
    candidates.push({
      userId,
      nick: entry.nick,
      features: [
        1,
        inLast,
        inLast * gapFeature,
        last2Ids.has(userId) ? 1 : 0,
        current.length > 0 ? (currentCounts.get(userId) ?? 0) / current.length : 0,
        previous.length > 0 ? (previousCounts.get(userId) ?? 0) / previous.length : 0,
        Math.log1p((now - entry.lastEnd) / 3600),
        entry.n7 / Math.max(1, weekBattles),
        Math.log1p(entry.n),
        entry.near / entry.n,
        entry.days.size / 14,
      ],
    })
  }
  return { regime: inSession ? 'session' : 'break', candidates }
}

export interface PlayerVehicleHistory {
  endTime: number
  vehicle: string
  lineup: readonly string[]
}

export interface VehicleChoiceFeatures {
  vehicles: string[]
  /** One row per vehicle, VEHICLE_FEATURES order with the unseen columns zero. */
  rows: number[][]
  /** The "not seen at this cap" option's row. */
  unseenRow: number[]
}

/** Candidate vehicles of one player from their battles at the current cap, oldest first. */
export function vehicleChoiceFeatures(history: readonly PlayerVehicleHistory[], now: number): VehicleChoiceFeatures | null {
  const recent = history.slice(-MAX_VEHICLE_HISTORY)
  const n = recent.length
  const last = recent[n - 1]
  if (!last) return null
  const afterBreak = now - last.endTime > SESSION_GAP_SEC ? 1 : 0
  const spawned = new Map<string, number>()
  const decayed = new Map<string, number>()
  let decayTotal = 0
  const vehicles = new Set<string>()
  recent.forEach((entry, index) => {
    const weight = 0.5 ** ((n - 1 - index) / 8)
    decayTotal += weight
    decayed.set(entry.vehicle, (decayed.get(entry.vehicle) ?? 0) + weight)
    spawned.set(entry.vehicle, (spawned.get(entry.vehicle) ?? 0) + 1)
    vehicles.add(entry.vehicle)
    for (const vehicle of entry.lineup) vehicles.add(vehicle)
  })
  const lastLineup = new Set(last.lineup)
  const sorted = [...vehicles].sort()
  const rows = sorted.map((vehicle) => {
    const isLast = vehicle === last.vehicle ? 1 : 0
    return [
      isLast,
      isLast * afterBreak,
      n >= 2 && recent[n - 2]!.vehicle === vehicle ? 1 : 0,
      n >= 3 && recent[n - 3]!.vehicle === vehicle ? 1 : 0,
      lastLineup.has(vehicle) ? 1 : 0,
      (decayed.get(vehicle) ?? 0) / decayTotal,
      spawned.has(vehicle) ? 0 : 1,
      0, 0, 0,
    ]
  })
  return { vehicles: sorted, rows, unseenRow: [0, 0, 0, 0, 0, 0, 0, 1, Math.log(n), afterBreak] }
}

export interface VehicleChance {
  vehicleId: string
  chance: number
}

/** Softmax over the candidates and the unseen option; vehicles by chance, highest first. */
export function vehicleChances(
  features: VehicleChoiceFeatures,
  weights: readonly number[] = VEHICLE_WEIGHTS,
): { vehicles: VehicleChance[]; unseen: number } {
  const scores = features.rows.map((row) => dot(weights, row))
  const unseenScore = dot(weights, features.unseenRow)
  const max = Math.max(unseenScore, ...scores)
  const exps = scores.map((score) => Math.exp(score - max))
  const unseenExp = Math.exp(unseenScore - max)
  const total = exps.reduce((sum, value) => sum + value, unseenExp)
  return {
    vehicles: features.vehicles
      .map((vehicleId, index) => ({ vehicleId, chance: exps[index]! / total }))
      .sort((a, b) => b.chance - a.chance || a.vehicleId.localeCompare(b.vehicleId)),
    unseen: unseenExp / total,
  }
}

/**
 * A player beyond the current cap: their stored squadron spawns at any cap and
 * StatShark's per-vehicle battles (playerBackground). It names the vehicle a
 * player takes when their battles at this cap do not (newVehicleChances).
 */
export interface PlayerBackground {
  /** Spawns per nation (research tree) and per class, any cap. */
  nations: ReadonlyMap<string, number>
  classes: ReadonlyMap<string, number>
  spawns: number
  /** Every vehicle seen in their lineups or spawns, any cap. */
  seen: ReadonlySet<string>
  /** StatShark battles per vehicle (squadron battles are not in them); null — no snapshot. */
  battles: ReadonlyMap<string, number> | null
  /** The snapshot is under STATSHARK_FRESH_SEC old: a vehicle missing from it counts as never played. */
  battlesFresh: boolean
}

/** Spawns per vehicle at the current cap so far, every squadron's: the BR's popularity. */
export type CapSpawns = ReadonlyMap<string, number>

/** Feature order of NEW_VEHICLE_WEIGHTS; the last scores the "a vehicle outside the cap's popular ones" option. */
export const NEW_VEHICLE_FEATURES = ['logShare', 'nationShare', 'classShare', 'seenBefore', 'logBattles', 'notPlayed', 'other'] as const
/**
 * Conditional logit fitted by `npm run scout:backtest -- <copy.db> --known-team
 * --fit-all --statshark` on the 72,282 new-vehicle events of 2026-07-15 –
 * 10-08 (a player taking a vehicle never seen from them at the cap); the two
 * StatShark weights on the events of the 84 players with a snapshot read up to
 * 3 days after the battle (docs/opponent-scouting.md).
 */
export const NEW_VEHICLE_WEIGHTS: readonly number[] = [0.834, 1.275, 0.89, 2.31, 0.298, -3.82, -1.2]
/** Candidates: the cap's most spawned vehicles (the top 150 held 96–97% of the spawns at 10.0 and 9.0). */
export const NEW_VEHICLE_CANDIDATES = 150
/**
 * A StatShark snapshot older than this still gives battle counts (they only
 * grow), but a vehicle missing from it may have been bought or played since:
 * `notPlayed` (×0.02) then does not apply. 19 of the 84 snapshots were over
 * 2 days old on 2026-10-09, the oldest 10 days.
 */
export const STATSHARK_FRESH_SEC = 2 * 86_400

export interface NewVehicleFeatures {
  vehicles: string[]
  /** One row per vehicle, NEW_VEHICLE_FEATURES order; the "other" option's row last. */
  rows: number[][]
}

/** A background from the player's stored rows (any cap; the caller keeps those known at query time) and StatShark's battles (`fresh`: STATSHARK_FRESH_SEC). */
export function playerBackground(
  rows: Iterable<{ vehicle: string | null; lineup: readonly string[] }>,
  info: (vehicleId: string) => { nation: string; cls: VehicleClass },
  battles: ReadonlyMap<string, number> | null = null,
  fresh = battles !== null,
): PlayerBackground {
  const nations = new Map<string, number>()
  const classes = new Map<string, number>()
  const seen = new Set<string>()
  let spawns = 0
  for (const row of rows) {
    for (const vehicle of row.lineup) seen.add(vehicle)
    if (!row.vehicle) continue
    seen.add(row.vehicle)
    const { nation, cls } = info(row.vehicle)
    nations.set(nation, (nations.get(nation) ?? 0) + 1)
    classes.set(cls, (classes.get(cls) ?? 0) + 1)
    spawns += 1
  }
  return { nations, classes, spawns, seen, battles, battlesFresh: battles !== null && fresh }
}

/** The cap's popular vehicles as a player's "new vehicle" options (`exclude`: theirs at this cap). */
export function newVehicleFeatures(
  capSpawns: CapSpawns,
  background: PlayerBackground | null,
  exclude: ReadonlySet<string>,
  info: (vehicleId: string) => { nation: string; cls: VehicleClass },
): NewVehicleFeatures {
  let total = 0
  for (const count of capSpawns.values()) total += count
  const ranked = [...capSpawns].filter(([id]) => !exclude.has(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, NEW_VEHICLE_CANDIDATES)
  const spawns = background?.spawns ?? 0
  const battles = background?.battles ?? null
  const rows = ranked.map(([id, count]) => {
    const { nation, cls } = info(id)
    const played = battles?.get(id) ?? 0
    return [
      Math.log(count / total),
      spawns > 0 ? (background!.nations.get(nation) ?? 0) / spawns : 0,
      spawns > 0 ? (background!.classes.get(cls) ?? 0) / spawns : 0,
      background?.seen.has(id) ? 1 : 0,
      battles ? Math.log1p(played) : 0,
      battles && background!.battlesFresh && played === 0 ? 1 : 0,
      0,
    ]
  })
  rows.push([0, 0, 0, 0, 0, 0, 1])
  return { vehicles: ranked.map(([id]) => id), rows }
}

/** Softmax over the candidates and "other": chances of a new vehicle, given one is taken. */
export function newVehicleChances(
  features: NewVehicleFeatures,
  weights: readonly number[] = NEW_VEHICLE_WEIGHTS,
): { vehicles: VehicleChance[]; other: number } {
  const scores = features.rows.map((row) => dot(weights, row))
  const max = Math.max(...scores)
  const exps = scores.map((score) => Math.exp(score - max))
  const total = exps.reduce((sum, value) => sum + value, 0)
  return {
    vehicles: features.vehicles
      .map((vehicleId, index) => ({ vehicleId, chance: exps[index]! / total }))
      .sort((a, b) => b.chance - a.chance || a.vehicleId.localeCompare(b.vehicleId)),
    other: exps[exps.length - 1]! / total,
  }
}

export function rosterChance(candidate: RosterCandidate, regime: 'session' | 'break'): number {
  return sigmoid(dot(ROSTER_WEIGHTS[regime], candidate.features))
}

export interface ScoutGroupBattle {
  sessionId: string
  endTime: number
  userIds: Set<string>
}

/**
 * Groups of the squadron's latest session: a battle joins the group whose
 * newest battle shares GROUP_MIN_SHARED players with it. Newest group first;
 * a group is active while its newest battle ended under SESSION_GAP_SEC ago.
 */
export function sessionGroups(history: readonly ScoutBattle[], now: number): ScoutGroupBattle[][] {
  if (history.length === 0) return []
  const chain = sessionChain(history, history.length - 1)
  const groups: ScoutGroupBattle[][] = []
  for (const battle of chain) {
    const entry = { sessionId: battle.sessionId, endTime: battle.endTime, userIds: new Set(battle.players.map((p) => p.userId)) }
    const group = groups.find((members) => {
      let shared = 0
      for (const id of members[0]!.userIds) if (entry.userIds.has(id)) shared += 1
      return shared >= GROUP_MIN_SHARED
    })
    if (group) group.push(entry)
    else groups.push([entry])
  }
  return groups.filter((group) => now - group[0]!.endTime <= SESSION_GAP_SEC)
}

export interface ScoutPlayerPrediction {
  userId: string
  nick: string
  playChance: number
  /** Battles at the current cap the vehicle chances come from. */
  battlesAtCap: number
  vehicles: VehicleChance[]
  /** A vehicle never seen from this player at the current cap (1 without history). */
  unseenChance: number
  /** The likeliest of those, the cap's popular vehicles (a part of unseenChance, highest first); empty — not guessed. */
  newVehicles: VehicleChance[]
  /** The last lineup at the current cap. */
  lineup: readonly string[]
}

export interface ScoutSetup {
  /** Expected number of players spawning each class. */
  expected: Record<ScoutClass, number>
  /** Most likely class counts of the eight spawns, most likely first; raw — the independent product. */
  compositions: { counts: Record<ScoutClass, number>; chance: number; raw: number }[]
  /** At least one aircraft or helicopter. */
  airChance: number
  rawAirChance: number
}

export interface ScoutGroupPrediction {
  regime: 'session' | 'break'
  /** The battle the prediction is anchored on: the squadron's (or the hinted player's group's) latest. */
  anchor: { sessionId: string; endTime: number }
  players: ScoutPlayerPrediction[]
  setup: ScoutSetup
}

export interface ScoutPredictionInput {
  battles: readonly ScoutBattle[]
  now: number
  stages: readonly ScoutStage[]
  classOf: (vehicleId: string) => VehicleClass
  /** A player seen on the enemy team: the prediction follows their group. */
  hintUserId?: string | undefined
}

export interface ScoutPrediction {
  /** Cap of the current BR period; null — outside the season schedule (vehicle history: last 7 days). */
  maxBr: number | null
  /** The squadron's known battles at the current cap (or in the last 7 days outside the schedule). */
  battlesAtCap: number
  lastBattleEnd: number | null
  primary: ScoutGroupPrediction | null
  /** Another group playing at the same time (newest battle under SESSION_GAP_SEC ago). */
  otherGroups: { anchor: { sessionId: string; endTime: number }; nicks: string[] }[]
  /** The hint matched no player of the squadron's known battles. */
  hintUnknown: boolean
}

/** Per-player vehicle history at the current cap (or the last 7 days outside the schedule). */
function vehicleHistories(known: readonly ScoutBattle[], stage: ScoutStage | null, now: number): Map<string, PlayerVehicleHistory[]> {
  const from = stage ? periodBounds(stage).from : now - 7 * 86_400
  const byPlayer = new Map<string, PlayerVehicleHistory[]>()
  for (const battle of known) {
    if (battle.startTime < from) continue
    for (const player of battle.players) {
      if (!player.vehicle) continue
      const list = byPlayer.get(player.userId)
      const entry = { endTime: battle.endTime, vehicle: player.vehicle, lineup: player.lineup }
      if (list) list.push(entry)
      else byPlayer.set(player.userId, [entry])
    }
  }
  return byPlayer
}

function classShares(known: readonly ScoutBattle[], stageFrom: number, classOf: (id: string) => VehicleClass): Record<ScoutClass, number> {
  const counts: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
  let total = 0
  for (const battle of known) {
    if (battle.startTime < stageFrom) continue
    for (const player of battle.players) {
      if (!player.vehicle) continue
      const cls = classOf(player.vehicle)
      if (cls === '?') continue
      counts[cls] += 1
      total += 1
    }
  }
  // Fewer than three teams' spawns: the global shares, blended in proportionally.
  const prior = 24
  const shares = { ...counts }
  for (const cls of SCOUT_CLASSES) shares[cls] = (counts[cls] + prior * DEFAULT_CLASS_SHARES[cls]) / (total + prior)
  return shares
}

/** Class distribution of the eight spawns: exact convolution over the predicted players. */
export function setupFromPlayers(
  players: readonly { classChances: Record<ScoutClass, number> }[],
  limit = 3,
): ScoutSetup {
  let states = new Map<string, number>([['0,0,0,0,0', 1]])
  const expected: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
  let noAir = 1
  for (const player of players) {
    const next = new Map<string, number>()
    for (const [key, chance] of states) {
      const counts = key.split(',').map(Number)
      SCOUT_CLASSES.forEach((cls, index) => {
        const p = player.classChances[cls]
        if (p <= 0) return
        counts[index]! += 1
        const nextKey = counts.join(',')
        next.set(nextKey, (next.get(nextKey) ?? 0) + chance * p)
        counts[index]! -= 1
      })
    }
    states = next
    for (const cls of SCOUT_CLASSES) expected[cls] += player.classChances[cls]
    noAir *= 1 - player.classChances.F - player.classChances.H
  }
  const compositions = [...states]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, chance]) => {
      const values = key.split(',').map(Number)
      const counts = Object.fromEntries(SCOUT_CLASSES.map((cls, index) => [cls, values[index]!])) as Record<ScoutClass, number>
      return { counts, chance, raw: chance }
    })
  return { expected, compositions, airChance: 1 - noAir, rawAirChance: 1 - noAir }
}

const logit = (p: number): number => {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p))
  return Math.log(c / (1 - c))
}

/** Features of AIR_CALIBRATION: [1, logit(independent chance), anchor team spawned air]. */
export function airCalibrationFeatures(independentChance: number, lastHadAir: boolean): number[] {
  return [1, logit(independentChance), lastHadAir ? 1 : 0]
}

/** Features of COMPOSITION_CALIBRATION: [1, logit(independent chance)]. */
export function compositionCalibrationFeatures(independentChance: number): number[] {
  return [1, logit(independentChance)]
}

export interface SetupCalibration {
  air: readonly number[]
  composition: readonly number[]
}

export function calibrateSetup(
  setup: ScoutSetup,
  lastHadAir: boolean,
  calibration: SetupCalibration = { air: AIR_CALIBRATION, composition: COMPOSITION_CALIBRATION },
): ScoutSetup {
  return {
    expected: setup.expected,
    compositions: setup.compositions.map((composition) => ({
      counts: composition.counts,
      chance: sigmoid(dot(calibration.composition, compositionCalibrationFeatures(composition.raw))),
      raw: composition.raw,
    })),
    airChance: sigmoid(dot(calibration.air, airCalibrationFeatures(setup.rawAirChance, lastHadAir))),
    rawAirChance: setup.rawAirChance,
  }
}

/** A player's chance of each class: their vehicles' and the guessed new ones', the unguessed and unknown-class rest spread by the shares. */
function classChancesOf(
  player: ScoutPlayerPrediction,
  classOf: (id: string) => VehicleClass,
  shares: Record<ScoutClass, number>,
): Record<ScoutClass, number> {
  const classChances: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
  let unknown = Math.max(0, player.unseenChance - player.newVehicles.reduce((sum, vehicle) => sum + vehicle.chance, 0))
  for (const vehicle of [...player.vehicles, ...player.newVehicles]) {
    const cls = classOf(vehicle.vehicleId)
    if (cls === '?') unknown += vehicle.chance
    else classChances[cls] += vehicle.chance
  }
  for (const cls of SCOUT_CLASSES) classChances[cls] += unknown * shares[cls]
  return classChances
}

function predictGroup(
  history: readonly ScoutBattle[],
  input: ScoutPredictionInput,
  vehicleHistory: Map<string, PlayerVehicleHistory[]>,
  shares: Record<ScoutClass, number>,
): ScoutGroupPrediction {
  const { regime, candidates } = rosterCandidates(history, input.now)
  const anchor = history[history.length - 1]!
  const players: ScoutPlayerPrediction[] = candidates.map((candidate) => {
    const own = vehicleHistory.get(candidate.userId) ?? []
    const features = vehicleChoiceFeatures(own, input.now)
    const chances = features ? vehicleChances(features) : { vehicles: [], unseen: 1 }
    return {
      userId: candidate.userId,
      nick: candidate.nick,
      playChance: rosterChance(candidate, regime),
      battlesAtCap: own.length,
      vehicles: chances.vehicles,
      unseenChance: chances.unseen,
      newVehicles: [],
      lineup: own[own.length - 1]?.lineup ?? [],
    }
  })
  players.sort((a, b) => b.playChance - a.playChance || a.nick.localeCompare(b.nick))
  const team = players.slice(0, TEAM_SIZE).map((player) => ({ classChances: classChancesOf(player, input.classOf, shares) }))
  const lastHadAir = anchor.players.some((player) => {
    const cls = player.vehicle ? input.classOf(player.vehicle) : '?'
    return cls === 'F' || cls === 'H'
  })
  return {
    regime,
    anchor: { sessionId: anchor.sessionId, endTime: anchor.endTime },
    players,
    setup: calibrateSetup(setupFromPlayers(team), lastHadAir),
  }
}

export function predictScout(input: ScoutPredictionInput): ScoutPrediction {
  const known = knownBattles(input.battles, input.now)
  const stage = stageAt(input.stages, input.now)
  const vehicleHistory = vehicleHistories(known, stage, input.now)
  const capFrom = stage ? periodBounds(stage).from : input.now - 7 * 86_400
  const shares = classShares(known, capFrom, input.classOf)
  const result: ScoutPrediction = {
    maxBr: stage?.maxBr ?? null,
    battlesAtCap: known.filter((battle) => battle.startTime >= capFrom).length,
    lastBattleEnd: known[known.length - 1]?.endTime ?? null,
    primary: null,
    otherGroups: [],
    hintUnknown: false,
  }
  if (known.length === 0) return result
  let anchorIndex = known.length - 1
  if (input.hintUserId !== undefined) {
    const index = known.findLastIndex((battle) => battle.players.some((player) => player.userId === input.hintUserId))
    if (index >= 0) anchorIndex = index
    else result.hintUnknown = true
  }
  const history = known.slice(0, anchorIndex + 1)
  result.primary = predictGroup(history, input, vehicleHistory, shares)
  const nickById = new Map<string, string>()
  for (const battle of known) for (const player of battle.players) nickById.set(player.userId, player.nick)
  const primaryIds = new Set(known[anchorIndex]!.players.map((player) => player.userId))
  for (const group of sessionGroups(known, input.now)) {
    const newest = group[0]!
    let shared = 0
    for (const id of newest.userIds) if (primaryIds.has(id)) shared += 1
    if (shared >= GROUP_MIN_SHARED) continue
    result.otherGroups.push({
      anchor: { sessionId: newest.sessionId, endTime: newest.endTime },
      nicks: [...newest.userIds].map((id) => nickById.get(id) ?? id).sort((a, b) => a.localeCompare(b)),
    })
  }
  return result
}

export interface KnownTeamInput {
  /** The players read from a scoreboard. */
  players: readonly { userId: string; nick: string }[]
  /** Enemy rows nobody was recognised in: they count with the class shares. */
  unknownPlayers: number
  /** The players' battles (any squadron, any teammates). */
  battles: readonly ScoutBattle[]
  now: number
  stages: readonly ScoutStage[]
  classOf: (vehicleId: string) => VehicleClass
  /** The flags above the enemy team (flag-evidence.ts); omitted — none read. */
  flags?: FlagEvidence | undefined
  /** Spawns per vehicle at the current cap so far, every squadron's: names the vehicles a player has not taken at this cap; omitted — unnamed. */
  capSpawns?: CapSpawns | undefined
  /** The players' backgrounds (playerBackground) by user id. */
  backgrounds?: ReadonlyMap<string, PlayerBackground> | undefined
  /** A vehicle's research-tree nation; the guesses need it with capSpawns. */
  nationOf?: ((vehicleId: string) => string) | undefined
  /** Aircraft and helicopters the screenshot's own squadron spawns per battle (opponentAir); null — unknown. */
  opponentAir?: number | null | undefined
  /** The backtest's fits; omitted — the shipped constants. */
  weights?: {
    newVehicle?: readonly number[]
    opponentAir?: Readonly<Partial<Record<ScoutClass, number>>>
    setup?: Readonly<Record<'flags' | 'noFlags', SetupCalibration>>
  } | undefined
}

/** New vehicles kept per player; the rest joins the unnamed share (each is an option of the flag chain). */
export const NEW_VEHICLES_KEPT = 30

/**
 * Squadrons bring anti-aircraft against an opponent that flies: a player who
 * took SPAA last time keeps it 62% against squadrons spawning under 0.5
 * aircraft a battle, 88% against 3 or more (2026-10-01 – 10-08). Per aircraft
 * a battle above OPPONENT_AIR_MEAN, a class's chances scale by exp(weight).
 */
export const OPPONENT_AIR_WEIGHTS: Readonly<Partial<Record<ScoutClass, number>>> = { F: 0.059, H: 0.022, T: -0.079, L: -0.046, AA: 0.347 }
export const OPPONENT_AIR_MEAN = 2
/** The own squadron's battles the habit is read from (the latest). */
export const OPPONENT_AIR_BATTLES = 20

/**
 * Setup calibrations of the picture path, without flags and with them
 * (screenshots 10–120 s after the first spawn): the roster is known, so the
 * raw chances are sharper than /scout squadron's, which overstated the setup
 * and missed the air chance by 24–28 points in 4% of teams. Same fit.
 */
export const KNOWN_TEAM_SETUP_CALIBRATION: Readonly<Record<'flags' | 'noFlags', SetupCalibration>> = {
  noFlags: { air: [-1.179, 0.637, 1.238], composition: [0.458, 1.137] },
  flags: { air: [-0.992, 0.901, 0.269], composition: [0.177, 1.126] },
}

/** Scales a player's options by class for the opponent's air habit (`excess`: its aircraft a battle over the mean); the unnamed share stays. */
export function weighOpponentAir(
  player: ScoutPlayerPrediction,
  excess: number,
  weights: Readonly<Partial<Record<ScoutClass, number>>>,
  classOf: (vehicleId: string) => VehicleClass,
): void {
  const scaled = (vehicles: readonly VehicleChance[]) => vehicles.map((vehicle) => {
    const cls = classOf(vehicle.vehicleId)
    return { vehicleId: vehicle.vehicleId, chance: vehicle.chance * (cls === '?' ? 1 : Math.exp((weights[cls] ?? 0) * excess)) }
  })
  const unnamed = Math.max(0, player.unseenChance - chanceSum(player.newVehicles))
  const vehicles = scaled(player.vehicles)
  const newVehicles = scaled(player.newVehicles)
  const total = chanceSum(vehicles) + chanceSum(newVehicles) + unnamed
  if (!(total > 0)) return
  const normal = (list: VehicleChance[]) => list.map((vehicle) => ({ vehicleId: vehicle.vehicleId, chance: vehicle.chance / total })).sort(byChance)
  player.vehicles = normal(vehicles)
  player.newVehicles = normal(newVehicles)
  player.unseenChance = unnamed / total + chanceSum(player.newVehicles)
}

/** Aircraft and helicopters per battle over a squadron's latest teams (any player's spawn of F or H); null — under 5 teams. */
export function opponentAir(teams: readonly { endTime: number; air: number }[]): number | null {
  const latest = [...teams].sort((a, b) => b.endTime - a.endTime).slice(0, OPPONENT_AIR_BATTLES)
  return latest.length >= 5 ? latest.reduce((sum, team) => sum + team.air, 0) / latest.length : null
}

const chanceSum = (vehicles: readonly VehicleChance[]): number => vehicles.reduce((sum, vehicle) => sum + vehicle.chance, 0)
const byChance = (a: VehicleChance, b: VehicleChance): number => b.chance - a.chance || a.vehicleId.localeCompare(b.vehicleId)

export interface KnownTeamPrediction {
  maxBr: number | null
  /** The latest battle with the most of these players together; null — none. */
  lastTogether: { endTime: number; players: number } | null
  /** Recognised players (play chance 1), most battles at the cap first. */
  players: ScoutPlayerPrediction[]
  setup: ScoutSetup
  /** The enemy flags the chances are conditioned on, as their likeliest reading; null — none read, or they fit nobody. */
  flags: { icons: string[]; operatorChance: number } | null
  /** The air calibration's input: lastTogether's team spawned an aircraft or helicopter. */
  lastHadAir: boolean
}

/**
 * The enemy team is known (a scoreboard screenshot): only the vehicles are
 * predicted, each player's from their own battles at the current cap with any
 * squadron; the share of a vehicle not seen from them at this cap goes to the
 * cap's popular vehicles (newVehicleChances, with capSpawns), the classes are
 * weighed by the opponent's air habit (with opponentAir), then everything is
 * given the flags above the enemy team when they were read (flag-evidence.ts).
 * The setup uses the picture path's calibration and the latest battle most of
 * them played together.
 */
export function predictKnownTeam(input: KnownTeamInput): KnownTeamPrediction {
  const known = input.battles
    .filter((battle) => battle.availableAt <= input.now && battle.endTime <= input.now)
    .sort((a, b) => a.endTime - b.endTime || a.startTime - b.startTime)
  const stage = stageAt(input.stages, input.now)
  const capFrom = stage ? periodBounds(stage).from : input.now - 7 * 86_400
  const vehicleHistory = vehicleHistories(known, stage, input.now)
  const shares = classShares(known, capFrom, input.classOf)
  const ids = new Set(input.players.map((player) => player.userId))
  let anchor: ScoutBattle | null = null
  let anchorCount = 0
  for (const battle of known) {
    const count = battle.players.filter((player) => ids.has(player.userId)).length
    if (count >= 2 && count >= anchorCount) {
      anchor = battle
      anchorCount = count
    }
  }
  const nationOf = input.nationOf
  const guessing = input.capSpawns !== undefined && input.capSpawns.size > 0 && nationOf !== undefined
  const info = (id: string) => ({ nation: nationOf?.(id) ?? '?', cls: input.classOf(id) })
  const players: ScoutPlayerPrediction[] = input.players.map((player) => {
    const own = vehicleHistory.get(player.userId) ?? []
    const features = vehicleChoiceFeatures(own, input.now)
    const chances = features ? vehicleChances(features) : { vehicles: [], unseen: 1 }
    const background = input.backgrounds?.get(player.userId) ?? null
    const newVehicles = guessing && chances.unseen > 0
      ? newVehicleChances(newVehicleFeatures(input.capSpawns!, background, new Set(features?.vehicles ?? []), info), input.weights?.newVehicle).vehicles
        .slice(0, NEW_VEHICLES_KEPT)
        .map((vehicle) => ({ vehicleId: vehicle.vehicleId, chance: vehicle.chance * chances.unseen }))
      : []
    const prediction: ScoutPlayerPrediction = {
      userId: player.userId,
      nick: player.nick,
      playChance: 1,
      battlesAtCap: own.length,
      vehicles: chances.vehicles,
      unseenChance: chances.unseen,
      newVehicles,
      lineup: own[own.length - 1]?.lineup ?? [],
    }
    if (input.opponentAir !== undefined && input.opponentAir !== null) {
      weighOpponentAir(prediction, input.opponentAir - OPPONENT_AIR_MEAN, input.weights?.opponentAir ?? OPPONENT_AIR_WEIGHTS, input.classOf)
    }
    return prediction
  })
  // The guessed new vehicles are options with their own flags; the unguessed rest stays unseen.
  const posterior = input.flags
    ? conditionOnFlags(players.map((player) => ({
        vehicles: [...player.vehicles, ...player.newVehicles],
        unseen: Math.max(0, player.unseenChance - chanceSum(player.newVehicles)),
      })), input.flags)
    : null
  if (posterior) {
    posterior.players.forEach((conditioned, index) => {
      const player = players[index]!
      const seen = player.vehicles.length
      player.vehicles = conditioned.vehicles.slice(0, seen).sort(byChance)
      player.newVehicles = conditioned.vehicles.slice(seen).sort(byChance)
      player.unseenChance = conditioned.unseen + chanceSum(player.newVehicles)
    })
  }
  players.sort((a, b) => b.battlesAtCap - a.battlesAtCap || a.nick.localeCompare(b.nick))
  const team = players.map((player) => ({ classChances: classChancesOf(player, input.classOf, shares) }))
  for (let i = 0; i < input.unknownPlayers; i += 1) team.push({ classChances: { ...shares } })
  const lastHadAir = anchor?.players.some((player) => {
    if (!ids.has(player.userId) || !player.vehicle) return false
    const cls = input.classOf(player.vehicle)
    return cls === 'F' || cls === 'H'
  }) ?? false
  return {
    maxBr: stage?.maxBr ?? null,
    lastTogether: anchor ? { endTime: anchor.endTime, players: anchorCount } : null,
    players,
    setup: calibrateSetup(setupFromPlayers(team), lastHadAir, (input.weights?.setup ?? KNOWN_TEAM_SETUP_CALIBRATION)[posterior ? 'flags' : 'noFlags']),
    flags: posterior ? { icons: posterior.line, operatorChance: posterior.operatorChance } : null,
    lastHadAir,
  }
}
