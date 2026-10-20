import type { BattleListEntry } from '../api'

/**
 * "Show more" on the battle list. The API's `to` is exclusive and several
 * battles can start in the same second, so the next page starts one second
 * after the oldest shown battle and mergeBattlePage drops the repeats.
 */
export function nextBattlesBound(shown: readonly Pick<BattleListEntry, 'startTime'>[]): number | null {
  const oldest = shown.at(-1)
  return oldest === undefined ? null : oldest.startTime + 1
}

/** The shown battles followed by the page's new ones, in the page's order. */
export function mergeBattlePage<T extends Pick<BattleListEntry, 'sessionId'>>(shown: readonly T[], page: readonly T[]): T[] {
  const known = new Set(shown.map((battle) => battle.sessionId))
  return [...shown, ...page.filter((battle) => !known.has(battle.sessionId))]
}
