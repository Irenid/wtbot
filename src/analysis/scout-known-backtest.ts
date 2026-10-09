// Backtest of the /scout picture path (predictKnownTeam, src/scout/model.ts) for
// `npm run scout:backtest -- <copy.db> --known-team [--fit | --fit-all] [--statshark]`.
// Each team of 8 from --split on is predicted with its players known, asked
// QUERY_DELAY_SEC after the start from what the bot had stored by then
// (backfilled battles: stored SIMULATED_INGEST_SEC after the end), without
// flags and with the flags and row icons a screenshot shows at moments of that
// battle (its events: getCountriesByTeam's line, row-icons.ts). Three models:
// the one before the new-vehicle guess (1f8ae62), with the guess
// (newVehicleChances), and with the opponent's air habit and the picture
// path's setup calibrations too. --fit fits NEW_VEHICLE_WEIGHTS,
// OPPONENT_AIR_WEIGHTS and KNOWN_TEAM_SETUP_CALIBRATION on the teams before
// the split, --fit-all on every team (the values to ship). --statshark adds the
// StatShark battles stored for players: a snapshot read after the battle, so
// its counts may include later games. Teams are split over worker threads
// (all cores but two): each streams the rows itself with strings and lineups
// shared, and rebuilds a team's inputs for each pass (keeping them for every
// team took 15 GB at 12 threads). `--variants <regex>` scores only the variants
// whose label matches ("full, no flags", "full, 30 s after the first spawn").
// Read-only; never point it at the live data/wtbot.db while the bot writes it.
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { dictionaryFlags, IN_VEHICLE_WITH_ICON, IN_VEHICLE_WITHOUT_ICON, type FlagEvidence } from '../scout/flag-evidence.js'
import {
  AIR_CALIBRATION,
  COMPOSITION_CALIBRATION,
  KILL_LIKELIHOODS,
  KILL_MOMENTS,
  KNOWN_TEAM_AIR_KNOTS,
  KNOWN_TEAM_SETUP_CALIBRATION,
  NEW_VEHICLE_FEATURES,
  NEW_VEHICLE_WEIGHTS,
  OPPONENT_AIR_MEAN,
  OPPONENT_AIR_WEIGHTS,
  SCOUT_CLASSES,
  STATSHARK_FRESH_SEC,
  airCalibrationFeatures,
  compositionCalibrationFeatures,
  newVehicleFeatures,
  opponentAir,
  periodBounds,
  playerBackground,
  predictKnownTeam,
  stageAt,
  type KnownTeamInput,
  type AirKnotMode,
  type ChanceKnots,
  type KillColumns,
  type KillTable,
  type KnownTeamPrediction,
  type PlayerBackground,
  type ScoutBattle,
  type ScoutClass,
  type ScoutPlayerPrediction,
  type ScoutStage,
  type SetupCalibration,
  type VehicleChance,
} from '../scout/model.js'
import { decodeEventsPayload } from '../wrpl/events-codec.js'
import { vehicleIdOfModel } from '../wrpl/player-events.js'
import type { ReplayEvents } from '../wrpl/replay-events.js'
import type { VehicleClass, VehicleDict } from '../wrpl/vehicles.js'

const QUERY_DELAY_SEC = 20
/** The bot stores a live battle p50 24 s, p90 38 s after its end (docs/opponent-scouting.md). */
const SIMULATED_INGEST_SEC = 40
const LIVE_INGEST_MAX_SEC = 600
/** The players' battles a screenshot reads (src/scout/report.ts IMAGE_HISTORY_WINDOW_SEC). */
const IMAGE_HISTORY_SEC = 9 * 86_400
/** Screenshot moments, seconds after the battle's first spawn; 'all' — everyone in a vehicle, nobody destroyed. */
const MOMENTS = ['all', 10, 30, 60, 120, 180, 300] as const
type Moment = (typeof MOMENTS)[number]
/** The flags calibration is fitted on screenshots from the spawns to the first losses (scouting is early). */
const FIT_MOMENTS = [10, 30, 60, 120] as const
/** Every screenshot moment and none: the air knots map what any reply says. */
const MOMENTS_ALL = [null, ...MOMENTS] as const
/**
 * A StatShark snapshot counts as live would have it: the latest read by the
 * reply's update (the screenshot queues the refresh; STATSHARK_WAIT_MS caps the
 * wait), fresh within STATSHARK_FRESH_SEC. Counting snapshots read days after
 * the battle (3 days until 2026-10-09) let the games played since leak into
 * "never played".
 */
const SHARK_UPDATE_SEC = 300
const L2 = 1e-3
/** The two StatShark weights get a N(0, 0.5²) prior while few players have a snapshot read before their battle. */
const SHARK_L2 = 4
const PROB_EDGES = [0, 0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001]
const COMPOSITION_EDGES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001]
const NEW_DIM = NEW_VEHICLE_FEATURES.length
/** The setup calibrations /scout squadron ships: the picture path's before KNOWN_TEAM_SETUP_CALIBRATION. */
const SQUADRON_SETUP: Record<'flags' | 'noFlags', SetupCalibration> = {
  flags: { air: AIR_CALIBRATION, composition: COMPOSITION_CALIBRATION },
  noFlags: { air: AIR_CALIBRATION, composition: COMPOSITION_CALIBRATION },
}

type Bins = [number, number, number][] // per bin: sum of predictions, sum of outcomes, count
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
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const format = (weights: readonly number[]): string => `[${weights.map((w) => Number(w.toFixed(3))).join(', ')}]`
const core = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

export interface KnownWeights {
  newVehicle: number[]
  opponentAir: Partial<Record<ScoutClass, number>>
  setup: Record<'flags' | 'noFlags', SetupCalibration>
  kills: KillTable
  airKnots: Record<AirKnotMode, ChanceKnots>
}

type ModelKind = 'before' | 'guess' | 'full'
interface Variant {
  name: string
  model: ModelKind
  moment: Moment | null
  flag: 'operator' | 'nation'
  icons: boolean
  /** With StatShark battles in the backgrounds (when loaded). */
  statshark: boolean
  /** The rows' kill columns at the moment, the timer read ('moment') or not ('unknown'); null — not read. */
  kills: 'moment' | 'unknown' | null
}

interface Tally {
  n: number
  top1: number
  top3: number
  loss: number
  /** Log loss with every vehicle not seen from the player at this cap as one outcome: comparable across the models. */
  lumped: number
  classTop1: number
  coldN: number
  coldTop1: number
  /** Players left unread (--unread-live): not in the per-player figures. */
  unreadN: number
  shark: { n: number; top1: number; loss: number }
  bins: Bins
  teams: number
  inVehicle: number
  lines: number[]
  operator: number
  setupTeams: number
  compHit: number
  compSaid: number
  comp: Bins
  air: Bins
  airError: number
}
const emptyTally = (): Tally => ({
  n: 0, top1: 0, top3: 0, loss: 0, lumped: 0, classTop1: 0, coldN: 0, coldTop1: 0, unreadN: 0, shark: { n: 0, top1: 0, loss: 0 },
  bins: emptyBins(PROB_EDGES), teams: 0, inVehicle: 0, lines: new Array<number>(9).fill(0), operator: 0,
  setupTeams: 0, compHit: 0, compSaid: 0, comp: emptyBins(COMPOSITION_EDGES), air: emptyBins(PROB_EDGES), airError: 0,
})
function mergeTally(target: Tally, source: Tally): void {
  for (const key of ['n', 'top1', 'top3', 'loss', 'lumped', 'classTop1', 'coldN', 'coldTop1', 'unreadN', 'teams', 'inVehicle', 'operator', 'setupTeams', 'compHit', 'compSaid', 'airError'] as const) {
    target[key] += source[key]
  }
  target.shark.n += source.shark.n
  target.shark.top1 += source.shark.top1
  target.shark.loss += source.shark.loss
  source.lines.forEach((count, i) => { target.lines[i]! += count })
  for (const key of ['bins', 'comp', 'air'] as const) {
    source[key].forEach((bin, i) => {
      target[key][i]![0] += bin[0]
      target[key][i]![1] += bin[1]
      target[key][i]![2] += bin[2]
    })
  }
}

