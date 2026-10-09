/**
 * /scout data: squadron lookup by tag or name and the prediction for a
 * squadron's next battle (model.ts) from its stored battles. The history is
 * read in a worker task on its own read-only connection.
 */

import { createHash } from 'node:crypto'
import { getDbWorkerPath, getScoutSquadronTags, getScoutStages, getScoutTeamRows, type ScoutTeamRow } from '../db/index.js'
import { normalizePlayerSearchKey } from '../db/index.js'
import { runWorkerTask } from '../workers/pool.js'
import { ensureVehicleDict, vehicleInfo, type VehicleDict } from '../wrpl/vehicles.js'
import {
  DEFAULT_OPERATOR_FLAGS_PRIOR,
  dictionaryFlagIcons,
  dictionaryFlags,
  IN_VEHICLE_WITH_ICON,
  IN_VEHICLE_WITHOUT_ICON,
  NATION_FLAG_SHARE,
  type FlagEvidence,
  type FlagSeat,
  type VehicleFlags,
} from './flag-evidence.js'
import { ensureFlagTemplates } from './flag-pack.js'
import {
  DEFAULT_CLASS_SHARES,
  KNOWN_TEAM_SETUP_CALIBRATION,
  NEW_VEHICLE_CANDIDATES,
  NEW_VEHICLE_WEIGHTS,
  NEW_VEHICLES_KEPT,
  OPPONENT_AIR_BATTLES,
  OPPONENT_AIR_MEAN,
  OPPONENT_AIR_WEIGHTS,
  ROSTER_WINDOW_SEC,
  STATSHARK_FRESH_SEC,
  VEHICLE_WEIGHTS,
  opponentAir,
  playerBackground,
  predictKnownTeam,
  predictScout,
  type KnownTeamPrediction,
  type ScoutBattle,
  type ScoutPrediction,
} from './model.js'
import { displayedNick, type NickMatch } from './nick-match.js'
import type { RowIcon } from './row-icons.js'
import type { ScoreboardReadResult } from './scoreboard-read.js'

/** A team with fewer of the squadron's players is another squadron's team with guests. */
const MIN_SQUADRON_PLAYERS = 4
const INDEX_TTL_MS = 10 * 60_000
const HISTORY_TTL_MS = 30_000

export const squadronCore = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

export interface ScoutSquadron {
  core: string
  /** Decorated tags seen in replays and on the leaderboard (SQL filters). */
  tags: string[]
  /** The tag to show: the leaderboard's, else the first seen in replays. */
  displayTag: string
  name: string | null
  /** Leaderboard place; null — not on it. */
  position: number | null
  inReplays: boolean
}

let index: { builtAt: number; squadrons: Map<string, ScoutSquadron> } | null = null

function squadronIndex(): Map<string, ScoutSquadron> {
  if (index && Date.now() - index.builtAt < INDEX_TTL_MS) return index.squadrons
  const { battleTags, clans } = getScoutSquadronTags()
  const squadrons = new Map<string, ScoutSquadron>()
  const entry = (tag: string): ScoutSquadron | null => {
    const core = squadronCore(tag)
    if (core === '') return null
    let squadron = squadrons.get(core)
    if (!squadron) {
      squadron = { core, tags: [], displayTag: tag, name: null, position: null, inReplays: false }
      squadrons.set(core, squadron)
    }
    if (!squadron.tags.includes(tag)) squadron.tags.push(tag)
    return squadron
  }
  for (const clan of clans) {
    const squadron = entry(clan.tag)
    if (!squadron) continue
    squadron.displayTag = clan.tag
    squadron.name = clan.name
    squadron.position = clan.position
  }
  for (const tag of battleTags) {
    const squadron = entry(tag)
    if (squadron) squadron.inReplays = true
  }
  index = { builtAt: Date.now(), squadrons }
  return squadrons
}

/**
 * Squadrons matching a tag or name: the exact tag first, then tag and name
 * prefixes, then the rest; within a rank, squadrons with replays and a better
 * leaderboard place first.
 */
