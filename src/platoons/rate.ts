/**
 * Who the voice members are and how useful each is now (identify.ts,
 * strength.ts), from the database through `read`: worker task
 * `read-platoon-players` runs it on its own read-only connection, so the
 * Discord thread never waits on the reads (a regular is up to
 * PLATOON_MAX_PLAYER_ROWS rows).
 */
import { stageAt } from '../clan-season.js'
import { normalizePlayerSearchKey } from '../nick-search.js'
import { identify, type Identity, type NickAccount } from './identify.js'
import { likelyVehicle, playerStrength, type Stage, type StrengthRow } from './strength.js'

/** The rows a strength reads: a player's battles of this long (stored battles begin 2026-07-15). */
const HISTORY_SEC = 120 * 86_400

export interface RateInput {
  clanCore: string
  members: { userId: string; wtNick: string }[]
  now: number
  /** The squadron season's start: PSR snapshots from it. */
  seasonFrom: number
}

export interface RatedMember {
  userId: string
  identity: Identity
  strength: number
  battles: number
  capBattles: number
  /** The vehicle the player most likely takes at the cap; null — no battle there. */
  vehicle: string | null
}

export interface RateOutput {
  /** The max BR playing now; null — no stage known. */
  cap: number | null
  members: RatedMember[]
}

export interface RateReader {
  roster(clanCore: string): { nick: string }[]
  accounts(keys: readonly string[]): NickAccount[]
  rows(userIds: readonly string[], fromTs: number, toTs: number): (Omit<StrengthRow, 'lineup'> & { userId: string; lineup: string })[]
  stages(): Stage[]
  ratings(nicks: readonly string[], sinceTs: number): { nick: string; rating: number }[]
}

export function ratePlatoonPlayers(input: RateInput, read: RateReader): RateOutput {
  const { now } = input
  const roster = read.roster(input.clanCore)
  const keys = [...new Set([...input.members.map((member) => member.wtNick), ...roster.map((member) => member.nick)]
    .map(normalizePlayerSearchKey))]
  const accounts = new Map(read.accounts(keys).map((account) => [account.key, account]))
  const identities = input.members.map((member) => ({
    member,
    identity: identify(member.wtNick, input.clanCore, roster, accounts, now),
  }))
  const userIds = identities.flatMap(({ identity }) => (identity.wtUserId === null ? [] : [identity.wtUserId]))
  const rowsByUser = new Map<string, StrengthRow[]>()
  for (const row of read.rows(userIds, now - HISTORY_SEC, now + 1)) {
    const list = rowsByUser.get(row.userId) ?? []
    list.push({ ...row, lineup: parseLineup(row.lineup) })
    rowsByUser.set(row.userId, list)
  }
  const ratings = new Map(read.ratings(identities.map(({ identity }) => identity.rosterNick ?? identity.wtNick), input.seasonFrom)
    .map((item) => [item.nick, item.rating]))
  const stages = read.stages()
  const cap = stageAt(stages, now)?.maxBr ?? null
  return {
    cap,
    members: identities.map(({ member, identity }) => {
      const rows = identity.wtUserId === null ? [] : rowsByUser.get(identity.wtUserId) ?? []
      const psr = ratings.get(identity.rosterNick ?? identity.wtNick) ?? null
      const strength = playerStrength(rows, stages, cap, psr)
      return {
        userId: member.userId,
        identity,
        strength: strength.value,
        battles: strength.battles,
        capBattles: strength.capBattles,
        vehicle: likelyVehicle(rows, stages, cap, now)?.vehicleId ?? null,
      }
    }),
  }
}

function parseLineup(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
