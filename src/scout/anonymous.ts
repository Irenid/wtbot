/**
 * Who hides behind the game's anonymiser name on a screenshot. An anonymous
 * player shows as a first name and 1–4 digits ("Abraham5625"), new every
 * battle, the names from a list (544 seen by 2026-10-15; 98% of later fakes
 * reuse an earlier name); the Replay API item gives the real nick only after
 * the battle (battle_players.fake_name, DB v23). Squadrons tend to have one
 * anonymous regular, so a lone fake-name row of the enemy is the squadron's
 * only player who hid their nick in the last 6 h, else in the last 3 days.
 *
 * Backtest (2026-10-15, 1,737 teams with one anonymous player, battles
 * started in the 15 min before unknown, as at a screenshot): the guess fires
 * for 81% and is right in 97%; the 6 h window alone fires for 70%, right in
 * 99%. Only 15 of 968 stored real nicks shaped "Name1234" start with a name
 * from the list, so a new real player is rarely taken for an anonymous one.
 */

/** Windows tried in order: the first one holding any anonymous player decides. */
export const ANONYMOUS_WINDOWS_SEC = [6 * 3_600, 3 * 86_400] as const

const FAKE_NAME = /^(\p{Lu}\p{Ll}+)\d{1,4}$/u

/** The first name of an anonymiser name ("Abraham5625" → "Abraham"); null — not shaped like one. */
export function fakeFirstName(text: string): string | null {
  return FAKE_NAME.exec(text)?.[1] ?? null
}

/** The first names the game picks from, as stored fakes show them. */
export function fakeFirstNames(fakes: Iterable<string>): Set<string> {
  const names = new Set<string>()
  for (const fake of fakes) {
    const name = fakeFirstName(fake)
    if (name !== null) names.add(name)
  }
  return names
}

/** An unread row's text (its last word: a squadron tag may precede it) is an anonymiser name. */
export function looksAnonymous(text: string, names: ReadonlySet<string>): boolean {
  const word = text.trim().split(/\s+/u).at(-1) ?? ''
  const name = fakeFirstName(word)
  return name !== null && names.has(name)
}

export interface AnonymousCandidate {
  userId: string
  nick: string
  /** Start of their latest battle under a fake name (unix seconds). */
  lastSeen: number
}

export interface AnonymousGuess {
  /** Index into the unread rows. */
  index: number
  userId: string
  nick: string
}

/**
 * The player behind the one unread row shaped like an anonymiser name: the
 * only candidate of the first window holding any, players recognised on the
 * screenshot aside. null — no such row, two of them, or no single candidate.
 */
export function guessAnonymous(
  unread: readonly string[],
  names: ReadonlySet<string>,
  candidates: readonly AnonymousCandidate[],
  recognised: ReadonlySet<string>,
  nowSec: number,
): AnonymousGuess | null {
  const rows = unread.flatMap((text, index) => (looksAnonymous(text, names) ? [index] : []))
  if (rows.length !== 1) return null
  const pool = candidates.filter((candidate) => !recognised.has(candidate.userId))
  for (const window of ANONYMOUS_WINDOWS_SEC) {
    const inWindow = pool.filter((candidate) => candidate.lastSeen >= nowSec - window)
    if (inWindow.length === 0) continue
    if (inWindow.length > 1) return null
    return { index: rows[0]!, userId: inWindow[0]!.userId, nick: inWindow[0]!.nick }
  }
  return null
}