// --- worker: its share of the teams ------------------------------------------------

interface KnownWorkerInput {
  kind: 'scout-known'
  dbPath: string
  dict: VehicleDict
  split: number
  part: number
  parts: number
  fit: 'train' | 'all' | null
  statshark: boolean
  /** Players without a stored battle are unread rows, as on a screenshot (the matcher knows only stored nicks). */
  unreadLive: boolean
}

type KnownRequest =
  | { op: 'newMoments'; weights: number[] }
  | { op: 'newEval'; weights: number[] }
  | { op: 'opponent'; weights: number[] }
  | { op: 'setup'; weights: KnownWeights; test: boolean }
  | { op: 'killTable' }
  | { op: 'airSamples'; weights: KnownWeights }
  | { op: 'evaluate'; weights: KnownWeights; variants: Variant[] }
  | { op: 'close' }

interface Row {
  key: string
  sessionId: string
  team: number
  userId: string
  botUserId: string | null
  nick: string
  core: string
  vehicle: string | null
  lineup: string[]
  startTime: number
  endTime: number
  availableAt: number
}

interface TeamContext {
  team: Row[]
  /** Fitted on (before the split, or every team with --fit-all). */
  train: boolean
  /** Scored (from the split). */
  test: boolean
  now: number
  stage: ScoutStage
  opponentAir: number | null
  order: Row[]
  place: Map<string, number>
  times: Map<string, Timeline> | null | undefined
}

/** A team's inputs, rebuilt by each pass (inputsOf) rather than kept for every team. */
interface TeamInputs {
  battles: ScoutBattle[]
  capSpawns: Map<string, number>
  backgrounds: Map<string, PlayerBackground>
  /** The same without StatShark battles (--statshark: their effect). */
  plainBackgrounds: Map<string, PlayerBackground>
  /** The vehicles seen from each player at this cap (the guess leaves them out). */
  seenAtCap: Map<string, Set<string>>
  /** Players with a stored battle by the query (a screenshot can name them). */
  known: Set<string>
}

/** A slot's battle from its events: seconds from the battle's first spawn to its first spawn and that vehicle's loss (Infinity: never), and its kills. */
interface Timeline {
  spawn: number
  loss: number
  /** Enemy vehicles it destroyed: seconds, and whether an aircraft, a helicopter or a drone (the board's air column). */
  kills: { t: number; air: boolean }[]
}

function battleTimeline(
  db: DatabaseSync,
  sessionId: string,
  teamOf: ReadonlyMap<string, number>,
  classOf: (id: string) => VehicleClass,
): Map<string, Timeline> | null {
  const row = db.prepare('SELECT events_blob FROM battle_events WHERE session_id = ?').get(sessionId) as { events_blob: Uint8Array } | undefined
  if (!row) return null
  const events = decodeEventsPayload(row.events_blob) as Pick<ReplayEvents, 'units' | 'kills'>
  const first = new Map<string, { t: number; vehicle: string }>()
  for (const unit of events.units) {
    const point = unit.path[0]
    if (unit.userId === '' || !point) continue
    const known = first.get(unit.userId)
    if (!known || point.t < known.t) first.set(unit.userId, { t: point.t, vehicle: vehicleIdOfModel(unit.model) })
  }
  if (first.size === 0) return null
  const t0 = Math.min(...[...first.values()].map((spawn) => spawn.t))
  const timelines = new Map<string, Timeline>()
  for (const [userId, spawn] of first) {
    const losses = events.kills.filter((kill) => kill.victimId === userId && vehicleIdOfModel(kill.victimModel) === spawn.vehicle && kill.time >= spawn.t)
    timelines.set(userId, { spawn: (spawn.t - t0) / 1000, loss: losses.length > 0 ? (Math.min(...losses.map((kill) => kill.time)) - t0) / 1000 : Infinity, kills: [] })
  }
  for (const kill of events.kills) {
    const killer = timelines.get(kill.killerId)
    const team = teamOf.get(kill.killerId)
    if (!killer || team === undefined || teamOf.get(kill.victimId) === team) continue
    const cls = classOf(vehicleIdOfModel(kill.victimModel))
    const air = cls === 'F' || cls === 'H' || (cls === '?' && !kill.victimModel.startsWith('tankModels/'))
    killer.kills.push({ t: (kill.time - t0) / 1000, air })
  }
  return timelines
}

