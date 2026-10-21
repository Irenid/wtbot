/**
 * Who should play in which platoon: advice over the server's current voice
 * state (src/bot/platoons.ts runs it after every voice change, debounced).
 * The bot moves nobody and creates no room — the field commander decides,
 * the post suggests. A squadron-battle team is PLATOON_SIZE players (every
 * stored squadron battle is 8 v 8). Rooms are the voice channels beside the
 * lobby, made by the server's join-to-create hub or by hand, in the order
 * Discord lists them. A full room may be in a battle, so the advice never
 * splits one:
 * - a short room is filled from the idle players (the lobby's, and a room's
 *   players beyond eight), the strongest for the current BR first
 *   (strength.ts), then from a later short room: two short teams cannot
 *   play, one full can;
 * - the idle players left form new platoons, the strongest eight first, not
 *   the first eight to arrive;
 * - a full room is offered a swap when an idle player who would not play
 *   otherwise is SWAP_MIN_GAIN stronger than its weakest. Swaps between two
 *   full rooms are never offered: they move strength from one team to the
 *   other, and the squadron wins no more.
 * A self-deafened player in the lobby is away and not placed (in a room they
 * count); a squadron outsider (guest) is never placed; an unknown nick comes
 * after every member.
 */

/** Players of a squadron-battle team. */
export const PLATOON_SIZE = 8
/**
 * The least strength gain (strength.ts) a swap must bring to be offered: 0.77 of a player rating's
 * spread (sd 0.195), about 2.8 points of win chance in an even battle at the within-squadron slope
 * (0.74), so a swap is worth interrupting a platoon.
 */
export const SWAP_MIN_GAIN = 0.15

/** Placeable: a squadron member; unknown — the nick matched nobody (after members); guest — never placed. */
export type Standing = 'member' | 'unknown' | 'guest'

export interface Candidate {
  userId: string
  /** The room's channel ID; null — the lobby. */
  room: string | null
  /** Self-deafened: away when in the lobby. */
  deaf: boolean
  standing: Standing
  /** Logit units (strength.ts); higher is better. */
  strength: number
  /** In voice since, Unix s: the earlier comer wins a tie. */
  since: number
}

/** A player called somewhere: from the lobby (null) or from a room. */
export interface Call {
  userId: string
  from: string | null
}

export interface RoomPlan {
  roomId: string
  /** The room's players who should play, at most PLATOON_SIZE with `calls`. */
  lineup: string[]
  /** The room's players beyond eight who stay idle: the reserve. */
  reserve: string[]
  /** Called in to fill the room, strongest first. */
  calls: Call[]
  /** A stronger idle player for the room's weakest. */
  swap: (Call & { out: string }) | null
}

export interface PlanResult {
  rooms: RoomPlan[]
  /** New platoons of idle players, PLATOON_SIZE each, the stronger first. */
  platoons: Call[][]
  /** Idle players left, fewer than PLATOON_SIZE, the next to play first: the next platoon so far. */
  waiting: Call[]
}

/** Members before unknown nicks, stronger first, then the earlier comer. */
function byPriority(a: Candidate, b: Candidate): number {
  return Number(a.standing !== 'member') - Number(b.standing !== 'member')
    || b.strength - a.strength
    || a.since - b.since
    || a.userId.localeCompare(b.userId)
}

/** `roomIds` in the order Discord lists the rooms: the first ones are filled first. */
export function planPlatoons(roomIds: readonly string[], candidates: readonly Candidate[]): PlanResult {
  const byUser = new Map(candidates.map((candidate) => [candidate.userId, candidate]))
  const order = (a: string, b: string) => byPriority(byUser.get(a)!, byUser.get(b)!)
  const strength = (userId: string) => byUser.get(userId)!.strength
  const rooms: RoomPlan[] = roomIds.map((roomId) => {
    const players = candidates.filter((candidate) => candidate.room === roomId && candidate.standing !== 'guest')
      .sort(byPriority).map((candidate) => candidate.userId)
    return { roomId, lineup: players.slice(0, PLATOON_SIZE), reserve: players.slice(PLATOON_SIZE), calls: [], swap: null }
  })
  const idle: Call[] = [
    ...candidates.filter((candidate) => candidate.room === null && !candidate.deaf && candidate.standing !== 'guest')
      .map((candidate) => ({ userId: candidate.userId, from: null })),
    ...rooms.flatMap((room) => room.reserve.map((userId) => ({ userId, from: room.roomId }))),
  ].sort((a, b) => order(a.userId, b.userId))
  const take = (call: Call) => {
    const from = rooms.find((room) => room.roomId === call.from)
    if (from) from.reserve = from.reserve.filter((userId) => userId !== call.userId)
  }

  for (const [index, room] of rooms.entries()) {
    if (room.lineup.length === 0) continue
    while (room.lineup.length + room.calls.length < PLATOON_SIZE) {
      let call = idle.shift()
      if (call) {
        take(call)
      } else {
        // Idle players are gone, so a later room still short stays short: its strongest come here.
        const donors = rooms.slice(index + 1).filter((other) => other.lineup.length > 0 && other.lineup.length < PLATOON_SIZE)
        const best = donors.flatMap((other) => other.lineup.map((userId) => ({ userId, from: other.roomId })))
          .sort((a, b) => strength(b.userId) - strength(a.userId) || order(a.userId, b.userId))[0]
        if (!best) break
        const donor = donors.find((other) => other.roomId === best.from)!
        donor.lineup = donor.lineup.filter((userId) => userId !== best.userId)
        call = best
      }
      room.calls.push(call)
    }
  }

  const platoons: Call[][] = []
  while (idle.length >= PLATOON_SIZE) {
    const platoon = idle.splice(0, PLATOON_SIZE)
    platoon.forEach(take)
    platoons.push(platoon)
  }

  // The rest would not play: the strongest member among them for a full room's weakest.
  const free = idle.filter((call) => byUser.get(call.userId)!.standing === 'member')
  for (const room of rooms) {
    if (room.lineup.length === 0 || room.lineup.length + room.calls.length < PLATOON_SIZE) continue
    // The weakest by strength alone, the later comer on a tie: the swap's gain is a strength difference.
    const weakest = [...room.lineup].sort((a, b) => strength(a) - strength(b) || byUser.get(b)!.since - byUser.get(a)!.since)[0]!
    const best = free[0]
    if (!best || strength(best.userId) - strength(weakest) < SWAP_MIN_GAIN) continue
    free.shift()
    idle.splice(idle.indexOf(best), 1)
    take(best)
    room.swap = { ...best, out: weakest }
  }
  return { rooms, platoons, waiting: idle }
}
