import { teamOfSquadMarker } from './player-events.js'

/**
 * The game sometimes records no squadron tag for a player: the results-BLK
 * and the ECS slot are both empty, for a whole login session. 6,207 of
 * 795,063 player rows (0.8%) of 216 players, 2026-10-08; 98.7% of them have
 * PSR readings under their team's tag (docs/replay-data-quality.md). A
 * squadron battle's team is one squadron, so such a player gets the team's
 * tag. One rule for ingest (battle-transform.ts), the results-only render of
 * a battle not stored yet and migration v21 of the stored rows.
 */
export interface SquadronTagPlayer {
  userId: string
  /** Filled in place. */
  clanTag: string
  team: number
  squadId: number
}

/**
 * Fills the empty tags of a team's real players when every one of them
 * carries the team's squadron-battle marker (`teamOfSquadMarker`; a random
 * battle's team is platoons and solo players) and its tags name one squadron.
 * Bots (negative userId) and team ≤ 0 stay as recorded.
 */
export function fillSquadronTags(players: readonly SquadronTagPlayer[]): void {
  const teams = new Map<number, SquadronTagPlayer[]>()
  for (const player of players) {
    if (player.team <= 0 || player.userId.startsWith('-')) continue
    const members = teams.get(player.team)
    if (members) members.push(player)
    else teams.set(player.team, [player])
  }
  for (const [team, members] of teams) {
    if (!members.every((player) => teamOfSquadMarker(player.squadId) === team)) continue
    const tag = teamTag(members)
    if (tag === null) continue
    for (const player of members) if (player.clanTag === '') player.clanTag = tag
  }
}

const tagCore = (tag: string): string => tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

/**
 * The most frequent tag, a tie going to the smaller string: any row order
 * gives the same tag. null — no tags, or two squadrons. Decorations of one
 * squadron differ by login (`=5XC=` beside `┺5XC┻`).
 */
function teamTag(members: readonly SquadronTagPlayer[]): string | null {
  const counts = new Map<string, number>()
  for (const { clanTag } of members) if (clanTag !== '') counts.set(clanTag, (counts.get(clanTag) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [tag, count] of counts) {
    if (best === null) {
      best = tag
      bestCount = count
      continue
    }
    if (tagCore(tag) !== tagCore(best)) return null
    if (count > bestCount || (count === bestCount && tag < best)) {
      best = tag
      bestCount = count
    }
  }
  return best
}
