// Backtest of the /scout model (src/scout/model.ts) on a copy of the database:
// every squadron team-battle is predicted as if /scout ran QUERY_DELAY_SEC after
// its start, from the battles the bot had stored by then (live ingest
// simulated for backfilled ones). Prints accuracy and calibration; --fit also
// fits the weights (train: before --split, default 2026-10-01; --fit-all: on
// everything, the weights to ship) and evaluates with them.
// Squadrons are split over worker threads (all cores but two, --threads N):
// each keeps its samples, and every Newton step of a fit is a map-reduce.
// --known-team instead scores the picture path (predictKnownTeam): each team of
// 8 from --split on, its players known, with and without the flags its spawns
// show above the scoreboard (simulated).
// Run: npm run scout:backtest -- <copy.db> [--fit | --fit-all | --known-team] [--split YYYY-MM-DD] [--threads N]
//      [--vehicles data/wt-vehicles.json]
// Read-only; never point it at the live data/wtbot.db while the bot writes it.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  AIR_CALIBRATION,
  COMPOSITION_CALIBRATION,
  GROUP_MIN_SHARED,
  ROSTER_FEATURES,
  ROSTER_WEIGHTS,
  SESSION_GAP_SEC,
  VEHICLE_FEATURES,
  VEHICLE_WEIGHTS,
  airCalibrationFeatures,
  compositionCalibrationFeatures,
  knownBattles,
  periodBounds,
  predictKnownTeam,
  predictScout,
  rosterCandidates,
  stageAt,
  vehicleChoiceFeatures,
  type PlayerVehicleHistory,
  type ScoutBattle,
  type ScoutClass,
  type ScoutStage,
} from '../scout/model.js'
import { dictionaryFlags, type FlagEvidence } from '../scout/flag-evidence.js'
import type { VehicleClass, VehicleDict } from '../wrpl/vehicles.js'

const QUERY_DELAY_SEC = 20
/** The bot stores a live battle p50 24 s, p90 38 s after its end (docs/opponent-scouting.md). */
const SIMULATED_INGEST_SEC = 40
const LIVE_INGEST_MAX_SEC = 600
const MIN_SQUADRON_ROWS = 4
const HISTORY_SEC = 15 * 86_400
const L2 = 1e-3
const ROSTER_DIM = ROSTER_FEATURES.length
const VEHICLE_DIM = VEHICLE_FEATURES.length
const PROB_EDGES = [0, 0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001]
const COMPOSITION_EDGES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 1.0001]

type Regime = 'session' | 'break'
type Bins = [number, number, number][] // per bin: sum of predictions, sum of outcomes, count

interface TeamBattle extends ScoutBattle {
  core: string
}

interface WorkerInput {
  teams: TeamBattle[]
  stages: ScoutStage[]
  classes: Record<string, VehicleClass>
  split: number
  trainSetup: boolean
}

interface SetupResult {
  airSamples: { x: number[]; y: number; test: boolean }[]
  compositionSamples: { x: number[]; y: number; test: boolean }[]
  composition: Bins
  air: Bins
  airError: number
  classError: number
  counted: number
  hint: { teams: number; plain: number; hinted: number; overlapTeams: number; overlapPlain: number; overlapHinted: number }
}

interface InitResult {
  rosterRows: number
  vehicleChoices: number
  cold: [number, number]
  setup: SetupResult
}

type Request =
  | { op: 'logistic'; regime: Regime; weights: number[]; all: boolean }
  | { op: 'clogit'; weights: number[]; all: boolean }
  | { op: 'evalRoster'; weights: Record<Regime, number[]> }
  | { op: 'evalVehicles'; weights: number[] }
  | { op: 'close' }

interface Moments { grad: number[]; hess: number[] }
interface RosterEval { loss: number; rows: number; precision: number; targets: number; bins: Bins }
interface VehicleEval { n: number; loss: number; top1: number; top3: number; bins: Bins }

const emptyBins = (edges: readonly number[]): Bins => edges.slice(1).map(() => [0, 0, 0])
function addToBins(bins: Bins, edges: readonly number[], p: number, y: number): void {
  for (let i = 0; i + 1 < edges.length; i += 1) {
    if (p >= edges[i]! && p < edges[i + 1]!) {
      bins[i]![0] += p
      bins[i]![1] += y
      bins[i]![2] += 1
      return
    }
  }
}
function mergeBins(target: Bins, source: Bins): void {
  source.forEach((bin, i) => {
    target[i]![0] += bin[0]
    target[i]![1] += bin[1]
    target[i]![2] += bin[2]
  })
}

// --- worker: samples of its squadrons -------------------------------------------

function vehicleHistory(battles: readonly ScoutBattle[], userId: string, from: number): PlayerVehicleHistory[] {
  const out: PlayerVehicleHistory[] = []
  for (const battle of battles) {
    if (battle.startTime < from) continue
    const player = battle.players.find((p) => p.userId === userId)
    if (player?.vehicle) out.push({ endTime: battle.endTime, vehicle: player.vehicle, lineup: player.lineup })
  }
  return out
}

