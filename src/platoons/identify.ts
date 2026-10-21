/**
 * Who a voice member is in War Thunder: the nick of their server name
 * («WTNick (Name)», voice-tracker.ts parseWtNick) found in the squadron's
 * roster (clan_roster, read from its claninfo page), as written or within the
 * player search's typo tolerance (src/nick-search.ts, a whole-nick match, one
 * roster nick only); else the account the nick last played under. A member
 * may play for the squadron; an account last seen in another squadron is a
 * guest, who cannot; a nick nobody knows is unknown and is placed after the
 * members (it may be a member under a nick the bot has not read yet).
 */
import { normalizePlayerSearchKey, prepareNickQuery, scoreNick, compareNickScores, type NickScore } from '../nick-search.js'
import { plainClanTag } from '../wrpl/render-battle.js'
import type { Standing } from './plan.js'

export interface RosterNick {
  nick: string
}

export interface NickAccount {
  key: string
  userId: string
  nick: string
  clanTag: string
  startTime: number
}

export interface Identity {
  /** The WT nick as the member's server name gives it. */
  wtNick: string
  standing: Standing
  /** The roster's spelling when found there. */
  rosterNick: string | null
  /** Found by the typo tolerance, not as written: the board says so. */
  guessed: boolean
  /** The account the nick last played under; null — no stored battle. */
  wtUserId: string | null
}

/** A member's last battle for another squadron within this long makes them a guest when the roster lacks them. */
export const GUEST_RECENT_SEC = 30 * 86_400

export function identify(
  wtNick: string,
  clanCore: string,
  roster: readonly RosterNick[],
  accounts: ReadonlyMap<string, NickAccount>,
  now: number,
): Identity {
  const key = normalizePlayerSearchKey(wtNick)
  const exact = roster.find((member) => normalizePlayerSearchKey(member.nick) === key)
  const close = exact ? null : closestRosterNick(wtNick, roster)
  const rosterNick = exact?.nick ?? close ?? null
  const account = accounts.get(rosterNick === null ? key : normalizePlayerSearchKey(rosterNick)) ?? null
  if (rosterNick !== null) {
    return { wtNick, standing: 'member', rosterNick, guessed: exact === undefined, wtUserId: account?.userId ?? null }
  }
  if (account === null) return { wtNick, standing: 'unknown', rosterNick: null, guessed: false, wtUserId: null }
  // Not on the roster (it may lag a new member by minutes): the last battle's squadron decides.
  const ours = plainClanTag(account.clanTag) === clanCore
  const recent = now - account.startTime <= GUEST_RECENT_SEC
  return {
    wtNick,
    standing: ours ? 'member' : recent ? 'guest' : 'unknown',
    rosterNick: null,
    guessed: false,
    wtUserId: account.userId,
  }
}

/** The one roster nick the typed nick matches whole within the search's tolerance; null when none or two tie. */
export function closestRosterNick(wtNick: string, roster: readonly RosterNick[]): string | null {
  if (wtNick.trim().length < 3) return null
  const query = prepareNickQuery(wtNick)
  let best: { nick: string; score: NickScore } | null = null
  let tied = false
  for (const member of roster) {
    const score = scoreNick(query, member.nick)
    if (score === null || score.kind !== 0) continue
    const order = best === null ? -1 : compareNickScores(score, best.score)
    if (order < 0) {
      best = { nick: member.nick, score }
      tied = false
    } else if (order === 0) {
      tied = true
    }
  }
  return best !== null && !tied ? best.nick : null
}