export function findSquadrons(query: string, limit = 25): ScoutSquadron[] {
  const core = squadronCore(query)
  const text = normalizePlayerSearchKey(query.trim())
  const ranked: { squadron: ScoutSquadron; rank: number }[] = []
  for (const squadron of squadronIndex().values()) {
    const name = squadron.name === null ? '' : normalizePlayerSearchKey(squadron.name)
    let rank: number
    if (core !== '' && squadron.core === core) rank = 0
    else if ((core !== '' && squadron.core.startsWith(core)) || (text !== '' && name.startsWith(text))) rank = 1
    else if ((core !== '' && squadron.core.includes(core)) || (text !== '' && name.includes(text))) rank = 2
    else if (core === '' && text === '') rank = 3
    else continue
    ranked.push({ squadron, rank })
  }
  ranked.sort((a, b) =>
    a.rank - b.rank
    || Number(b.squadron.inReplays) - Number(a.squadron.inReplays)
    || (a.squadron.position ?? Number.MAX_SAFE_INTEGER) - (b.squadron.position ?? Number.MAX_SAFE_INTEGER)
    || a.squadron.core.localeCompare(b.squadron.core))
  return ranked.slice(0, limit).map((item) => item.squadron)
}

/** Battles from rows, one per team with at least `minPlayers` of the rows' players (a squadron: MIN_SQUADRON_PLAYERS). */
export function scoutBattlesFromRows(rows: readonly ScoutTeamRow[], minPlayers = MIN_SQUADRON_PLAYERS): ScoutBattle[] {
  const teams = new Map<string, ScoutBattle & { players: ScoutBattle['players'][number][] }>()
  for (const row of rows) {
    const key = `${row.sessionId}:${row.team}`
    let battle = teams.get(key)
    if (!battle) {
      battle = {
        sessionId: row.sessionId,
        startTime: row.startTime,
        endTime: row.startTime + row.durationSec,
        availableAt: row.ingestedAt,
        players: [],
      }
      teams.set(key, battle)
    }
    let lineup: string[] = []
    try {
      const parsed = JSON.parse(row.vehicles) as unknown
      if (Array.isArray(parsed)) lineup = parsed.filter((value): value is string => typeof value === 'string')
    } catch {
      // A broken lineup leaves the player's spawn only.
    }
    battle.players.push({ userId: row.userId, nick: row.nick, vehicle: row.vehicle, lineup })
  }
  return [...teams.values()]
    .filter((battle) => battle.players.length >= minPlayers)
    .sort((a, b) => a.endTime - b.endTime)
}

interface ScoutHistory {
  battles: ScoutBattle[]
  stages: { startsAt: number; endsAt: number; maxBr: number }[]
}

const historyCache = new Map<string, { builtAt: number; value: Promise<ScoutHistory> }>()

/** The squadron's battles of the roster window; concurrent and repeated calls within HISTORY_TTL_MS share one read. */
export function loadScoutHistory(squadron: ScoutSquadron, nowSec: number): Promise<ScoutHistory> {
  const cached = historyCache.get(squadron.core)
  if (cached && Date.now() - cached.builtAt < HISTORY_TTL_MS) return cached.value
  const fromTs = nowSec - ROSTER_WINDOW_SEC - 86_400
  const toTs = nowSec + 1
  const dbPath = getDbWorkerPath()
  const value: Promise<ScoutHistory> = (dbPath === null
    ? Promise.resolve().then(() => ({ rows: getScoutTeamRows(squadron.tags, fromTs, toTs), stages: getScoutStages() }))
    : runWorkerTask(
      { kind: 'read-scout-history', input: { dbPath, tags: squadron.tags.slice(0, 8), fromTs, toTs } },
      { priority: 'interactive', timeoutMs: 20_000 },
    )).then(({ rows, stages }) => ({ battles: scoutBattlesFromRows(rows), stages }))
  historyCache.set(squadron.core, { builtAt: Date.now(), value })
  value.catch(() => {
    if (historyCache.get(squadron.core)?.value === value) historyCache.delete(squadron.core)
  })
  for (const [key, item] of historyCache) if (Date.now() - item.builtAt >= HISTORY_TTL_MS) historyCache.delete(key)
  return value
}