function runWorker(input: WorkerInput): void {
  const { stages, split } = input
  const classOf = (id: string): VehicleClass => input.classes[id] ?? '?'
  const bySquadron = new Map<string, TeamBattle[]>()
  for (const team of input.teams) {
    const list = bySquadron.get(team.core)
    if (list) list.push(team)
    else bySquadron.set(team.core, [team])
  }

  // Roster samples: flat features, one row per candidate of each target team.
  const rosterX: number[] = []
  const rosterY: number[] = []
  const rosterRegime: Regime[] = []
  const rosterTarget: number[] = []
  const rosterTest: boolean[] = []
  // Vehicle samples: each choice's rows (candidates, then the unseen option).
  const choiceRows: number[][][] = []
  const choiceChosen: number[] = []
  const choiceAfterBreak: boolean[] = []
  const choiceTest: boolean[] = []
  const cold: [number, number] = [0, 0]
  const setup: SetupResult = {
    airSamples: [],
    compositionSamples: [],
    composition: emptyBins(COMPOSITION_EDGES),
    air: emptyBins(PROB_EDGES),
    airError: 0,
    classError: 0,
    counted: 0,
    hint: { teams: 0, plain: 0, hinted: 0, overlapTeams: 0, overlapPlain: 0, overlapHinted: 0 },
  }
  let target = 0

  for (const list of bySquadron.values()) {
    let lo = 0
    list.forEach((battle, index) => {
      const now = battle.startTime + QUERY_DELAY_SEC
      while (list[lo]!.endTime < now - HISTORY_SEC) lo += 1
      const prior = list.slice(lo, index)
      const known = knownBattles(prior, now)
      if (known.length === 0) return
      const test = battle.startTime >= split
      const actual = new Set(battle.players.map((p) => p.userId))

      const { regime, candidates } = rosterCandidates(known, now)
      for (const candidate of candidates) {
        rosterX.push(...candidate.features)
        rosterY.push(actual.has(candidate.userId) ? 1 : 0)
        rosterRegime.push(regime)
        rosterTarget.push(target)
        rosterTest.push(test)
      }
      target += 1

      const stage = stageAt(stages, now)
      if (stage) {
        const from = periodBounds(stage).from
        for (const player of battle.players) {
          if (!player.vehicle) continue
          const features = vehicleChoiceFeatures(vehicleHistory(known, player.userId, from), now)
          if (!features) {
            cold[test ? 1 : 0] += 1
            continue
          }
          const chosen = features.vehicles.indexOf(player.vehicle)
          choiceRows.push([...features.rows, features.unseenRow])
          choiceChosen.push(chosen >= 0 ? chosen : features.rows.length)
          choiceAfterBreak.push(features.unseenRow[9] === 1)
          choiceTest.push(test)
        }
      }

      // Setup: the most likely class counts and the air chance against the team's spawns.
      if (battle.players.length !== 8 || (!test && !input.trainSetup)) return
      const prediction = predictScout({ battles: prior, now, stages, classOf })
      const group = prediction.primary
      if (!group || group.regime !== 'session') return
      const counts: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
      for (const player of battle.players) {
        const cls = player.vehicle ? classOf(player.vehicle) : '?'
        if (cls === '?') return
        counts[cls] += 1
      }
      const airCount = counts.F + counts.H
      const anchor = prior.find((b) => b.sessionId === group.anchor.sessionId && b.endTime === group.anchor.endTime)
      const lastHadAir = anchor?.players.some((p) => p.vehicle !== null && ['F', 'H'].includes(classOf(p.vehicle))) ?? false
      const top = group.setup.compositions[0]
      if (top) {
        const hit = (Object.keys(counts) as ScoutClass[]).every((cls) => top.counts[cls] === counts[cls]) ? 1 : 0
        setup.compositionSamples.push({ x: compositionCalibrationFeatures(top.raw), y: hit, test })
        if (test) addToBins(setup.composition, COMPOSITION_EDGES, top.chance, hit)
      }
      setup.airSamples.push({ x: airCalibrationFeatures(group.setup.rawAirChance, lastHadAir), y: airCount > 0 ? 1 : 0, test })
      if (!test) return
      addToBins(setup.air, PROB_EDGES, group.setup.airChance, airCount > 0 ? 1 : 0)
      setup.airError += Math.abs(group.setup.expected.F + group.setup.expected.H - airCount)
      setup.classError += (Object.keys(counts) as ScoutClass[]).reduce((sum, cls) => sum + Math.abs(group.setup.expected[cls] - counts[cls]), 0) / 2
      setup.counted += 1
      // One enemy nick as the hint (the first player) against the plain latest battle.
      const hinted = predictScout({ battles: prior, now, stages, classOf, hintUserId: battle.players[0]!.userId })
      const score = (p: typeof prediction) => (p.primary?.players.slice(0, 8).filter((x) => actual.has(x.userId)).length ?? 0) / 8
      const otherGroup = prior.some((other) => {
        if (other.endTime < battle.startTime - SESSION_GAP_SEC) return false
        let shared = 0
        for (const p of other.players) if (actual.has(p.userId)) shared += 1
        return shared < GROUP_MIN_SHARED
      })
      setup.hint.teams += 1
      setup.hint.plain += score(prediction)
      setup.hint.hinted += score(hinted)
      if (prediction.otherGroups.length > 0 || otherGroup) {
        setup.hint.overlapTeams += 1
        setup.hint.overlapPlain += score(prediction)
        setup.hint.overlapHinted += score(hinted)
      }
    })
  }

  const rosterRows = rosterY.length
  const X = Float64Array.from(rosterX)
  rosterX.length = 0

  const logisticMoments = (regime: Regime, w: readonly number[], all: boolean): Moments => {
    const grad = new Array<number>(ROSTER_DIM).fill(0)
    const hess = new Array<number>(ROSTER_DIM * ROSTER_DIM).fill(0)
    for (let n = 0; n < rosterRows; n += 1) {
      if (rosterRegime[n] !== regime || (!all && rosterTest[n])) continue
      const o = n * ROSTER_DIM
      let s = 0
      for (let i = 0; i < ROSTER_DIM; i += 1) s += w[i]! * X[o + i]!
      const p = 1 / (1 + Math.exp(-s))
      const r = rosterY[n]! - p
      const v = p * (1 - p)
      for (let i = 0; i < ROSTER_DIM; i += 1) {
        const xi = X[o + i]!
        if (xi === 0) continue
        grad[i]! += r * xi
        for (let j = 0; j < ROSTER_DIM; j += 1) hess[i * ROSTER_DIM + j]! += v * xi * X[o + j]!
      }
    }
    return { grad, hess }
  }

  const softmax = (rows: readonly number[][], w: readonly number[]): number[] => {
    const scores = rows.map((row) => row.reduce((sum, x, i) => sum + x * w[i]!, 0))
    const max = Math.max(...scores)
    const exps = scores.map((s) => Math.exp(s - max))
    const total = exps.reduce((a, b) => a + b, 0)
    return exps.map((e) => e / total)
  }

  const clogitMoments = (w: readonly number[], all: boolean): Moments => {
    const grad = new Array<number>(VEHICLE_DIM).fill(0)
    const hess = new Array<number>(VEHICLE_DIM * VEHICLE_DIM).fill(0)
    choiceRows.forEach((rows, c) => {
      if (!all && choiceTest[c]) return
      const probs = softmax(rows, w)
      const mean = new Array<number>(VEHICLE_DIM).fill(0)
      rows.forEach((row, r) => {
        for (let i = 0; i < VEHICLE_DIM; i += 1) mean[i]! += probs[r]! * row[i]!
      })
      const picked = rows[choiceChosen[c]!]!
      for (let i = 0; i < VEHICLE_DIM; i += 1) grad[i]! += picked[i]! - mean[i]!
      rows.forEach((row, r) => {
        for (let i = 0; i < VEHICLE_DIM; i += 1) {
          const di = row[i]! - mean[i]!
          if (di === 0) continue
          for (let j = 0; j < VEHICLE_DIM; j += 1) hess[i * VEHICLE_DIM + j]! += probs[r]! * di * (row[j]! - mean[j]!)
        }
      })
    })
    return { grad, hess }
  }

  const evalRoster = (weights: Record<Regime, number[]>): Record<Regime, RosterEval> => {
    const out = {} as Record<Regime, RosterEval>
    for (const regime of ['session', 'break'] as const) {
      const result: RosterEval = { loss: 0, rows: 0, precision: 0, targets: 0, bins: emptyBins(PROB_EDGES) }
      let current = -1
      let scored: { p: number; y: number }[] = []
      const flush = () => {
        if (scored.length === 0) return
        scored.sort((a, b) => b.p - a.p)
        result.precision += scored.slice(0, 8).reduce((sum, item) => sum + item.y, 0) / 8
        result.targets += 1
        scored = []
      }
      for (let n = 0; n < rosterRows; n += 1) {
        if (!rosterTest[n] || rosterRegime[n] !== regime) continue
        if (rosterTarget[n] !== current) {
          flush()
          current = rosterTarget[n]!
        }
        const o = n * ROSTER_DIM
        let s = 0
        for (let i = 0; i < ROSTER_DIM; i += 1) s += weights[regime][i]! * X[o + i]!
        const p = 1 / (1 + Math.exp(-s))
        const y = rosterY[n]!
        const c = Math.min(1 - 1e-6, Math.max(1e-6, p))
        result.loss -= y * Math.log(c) + (1 - y) * Math.log(1 - c)
        result.rows += 1
        addToBins(result.bins, PROB_EDGES, p, y)
        scored.push({ p, y })
      }
      flush()
      out[regime] = result
    }
    return out
  }

  const evalVehicles = (w: readonly number[]): Record<'all' | 'session' | 'break', VehicleEval> => {
    const out = {
      all: { n: 0, loss: 0, top1: 0, top3: 0, bins: emptyBins(PROB_EDGES) },
      session: { n: 0, loss: 0, top1: 0, top3: 0, bins: emptyBins(PROB_EDGES) },
      break: { n: 0, loss: 0, top1: 0, top3: 0, bins: emptyBins(PROB_EDGES) },
    }
    choiceRows.forEach((rows, c) => {
      if (!choiceTest[c]) return
      const probs = softmax(rows, w)
      const chosen = choiceChosen[c]!
      // Ranking over real vehicles: the unseen option (last row) is no answer.
      const ranked = probs.slice(0, -1).map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p)
      for (const key of ['all', choiceAfterBreak[c] ? 'break' : 'session'] as const) {
        const e = out[key]
        e.n += 1
        e.loss -= Math.log(Math.max(1e-12, probs[chosen]!))
        if (ranked[0]?.i === chosen) e.top1 += 1
        if (ranked.slice(0, 3).some((item) => item.i === chosen)) e.top3 += 1
        if (ranked[0]) addToBins(e.bins, PROB_EDGES, ranked[0].p, ranked[0].i === chosen ? 1 : 0)
      }
    })
    return out
  }

  const init: InitResult = { rosterRows, vehicleChoices: choiceRows.length, cold, setup }
  parentPort!.postMessage(init)
  parentPort!.on('message', (request: Request) => {
    switch (request.op) {
      case 'logistic':
        parentPort!.postMessage(logisticMoments(request.regime, request.weights, request.all))
        break
      case 'clogit':
        parentPort!.postMessage(clogitMoments(request.weights, request.all))
        break
      case 'evalRoster':
        parentPort!.postMessage(evalRoster(request.weights))
        break
      case 'evalVehicles':
        parentPort!.postMessage(evalVehicles(request.weights))
        break
      case 'close':
        parentPort!.close()
        break
    }
  })
}

