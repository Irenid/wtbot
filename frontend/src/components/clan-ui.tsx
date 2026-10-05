import { useEffect, useState, type CSSProperties } from 'react'
import type { ClanListEntry } from '../api'
import { t, tp } from '../i18n'
import { fmtDateTime, fmtInt } from '../lib/format'

/**
 * Season figures shared by the ranking (ClansPage.tsx) and a squadron's page (ClanPage.tsx): reward
 * tiers, the colour steps of figures above or below the norm, the 24 h change and places moved.
 */

/**
 * Season battles below which a win rate or K/D is noise (2–5 battles gave 100 %): such figures
 * stay grey; the server sorts them after the rest by the same number (MIN_RATE_BATTLES in
 * src/web/clan-ranking.ts).
 */
export const MIN_RATE_BATTLES = 50
/**
 * A 24 h change from these sizes up gets a stronger pill: on 2026-10-05 the top 100's |change|
 * had p75 342 and p90 732, so about the busiest quarter and tenth stand out.
 */
const CHANGE_STRONG = 250
const CHANGE_HUGE = 700

/**
 * Season reward tiers by place: places 1–3 have their own rewards, the rest share one per tier
 * (see the rewards on a squadron page). A line under a tier's last place closes it. The server
 * keeps the same list (CLAN_REWARD_TIER_PLACES in src/web/clan-ranking.ts).
 */
export const REWARD_TIERS = [
  { top: 5, from: 4 },
  { top: 10, from: 6 },
  { top: 20, from: 11 },
  { top: 50, from: 21 },
  { top: 100, from: 51 },
] as const

export type RewardTier = (typeof REWARD_TIERS)[number]
export type TierCutoff = { place: number; rating: number }

/** The tier a place falls in; undefined — places 1–3 or outside the top 100. */
export function rewardTierOf(rank: number): RewardTier | undefined {
  return REWARD_TIERS.find((tier) => rank >= tier.from && rank <= tier.top)
}

/**
 * The reward a squadron holds now, as classes that colour its place, bar and marks: its place
 * (1–3) or its tier; null — outside the top 100 or the leaderboard.
 */
export function rewardZone(rank: number, leaderboard: ClanListEntry['leaderboard']): string | null {
  // Only squadrons in the leaderboard compete for its rewards; the ranking puts them first.
  if (leaderboard !== 'current') return null
  if (rank <= 3) return `is-podium place-${rank}`
  const tier = rewardTierOf(rank)
  return tier === undefined ? null : `zone-${tier.top}`
}

/**
 * Colour class of a figure by its score, −1…1 (beyond — clamped): three steps of green above the
 * norm, of red below; '' for a plain one near it.
 */
export function toneClass(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return ''
  const level = Math.min(3, Math.floor(Math.abs(score) * 3))
  return level === 0 ? '' : ` tone-${score > 0 ? 'up' : 'down'}-${level}`
}

/** Win rate around 50 %: steps at 60, 70 and 80 % (40, 30, 20 % below). */
export function winRateScore(rate: number | null): number | null {
  return rate === null ? null : (rate - 0.5) / 0.3
}

/**
 * K/D on a log scale around 1, steps at 1.26, 1.59 and 2.0 (0.79, 0.63, 0.5 below): on 2026-10-05
 * the middle 80 % of squadrons sat between 0.78 and 1.29, so only the outer tenth on each side
 * gets colour.
 */
export function kdScore(kd: number | null): number | null {
  return kd === null || kd <= 0 ? null : Math.log2(kd)
}

type SeasonFigures = Pick<ClanListEntry, 'seasonBattles' | 'seasonWins' | 'airKills' | 'groundKills' | 'deaths'>

/** Season win rate from the official leaderboard; null — no data. */
export function seasonWinRate(clan: SeasonFigures): number | null {
  return clan.seasonBattles !== null && clan.seasonBattles > 0 && clan.seasonWins !== null
    ? clan.seasonWins / clan.seasonBattles
    : null
}