/** A nickname as typed: case, spaces and the platform suffix ("@psn", "@live") ignored. */
export const nickKey = (nick: string): string => normalizePlayerSearchKey(nick.trim().replace(/@\w+$/u, ''))

/** Recent players of the squadron, most recent first (the `player` option's suggestions). */
export function recentNicks(battles: readonly ScoutBattle[]): string[] {
  const seen = new Set<string>()
  const nicks: string[] = []
  for (let i = battles.length - 1; i >= 0; i -= 1) {
    for (const player of battles[i]!.players) {
      if (seen.has(player.userId)) continue
      seen.add(player.userId)
      nicks.push(player.nick)
    }
  }
  return nicks
}

export interface ScoutReport {
  squadron: ScoutSquadron
  prediction: ScoutPrediction
  /** Battles of the squadron in the roster window. */
  battleCount: number
  /** The hint as typed; matched — it named one of the squadron's players. */
  hint: { nick: string; matched: boolean } | null
  vehicles: VehicleDict
  now: number
}

export async function buildScoutReport(squadron: ScoutSquadron, hintNick: string | null, nowSec = Math.floor(Date.now() / 1000)): Promise<ScoutReport> {
  const [history, vehicles] = await Promise.all([loadScoutHistory(squadron, nowSec), ensureVehicleDict('interactive')])
  let hintUserId: string | undefined
  if (hintNick !== null && hintNick.trim() !== '') {
    const key = nickKey(hintNick)
    for (let i = history.battles.length - 1; i >= 0 && hintUserId === undefined; i -= 1) {
      hintUserId = history.battles[i]!.players.find((player) => nickKey(player.nick) === key)?.userId
    }
  }
  const prediction = predictScout({
    battles: history.battles,
    now: nowSec,
    stages: history.stages,
    classOf: (id) => vehicleInfo(vehicles, id).cls,
    hintUserId: hintNick !== null && hintNick.trim() !== '' ? (hintUserId ?? '') : undefined,
  })
  return {
    squadron,
    prediction,
    battleCount: history.battles.length,
    hint: hintNick !== null && hintNick.trim() !== '' ? { nick: hintNick.trim(), matched: hintUserId !== undefined } : null,
    vehicles,
    now: nowSec,
  }
}

/** Players matched against a screenshot: everyone seen in the last 120 days (a squadron player can pause for months). */
const IMAGE_CANDIDATE_WINDOW_SEC = 120 * 86_400
/** Vehicle history of the recognised players: the current BR period at most (a week plus the switch delay). */
const IMAGE_HISTORY_WINDOW_SEC = 9 * 86_400
/** Their battles at any cap the new-vehicle guess reads (nations, classes, vehicles seen): the candidate window. */
const IMAGE_BACKGROUND_WINDOW_SEC = IMAGE_CANDIDATE_WINDOW_SEC
/** The own squadron's battles its air habit is read from (opponentAir takes the latest 20 teams). */
const ALLY_AIR_WINDOW_SEC = 14 * 86_400
/** An own-squadron team counts for the habit with this many of its players (a team of 8, guests aside). */
const ALLY_MIN_ROWS = 6
/** How long a reply waits for the enemies' StatShark refreshes (~5 s each, one at a time) before it is updated. */
const STATSHARK_WAIT_MS = 3 * 60_000

/** StatShark refreshes for /scout pictures (src/index.ts wraps the lazy StatShark service). */
export interface ScoutStatSharkSource {
  /** Queues a refresh of the player's snapshot unless a fresh one exists; settles when it ends; null — nothing queued. */
  refresh(userId: string): Promise<void> | null
}