// --- main: load, distribute, fit, report --------------------------------------------

const core = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

function load(path: string): { teams: TeamBattle[]; stages: ScoutStage[] } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const stages = (db.prepare('SELECT starts_at, ends_at, max_br FROM clan_season_stages ORDER BY starts_at').all() as {
      starts_at: number; ends_at: number; max_br: number
    }[]).map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at, maxBr: row.max_br }))
    const rows = db.prepare(`
      SELECT bp.session_id, bp.team, bp.user_id, bp.nick, bp.clan_tag, bp.vehicle, bp.vehicles,
             b.start_time, b.duration_sec, b.ingested_at
      FROM battle_players bp JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.team > 0 AND bp.user_id NOT LIKE '-%' AND bp.clan_tag <> ''
    `).all() as {
      session_id: string; team: number; user_id: string; nick: string; clan_tag: string; vehicle: string | null
      vehicles: string; start_time: number; duration_sec: number; ingested_at: number
    }[]
    const byTeam = new Map<string, Map<string, TeamBattle>>()
    for (const row of rows) {
      const squadron = core(row.clan_tag)
      if (squadron === '') continue
      const key = `${row.session_id}:${row.team}`
      let cores = byTeam.get(key)
      if (!cores) byTeam.set(key, (cores = new Map()))
      let battle = cores.get(squadron)
      if (!battle) {
        const endTime = row.start_time + row.duration_sec
        const lag = row.ingested_at - endTime
        battle = {
          core: squadron,
          sessionId: row.session_id,
          startTime: row.start_time,
          endTime,
          availableAt: lag >= 0 && lag <= LIVE_INGEST_MAX_SEC ? row.ingested_at : endTime + SIMULATED_INGEST_SEC,
          players: [],
        }
        cores.set(squadron, battle)
      }
      ;(battle.players as ScoutBattle['players'][number][]).push({
        userId: row.user_id,
        nick: row.nick,
        vehicle: row.vehicle,
        lineup: JSON.parse(row.vehicles) as string[],
      })
    }
    const teams: TeamBattle[] = []
    for (const cores of byTeam.values()) for (const battle of cores.values()) if (battle.players.length >= MIN_SQUADRON_ROWS) teams.push(battle)
    teams.sort((a, b) => a.startTime - b.startTime || a.sessionId.localeCompare(b.sessionId))
    return { teams, stages }
  } finally {
    db.close()
  }
}

