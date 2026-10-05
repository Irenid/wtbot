/**
 * Season reward tiers by place: places 1–3 have their own rewards, the rest share one per tier
 * (see the rewards on a squadron page). The server keeps the same list (CLAN_REWARD_TIER_PLACES in
 * src/web/clan-ranking.ts); theme.css colours each tier with --zone-<top>.
 */
export const REWARD_TIERS = [
  { top: 5, from: 4 },
  { top: 10, from: 6 },
  { top: 20, from: 11 },
  { top: 50, from: 21 },
  { top: 100, from: 51 },
] as const

export type RewardTier = (typeof REWARD_TIERS)[number]

/** The rating at a tier's last place (/api/clans `tierCutoffs`): what it takes to enter the tier. */
export interface TierCutoff {
  place: number
  rating: number
}