export interface ScoutImageReport {
  /** The enemy squadron (most recognised players' tag); null — not in the index. */
  squadron: ScoutSquadron | null
  /** The own team's squadron as read (left side). */
  allySquadron: ScoutSquadron | null
  prediction: KnownTeamPrediction
  recognised: number
  unread: string[]
  /**
   * Flags read above the enemy team (the chances use them when they fit:
   * prediction.flags), and the enemy rows with an icon, whose players show
   * none: not spawned yet or destroyed (row-icons.ts); null — the icon column
   * is not in the picture.
   */
  enemyFlags: { read: number; rowsWithout: number | null }
  /** Enemies with StatShark battles in their new-vehicle guesses; pending — refreshes queued, the reply is updated when they end. */
  statShark: { players: number; pending: boolean }
  vehicles: VehicleDict
  now: number
}

export type ScoutImageOutcome =
  /** update: the report again once the queued StatShark refreshes end (or their wait runs out); null — none queued. */
  | { kind: 'report'; report: ScoutImageReport; read: ScoreboardReadResult; update: Promise<ScoutImageReport> | null }
  | { kind: 'no-table' | 'no-players'; read: ScoreboardReadResult }
  | { kind: 'one-side'; read: ScoreboardReadResult; squadron: ScoutSquadron | null }

/** The squadron most matches stand under on the screenshot. */
function majoritySquadron(matches: readonly NickMatch[]): ScoutSquadron | null {
  const counts = new Map<string, number>()
  for (const match of matches) {
    if (match.squadron !== '') counts.set(match.squadron, (counts.get(match.squadron) ?? 0) + 1)
  }
  const core = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  return core === undefined ? null : squadronIndex().get(core) ?? null
}

const vehicleFlags = new WeakMap<VehicleDict, (vehicleId: string) => VehicleFlags | null>()

/** The flags the reader may see: the dictionary's nations and operators; null — every template (a dictionary built before operators were kept). */
function flagIconsOf(vehicles: VehicleDict): string[] | null {
  return Object.values(vehicles).some((info) => info.operator !== undefined) ? dictionaryFlagIcons(vehicles) : null
}

/**
 * The enemy rows as flag seats (flag-evidence.ts): the recognised players
 * (`enemies` order), then the rows nobody was recognised in. The game lists
 * flags in the order of user ids compared as text, which the rows follow while
 * scores tie: when the recognised rows stand in that order every row keeps its
 * place on screen, otherwise the unrecognised rows may stand anywhere.
 */
export function enemySeats(
  enemies: readonly { userId: string; row: number }[],
  unreadRows: readonly number[],
  icons: readonly (RowIcon | null)[] | null,
): FlagSeat[] {
  const byId = [...enemies].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
  const tied = byId.every((enemy, i) => i === 0 || byId[i - 1]!.row < enemy.row)
  const rank = new Map(byId.map((enemy, i) => [enemy, i]))
  const inVehicle = (row: number): number | null => (icons === null ? null : icons[row] ? IN_VEHICLE_WITH_ICON : IN_VEHICLE_WITHOUT_ICON)
  return [
    ...enemies.map((enemy) => ({ place: tied ? enemy.row : rank.get(enemy)!, inVehicle: inVehicle(enemy.row) })),
    ...unreadRows.map((row) => ({ place: tied ? row : null, inVehicle: inVehicle(row) })),
  ]
}

/** The own squadron's aircraft and helicopters per battle over its latest teams (its rows: getScoutTeamRows). */
export function allyAir(rows: readonly ScoutTeamRow[], vehicles: VehicleDict): number | null {
  const teams = new Map<string, { endTime: number; players: number; air: number }>()
  for (const row of rows) {
    const key = `${row.sessionId}:${row.team}`
    let team = teams.get(key)
    if (!team) teams.set(key, (team = { endTime: row.startTime + row.durationSec, players: 0, air: 0 }))
    team.players += 1
    const cls = row.vehicle ? vehicleInfo(vehicles, row.vehicle).cls : '?'
    if (cls === 'F' || cls === 'H') team.air += 1
  }
  return opponentAir([...teams.values()].filter((team) => team.players >= ALLY_MIN_ROWS))
}

