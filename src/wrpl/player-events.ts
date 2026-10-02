import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult } from './replay.js'

/**
 * Per-player facts the results-BLK gets wrong or lacks, taken from the battle
 * events. One rule set for ingest (battle-transform.ts) and the repair pass of
 * stored battles (REPAIR_VERSION 2, db/maintenance.ts). Audit of 2026-10-02,
 * 42,332 battles (docs/replay-data-quality.md):
 *
 * - results list the lineup (matchingInfo crafts_info), not what was driven:
 *   46% of spawned players never drove the lineup's first vehicle;
 * - the game hands the slot of a squadron-battle player who did not load in
 *   to a bot (negative userId, `coop/Bot…`) and credits the bot's kills and
 *   score to the player's results row (kills match in 507 of 510 pairs); the
 *   bot's deaths stay on the bot's row;
 * - results `teamKills` is almost always 0 (57 rows, mostly drone kills),
 *   while the kill feed has ~8,200 teammate kills;
 * - a player who never loaded in may get team 0, while `squadId` still holds
 *   the team marker (58 rows, 56 of them played by a bot).
 */

export interface PlayerEventFacts {
  /** The results team; for team ≤ 0, the squad marker's team when known. */
  team: number
  /**
   * Vehicles of the player's slot in spawn order, from unit tracks, as
   * lineup ids (no `tankModels/`). Empty: no tracked spawn. null: the events
   * have no tracks at all (old or broken parse) — readers use the lineup.
   */
  playedVehicles: string[] | null
  /** The bot slot that played for this player; null: none or ambiguous. */
  botUserId: string | null
  /** Teammates destroyed per the kill feed, the bot slot's kills included. */
  teamKills: number
}

type FactsEvents = Pick<ReplayEvents, 'players' | 'units' | 'kills'>
type BotSlotEvents = Pick<ReplayEvents, 'units' | 'kills' | 'damage'>

/** results-BLK `squadId` is a team marker, not a squad: 4096 — team 1, 4097 — team 2. */
export function teamOfSquadMarker(squadId: number): number | null {
  return squadId === 4096 ? 1 : squadId === 4097 ? 2 : null
}

/** Unit model → lineup id: ground models carry a `tankModels/` prefix. */
export const vehicleIdOfModel = (model: string): string => model.replace(/^.*\//, '')

const isBotId = (userId: string): boolean => userId.startsWith('-')

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key)
  if (values) values.add(value)
  else map.set(key, new Set([value]))
}

export function derivePlayerEventFacts(
  players: readonly { userId: string; team: number; squadId: number }[],
  events: FactsEvents,
): Map<string, PlayerEventFacts> {
  const teamOf = new Map<string, number>()
  for (const slot of events.players) if (slot.team > 0) teamOf.set(slot.userId, slot.team)
  const resolvedTeams = new Map<string, number>()
  for (const player of players) {
    const team = player.team > 0 ? player.team : teamOfSquadMarker(player.squadId) ?? player.team
    resolvedTeams.set(player.userId, team)
    if (team > 0) teamOf.set(player.userId, team)
  }

  // A bot slot pairs with a player only when it is the team's only bot slot
  // and the player is the team's only one without an ECS slot: larger groups
  // (16 in the audit) cannot be told apart.
  const slotIds = new Set(events.players.map((slot) => slot.userId))
  const slotless = new Map<number, Set<string>>()
  for (const [userId, team] of resolvedTeams) {
    if (team > 0 && !isBotId(userId) && !slotIds.has(userId)) addTo(slotless, team, userId)
  }
  const botSlots = new Map<number, Set<string>>()
  for (const slot of events.players) if (slot.team > 0 && isBotId(slot.userId)) addTo(botSlots, slot.team, slot.userId)
  const botOf = new Map<string, string>()
  for (const [team, userIds] of slotless) {
    const bots = botSlots.get(team)
    if (userIds.size === 1 && bots?.size === 1) botOf.set([...userIds][0]!, [...bots][0]!)
  }
  const playerOfBot = new Map([...botOf].map(([userId, botId]) => [botId, userId]))

  const teamKills = new Map<string, number>()
  for (const kill of events.kills) {
    if (kill.killerId === '' || kill.killerId === kill.victimId) continue
    const team = teamOf.get(kill.killerId)
    if (team === undefined || teamOf.get(kill.victimId) !== team) continue
    const killer = playerOfBot.get(kill.killerId) ?? kill.killerId
    teamKills.set(killer, (teamKills.get(killer) ?? 0) + 1)
  }

  const spawns = new Map<string, { t: number; vehicle: string }[]>()
  for (const unit of events.units) {
    const first = unit.path[0]
    if (unit.userId === '' || !first) continue
    const list = spawns.get(unit.userId)
    const spawn = { t: first.t, vehicle: vehicleIdOfModel(unit.model) }
    if (list) list.push(spawn)
    else spawns.set(unit.userId, [spawn])
  }
  const playedBy = (userId: string): string[] | null => {
    if (events.units.length === 0) return null
    const list = [...(spawns.get(userId) ?? [])].sort((a, b) => a.t - b.t)
    return [...new Set(list.map((spawn) => spawn.vehicle))]
  }

  const facts = new Map<string, PlayerEventFacts>()
  for (const [userId, team] of resolvedTeams) {
    const botUserId = botOf.get(userId) ?? null
    facts.set(userId, {
      team,
      playedVehicles: playedBy(botUserId ?? userId),
      botUserId,
      teamKills: teamKills.get(userId) ?? 0,
    })
  }
  return facts
}

/** Ingest: the facts replace the results' team (≤ 0 only), teamKills and fill playedVehicles and botUserId. */
export function applyPlayerEventFacts(players: ReplayPlayerResult[], events: FactsEvents): void {
  const facts = derivePlayerEventFacts(players, events)
  for (const player of players) {
    const fact = facts.get(player.userId)
    if (!fact) continue
    player.team = fact.team
    player.teamKills = fact.teamKills
    player.playedVehicles = fact.playedVehicles ?? undefined
    player.botUserId = fact.botUserId
  }
}

/** Bot slot → the player it played for, from `botUserId` of the results rows. */
export function botSlotOwners(
  players: readonly { userId: string; botUserId?: string | null | undefined }[],
): Map<string, string> {
  return new Map(players.flatMap((player) => (player.botUserId ? [[player.botUserId, player.userId] as const] : [])))
}

/**
 * Tracks, kills and damage of paired bot slots under their players' userIds,
 * in place: the battle log, heatmaps and the scene credit the player, as the
 * results do. `events.players` (ECS slots) stays as recorded.
 */
export function creditBotSlots(events: BotSlotEvents, owners: ReadonlyMap<string, string>): void {
  if (owners.size === 0) return
  const owner = (userId: string): string => owners.get(userId) ?? userId
  for (const unit of events.units) unit.userId = owner(unit.userId)
  for (const kill of events.kills) {
    kill.killerId = owner(kill.killerId)
    kill.victimId = owner(kill.victimId)
  }
  for (const damage of events.damage) {
    damage.offenderId = owner(damage.offenderId)
    damage.victimId = owner(damage.victimId)
  }
}
