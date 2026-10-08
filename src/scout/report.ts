/**
 * /scout data: squadron lookup by tag or name and the prediction for a
 * squadron's next battle (model.ts) from its stored battles. The history is
 * read in a worker task on its own read-only connection.
 */

import { getDbWorkerPath, getScoutSquadronTags, getScoutStages, getScoutTeamRows, type ScoutTeamRow } from '../db/index.js'
import { normalizePlayerSearchKey } from '../db/index.js'
import { runWorkerTask } from '../workers/pool.js'
import { ensureVehicleDict, vehicleInfo, type VehicleDict } from '../wrpl/vehicles.js'
import { dictionaryFlagIcons, dictionaryFlags, type FlagEvidence, type VehicleFlags } from './flag-evidence.js'
import { ensureFlagTemplates } from './flag-pack.js'
import { ROSTER_WINDOW_SEC, predictKnownTeam, predictScout, type KnownTeamPrediction, type ScoutBattle, type ScoutPrediction } from './model.js'
import { displayedNick, type NickMatch } from './nick-match.js'
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

export interface ScoutImageReport {
  /** The enemy squadron (most recognised players' tag); null — not in the index. */
  squadron: ScoutSquadron | null
  /** The own team's squadron as read (left side). */
  allySquadron: ScoutSquadron | null
  prediction: KnownTeamPrediction
  recognised: number
  unread: string[]
  /** Flags were read above the enemy team (the chances use them when they fit: prediction.flags). */
  enemyFlagsSeen: boolean
  vehicles: VehicleDict
  now: number
}

export type ScoutImageOutcome =
  | { kind: 'report'; report: ScoutImageReport; read: ScoreboardReadResult }
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

/** A scoreboard screenshot to the enemy's likely vehicles; OCR and reads run in workers. */
export async function scoutFromImage(image: Uint8Array, nowSec = Math.floor(Date.now() / 1000)): Promise<ScoutImageOutcome> {
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
  const { rows, stages } = await runWorkerTask(
    {
      kind: 'read-scout-players',
      input: { dbPath, userIds: read.enemies.map((m) => m.userId), fromTs: nowSec - IMAGE_HISTORY_WINDOW_SEC, toTs: nowSec + 1 },
    },
    { priority: 'interactive', timeoutMs: 20_000 },
  )
  let flagsOf = vehicleFlags.get(vehicles)
  if (!flagsOf) vehicleFlags.set(vehicles, (flagsOf = dictionaryFlags(vehicles)))
  const enemyFlags = read.flags?.enemies ?? []
  const flags: FlagEvidence | undefined = enemyFlags.length > 0
    ? { flags: enemyFlags.map((flag) => flag.candidates.map(({ icon, likelihood }) => ({ icon, likelihood }))), rows: read.rows, flagsOf }
    : undefined
  const prediction = predictKnownTeam({
    players: read.enemies.map((m) => ({ userId: m.userId, nick: displayedNick(m.nick) })),
    unknownPlayers: read.unread.length,
    battles: scoutBattlesFromRows(rows, 1),
    now: nowSec,
    stages,
    classOf: (id) => vehicleInfo(vehicles, id).cls,
    flags,
  })
  return {
    kind: 'report',
    read,
    report: {
      squadron: majoritySquadron(read.enemies),
      allySquadron: majoritySquadron(read.allies),
      prediction,
      recognised: read.enemies.length,
      unread: read.unread,
      enemyFlagsSeen: enemyFlags.length > 0,
      vehicles,
      now: nowSec,
    },
  }
}