/** A scoreboard screenshot to the enemy's likely vehicles; OCR and reads run in workers. */
export async function scoutFromImage(
  image: Uint8Array,
  nowSec = Math.floor(Date.now() / 1000),
  statShark: ScoutStatSharkSource | null = null,
): Promise<ScoutImageOutcome> {
  const dbPath = getDbWorkerPath()
  if (dbPath === null) throw new Error('/scout pictures need a file database')
  const buffer = image.slice().buffer
  const [templates, vehicles] = await Promise.all([ensureFlagTemplates('interactive'), ensureVehicleDict('interactive')])
  const read = await runWorkerTask(
    {
      kind: 'read-scoreboard-image',
      input: {
        dbPath,
        image: buffer,
        fromTs: nowSec - IMAGE_CANDIDATE_WINDOW_SEC,
        flags: templates,
        flagIcons: templates ? flagIconsOf(vehicles) : null,
      },
    },
    { priority: 'interactive', timeoutMs: 60_000, transferList: [buffer] },
  )
  if (read.status === 'no-table' || read.status === 'no-players') return { kind: read.status, read }
  if (read.status === 'one-side') return { kind: 'one-side', read, squadron: majoritySquadron(read.oneSide) }
  if (read.enemies.length === 0) return { kind: 'no-players', read }
  let flagsOf = vehicleFlags.get(vehicles)
  if (!flagsOf) vehicleFlags.set(vehicles, (flagsOf = dictionaryFlags(vehicles)))
  const enemyFlags = read.flags?.enemies ?? []
  const flags: FlagEvidence | undefined = enemyFlags.length > 0
    ? {
        flags: enemyFlags.map((flag) => flag.candidates.map(({ icon, likelihood }) => ({ icon, likelihood }))),
        seats: enemySeats(read.enemies, read.unreadRows, read.enemyIcons),
        flagsOf,
      }
    : undefined
  const enemyRows = [...read.enemies.map((match) => match.row), ...read.unreadRows]
  const allySquadron = majoritySquadron(read.allies)
  const info = (id: string) => {
    const vehicle = vehicleInfo(vehicles, id)
    return { nation: vehicle.country, cls: vehicle.cls }
  }
  // The players' rows (any cap) and StatShark battles are read again for the update.
  const build = async (): Promise<ScoutImageReport> => {
    const { rows, stages, capSpawns, statShark: shark, allyRows } = await runWorkerTask(
      {
        kind: 'read-scout-players',
        input: {
          dbPath,
          userIds: read.enemies.map((m) => m.userId),
          fromTs: nowSec - IMAGE_BACKGROUND_WINDOW_SEC,
          toTs: nowSec + 1,
          allyTags: allySquadron?.tags.slice(0, 8) ?? [],
          allyFromTs: nowSec - ALLY_AIR_WINDOW_SEC,
        },
      },
      { priority: 'interactive', timeoutMs: 20_000 },
    )
    const rowsOf = new Map<string, { vehicle: string | null; lineup: string[] }[]>()
    for (const row of rows) {
      const list = rowsOf.get(row.userId) ?? []
      list.push({ vehicle: row.vehicle, lineup: JSON.parse(row.vehicles) as string[] })
      rowsOf.set(row.userId, list)
    }
    const sharkOf = new Map(shark.map((entry) => [entry.userId, { battles: new Map(entry.vehicles), fresh: nowSec - entry.fetchedAt <= STATSHARK_FRESH_SEC }]))
    const prediction = predictKnownTeam({
      players: read.enemies.map((m) => ({ userId: m.userId, nick: displayedNick(m.nick) })),
      unknownPlayers: read.unread.length,
      battles: scoutBattlesFromRows(rows.filter((row) => row.startTime >= nowSec - IMAGE_HISTORY_WINDOW_SEC), 1),
      now: nowSec,
      stages,
      classOf: (id) => vehicleInfo(vehicles, id).cls,
      flags,
      capSpawns: new Map(capSpawns),
      backgrounds: new Map(read.enemies.map((m) => {
        const snapshot = sharkOf.get(m.userId)
        return [m.userId, playerBackground(rowsOf.get(m.userId) ?? [], info, snapshot?.battles ?? null, snapshot?.fresh ?? false)]
      })),
      nationOf: (id) => vehicleInfo(vehicles, id).country,
      opponentAir: allyAir(allyRows, vehicles),
    })
    return {
      squadron: majoritySquadron(read.enemies),
      allySquadron,
      prediction,
      recognised: read.enemies.length,
      unread: read.unread,
      enemyFlags: {
        read: enemyFlags.length,
        rowsWithout: read.enemyIcons && enemyRows.filter((row) => read.enemyIcons![row]).length,
      },
      statShark: { players: shark.length, pending: false },
      vehicles,
      now: nowSec,
    }
  }
  const first = await build()
  let update: Promise<ScoutImageReport> | null = null
  if (statShark) {
    // Players without battles at this BR first: their guess leans on StatShark most.
    const queued = [...first.prediction.players]
      .sort((a, b) => a.battlesAtCap - b.battlesAtCap)
      .map((player) => {
        try {
          return statShark.refresh(player.userId)
        } catch (error) {
          console.warn('[scout] StatShark refresh not queued:', error)
          return null
        }
      })
      .filter((refresh): refresh is Promise<void> => refresh !== null)
    if (queued.length > 0) {
      first.statShark.pending = true
      update = (async () => {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          Promise.allSettled(queued),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, STATSHARK_WAIT_MS)
            timer.unref()
          }),
        ])
        clearTimeout(timer)
        // Always the report again: the reply drops its "checking" line even when StatShark failed.
        return build()
      })()
      // Handled until the reply is sent and attaches its own: an unhandled rejection stops the bot (src/index.ts).
      void update.catch(() => undefined)
    }
  }
  return { kind: 'report', read, report: first, update }
}