function runKnownWorker(input: KnownWorkerInput): void {
  const { dict, split } = input
  const db = new DatabaseSync(input.dbPath, { readOnly: true })
  const stages: ScoutStage[] = (db.prepare('SELECT starts_at, ends_at, max_br FROM clan_season_stages ORDER BY starts_at').all() as {
    starts_at: number; ends_at: number; max_br: number
  }[]).map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at, maxBr: row.max_br }))
  const raw = db.prepare(`
    SELECT bp.session_id, bp.team, bp.user_id, bp.bot_user_id, bp.nick, bp.clan_tag, bp.vehicle, bp.vehicles, b.start_time, b.duration_sec, b.ingested_at
    FROM battle_players bp JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.team > 0 AND bp.user_id NOT LIKE '-%'
  `).iterate() as Iterable<{
    session_id: string; team: number; user_id: string; bot_user_id: string | null; nick: string; clan_tag: string; vehicle: string | null
    vehicles: string; start_time: number; duration_sec: number; ingested_at: number
  }>
  /** Every StatShark snapshot of a player, oldest first. */
  const statshark = new Map<string, { fetchedAt: number; battles: Map<string, number> }[]>()
  if (input.statshark) {
    const rows = db.prepare(`
      SELECT i.wt_user_id AS user_id, s.id AS snapshot_id, s.fetched_at, v.vehicle_id, sum(coalesce(v.victories, 0) + coalesce(v.defeats, 0)) AS battles
      FROM player_external_snapshots s
      JOIN player_identities i ON i.id = s.identity_id
      JOIN player_external_vehicles v ON v.snapshot_id = s.id
      WHERE s.source = 'statshark' AND s.status = 'ok' AND i.wt_user_id IS NOT NULL
      GROUP BY s.id, v.vehicle_id
      ORDER BY s.fetched_at, s.id
    `).all() as { user_id: string; snapshot_id: number; fetched_at: number; vehicle_id: string; battles: number }[]
    const bySnapshot = new Map<number, { fetchedAt: number; battles: Map<string, number> }>()
    for (const row of rows) {
      let snapshot = bySnapshot.get(row.snapshot_id)
      if (!snapshot) {
        bySnapshot.set(row.snapshot_id, (snapshot = { fetchedAt: row.fetched_at, battles: new Map() }))
        const list = statshark.get(row.user_id)
        if (list) list.push(snapshot)
        else statshark.set(row.user_id, [snapshot])
      }
      snapshot.battles.set(row.vehicle_id, row.battles)
    }
  }
  // SCOUT_SHARK_FOLD=0|1: the StatShark weights are fitted on the other half of the players (by user id) and scored on this half.
  const fold = process.env['SCOUT_SHARK_FOLD']
  const heldOut = (userId: string): boolean => fold === undefined || Number(BigInt(userId) % 2n) === Number(fold)
  /** The snapshot the reply's update would read (SHARK_UPDATE_SEC); fresh within STATSHARK_FRESH_SEC. */
  const sharkAt = (userId: string, now: number): { battles: Map<string, number>; fresh: boolean } | null => {
    let latest: { fetchedAt: number; battles: Map<string, number> } | null = null
    for (const snapshot of statshark.get(userId) ?? []) {
      if (snapshot.fetchedAt > now + SHARK_UPDATE_SEC) break
      latest = snapshot
    }
    return latest && { battles: latest.battles, fresh: latest.fetchedAt >= now - STATSHARK_FRESH_SEC }
  }
  const classOf = (id: string): VehicleClass => dict[id]?.cls ?? '?'
  const nationOf = (id: string): string => dict[id]?.country ?? '?'
  const info = (id: string) => ({ nation: nationOf(id), cls: classOf(id) })
  const flagsOf = dictionaryFlags(dict)
  const operatorFlag = (id: string) => flagsOf(id)?.operator ?? dict[id]?.country ?? '?'

  // One copy of each string and lineup (92% of lineups repeat the player's previous one); nothing mutates them.
  const strings = new Map<string, string>()
  const intern = (value: string): string => {
    const known = strings.get(value)
    if (known !== undefined) return known
    strings.set(value, value)
    return value
  }
  const lineups = new Map<string, string[]>()
  const byPlayer = new Map<string, Row[]>()
  const teams = new Map<string, Row[]>()
  for (const row of raw) {
    const endTime = row.start_time + row.duration_sec
    const lag = row.ingested_at - endTime
    let lineup = lineups.get(row.vehicles)
    if (!lineup) lineups.set(row.vehicles, (lineup = (JSON.parse(row.vehicles) as string[]).map(intern)))
    const entry: Row = {
      key: intern(`${row.session_id}:${row.team}`),
      sessionId: intern(row.session_id),
      team: row.team,
      userId: intern(row.user_id),
      botUserId: row.bot_user_id === null ? null : intern(row.bot_user_id),
      nick: intern(row.nick),
      core: intern(core(row.clan_tag)),
      vehicle: row.vehicle === null ? null : intern(row.vehicle),
      lineup,
      startTime: row.start_time,
      endTime,
      availableAt: lag >= 0 && lag <= LIVE_INGEST_MAX_SEC ? row.ingested_at : endTime + SIMULATED_INGEST_SEC,
    }
    for (const [map, key] of [[byPlayer, entry.userId], [teams, entry.key]] as const) {
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.startTime - b.startTime)

  // The cap's spawns by when they were stored; counts cached per stage and hour.
  const stageSpawns = new Map<number, { availableAt: number; vehicle: string }[]>()
  for (const list of byPlayer.values()) {
    for (const row of list) {
      if (!row.vehicle) continue
      const stage = stageAt(stages, row.startTime)
      if (!stage) continue
      let spawns = stageSpawns.get(stage.startsAt)
      if (!spawns) stageSpawns.set(stage.startsAt, (spawns = []))
      spawns.push({ availableAt: row.availableAt, vehicle: row.vehicle })
    }
  }
  for (const list of stageSpawns.values()) list.sort((a, b) => a.availableAt - b.availableAt)
  const capCache = new Map<string, Map<string, number>>()
  const capSpawnsAt = (stage: ScoutStage, now: number): Map<string, number> => {
    const hour = Math.floor(now / 3600) * 3600
    const key = `${stage.startsAt}:${hour}`
    let counts = capCache.get(key)
    if (counts) return counts
    counts = new Map()
    for (const spawn of stageSpawns.get(stage.startsAt) ?? []) {
      if (spawn.availableAt > hour) break
      counts.set(spawn.vehicle, (counts.get(spawn.vehicle) ?? 0) + 1)
    }
    capCache.set(key, counts)
    return counts
  }
  // Squadron teams of 8: their aircraft, for the opponent's habit.
  const teamCore = (team: Row[]): string => {
    const counts = new Map<string, number>()
    for (const row of team) if (row.core !== '') counts.set(row.core, (counts.get(row.core) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  const squadronTeams = new Map<string, { availableAt: number; endTime: number; air: number }[]>()
  for (const team of teams.values()) {
    if (team.length !== 8) continue
    const squadron = teamCore(team)
    if (squadron === '') continue
    const air = team.filter((row) => row.vehicle && ['F', 'H'].includes(classOf(row.vehicle))).length
    let list = squadronTeams.get(squadron)
    if (!list) squadronTeams.set(squadron, (list = []))
    list.push({ availableAt: team[0]!.availableAt, endTime: team[0]!.endTime, air })
  }

  // This worker's teams: eligible teams of 8, every n-th by start.
  const eligible = [...teams.values()]
    .filter((team) => team.length === 8 && team.every((row) => row.vehicle))
    .sort((a, b) => a[0]!.startTime - b[0]!.startTime || a[0]!.key.localeCompare(b[0]!.key))
  const contexts: TeamContext[] = []
  eligible.forEach((team, index) => {
    if (index % input.parts !== input.part) return
    const start = team[0]!.startTime
    const test = start >= split
    const train = input.fit === 'all' || (input.fit === 'train' && !test)
    if (!test && !train) return
    const now = start + QUERY_DELAY_SEC
    const stage = stageAt(stages, now)
    if (!stage) return
    const opponent = teams.get(`${team[0]!.sessionId}:${team[0]!.team === 1 ? 2 : 1}`)
    const opponentCore = opponent ? teamCore(opponent) : ''
    const order = [...team].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    contexts.push({
      team,
      train,
      test,
      now,
      stage,
      opponentAir: opponentCore === '' ? null : opponentAir((squadronTeams.get(opponentCore) ?? []).filter((t) => t.availableAt <= now)),
      order,
      place: new Map(order.map((row, i) => [row.userId, i])),
      times: undefined,
    })
  })
  /** The players' battles stored by the query, their backgrounds and the vehicles seen from them at the cap. */
  const inputsOf = (context: TeamContext): TeamInputs => {
    const { now } = context
    const capFrom = periodBounds(context.stage).from
    const battles = new Map<string, ScoutBattle & { players: ScoutBattle['players'][number][] }>()
    const backgrounds = new Map<string, PlayerBackground>()
    const plainBackgrounds = new Map<string, PlayerBackground>()
    const seenAtCap = new Map<string, Set<string>>()
    const knownPlayers = new Set<string>()
    for (const player of context.team) {
      const known: Row[] = []
      const seen = new Set<string>()
      for (const row of byPlayer.get(player.userId) ?? []) {
        if (row.startTime >= now) break
        if (row.availableAt > now || row.endTime > now) continue
        known.push(row)
        if (row.startTime < now - IMAGE_HISTORY_SEC) continue
        let battle = battles.get(row.key)
        if (!battle) battles.set(row.key, (battle = { sessionId: row.key, startTime: row.startTime, endTime: row.endTime, availableAt: row.availableAt, players: [] }))
        battle.players.push({ userId: row.userId, nick: row.nick, vehicle: row.vehicle, lineup: row.lineup })
        if (row.startTime >= capFrom && row.vehicle) {
          seen.add(row.vehicle)
          for (const vehicle of row.lineup) seen.add(vehicle)
        }
      }
      const plain = playerBackground(known, info)
      const shark = sharkAt(player.userId, now)
      plainBackgrounds.set(player.userId, plain)
      backgrounds.set(player.userId, shark ? { ...plain, battles: shark.battles, battlesFresh: shark.fresh } : plain)
      seenAtCap.set(player.userId, seen)
      if (known.length > 0) knownPlayers.add(player.userId)
    }
    return { battles: [...battles.values()], capSpawns: capSpawnsAt(context.stage, now), backgrounds, plainBackgrounds, seenAtCap, known: knownPlayers }
  }
  const timesOf = (context: TeamContext) => {
    if (context.times === undefined) {
      const sessionId = context.team[0]!.sessionId
      const teamOf = new Map<string, number>()
      for (const side of [1, 2]) {
        for (const row of teams.get(`${sessionId}:${side}`) ?? []) {
          teamOf.set(row.userId, side)
          if (row.botUserId) teamOf.set(row.botUserId, side)
        }
      }
      context.times = battleTimeline(db, sessionId, teamOf, classOf)
    }
    return context.times
  }
  /** What a row's kill columns show `moment` seconds after the first spawn. */
  const columnsAt = (context: TeamContext, row: Row, moment: number): KillColumns => {
    const kills = timesOf(context)?.get(row.botUserId ?? row.userId)?.kills ?? []
    let air = 0
    let ground = 0
    for (const kill of kills) {
      if (kill.t > moment) continue
      if (kill.air) air += 1
      else ground += 1
    }
    return { air, ground, captures: null }
  }
  const inVehicleAt = (context: TeamContext, row: Row, moment: Moment): boolean => {
    if (moment === 'all') return true
    const time = timesOf(context)?.get(row.botUserId ?? row.userId)
    return time !== undefined && time.spawn <= moment && time.loss > moment
  }
  /** The flags and icons a screenshot shows at the moment; undefined — no flags; null — the moment needs events the battle lacks. */
  const evidenceAt = (context: TeamContext, moment: Moment | null, flag: 'operator' | 'nation', icons: boolean): FlagEvidence | undefined | null => {
    if (moment === null) return undefined
    if (moment !== 'all' && !timesOf(context)) return null
    const flagOf = flag === 'operator' ? operatorFlag : nationOf
    const line: string[] = []
    for (const row of context.order) {
      const icon = flagOf(row.vehicle!)
      if (inVehicleAt(context, row, moment) && !line.includes(icon)) line.push(icon)
    }
    return {
      flags: line.map((icon) => [{ icon, likelihood: 1 }]),
      seats: context.team.map((row) => ({
        place: context.place.get(row.userId)!,
        inVehicle: !icons ? null : inVehicleAt(context, row, moment) ? IN_VEHICLE_WITHOUT_ICON : IN_VEHICLE_WITH_ICON,
      })),
      flagsOf,
    }
  }
  const predict = (
    context: TeamContext,
    inputs: TeamInputs,
    model: ModelKind,
    flags: FlagEvidence | undefined,
    weights: KnownWeights | null,
    withShark = true,
    kills: { moment: number; known: boolean } | null = null,
  ): KnownTeamPrediction => {
    // Live, a player without a stored battle is an unread row: after the recognised ones, keeping its place.
    const recognised = input.unreadLive ? context.team.filter((row) => inputs.known.has(row.userId)) : context.team
    const unread = input.unreadLive ? context.team.filter((row) => !inputs.known.has(row.userId)) : []
    const seatOf = flags && new Map(context.team.map((row, i) => [row.userId, flags.seats[i]!]))
    const base: KnownTeamInput = {
      players: recognised.map((row) => ({ userId: row.userId, nick: row.nick })),
      unknownPlayers: unread.length,
      battles: inputs.battles,
      now: context.now,
      stages,
      classOf,
      flags: flags && seatOf ? { ...flags, seats: [...recognised, ...unread].map((row) => seatOf.get(row.userId)!) } : flags,
      ...(kills ? { kills: recognised.map((row) => columnsAt(context, row, kills.moment)), killMoment: kills.known ? kills.moment : null } : {}),
    }
    const noKnots = { flags: [], noFlags: [], flagsAllIn: [] }
    if (model === 'before') return predictKnownTeam({ ...base, weights: { setup: SQUADRON_SETUP, airKnots: noKnots } })
    const guess = {
      ...base,
      capSpawns: inputs.capSpawns,
      backgrounds: withShark ? inputs.backgrounds : inputs.plainBackgrounds,
      nationOf,
    }
    if (model === 'guess') return predictKnownTeam({ ...guess, weights: { newVehicle: weights?.newVehicle ?? [...NEW_VEHICLE_WEIGHTS], setup: SQUADRON_SETUP, airKnots: noKnots } })
    return predictKnownTeam({
      ...guess,
      opponentAir: context.opponentAir,
      weights: weights ?? undefined,
    })
  }

  // New-vehicle events: a player taking a vehicle never seen from them at this cap.
  interface NewEvent { train: boolean; test: boolean; rows: Float64Array; count: number; chosen: number; shark: 'fresh' | 'stale' | null }
  const events: NewEvent[] = []
  for (const context of contexts) {
    const inputs = inputsOf(context)
    for (const row of context.team) {
      const seen = inputs.seenAtCap.get(row.userId)!
      if (seen.has(row.vehicle!)) continue
      const background = fold !== undefined && heldOut(row.userId) ? inputs.plainBackgrounds : inputs.backgrounds
      const features = newVehicleFeatures(inputs.capSpawns, background.get(row.userId)!, seen, info)
      if (features.vehicles.length === 0) continue
      const index = features.vehicles.indexOf(row.vehicle!)
      const own = background.get(row.userId)!
      events.push({
        train: context.train,
        test: context.test,
        rows: Float64Array.from(features.rows.flat()),
        count: features.rows.length,
        chosen: index >= 0 ? index : features.rows.length - 1,
        shark: own.battles === null ? null : own.battlesFresh ? 'fresh' : 'stale',
      })
    }
  }
  const eventProbs = (event: NewEvent, w: readonly number[]): Float64Array => {
    const scores = new Float64Array(event.count)
    let max = -Infinity
    for (let r = 0; r < event.count; r += 1) {
      let s = 0
      for (let i = 0; i < NEW_DIM; i += 1) s += w[i]! * event.rows[r * NEW_DIM + i]!
      scores[r] = s
      if (s > max) max = s
    }
    let total = 0
    for (let r = 0; r < event.count; r += 1) total += (scores[r] = Math.exp(scores[r]! - max))
    for (let r = 0; r < event.count; r += 1) scores[r]! /= total
    return scores
  }

  const firstOf = (player: ScoutPlayerPrediction): VehicleChance | undefined => {
    const a = player.vehicles[0]
    const b = player.newVehicles[0]
    return !a ? b : !b ? a : b.chance > a.chance ? b : a
  }
  const truthChance = (player: ScoutPlayerPrediction, truth: string): number =>
    player.vehicles.find((v) => v.vehicleId === truth)?.chance
    ?? player.newVehicles.find((v) => v.vehicleId === truth)?.chance
    ?? Math.max(1e-9, player.unseenChance - player.newVehicles.reduce((sum, v) => sum + v.chance, 0))

  const handlers = {
    newMoments(w: number[]) {
      const grad = new Array<number>(NEW_DIM).fill(0)
      const hess = new Array<number>(NEW_DIM * NEW_DIM).fill(0)
      let ll = 0
      for (const event of events) {
        if (!event.train) continue
        const probs = eventProbs(event, w)
        ll += Math.log(Math.max(1e-300, probs[event.chosen]!))
        const mean = new Array<number>(NEW_DIM).fill(0)
        for (let r = 0; r < event.count; r += 1) for (let i = 0; i < NEW_DIM; i += 1) mean[i]! += probs[r]! * event.rows[r * NEW_DIM + i]!
        for (let i = 0; i < NEW_DIM; i += 1) grad[i]! += event.rows[event.chosen * NEW_DIM + i]! - mean[i]!
        for (let r = 0; r < event.count; r += 1) {
          for (let i = 0; i < NEW_DIM; i += 1) {
            const di = event.rows[r * NEW_DIM + i]! - mean[i]!
            if (di === 0) continue
            for (let j = 0; j < NEW_DIM; j += 1) hess[i * NEW_DIM + j]! += probs[r]! * di * (event.rows[r * NEW_DIM + j]! - mean[j]!)
          }
        }
      }
      return { grad, hess, ll }
    },
    newEval(w: number[]) {
      const out = { n: 0, loss: 0, top1: 0, top3: 0, other: 0 }
      for (const event of events) {
        if (!event.test) continue
        const probs = eventProbs(event, w)
        const ranked = Array.from({ length: event.count - 1 }, (_, r) => r).sort((a, b) => probs[b]! - probs[a]!)
        out.n += 1
        out.loss -= Math.log(Math.max(1e-12, probs[event.chosen]!))
        if (ranked[0] === event.chosen) out.top1 += 1
        if (ranked.slice(0, 3).includes(event.chosen)) out.top3 += 1
        if (event.chosen === event.count - 1) out.other += 1
      }
      return out
    },
    /** Per player of the fitting teams: the opponent's excess air, the truth's class (-1 unnamed) and chance, the named chances by class, the unnamed rest. */
    opponent(w: number[]) {
      const records: number[] = []
      for (const context of contexts) {
        if (!context.train || context.opponentAir === null) continue
        const prediction = predict(context, inputsOf(context), 'guess', undefined, { newVehicle: w, opponentAir: {}, setup: SQUADRON_SETUP, kills: KILL_LIKELIHOODS, airKnots: { flags: [], noFlags: [], flagsAllIn: [] } })
        const truth = new Map(context.team.map((row) => [row.userId, row.vehicle!]))
        for (const player of prediction.players) {
          const actual = truth.get(player.userId)!
          const masses = SCOUT_CLASSES.map(() => 0)
          let named = 0
          let truthClass = -1
          let truthChance = 0
          for (const vehicle of [...player.vehicles, ...player.newVehicles]) {
            const cls = classOf(vehicle.vehicleId)
            const index = cls === '?' ? -1 : SCOUT_CLASSES.indexOf(cls)
            if (index >= 0) masses[index]! += vehicle.chance
            named += vehicle.chance
            if (vehicle.vehicleId === actual) {
              truthClass = index
              truthChance = vehicle.chance
            }
          }
          // Named vehicles of an unknown class count with the unnamed rest (factor 1).
          const rest = Math.max(0, 1 - masses.reduce((a, b) => a + b, 0))
          if (truthChance === 0) truthChance = Math.max(1e-9, 1 - named)
          records.push(context.opponentAir - OPPONENT_AIR_MEAN, truthClass, truthChance, ...masses, rest)
        }
      }
      return records
    },
    /** Kill patterns (none, air, ground, both) per KILL_MOMENTS row and class over the fitting teams: [row][class][pattern]. */
    killTable() {
      const counts = KILL_MOMENTS.map(() => SCOUT_CLASSES.map(() => [0, 0, 0, 0]))
      for (const context of contexts) {
        if (!context.train || !timesOf(context)) continue
        for (const row of context.team) {
          const c = SCOUT_CLASSES.indexOf(classOf(row.vehicle!) as ScoutClass)
          if (c < 0) continue
          KILL_MOMENTS.forEach((moment, m) => {
            const columns = columnsAt(context, row, moment)
            counts[m]![c]![(columns.air! > 0 ? 1 : 0) + (columns.ground! > 0 ? 2 : 0)]! += 1
          })
        }
      }
      return counts
    },
    /** The calibrated air chance (before the knots) and whether air happened, at every screenshot moment with the kill columns: [mode 0 no flags / 1 flags / 2 flags all in, chance, happened]. */
    airSamples(weights: KnownWeights) {
      const plain = { ...weights, airKnots: { flags: [], noFlags: [], flagsAllIn: [] } }
      const samples: number[] = []
      for (const context of contexts) {
        if (!context.train || !timesOf(context)) continue
        let classesKnown = true
        let air = 0
        for (const row of context.team) {
          const cls = classOf(row.vehicle!)
          if (cls === '?') classesKnown = false
          if (cls === 'F' || cls === 'H') air += 1
        }
        if (!classesKnown) continue
        const inputs = inputsOf(context)
        for (const moment of MOMENTS_ALL) {
          const flags = evidenceAt(context, moment, 'operator', true)
          if (flags === null) continue
          const kills = typeof moment === 'number' ? { moment, known: false } : null
          const prediction = predict(context, inputs, 'full', flags, plain, true, kills)
          const allIn = flags !== undefined && flags.seats.every((seat) => seat.inVehicle === IN_VEHICLE_WITHOUT_ICON)
          samples.push(prediction.flags ? (allIn ? 2 : 1) : 0, prediction.setup.airChance, air > 0 ? 1 : 0)
        }
      }
      return samples
    },
    /** Raw setup chances and what happened: [flags 0/1, logit raw composition, hit, raw air, last had air, air happened]. */
    setup(weights: KnownWeights, test: boolean) {
      const samples: number[] = []
      for (const context of contexts) {
        if (test ? !context.test : !context.train) continue
        const counts: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
        let known = true
        for (const row of context.team) {
          const cls = classOf(row.vehicle!)
          if (cls === '?') known = false
          else counts[cls] += 1
        }
        if (!known) continue
        const inputs = inputsOf(context)
        for (const moment of [null, ...FIT_MOMENTS] as const) {
          const flags = evidenceAt(context, moment, 'operator', true)
          if (flags === null) continue
          const prediction = predict(context, inputs, 'full', flags, weights)
          const top = prediction.setup.compositions[0]
          if (!top) continue
          const hit = SCOUT_CLASSES.every((cls) => top.counts[cls] === counts[cls]) ? 1 : 0
          samples.push(prediction.flags ? 1 : 0, top.raw, hit, prediction.setup.rawAirChance, prediction.lastHadAir ? 1 : 0, counts.F + counts.H > 0 ? 1 : 0)
        }
      }
      return samples
    },
    evaluate(weights: KnownWeights, variants: Variant[]) {
      const tallies = variants.map(() => emptyTally())
      let teamsScored = 0
      for (const context of contexts) {
        if (!context.test || !timesOf(context)) continue
        teamsScored += 1
        const inputs = inputsOf(context)
        const truth = new Map(context.team.map((row) => [row.userId, row.vehicle!]))
        const counts: Record<ScoutClass, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
        let classesKnown = true
        for (const row of context.team) {
          const cls = classOf(row.vehicle!)
          if (cls === '?') classesKnown = false
          else counts[cls] += 1
        }
        variants.forEach((variant, index) => {
          const flags = evidenceAt(context, variant.moment, variant.flag, variant.icons)
          if (flags === null) return
          const tally = tallies[index]!
          const kills = variant.kills !== null && typeof variant.moment === 'number' ? { moment: variant.moment, known: variant.kills === 'moment' } : null
          const prediction = predict(context, inputs, variant.model, flags, weights, variant.statshark, kills)
          tally.teams += 1
          tally.unreadN += context.team.length - prediction.players.length
          tally.operator += prediction.flags?.operatorChance ?? 0
          if (flags) {
            tally.lines[flags.flags.length]! += 1
            tally.inVehicle += context.team.filter((row) => inVehicleAt(context, row, variant.moment!)).length
          }
          for (const player of prediction.players) {
            const actual = truth.get(player.userId)!
            const options = [...player.vehicles, ...player.newVehicles].sort((a, b) => b.chance - a.chance)
            const first = firstOf(player)
            const hit = first?.vehicleId === actual ? 1 : 0
            const chance = truthChance(player, actual)
            tally.n += 1
            tally.top1 += hit
            if (options.slice(0, 3).some((v) => v.vehicleId === actual)) tally.top3 += 1
            tally.loss -= Math.log(chance)
            const seen = player.vehicles.find((v) => v.vehicleId === actual)?.chance
            tally.lumped -= Math.log(Math.max(1e-9, seen ?? player.unseenChance))
            if (first && classOf(first.vehicleId) === classOf(actual)) tally.classTop1 += 1
            if (player.battlesAtCap === 0) {
              tally.coldN += 1
              tally.coldTop1 += hit
            }
            if (inputs.backgrounds.get(player.userId)?.battles && heldOut(player.userId)) {
              tally.shark.n += 1
              tally.shark.top1 += hit
              tally.shark.loss -= Math.log(chance)
            }
            if (first) addToBins(tally.bins, PROB_EDGES, first.chance, hit)
          }
          if (!classesKnown) return
          const top = prediction.setup.compositions[0]
          if (!top) return
          const compositionHit = SCOUT_CLASSES.every((cls) => top.counts[cls] === counts[cls]) ? 1 : 0
          tally.setupTeams += 1
          tally.compHit += compositionHit
          tally.compSaid += top.chance
          addToBins(tally.comp, COMPOSITION_EDGES, top.chance, compositionHit)
          addToBins(tally.air, PROB_EDGES, prediction.setup.airChance, counts.F + counts.H > 0 ? 1 : 0)
          tally.airError += Math.abs(prediction.setup.expected.F + prediction.setup.expected.H - counts.F - counts.H)
        })
      }
      return { tallies, teamsScored }
    },
  }

  parentPort!.postMessage({
    train: contexts.filter((context) => context.train).length,
    test: contexts.filter((context) => context.test).length,
    events: events.length,
    sharkEvents: events.filter((event) => event.shark === 'fresh').length,
    staleSharkEvents: events.filter((event) => event.shark === 'stale').length,
    sharkPlayers: statshark.size,
    heapMb: process.memoryUsage().heapUsed / 2 ** 20,
  })
  parentPort!.on('message', (request: KnownRequest) => {
    switch (request.op) {
      case 'newMoments':
        parentPort!.postMessage(handlers.newMoments(request.weights))
        break
      case 'newEval':
        parentPort!.postMessage(handlers.newEval(request.weights))
        break
      case 'opponent':
        parentPort!.postMessage(handlers.opponent(request.weights))
        break
      case 'setup':
        parentPort!.postMessage(handlers.setup(request.weights, request.test))
        break
      case 'killTable':
        parentPort!.postMessage(handlers.killTable())
        break
      case 'airSamples':
        parentPort!.postMessage(handlers.airSamples(request.weights))
        break
      case 'evaluate':
        parentPort!.postMessage(handlers.evaluate(request.weights, request.variants))
        break
      case 'close':
        db.close()
        parentPort!.close()
        break
    }
  })
}

// --- main ------------------------------------------------------------------------

class Handle {
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
  request<T>(message: KnownRequest): Promise<T> {
    const reply = this.next<T>()
    this.worker.postMessage(message)
    return reply
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

/** Newton's method with an L2 term; `moments` sums the log-likelihood's gradient and its negative Hessian. */
async function newton(start: readonly number[], moments: (w: number[]) => Promise<{ grad: number[]; hess: number[] }>): Promise<number[]> {
  const dim = start.length
  let w = [...start]
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

/** Newton's method with step halving on the penalised log-likelihood (the softmax over ~150 options overshoots from zero). */
async function dampedNewton(
  start: readonly number[],
  moments: (w: number[]) => Promise<{ grad: number[]; hess: number[]; ll: number }>,
  penalties: readonly number[] = start.map(() => L2),
): Promise<number[]> {
  const dim = start.length
  const objective = (w: readonly number[], ll: number) => ll - w.reduce((sum, v, i) => sum + (penalties[i]! / 2) * v * v, 0)
  let w = [...start]
  let current = await moments(w)
  for (let iter = 0; iter < 100; iter += 1) {
    const g = current.grad.map((value, i) => value - penalties[i]! * w[i]!)
    const h = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => current.hess[i * dim + j]! + (i === j ? penalties[i]! : 0)))
    const step = solve(h, g)
    let scale = 1
    let next = w
    let nextMoments = current
    for (;;) {
      next = w.map((value, i) => value + scale * step[i]!)
      nextMoments = await moments(next)
      if (objective(next, nextMoments.ll) >= objective(w, current.ll) - 1e-9 || scale < 1e-6) break
      scale /= 2
    }
    if (process.env['SCOUT_FIT_DEBUG']) console.log(`    iteration ${iter}: log-likelihood ${nextMoments.ll.toFixed(1)}, step ${scale}, ${format(next)}`)
    const moved = Math.max(...step.map((value) => Math.abs(value * scale)))
    w = next
    current = nextMoments
    if (moved < 1e-7) break
  }
  return w
}

function fitLogistic(xs: readonly number[][], ys: readonly number[]): Promise<number[]> {
  const dim = xs[0]!.length
  return newton(new Array<number>(dim).fill(0), async (w) => {
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

/** The opponent-air weights per class: maximum likelihood of each player's vehicle after scaling the named chances by exp(w_class · excess air). */
function fitOpponentAir(records: readonly number[]): Promise<number[]> {
  const width = 3 + SCOUT_CLASSES.length + 1
  const dim = SCOUT_CLASSES.length
  return newton(new Array<number>(dim).fill(0), async (w) => {
    const grad = new Array<number>(dim).fill(0)
    const hess = new Array<number>(dim * dim).fill(0)
    for (let o = 0; o + width <= records.length; o += width) {
      const x = records[o]!
      const truthClass = records[o + 1]!
      const scaled = SCOUT_CLASSES.map((_, c) => records[o + 3 + c]! * Math.exp(w[c]! * x))
      const z = scaled.reduce((a, b) => a + b, 0) + records[o + 3 + dim]!
      for (let c = 0; c < dim; c += 1) {
        grad[c]! += (truthClass === c ? x : 0) - (x * scaled[c]!) / z
        for (let d = 0; d < dim; d += 1) {
          hess[c * dim + d]! += x * x * ((c === d ? scaled[c]! / z : 0) - (scaled[c]! * scaled[d]!) / (z * z))
        }
      }
    }
    return { grad, hess }
  })
}

/** Isotonic regression of y on x over AIR_KNOT_BINS equal-count bins (pool adjacent violators): the knots of a monotone map. */
const AIR_KNOT_BINS = 20
function isotonicKnots(points: { x: number; y: number }[]): [number, number][] {
  if (points.length < AIR_KNOT_BINS * 50) return []
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const blocks: { x: number; y: number; n: number }[] = []
  for (let b = 0; b < AIR_KNOT_BINS; b += 1) {
    const slice = sorted.slice(Math.floor((b * sorted.length) / AIR_KNOT_BINS), Math.floor(((b + 1) * sorted.length) / AIR_KNOT_BINS))
    if (slice.length === 0) continue
    blocks.push({ x: slice.reduce((s, p) => s + p.x, 0) / slice.length, y: slice.reduce((s, p) => s + p.y, 0) / slice.length, n: slice.length })
  }
  for (let i = 0; i + 1 < blocks.length;) {
    if (blocks[i]!.y <= blocks[i + 1]!.y) {
      i += 1
      continue
    }
    const [a, b] = [blocks[i]!, blocks[i + 1]!]
    blocks.splice(i, 2, { x: (a.x * a.n + b.x * b.n) / (a.n + b.n), y: (a.y * a.n + b.y * b.n) / (a.n + b.n), n: a.n + b.n })
    if (i > 0) i -= 1
  }
  return blocks.map((block) => [Number(block.x.toFixed(4)), Number(block.y.toFixed(4))])
}

function printBins(bins: Bins, edges: readonly number[], indent = '    '): void {
  bins.forEach(([sumP, sumY, n], i) => {
    if (n === 0) return
    console.log(`${indent}${edges[i]!.toFixed(2)}–${Math.min(1, edges[i + 1]!).toFixed(2)}: n=${n} said ${pct(sumP / n)}, happened ${pct(sumY / n)}`)
  })
}

export async function knownTeamBacktest(
  dbPath: string,
  dict: VehicleDict,
  split: number,
  options: { fit: 'train' | 'all' | null; statshark: boolean; threads: number; variants?: RegExp | undefined; unreadLive?: boolean },
): Promise<void> {
  const started = performance.now()
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`
  const parts = Math.max(1, options.threads)
  const workers = Array.from({ length: parts }, (_, part) => {
    const input: KnownWorkerInput = { kind: 'scout-known', dbPath, dict, split, part, parts, fit: options.fit, statshark: options.statshark, unreadLive: options.unreadLive ?? false }
    return new Handle(new Worker(new URL(import.meta.url), { workerData: input }))
  })
  const inits = await Promise.all(workers.map((w) => w.next<{ train: number; test: number; events: number; sharkEvents: number; staleSharkEvents: number; sharkPlayers: number; heapMb: number }>()))
  const all = <T>(message: KnownRequest) => Promise.all(workers.map((w) => w.request<T>(message)))
  const sumOf = (field: 'train' | 'test' | 'events' | 'sharkEvents' | 'staleSharkEvents') => inits.reduce((s, r) => s + r[field], 0)
  const heaps = inits.map((init) => init.heapMb)
  console.log(`known team: ${sumOf('test')} teams of 8 scored from ${new Date(split * 1000).toISOString().slice(0, 10)}, ${sumOf('train')} fitted on, ${sumOf('events')} new-vehicle events${options.statshark ? ` (${sumOf('sharkEvents')} with a fresh StatShark snapshot, ${sumOf('staleSharkEvents')} with an older one; ${inits[0]!.sharkPlayers} players have snapshots)` : ''}; ${parts} threads, heap ${Math.round(Math.max(...heaps))} MiB a thread at most, ${(heaps.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} GiB in all (${elapsed()})`)

  const weights: KnownWeights = {
    newVehicle: [...NEW_VEHICLE_WEIGHTS],
    opponentAir: { ...OPPONENT_AIR_WEIGHTS },
    setup: { flags: { ...KNOWN_TEAM_SETUP_CALIBRATION.flags }, noFlags: { ...KNOWN_TEAM_SETUP_CALIBRATION.noFlags } },
    kills: KILL_LIKELIHOODS,
    airKnots: { flags: [...KNOWN_TEAM_AIR_KNOTS.flags], noFlags: [...KNOWN_TEAM_AIR_KNOTS.noFlags], flagsAllIn: [...KNOWN_TEAM_AIR_KNOTS.flagsAllIn] },
  }
  if (options.fit) {
    weights.newVehicle = await dampedNewton(NEW_VEHICLE_WEIGHTS.map(() => 0), async (w) => {
      const parts = await all<{ grad: number[]; hess: number[]; ll: number }>({ op: 'newMoments', weights: w })
      return {
        grad: Array.from({ length: NEW_DIM }, (_, i) => parts.reduce((s, p) => s + p.grad[i]!, 0)),
        hess: Array.from({ length: NEW_DIM * NEW_DIM }, (_, i) => parts.reduce((s, p) => s + p.hess[i]!, 0)),
        ll: parts.reduce((s, p) => s + p.ll, 0),
      }
    }, NEW_VEHICLE_FEATURES.map((name) => (name === 'logBattles' || name === 'notPlayed' ? SHARK_L2 : L2)))
    console.log(`fitted (${options.fit === 'all' ? 'every team' : 'before the split'}, ${elapsed()}):`)
    console.log(`  NEW_VEHICLE_FEATURES ${NEW_VEHICLE_FEATURES.join(', ')}`)
    console.log(`  NEW_VEHICLE_WEIGHTS ${format(weights.newVehicle)}`)
    const records = (await all<number[]>({ op: 'opponent', weights: weights.newVehicle })).flat()
    const air = await fitOpponentAir(records)
    weights.opponentAir = Object.fromEntries(SCOUT_CLASSES.map((cls, i) => [cls, Number(air[i]!.toFixed(3))]))
    console.log(`  OPPONENT_AIR_WEIGHTS ${JSON.stringify(weights.opponentAir)} (${records.length / (3 + SCOUT_CLASSES.length + 1)} players, ${elapsed()})`)
    const samples = (await all<number[]>({ op: 'setup', weights, test: false })).flat()
    const held = options.fit === 'train' ? (await all<number[]>({ op: 'setup', weights, test: true })).flat() : []
    const split6 = (list: number[], flags: number) => {
      const rows: number[][] = []
      for (let o = 0; o + 6 <= list.length; o += 6) if (list[o] === flags) rows.push(list.slice(o + 1, o + 6))
      return rows
    }
    const logit = (p: number) => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))))
    for (const flags of [0, 1]) {
      const rows = split6(samples, flags)
      const composition = await fitLogistic(rows.map((r) => compositionCalibrationFeatures(r[0]!)), rows.map((r) => r[1]!))
      const airFit = await fitLogistic(rows.map((r) => airCalibrationFeatures(r[2]!, r[3] === 1)), rows.map((r) => r[4]!))
      weights.setup[flags ? 'flags' : 'noFlags'] = { air: airFit.map((v) => Number(v.toFixed(3))), composition: composition.map((v) => Number(v.toFixed(3))) }
      console.log(`  KNOWN_TEAM_SETUP_CALIBRATION.${flags ? 'flags' : 'noFlags'} air ${format(airFit)}, composition ${format(composition)} (${rows.length} samples)`)
      // Held-out teams: the air calibration's shapes against the raw chance (log loss and the worst band).
      const test = split6(held, flags)
      if (test.length === 0) continue
      const shapes: [string, (r: number[]) => number[]][] = [
        ['raw', (r) => [logit(r[2]!)]],
        ['logit', (r) => [1, logit(r[2]!)]],
        ['logit + last had air', (r) => airCalibrationFeatures(r[2]!, r[3] === 1)],
        ['logit × last had air', (r) => [1, logit(r[2]!), r[3]!, r[3]! * logit(r[2]!)]],
      ]
      for (const [name, features] of shapes) {
        const w = name === 'raw' ? [1] : await fitLogistic(rows.map(features), rows.map((r) => r[4]!))
        const bins = emptyBins(PROB_EDGES)
        let loss = 0
        for (const r of test) {
          const p = 1 / (1 + Math.exp(-features(r).reduce((sum, v, i) => sum + v * w[i]!, 0)))
          loss -= r[4] === 1 ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p))
          addToBins(bins, PROB_EDGES, p, r[4]!)
        }
        const worst = Math.max(...bins.map(([p, y, n]) => (n >= 100 ? Math.abs(p - y) / n : 0)))
        console.log(`    air, ${flags ? 'flags' : 'no flags'}, ${name}: held-out log loss ${(loss / test.length).toFixed(4)}, worst band (100+ teams) off by ${(worst * 100).toFixed(1)} points ${format(w)}`)
      }
    }
    // The kill table: each class's patterns by each moment, add-one smoothed.
    const killParts = await all<number[][][]>({ op: 'killTable' })
    const table = Object.fromEntries(SCOUT_CLASSES.map((cls, c) => [cls, KILL_MOMENTS.map((_, m) => {
      const n = [0, 1, 2, 3].map((pattern) => killParts.reduce((sum, part) => sum + part[m]![c]![pattern]!, 0) + 1)
      const total = n.reduce((a, b) => a + b, 0)
      return n.map((value) => Number((value / total).toFixed(4)))
    })])) as unknown as KillTable
    weights.kills = table
    console.log(`  KILL_LIKELIHOODS (rows ${KILL_MOMENTS.join(', ')} s; none, air, ground, both) ${JSON.stringify(table)}`)
    // The air knots: isotonic over the calibrated chances at every moment, per mode.
    const airParts = (await all<number[]>({ op: 'airSamples', weights })).flat()
    for (const [mode, tag] of [['noFlags', 0], ['flags', 1], ['flagsAllIn', 2]] as const) {
      const points: { x: number; y: number }[] = []
      for (let o = 0; o + 3 <= airParts.length; o += 3) if (airParts[o] === tag) points.push({ x: airParts[o + 1]!, y: airParts[o + 2]! })
      weights.airKnots[mode] = isotonicKnots(points)
    }
    console.log(`  KNOWN_TEAM_AIR_KNOTS ${JSON.stringify(weights.airKnots)}`)
    console.log(`  (${elapsed()})`)
  }

  const newEval = (await all<{ n: number; loss: number; top1: number; top3: number; other: number }>({ op: 'newEval', weights: weights.newVehicle }))
    .reduce((s, r) => ({ n: s.n + r.n, loss: s.loss + r.loss, top1: s.top1 + r.top1, top3: s.top3 + r.top3, other: s.other + r.other }))
  console.log(`new-vehicle events from the split: ${newEval.n}; the guess names it first ${pct(newEval.top1 / newEval.n)}, among three ${pct(newEval.top3 / newEval.n)}, log loss ${(newEval.loss / newEval.n).toFixed(4)}; outside the cap's top vehicles ${pct(newEval.other / newEval.n)}`)

  const variants: Variant[] = []
  const add = (name: string, model: ModelKind, moment: Moment | null, flag: 'operator' | 'nation' = 'operator', icons = true, statshark = true, kills: Variant['kills'] = null) =>
    variants.push({ name, model, moment, flag, icons, statshark, kills })
  for (const model of ['before', 'guess', 'full'] as const) for (const moment of [null, 'all', 30, 180] as const) add(`${model}`, model, moment)
  for (const moment of [10, 60, 120, 300] as const) add('full', 'full', moment)
  for (const moment of ['all', 30, 180] as const) add('full, icons not in the picture', 'full', moment, 'operator', false)
  for (const moment of ['all', 30] as const) add('full, nation flags', 'full', moment, 'nation')
  if (options.statshark) for (const moment of [null, 'all'] as const) add('full without StatShark', 'full', moment, 'operator', true, false)
  for (const moment of [60, 120, 180, 300] as const) add('full + kills', 'full', moment, 'operator', true, true, 'moment')
  for (const moment of [120, 180, 300] as const) add('full + kills, timer not read', 'full', moment, 'operator', true, true, 'unknown')
  const label = (variant: Variant) => `${variant.name}, ${variant.moment === null ? 'no flags' : variant.moment === 'all' ? 'everyone in a vehicle' : `${variant.moment} s after the first spawn`}`
  if (options.variants) variants.splice(0, variants.length, ...variants.filter((variant) => options.variants!.test(label(variant))))
  const parts2 = await all<{ tallies: Tally[]; teamsScored: number }>({ op: 'evaluate', weights, variants })
  const tallies = variants.map(() => emptyTally())
  for (const part of parts2) part.tallies.forEach((tally, i) => mergeTally(tallies[i]!, tally))
  console.log(`scored ${parts2.reduce((s, p) => s + p.teamsScored, 0)} teams (${elapsed()}); models: before — 1f8ae62; guess — new vehicles named from the cap's spawns${options.statshark ? ' and StatShark' : ''}; full — and the opponent's air, the picture path's setup calibration`)
  variants.forEach((variant, index) => {
    const t = tallies[index]!
    if (t.n === 0) return
    const when = label(variant).slice(variant.name.length + 2)
    const detail = variant.moment === null ? '' : `; in a vehicle ${pct(t.inVehicle / t.n)}, operator flags said ${pct(t.operator / t.teams)}`
    const shark = t.shark.n > 0 ? `; with StatShark (${t.shark.n}) ${pct(t.shark.top1 / t.shark.n)} / ${(t.shark.loss / t.shark.n).toFixed(4)}` : ''
    const unread = t.unreadN > 0 ? `; unread rows ${pct(t.unreadN / (t.n + t.unreadN))} of the players` : ''
    console.log(`  ${variant.name}, ${when}: first ${pct(t.top1 / t.n)}, three ${pct(t.top3 / t.n)}, log loss ${(t.loss / t.n).toFixed(4)} (new vehicles as one ${(t.lumped / t.n).toFixed(4)}), class ${pct(t.classTop1 / t.n)}; no battles at the cap (${pct(t.coldN / t.n)}) ${pct(t.coldTop1 / Math.max(1, t.coldN))}${unread}${shark}${detail}`)
    console.log(`    setup: most likely right ${pct(t.compHit / t.setupTeams)} (said ${pct(t.compSaid / t.setupTeams)}), aircraft off by ${(t.airError / t.setupTeams).toFixed(2)}`)
    if (variant.moment === null || variant.moment === 'all') {
      if (variant.model === 'full' && variant.icons && variant.flag === 'operator' && variant.statshark) {
        console.log('    first vehicle, said → happened:')
        printBins(t.bins, PROB_EDGES, '      ')
      }
      if (variant.model !== 'guess' && variant.icons && variant.flag === 'operator' && variant.statshark) {
        console.log('    most likely setup, said → happened:')
        printBins(t.comp, COMPOSITION_EDGES, '      ')
        console.log('    at least one aircraft, said → happened:')
        printBins(t.air, PROB_EDGES, '      ')
      }
    }
  })
  await Promise.all(workers.map((w) => { w.worker.postMessage({ op: 'close' } satisfies KnownRequest); return w.worker.terminate() }))
  console.log(`done in ${elapsed()}`)
}

if (!isMainThread && (workerData as { kind?: string } | null)?.kind === 'scout-known') runKnownWorker(workerData as KnownWorkerInput)