/** Season kills per death from the leaderboard: air and ground together. */
export function seasonKd(clan: SeasonFigures): number | null {
  if (clan.deaths === null || clan.deaths === 0) return null
  if (clan.airKills === null && clan.groundKills === null) return null
  return ((clan.airKills ?? 0) + (clan.groundKills ?? 0)) / clan.deaths
}

/** Tooltip parts joined; undefined — none. */
export function joinTitles(...parts: (string | null | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return present.length > 0 ? present.join(' · ') : undefined
}

/** A search query as a case-insensitive pattern; null — no query. */
export function searchPattern(query: string): RegExp | null {
  return query === '' ? null : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
}

/** A name with the first match of the search marked. */
export function Marked({ text, pattern }: { text: string; pattern: RegExp | null }) {
  const match = pattern?.exec(text) ?? null
  if (match === null) return <>{text}</>
  return (
    <>
      {text.slice(0, match.index)}
      <mark>{match[0]}</mark>
      {text.slice(match.index + match[0].length)}
    </>
  )
}

export function Triangle({ size = 7, down = false }: { size?: number; down?: boolean }) {
  return (
    <svg className={down ? 'is-down' : undefined} width={size} height={size} viewBox="0 0 8 8" aria-hidden="true">
      <path d="M4 1.2 7.4 6.6H.6z" fill="currentColor" />
    </svg>
  )
}

/** Places gained or lost over the day, next to the place. */
export function Move({ value }: { value: number | null }) {
  if (value === null || value === 0) return null
  const up = value > 0
  const size = Math.abs(value)
  return (
    <span className={`move ${up ? 'up' : 'down'}`} title={tp(up ? 'clans.move.up' : 'clans.move.down', size)}>
      <Triangle down={!up} />
      <span className="move__n">{fmtInt(size)}</span>
    </span>
  )
}

export type DayFigures = Pick<ClanListEntry, 'delta24h' | 'delta24hFrom' | 'delta24hTo' | 'battles24h' | 'wins24h' | 'leaderboard'>

/**
 * The 24 h rating change: a signed pill, stronger for a big move; 0 and "no data" stay quiet. The
 * tooltip names the window: below the top 100 only full crawls read a squadron, hours apart, so it
 * is a day give or take a few hours.
 */
export function Change({ clan, note = null }: { clan: DayFigures; note?: string | null }) {
  const value = clan.delta24h
  if (value === null) {
    // Dropped and PSR-rated rows explain themselves; for the rest the dash is missing history.
    return <span className="change none" title={clan.leaderboard === 'current' ? t('clans.change.none') : undefined}>—</span>
  }
  const title = joinTitles(
    note,
    clan.delta24hFrom !== null && clan.delta24hTo !== null
      ? t('clans.change.window', { from: fmtDateTime(clan.delta24hFrom), to: fmtDateTime(clan.delta24hTo) })
      : null,
    clan.battles24h !== null && clan.wins24h !== null
      ? t('clans.change.day', { battles: fmtInt(clan.battles24h), wins: fmtInt(clan.wins24h) })
      : null,
  )
  if (value === 0) return <span className="change flat" title={title}>0</span>
  const size = Math.abs(value)
  const level = size >= CHANGE_HUGE ? 3 : size >= CHANGE_STRONG ? 2 : 1
  return (
    <span className={`change ${value > 0 ? 'up' : 'down'} lvl-${level}`} title={title}>
      {value > 0 ? '+' : '−'}{fmtInt(size)}
    </span>
  )
}

/** A row's place in the entrance cascade: CSS staggers the row and its bar or tier line by it. */
export function cascade(index: number): CSSProperties {
  return { '--i': index } as CSSProperties
}

/** Height of the sticky top bar (App.tsx): a table head sticks right under it. */
export function useTopBarHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('.topnav')
    if (bar === null) return
    const update = (): void => setHeight(bar.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])
  return height
}