let modelHash: string | null = null

/** A short hash of the model's constants: a saved record tells which fit answered it. */
export function scoutModelHash(): string {
  modelHash ??= createHash('sha256').update(JSON.stringify([
    VEHICLE_WEIGHTS, NEW_VEHICLE_WEIGHTS, NEW_VEHICLE_CANDIDATES, NEW_VEHICLES_KEPT, OPPONENT_AIR_WEIGHTS, OPPONENT_AIR_MEAN,
    OPPONENT_AIR_BATTLES, KNOWN_TEAM_SETUP_CALIBRATION, DEFAULT_CLASS_SHARES, STATSHARK_FRESH_SEC, IN_VEHICLE_WITH_ICON,
    IN_VEHICLE_WITHOUT_ICON, DEFAULT_OPERATOR_FLAGS_PRIOR, NATION_FLAG_SHARE,
  ])).digest('hex').slice(0, 12)
  return modelHash
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

/**
 * What a screenshot's reply predicted, kept in its record so `npm run
 * scout:outcomes` can score it against the battle once stored: per enemy the
 * three likeliest vehicles (new — not seen from them at this cap), the setup
 * and the flags reading the chances used.
 */
export function scoutPredictionRecord(report: ScoutImageReport): Record<string, unknown> {
  const { prediction } = report
  return {
    model: scoutModelHash(),
    maxBr: prediction.maxBr,
    lastTogether: prediction.lastTogether,
    flags: prediction.flags && { icons: prediction.flags.icons, operatorChance: round4(prediction.flags.operatorChance) },
    players: prediction.players.map((player) => ({
      userId: player.userId,
      battlesAtCap: player.battlesAtCap,
      options: [...player.vehicles, ...player.newVehicles]
        .sort((a, b) => b.chance - a.chance || a.vehicleId.localeCompare(b.vehicleId))
        .slice(0, 3)
        .map((vehicle) => ({ vehicleId: vehicle.vehicleId, chance: round4(vehicle.chance), new: player.newVehicles.includes(vehicle) })),
      unseenChance: round4(player.unseenChance),
    })),
    unread: report.unread.length,
    setup: {
      expected: Object.fromEntries(Object.entries(prediction.setup.expected).map(([cls, value]) => [cls, round4(value)])),
      compositions: prediction.setup.compositions.map((composition) => ({ counts: composition.counts, chance: round4(composition.chance) })),
      airChance: round4(prediction.setup.airChance),
    },
    statShark: report.statShark,
  }
}