function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]!])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = a[row]![col]! / a[col]![col]!
      for (let k = col; k <= n; k += 1) a[row]![k]! -= factor * a[col]![k]!
    }
  }
  return a.map((row, i) => row[n]! / row[i]!)
}

/** Newton's method with an L2 term; `moments` sums the gradient and Hessian of the log-likelihood. */
async function newton(dim: number, moments: (w: number[]) => Promise<Moments>): Promise<number[]> {
  let w = new Array<number>(dim).fill(0)
  for (let iter = 0; iter < 50; iter += 1) {
    const { grad, hess } = await moments(w)
    const g = grad.map((value, i) => value - L2 * w[i]!)
    const h = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => hess[i * dim + j]! + (i === j ? L2 : 0)))
    const step = solve(h, g)
    w = w.map((value, i) => value + step[i]!)
    if (Math.max(...step.map(Math.abs)) < 1e-7) break
  }
  return w
}

/** Logistic regression of small in-memory samples (the calibrations). */
function fitLogistic(xs: readonly number[][], ys: readonly number[]): Promise<number[]> {
  const dim = xs[0]!.length
  return newton(dim, async (w) => {
    const grad = new Array<number>(dim).fill(0)
    const hess = new Array<number>(dim * dim).fill(0)
    xs.forEach((x, n) => {
      const p = 1 / (1 + Math.exp(-x.reduce((sum, v, i) => sum + v * w[i]!, 0)))
      for (let i = 0; i < dim; i += 1) {
        grad[i]! += (ys[n]! - p) * x[i]!
        for (let j = 0; j < dim; j += 1) hess[i * dim + j]! += p * (1 - p) * x[i]! * x[j]!
      }
    })
    return { grad, hess }
  })
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const format = (weights: readonly number[]): string => `[${weights.map((w) => Number(w.toFixed(3))).join(', ')}]`

function printBins(bins: Bins, edges: readonly number[]): void {
  bins.forEach(([sumP, sumY, n], i) => {
    if (n === 0) return
    console.log(`    ${edges[i]!.toFixed(2)}–${Math.min(1, edges[i + 1]!).toFixed(2)}: n=${n} predicted ${pct(sumP / n)}, happened ${pct(sumY / n)}`)
  })
}

class WorkerHandle {
  private readonly queue: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
  constructor(readonly worker: Worker) {
    worker.on('message', (message: unknown) => this.queue.shift()?.resolve(message))
    worker.on('error', (error) => {
      for (const pending of this.queue.splice(0)) pending.reject(error)
    })
  }
  next<T>(): Promise<T> {
    return new Promise((resolve, reject) => this.queue.push({ resolve: resolve as (value: unknown) => void, reject }))
  }
  request<T>(message: Request): Promise<T> {
    const reply = this.next<T>()
    this.worker.postMessage(message)
    return reply
  }
}

// --- known team (--known-team): the picture path ---------------------------------

/** The players' battles a screenshot reads (src/scout/report.ts IMAGE_HISTORY_WINDOW_SEC). */
const IMAGE_HISTORY_SEC = 9 * 86_400

interface PlayerRow {
  key: string
  userId: string
  nick: string
  vehicle: string | null
  lineup: string[]
  startTime: number
  endTime: number
  availableAt: number
}

/** A seeded generator: the same players stay unspawned between runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function knownTeamBacktest(dbPath: string, dict: VehicleDict, split: number): Promise<void> {
  const started = performance.now()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const stages = (db.prepare('SELECT starts_at, ends_at, max_br FROM clan_season_stages ORDER BY starts_at').all() as {
    starts_at: number; ends_at: number; max_br: number
  }[]).map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at, maxBr: row.max_br }))
  const rows = db.prepare(`
    SELECT bp.session_id, bp.team, bp.user_id, bp.nick, bp.vehicle, bp.vehicles, b.start_time, b.duration_sec, b.ingested_at
    FROM battle_players bp JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.team > 0 AND bp.user_id NOT LIKE '-%' AND b.start_time >= ?
  `).all(split - IMAGE_HISTORY_SEC - 86_400) as {
    session_id: string; team: number; user_id: string; nick: string; vehicle: string | null; vehicles: string
    start_time: number; duration_sec: number; ingested_at: number
  }[]
  db.close()
  const byPlayer = new Map<string, PlayerRow[]>()
  const teams = new Map<string, PlayerRow[]>()
  for (const row of rows) {
    const endTime = row.start_time + row.duration_sec
    const lag = row.ingested_at - endTime
    const entry: PlayerRow = {
      key: `${row.session_id}:${row.team}`,
      userId: row.user_id,
      nick: row.nick,
      vehicle: row.vehicle,
      lineup: JSON.parse(row.vehicles) as string[],
      startTime: row.start_time,
      endTime,
      availableAt: lag >= 0 && lag <= LIVE_INGEST_MAX_SEC ? row.ingested_at : endTime + SIMULATED_INGEST_SEC,
    }
    for (const [map, key] of [[byPlayer, row.user_id], [teams, entry.key]] as const) {
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.startTime - b.startTime)
  const classOf = (id: string): VehicleClass => dict[id]?.cls ?? '?'
  const flagsOf = dictionaryFlags(dict)
  const random = mulberry32(1)
  type Variant = 'none' | 'operator' | 'nation' | 'operator, 2 not spawned'
  const variants: Variant[] = ['none', 'operator', 'nation', 'operator, 2 not spawned']
  const scores = Object.fromEntries(variants.map((v) => [v, { n: 0, top1: 0, top3: 0, loss: 0, bins: emptyBins(PROB_EDGES), operator: 0, teams: 0 }]))
  let conditionMs: number[] = []
  let teamsScored = 0
  for (const team of teams.values()) {
    const start = team[0]!.startTime
    if (start < split || team.length !== 8 || team.some((player) => !player.vehicle)) continue
    const now = start + QUERY_DELAY_SEC
    const battles = new Map<string, ScoutBattle & { players: ScoutBattle['players'][number][] }>()
    for (const player of team) {
      for (const row of byPlayer.get(player.userId) ?? []) {
        if (row.startTime < now - IMAGE_HISTORY_SEC) continue
        if (row.startTime >= now) break
        let battle = battles.get(row.key)
        if (!battle) {
          battle = { sessionId: row.key, startTime: row.startTime, endTime: row.endTime, availableAt: row.availableAt, players: [] }
          battles.set(row.key, battle)
        }
        battle.players.push({ userId: row.userId, nick: row.nick, vehicle: row.vehicle, lineup: row.lineup })
      }
    }
    const players = team.map((player) => ({ userId: player.userId, nick: player.nick }))
    const truth = new Map(team.map((player) => [player.userId, player.vehicle!]))
    const icons = (pick: (vehicleId: string) => string, spawned: (player: PlayerRow) => boolean) => [...new Set(team.filter(spawned).map((player) => pick(player.vehicle!)))]
    const operatorFlag = (id: string) => flagsOf(id)?.operator ?? dict[id]?.country ?? '?'
    const nationFlag = (id: string) => dict[id]?.country ?? '?'
    const unspawned = new Set<string>()
    while (unspawned.size < 2) unspawned.add(team[Math.floor(random() * team.length)]!.userId)
    const flags: Record<Variant, string[] | null> = {
      none: null,
      operator: icons(operatorFlag, () => true),
      nation: icons(nationFlag, () => true),
      'operator, 2 not spawned': icons(operatorFlag, (player) => !unspawned.has(player.userId)),
    }
    teamsScored += 1
    for (const variant of variants) {
      const list = flags[variant]
      const evidence: FlagEvidence | undefined = list
        ? { flags: list.map((icon) => [{ icon, likelihood: 1 }]), rows: 8, flagsOf }
        : undefined
      const t = performance.now()
      const prediction = predictKnownTeam({ players, unknownPlayers: 0, battles: [...battles.values()], now, stages, classOf, flags: evidence })
      if (evidence) conditionMs.push(performance.now() - t)
      const score = scores[variant]!
      score.teams += 1
      score.operator += prediction.flags?.operatorChance ?? 0
      for (const player of prediction.players) {
        const actual = truth.get(player.userId)!
        score.n += 1
        if (player.vehicles[0]?.vehicleId === actual) score.top1 += 1
        if (player.vehicles.slice(0, 3).some((vehicle) => vehicle.vehicleId === actual)) score.top3 += 1
        const chance = player.vehicles.find((vehicle) => vehicle.vehicleId === actual)?.chance ?? player.unseenChance
        score.loss -= Math.log(Math.max(1e-9, chance))
        const best = player.vehicles[0]
        if (best) addToBins(score.bins, PROB_EDGES, best.chance, best.vehicleId === actual ? 1 : 0)
      }
    }
  }
  conditionMs = conditionMs.sort((a, b) => a - b)
  const at = (q: number) => conditionMs[Math.min(conditionMs.length - 1, Math.floor(conditionMs.length * q))]!.toFixed(1)
  console.log(`known team: ${teamsScored} teams of 8 from ${new Date(split * 1000).toISOString().slice(0, 10)}, history ${IMAGE_HISTORY_SEC / 86_400} days, asked ${QUERY_DELAY_SEC} s after the start; prediction with flags p50 ${at(0.5)} ms, p99 ${at(0.99)} ms`)
  for (const variant of variants) {
    const score = scores[variant]!
    const operator = variant === 'none' ? '' : `; operator flags said ${pct(score.operator / score.teams)}`
    console.log(`  flags ${variant}: top-1 ${pct(score.top1 / score.n)}, top-3 ${pct(score.top3 / score.n)}, log loss ${(score.loss / score.n).toFixed(4)} (${score.n} players)${operator}`)
    printBins(score.bins, PROB_EDGES)
  }
  console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const dbPath = args.find((arg, i) => !arg.startsWith('--') && !['--split', '--threads', '--vehicles'].includes(args[i - 1] ?? ''))
  if (!dbPath || !existsSync(dbPath)) {
    console.error('Usage: npm run scout:backtest -- <copy.db> [--fit | --fit-all | --known-team] [--split YYYY-MM-DD] [--threads N] [--vehicles data/wt-vehicles.json]')
    process.exit(1)
  }
  const fitMode = args.includes('--fit-all') ? 'all' : args.includes('--fit') ? 'train' : null
  const split = Date.parse(`${value('--split') ?? '2026-10-01'}T00:00:00Z`) / 1000
  const threads = Math.max(1, Number(value('--threads') ?? Math.max(1, availableParallelism() - 2)))
  const started = performance.now()
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`
  const dict = JSON.parse(await readFile(value('--vehicles') ?? 'data/wt-vehicles.json', 'utf8')) as VehicleDict
  if (args.includes('--known-team')) {
    await knownTeamBacktest(dbPath, dict, split)
    return
  }

  const { teams, stages } = load(dbPath)
  const classes = Object.fromEntries(Object.entries(dict).map(([id, info]) => [id, info.cls]))
  console.log(`${teams.length} squadron team-battles, split at ${new Date(split * 1000).toISOString().slice(0, 10)}, ${threads} threads (${elapsed()})`)

  // Whole squadrons per worker, the biggest first onto the least loaded (cost ~ battles²).
  const bySquadron = new Map<string, TeamBattle[]>()
  for (const team of teams) {
    const list = bySquadron.get(team.core)
    if (list) list.push(team)
    else bySquadron.set(team.core, [team])
  }
  const chunks = Array.from({ length: threads }, () => ({ teams: [] as TeamBattle[], cost: 0 }))
  for (const list of [...bySquadron.values()].sort((a, b) => b.length - a.length)) {
    const chunk = chunks.reduce((best, c) => (c.cost < best.cost ? c : best))
    chunk.teams.push(...list)
    chunk.cost += list.length * Math.min(list.length, 400)
  }
  const workers = chunks.map((chunk) => {
    const input: WorkerInput = { teams: chunk.teams, stages, classes, split, trainSetup: fitMode !== null }
    return new WorkerHandle(new Worker(new URL(import.meta.url), { workerData: input }))
  })
  const inits = await Promise.all(workers.map((w) => w.next<InitResult>()))
  const all = <T>(message: Request) => Promise.all(workers.map((w) => w.request<T>(message)))
  const sum = async (message: Request, dim: number): Promise<Moments> => {
    const parts = await all<Moments>(message)
    return {
      grad: Array.from({ length: dim }, (_, i) => parts.reduce((s, p) => s + p.grad[i]!, 0)),
      hess: Array.from({ length: dim * dim }, (_, i) => parts.reduce((s, p) => s + p.hess[i]!, 0)),
    }
  }
  const cold = inits.reduce<[number, number]>((s, r) => [s[0] + r.cold[0], s[1] + r.cold[1]], [0, 0])
  console.log(`samples: roster ${inits.reduce((s, r) => s + r.rosterRows, 0)}, vehicles ${inits.reduce((s, r) => s + r.vehicleChoices, 0)}; players without battles at the cap: ${cold[0]} train, ${cold[1]} test (${elapsed()})`)

  let rosterWeights: Record<Regime, number[]> = { session: [...ROSTER_WEIGHTS.session], break: [...ROSTER_WEIGHTS.break] }
  let vehicleWeights = [...VEHICLE_WEIGHTS]
  if (fitMode) {
    const useAll = fitMode === 'all'
    const [session, brk, vehicles] = await Promise.all([
      newton(ROSTER_DIM, (w) => sum({ op: 'logistic', regime: 'session', weights: w, all: useAll }, ROSTER_DIM)),
      newton(ROSTER_DIM, (w) => sum({ op: 'logistic', regime: 'break', weights: w, all: useAll }, ROSTER_DIM)),
      newton(VEHICLE_DIM, (w) => sum({ op: 'clogit', weights: w, all: useAll }, VEHICLE_DIM)),
    ])
    rosterWeights = { session, break: brk }
    vehicleWeights = vehicles
    console.log(`fitted on ${useAll ? 'all battles' : 'the train part'} (${elapsed()}):`)
    console.log(`  ROSTER_FEATURES ${ROSTER_FEATURES.join(', ')}`)
    console.log(`  session: ${format(session)}`)
    console.log(`  break: ${format(brk)}`)
    console.log(`  VEHICLE_FEATURES ${VEHICLE_FEATURES.join(', ')}`)
    console.log(`  vehicles: ${format(vehicles)}`)
  }

  console.log(`test part (battles from ${new Date(split * 1000).toISOString().slice(0, 10)}), ${fitMode ? 'fitted' : 'shipped'} weights:`)
  const rosterParts = await all<Record<Regime, RosterEval>>({ op: 'evalRoster', weights: rosterWeights })
  for (const regime of ['session', 'break'] as const) {
    const total: RosterEval = { loss: 0, rows: 0, precision: 0, targets: 0, bins: emptyBins(PROB_EDGES) }
    for (const part of rosterParts) {
      total.loss += part[regime].loss
      total.rows += part[regime].rows
      total.precision += part[regime].precision
      total.targets += part[regime].targets
      mergeBins(total.bins, part[regime].bins)
    }
    console.log(`  roster, ${regime === 'session' ? 'in a session' : 'after a break'}: ${total.targets} teams, top-8 right ${pct(total.precision / total.targets)}, log loss ${(total.loss / total.rows).toFixed(4)}`)
    printBins(total.bins, PROB_EDGES)
  }
  const vehicleParts = await all<Record<'all' | 'session' | 'break', VehicleEval>>({ op: 'evalVehicles', weights: vehicleWeights })
  for (const key of ['all', 'session', 'break'] as const) {
    const total: VehicleEval = { n: 0, loss: 0, top1: 0, top3: 0, bins: emptyBins(PROB_EDGES) }
    for (const part of vehicleParts) {
      total.n += part[key].n
      total.loss += part[key].loss
      total.top1 += part[key].top1
      total.top3 += part[key].top3
      mergeBins(total.bins, part[key].bins)
    }
    const label = key === 'all' ? 'all' : key === 'session' ? 'in a session' : 'after a break'
    console.log(`  vehicle, ${label}: ${total.n} players, top-1 ${pct(total.top1 / total.n)}, top-3 ${pct(total.top3 / total.n)}, log loss ${(total.loss / total.n).toFixed(4)}`)
    if (key === 'all') printBins(total.bins, PROB_EDGES)
  }

  const setups = inits.map((r) => r.setup)
  console.log(`setup (shipped model weights, AIR_CALIBRATION ${format(AIR_CALIBRATION)}, COMPOSITION_CALIBRATION ${format(COMPOSITION_CALIBRATION)}):`)
  if (fitMode) {
    const use = (sample: { test: boolean }) => fitMode === 'all' || !sample.test
    const air = setups.flatMap((s) => s.airSamples).filter(use)
    const composition = setups.flatMap((s) => s.compositionSamples).filter(use)
    console.log(`  fitted AIR_CALIBRATION: ${format(await fitLogistic(air.map((s) => s.x), air.map((s) => s.y)))}`)
    console.log(`  fitted COMPOSITION_CALIBRATION: ${format(await fitLogistic(composition.map((s) => s.x), composition.map((s) => s.y)))}`)
    console.log('  (the figures below use the shipped calibration)')
  }
  const counted = setups.reduce((s, r) => s + r.counted, 0)
  console.log(`  in a session: ${counted} teams; expected aircraft off by ${(setups.reduce((s, r) => s + r.airError, 0) / counted).toFixed(2)} on average, class counts off by ${(setups.reduce((s, r) => s + r.classError, 0) / counted).toFixed(2)} players`)
  const compositionBins = emptyBins(COMPOSITION_EDGES)
  const airBins = emptyBins(PROB_EDGES)
  for (const s of setups) {
    mergeBins(compositionBins, s.composition)
    mergeBins(airBins, s.air)
  }
  console.log('  most likely class counts (chance shown vs happened):')
  printBins(compositionBins, COMPOSITION_EDGES)
  console.log('  at least one aircraft or helicopter:')
  printBins(airBins, PROB_EDGES)
  const hint = setups.reduce((s, r) => ({
    teams: s.teams + r.hint.teams, plain: s.plain + r.hint.plain, hinted: s.hinted + r.hint.hinted,
    overlapTeams: s.overlapTeams + r.hint.overlapTeams, overlapPlain: s.overlapPlain + r.hint.overlapPlain, overlapHinted: s.overlapHinted + r.hint.overlapHinted,
  }), { teams: 0, plain: 0, hinted: 0, overlapTeams: 0, overlapPlain: 0, overlapHinted: 0 })
  console.log(`  roster with one enemy nick as the hint: ${pct(hint.hinted / hint.teams)} vs ${pct(hint.plain / hint.teams)} without (${hint.teams} teams); where another group of the squadron played within ${SESSION_GAP_SEC / 60} min: ${pct(hint.overlapHinted / hint.overlapTeams)} vs ${pct(hint.overlapPlain / hint.overlapTeams)} (${hint.overlapTeams} teams)`)
  await Promise.all(workers.map((w) => { w.worker.postMessage({ op: 'close' } satisfies Request); return w.worker.terminate() }))
  console.log(`done in ${elapsed()}`)
}

if (isMainThread) await main()
else runWorker(workerData as WorkerInput)
