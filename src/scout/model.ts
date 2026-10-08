/**
 * Predicts a squadron's team in its next squadron battle: who plays and which
 * vehicle each player spawns. A squadron battle gives one life (0 or 1 deaths
 * in 99.99% of 795,063 rows, 2026-10-08), so the eight spawned vehicles are
 * the whole setup. Both models are logistic regressions whose weights
 * `npm run scout:backtest` fits on stored battles; accuracy, calibration and
 * the dead ends (map, cold start) are in docs/opponent-scouting.md.
 *
 * Pure functions over plain rows: the database reader (`readScoutHistory`)
 * and the backtest feed the same code.
 */

import type { VehicleClass } from '../wrpl/vehicles.js'

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

export function calibrateSetup(setup: ScoutSetup, lastHadAir: boolean): ScoutSetup {
  return {
    expected: setup.expected,
    compositions: setup.compositions.map((composition) => ({
      counts: composition.counts,
      chance: sigmoid(dot(COMPOSITION_CALIBRATION, compositionCalibrationFeatures(composition.raw))),
      raw: composition.raw,
    })),
    airChance: sigmoid(dot(AIR_CALIBRATION, airCalibrationFeatures(setup.rawAirChance, lastHadAir))),
    rawAirChance: setup.rawAirChance,
  }
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
      lineup: own[own.length - 1]?.lineup ?? [],
    }
  })
  players.sort((a, b) => b.playChance - a.playChance || a.nick.localeCompare(b.nick))
  const team = players.slice(0, TEAM_SIZE).map((player) => {
    const classChances: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
    let unknown = player.unseenChance
    for (const vehicle of player.vehicles) {
      const cls = input.classOf(vehicle.vehicleId)
      if (cls === '?') unknown += vehicle.chance
      else classChances[cls] += vehicle.chance
    }
    for (const cls of SCOUT_CLASSES) classChances[cls] += unknown * shares[cls]
    return { classChances }
  })
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
