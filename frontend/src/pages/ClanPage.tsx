import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  fetchClan,
  fetchClanHistory,
  SiteApiError,
  type ClanDetail,
  type ClanHistoryPoint,
  type ClanNeighbor,
  type ClanProfile,
  type ClanRecords,
  type ClanRequirements,
} from '../api'
import {
  battleVersusLabel,
  clanRewardLabel,
  clanRoleLabel,
  difficultyShortLabel,
  fmtAge,
  fmtDate,
  fmtDateTime,
  fmtHours,
  fmtInt,
  fmtPercent,
  fmtRatio,
  fmtRecentTime,
  romanRank,
  unitTypeLabel,
} from '../lib/format'
import { DeltaPill, DonutKpi, ErrorNotice, Kpi, Loading, ResultBadge, SecHead, SegControl, StarIcon, useRowLink } from '../components/ui'
import {
  Change,
  cascade,
  joinTitles,
  kdScore,
  Marked,
  MIN_RATE_BATTLES,
  Move,
  rewardTierOf,
  rewardZone,
  searchPattern,
  seasonKd,
  seasonWinRate,
  toneClass,
  Triangle,
  useTopBarHeight,
  winRateScore,
} from '../components/clan-ui'
import { MAX_FAVORITE_CLANS, toggleFavoriteClan, useFavoriteClans } from '../lib/favorite-clans'
import { holdWinRate, PSR_K, SQUADRON_REST_SHARE, SQUADRON_TOP } from '../lib/psr'
import { seasonHeading, seasonLine } from '../components/SeasonPanel'
import { TimeChart } from '../components/TimeChart'
import { localeTag, t, tp, useLocale } from '../i18n'

type Clan = ClanDetail['clan']
type Member = ClanDetail['roster'][number]
type Period = '7' | '30' | '90'

const DAY_SEC = 86_400
/**
 * The highest activity a squadron page shows: on 2026-10-05, 2,414 of the 31,759 stored members
 * with a value sat exactly at it, none above.
 */
const ACTIVITY_MAX = 3_960
/** Members' activity median and upper quartile over every stored roster (2026-10-05): its green steps. */
const ACTIVITY_MEDIAN = 1_621
const ACTIVITY_HIGH = 3_111
/**
 * A member's last PSR change from these sizes up gets a stronger pill: one battle moves PSR by at
 * most PSR_K, and on 2026-10-05 the last changes had p90 62 and p95 64.
 */
const MEMBER_CHANGE_STRONG = PSR_K
const MEMBER_CHANGE_HUGE = 2 * PSR_K
/** Members who joined within this many days get a "new" badge. */
const NEW_MEMBER_DAYS = 30
/** Roles by seniority, as the squadron page names them; Private, the default, gets no badge or filter. */
const ROLES = ['Commander', 'Deputy', 'Officer', 'Sergeant'] as const
/**
 * The roster opens with the members whose PSR counts in full; a few more rows than that are shown
 * at once rather than behind a button.
 */
const ROSTER_PREVIEW = SQUADRON_TOP
const ROSTER_PREVIEW_SLACK = 5
const ROSTER_COLUMNS = 6
/** The daily battles chart's span, days. */
const DAILY_DAYS = 30
/** The rating chart's height, px: level with the daily bars and their legend beside it. */
const RATING_CHART_HEIGHT = 262
/** The URL's limit for the roster search, as on /clans. */
const MAX_QUERY_LENGTH = 64
/** One URL update per pause in typing: the rows follow the field at once. */
const SEARCH_DELAY_MS = 300

/** Season title of a reward ("place3@historical"); the mode is named only when it is not RB squadron battles. */
function rewardText(code: string): string | null {
  const [title = '', mode] = code.split('@')
  const label = clanRewardLabel(title)
  if (label === null) return null
  return mode === undefined || mode === 'historical' ? label : `${label} · ${difficultyShortLabel(mode)}`
}

/** A reward's colour class: places 1–3 in their metal, the tiers in the ranking's zone colours. */
function rewardClass(code: string): string {
  const [title = ''] = code.split('@')
  const place = /^place([1-3])$/.exec(title)
  if (place) return ` is-podium place-${place[1]}`
  const top = /^top(\d{1,3})$/.exec(title)
  return top !== null && rewardTierOf(Number(top[1]))?.top === Number(top[1]) ? ` zone-${top[1]}` : ''
}

function requirementLines(requirements: ClanRequirements): string[] {
  const lines: string[] = []
  const ranks = requirements.ranks
  if (ranks !== null && ranks.items.length > 0) {
    const list = ranks.items
      .map((item) => {
        const text = t('clan.req.rankItem', { unit: unitTypeLabel(item.unitType), rank: romanRank(item.rank) })
        return item.count > 1 ? `${text} ×${fmtInt(item.count)}` : text
      })
      .join(` ${t(ranks.mode === 'and' ? 'clan.req.and' : 'clan.req.or')} `)
    lines.push(t('clan.req.ranks', { list }))
  }
  for (const battle of requirements.battles) {
    lines.push(t('clan.req.battles', { n: fmtInt(battle.count), mode: difficultyShortLabel(battle.difficulty) }))
  }
  return lines
}

/** Applications; an unknown status is not interpreted. */
function applicationsText(profile: ClanProfile): string | null {
  if (profile.status === 'closed') return t('clan.about.applications.closed')
  if (profile.status !== 'open') return null
  if (profile.autoAccept === true) return t('clan.about.applications.auto')
  if (profile.autoAccept === false) return t('clan.about.applications.manual')
  return t('clan.about.applications.open')
}

/** A roster member's profile: by WT user id or identity when the bot knows one, else by nick. */
function memberPath(member: Member): string {
  if (member.wtUserId) return `/players/${member.wtUserId}`
  if (member.identityId !== null) return `/players/id/${member.identityId}`
  return `/players/nick/${encodeURIComponent(member.nick)}`
}

/**
 * A member's PSR in the colour of the win rate it takes to hold it (holdWinRate on the win-rate
 * scale): green from ≈1570 (60 % wins), brighter from ≈1647 (70 %) and ≈1741 (80 %) — about the top
 * 10, 5 and 2.5 % of members with PSR this season (2026-10-05). PSR starts at 0 every season, so a
 * low one is no fault and gets no red.
 */
function psrTone(psr: number): string {
  const score = winRateScore(holdWinRate(psr))
  return score !== null && score > 0 ? toneClass(score) : ''
}

/** Activity in green from the members' median up, brightest at the maximum; none is muted. */
function activityTone(activity: number): string {
  if (activity <= 0) return ' is-idle'
  if (activity >= ACTIVITY_MAX) return ' tone-up-3'
  if (activity >= ACTIVITY_HIGH) return ' tone-up-2'
  if (activity >= ACTIVITY_MEDIAN) return ' tone-up-1'
  return ''
}

function isNewMember(member: Member, nowSec: number): boolean {
  return member.joinedAt !== null && nowSec - member.joinedAt < NEW_MEMBER_DAYS * DAY_SEC
}

/** A nick as search compares it: NFKC, locale-neutral lowercase (as the server's nick search). */
function searchKey(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** Adds the squadron to the viewer's favourites, the filter of the /clans table. */
function FavoriteChip({ coreTag }: { coreTag: string }) {
  const favorites = useFavoriteClans()
  const on = favorites.includes(coreTag)
  const full = !on && favorites.length >= MAX_FAVORITE_CLANS
  return (
    <button
      type="button"
      className={`chip fav-chip${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-disabled={full}
      title={on ? t('clans.favorite.remove') : full ? t('clans.favorite.full', { n: MAX_FAVORITE_CLANS }) : undefined}
      onClick={() => toggleFavoriteClan(coreTag)}
    >
      <StarIcon filled={on} size={12} />
      {t(on ? 'clans.favorite.on' : 'clans.favorite.add')}
    </button>
  )
}

/** The reward the place holds at the season's end, in the place's colour: places 1–3 their own, the rest a tier's. */
function RewardBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <span className="reward-badge" title={t('clan.hero.podium', { n: rank })}>
        <Triangle size={8} />
        {t('clan.reward.place', { n: rank })}
      </span>
    )
  }
  const tier = rewardTierOf(rank)
  if (tier === undefined) return null
  const reward = t('clan.reward.top', { n: tier.top })
  return (
    <span className="reward-badge" title={t('clans.tier.title', { from: tier.from, to: tier.top, reward })}>
      <Triangle size={8} />
      {reward}
    </span>
  )
}

/** One end of the standing track: the neighbour's place and tag, and the gap to it. */
function StandingEnd({ neighbor, gap, side }: { neighbor: ClanNeighbor | null; gap: number | null; side: 'above' | 'below' }) {
  if (neighbor === null || gap === null) {
    return side === 'above'
      ? <div className="standing__end is-above is-first">{t('clan.standing.first')}</div>
      : <div className="standing__end is-below" />
  }
  const zone = rewardZone(neighbor.rank, 'current')
  return (
    <div className={`standing__end is-${side}${zone ? ` ${zone}` : ''}`}>
      <Link to={`/clans/${neighbor.coreTag}`} className="standing__who">
        <span className="standing__rank">#{fmtInt(neighbor.rank)}</span>
        <span className="standing__tag">{neighbor.displayTag}</span>
      </Link>
      <span className="standing__gap">
        {t(side === 'above' ? 'clan.standing.gap' : 'clan.standing.lead', { n: fmtInt(gap) })}
      </span>
    </div>
  )
}

/**
 * The squadron between its neighbours in the table: the marker sits at its rating on the way from
 * the place below to the place above (the leader's at the right end). Under it, the next reward tier
 * past the place above, as the /clans rating tooltip names it.
 */
function Standing({ clan, ranking }: { clan: Clan; ranking: ClanDetail['ranking'] }) {
  const { above, below } = ranking
  if (above === null && below === null) return null
  const toGo = above === null ? null : Math.max(0, above.rating - clan.totalRating)
  const lead = below === null ? null : Math.max(0, clan.totalRating - below.rating)
  const position = toGo === null ? 1 : lead === null ? 0 : lead + toGo > 0 ? lead / (lead + toGo) : 0.5
  const tier = ranking.tierCutoffs.filter((cutoff) => cutoff.place < clan.rank - 1).at(-1)
  return (
    <div className="standing" role="group" aria-label={t('clan.standing.label')} style={{ '--pos': position.toFixed(4) } as CSSProperties}>
      <StandingEnd neighbor={below} gap={lead} side="below" />
      <div className="standing__track" aria-hidden="true">
        <span className="standing__lead" />
        <span className="standing__marker" />
      </div>
      <StandingEnd neighbor={above} gap={toGo} side="above" />
      {tier !== undefined && (
        <div className={`standing__tier zone-${tier.place}`}>
          <Triangle size={8} />
          {t('clan.standing.tier', {
            top: tier.place,
            rating: fmtInt(tier.rating),
            n: fmtInt(Math.max(0, tier.rating - clan.totalRating)),
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Who the squadron is and where it stands: its place in the colour of the reward it holds (the
 * ranking's zones), the rating with its 24 h change and places moved, the gaps to its neighbours.
 */
function ClanHero({ detail }: { detail: ClanDetail }) {
  const { clan, ranking } = detail
  const zone = rewardZone(clan.rank, clan.leaderboard)
  const estimate = clan.leaderboard === null
  const dropped = clan.leaderboard === 'dropped'
  const gainRecord = ranking.records.gain === clan.coreTag
  const showName = clan.name !== null && clan.name.toLowerCase() !== clan.displayTag.toLowerCase()
  const classes = ['card', 'clan-hero', zone, estimate ? 'is-estimate' : null, dropped ? 'is-dropped' : null]
    .filter(Boolean)
    .join(' ')
  return (
    <header className={classes}>
      <div className="clan-hero__main">
        <div
          className="clan-medal"
          role="img"
          aria-label={t('clan.hero.place', { n: fmtInt(clan.rank), total: fmtInt(ranking.total) })}
          title={t('clan.hero.place', { n: fmtInt(clan.rank), total: fmtInt(ranking.total) })}
          style={{ '--len': fmtInt(clan.rank).length } as CSSProperties}
        >
          <span className="clan-medal__hash" aria-hidden="true">#</span>
          <span className="clan-medal__n" aria-hidden="true">{fmtInt(clan.rank)}</span>
        </div>
        <div className="clan-hero__who">
          <h1>
            <span className="clan-hero__tag">{clan.displayTag}</span>
            {showName && <span className="clan-hero__name">{clan.name}</span>}
          </h1>
          <div className="clan-hero__chips">
            {clan.leaderboard === 'current' && <RewardBadge rank={clan.rank} />}
            {ranking.live !== null && clan.recentBattles > 0 && (
              <span
                className="clan-chip is-live is-on is-static"
                title={tp('clans.live.title', clan.recentBattles, { min: Math.round(ranking.live.windowSec / 60) })}
              >
                <span className="clan-chip__pulse" aria-hidden="true" />
                {t('clans.filter.live')}
              </span>
            )}
            {dropped && <span className="chip" title={t('clans.dropped.title', { time: fmtDateTime(clan.lastSeenAt) })}>{t('clan.hero.dropped')}</span>}
            {estimate && <span className="chip" title={t('clans.psr.title')}>{t('clan.hero.estimate')}</span>}
            <span className="chip">{tp('common.members', clan.members)}</span>
            <FavoriteChip coreTag={clan.coreTag} />
          </div>
        </div>
        <div className="clan-hero__score">
          <div className="clan-hero__rating">
            <span className="clan-hero__value">{estimate ? '≈ ' : ''}{fmtInt(clan.totalRating)}</span>
            {clan.delta24h !== null && clan.delta24h !== 0 && (
              <span className={gainRecord ? 'has-record' : undefined}>
                <Change clan={clan} note={gainRecord ? t('clans.record.gain') : null} />
              </span>
            )}
          </div>
          <div className="clan-hero__label">
            {t(clan.official ? 'clan.officialRating' : 'metric.pkr.sum')}
            <Move value={clan.rankChange24h} />
          </div>
        </div>
      </div>
      {clan.leaderboard === 'current' && <Standing clan={clan} ranking={ranking} />}
    </header>
  )
}

/** A KPI that holds a season record: gold, with the record named on hover. */
function RecordMark({ title }: { title: string }) {
  return (
    <span className="kpi-record" title={title}>
      <StarIcon filled size={11} />
      {t('clan.record')}
    </span>
  )
}

/** Win rate and K/D toned as on /clans; fewer than MIN_RATE_BATTLES battles stay grey. */
function rateTone(score: number | null, battles: number): string {
  return battles >= MIN_RATE_BATTLES ? toneClass(score) : ' is-few'
}

/**
 * The season from the game's leaderboard (not from the bot's replays): figures toned against the
 * norm as in the ranking, gold where the squadron holds the season's record.
 */
function SeasonCard({ detail }: { detail: ClanDetail }) {
  const { clan, ranking } = detail
  if (!clan.official || clan.seasonBattles === null) return null
  const battles = clan.seasonBattles
  const winRate = seasonWinRate(clan)
  const kd = seasonKd(clan)
  const losses = clan.seasonWins === null ? null : battles - clan.seasonWins
  const holds = (key: keyof ClanRecords): boolean => ranking.records[key] === clan.coreTag
  const few = battles < MIN_RATE_BATTLES ? t('clans.rate.few', { n: MIN_RATE_BATTLES }) : null
  const line = seasonLine(detail.season)
  return (
    <section className="card clan-season">
      <div className="clan-card__head">
        <SecHead title={seasonHeading(detail.season, detail.officialSeason)} hint={t('clan.official.hint')} />
        {line !== null && <div className="clan-card__meta">{line}</div>}
      </div>
      <div className="kpis clan-kpis">
        <Kpi
          label={t('metric.battles')}
          value={fmtInt(battles)}
          className={holds('battles') ? 'has-record' : undefined}
          sub={clan.battles24h !== null && clan.battles24h > 0
            ? <span className="kpi-day">{t('clans.battles.day', { n: fmtInt(clan.battles24h) })}</span>
            : undefined}
        >
          {holds('battles') && <RecordMark title={t('clans.record.battles')} />}
        </Kpi>
        <DonutKpi
          label={t('metric.winrate')}
          fraction={winRate}
          text={fmtPercent(winRate)}
          className={`${rateTone(winRateScore(winRate), battles)}${winRate !== null && winRate < 0.5 ? ' is-losing' : ''}${holds('winRate') ? ' has-record' : ''}`}
          title={joinTitles(holds('winRate') ? t('clans.record.winRate', { n: MIN_RATE_BATTLES }) : null, few)}
          sub={<>
            <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(clan.seasonWins)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
            <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
          </>}
        >
          {holds('winRate') && <RecordMark title={t('clans.record.winRate', { n: MIN_RATE_BATTLES })} />}
        </DonutKpi>
        <Kpi
          label={t('metric.kd')}
          value={fmtRatio(kd)}
          className={`${rateTone(kdScore(kd), battles)}${holds('kd') ? ' has-record' : ''}`}
          title={joinTitles(holds('kd') ? t('clans.record.kd', { n: MIN_RATE_BATTLES }) : null, few)}
          sub={`${fmtInt(clan.airKills)} ${t('metric.killsAir')} · ${fmtInt(clan.groundKills)} ${t('metric.killsGround')} · ${t('metric.deaths.count', { n: fmtInt(clan.deaths) })}`}
        >
          {holds('kd') && <RecordMark title={t('clans.record.kd', { n: MIN_RATE_BATTLES })} />}
        </Kpi>
        <Kpi label={t('clan.official.flightTime')} value={fmtHours(clan.flightTimeMin === null ? null : clan.flightTimeMin * 60)} />
        <Kpi label={t('clan.official.activity')} value={fmtInt(clan.activity)} />
      </div>
    </section>
  )
}

/** The rating over the season's last 90 days: the official one, or the members' PSR sum. */
function RatingChartCard({ clan, history, truncated, error }: {
  clan: Clan
  history: ClanHistoryPoint[] | null
  truncated: boolean
  error: unknown
}) {
  const { locale } = useLocale()
  // A new array would rebuild the chart: one per history and language.
  const chart = useMemo(() => history === null ? null : {
    xs: history.map((point) => point.t),
    series: [{
      label: t('clan.dynamics.series'),
      color: '#f5bc4a',
      area: { top: 'rgba(245, 188, 74, 0.22)', bottom: 'rgba(245, 188, 74, 0)' },
      values: history.map((point) => point.total),
      stepped: true,
    }],
  }, [history, locale])
  const hint = `${t(clan.official ? 'clan.dynamics.hint.official' : 'clan.dynamics.hint')}${truncated ? ` · ${t('clan.dynamics.truncated')}` : ''}`
  let body: ReactNode
  if (error !== null) body = <ErrorNotice error={error} />
  else if (chart === null) body = <div className="clan-chart__wait"><Loading /></div>
  else if (chart.xs.length < 2) body = <div className="clan-chart__wait muted small">{t('common.chart.noData')}</div>
  else body = <TimeChart xs={chart.xs} series={chart.series} height={RATING_CHART_HEIGHT} />
  return (
    <section className="card clan-chart">
      <SecHead title={t('clan.dynamics')} hint={hint}>
        {clan.delta30d !== null && clan.delta30d !== 0 && (
          <span className="clan-chart__month" title={t(clan.official ? 'clan.deltaTooltip.official' : 'clan.deltaTooltip')}>
            {t('clan.dynamics.month')} <DeltaPill value={clan.delta30d} />
          </span>
        )}
      </SecHead>
      {body}
    </section>
  )
}

interface BattleDay {
  /** UTC midnight, Unix seconds. */
  day: number
  battles: number
  wins: number
  /** The latest reading's day: counted up to it. */
  partial: boolean
}

/**
 * Season battles and wins per UTC day from the official readings: the change between the last
 * readings before two midnights, the last day's up to the latest reading. Squadron battle windows
 * close before midnight UTC, so no window is split; below the top 100 a reading may be hours old,
 * and battles after it count to the next day. The first reading's own day has no reading before it
 * and is left out.
 */
function battleDays(points: readonly ClanHistoryPoint[], limit: number): BattleDay[] {
  const readings = points.flatMap((point) =>
    typeof point.battles === 'number' && typeof point.wins === 'number' ? [{ t: point.t, battles: point.battles, wins: point.wins }] : [])
  const first = readings[0]
  const last = readings[readings.length - 1]
  if (first === undefined || last === undefined || readings.length < 2) return []
  let index = 0
  /** The last reading at or before a moment; moments only grow. */
  const readingAt = (moment: number) => {
    while (index + 1 < readings.length && readings[index + 1]!.t <= moment) index += 1
    return readings[index]!
  }
  const days: BattleDay[] = []
  let start = readingAt(Math.floor(first.t / DAY_SEC) * DAY_SEC + DAY_SEC)
  for (let day = Math.floor(first.t / DAY_SEC) * DAY_SEC + DAY_SEC; day <= last.t; day += DAY_SEC) {
    const partial = day + DAY_SEC > last.t
    const end = partial ? last : readingAt(day + DAY_SEC)
    days.push({ day, battles: Math.max(0, end.battles - start.battles), wins: Math.max(0, end.wins - start.wins), partial })
    start = end
  }
  return days.slice(-limit)
}

/** "Oct 4" in UTC. */
function utcDay(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** "07:33 UTC". */
function utcTime(timestamp: number): string {
  const time = new Date(timestamp * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
  return `${time} UTC`
}

/**
 * Battles per day, each bar split into wins and losses; the busiest day is marked. It replaces a
 * chart of the season's running totals, two near-flat lines.
 */
function DailyBattlesCard({ days, until }: { days: BattleDay[] | null; until: number | null }) {
  if (days === null) {
    return (
      <section className="card clan-daily">
        <SecHead title={t('clan.daily')} hint={t('clan.daily.hint')} />
        <div className="clan-chart__wait"><Loading /></div>
      </section>
    )
  }
  if (days.length === 0) return null
  const max = Math.max(1, ...days.map((day) => day.battles))
  const peak = days.reduce((best, day) => (day.battles > best.battles ? day : best))
  // Day numbers under every day, every second or every third, counted back from the last one.
  const labelStep = days.length > 20 ? 3 : days.length > 10 ? 2 : 1
  const range = `${utcDay(days[0]!.day)} – ${utcDay(days[days.length - 1]!.day)}`
  const none = days.every((day) => day.battles === 0)
  return (
    <section className="card clan-daily">
      <SecHead title={t('clan.daily')} hint={t('clan.daily.hint')} />
      <ol className={`daily-bars${none ? ' is-none' : ''}`} style={{ '--n': days.length } as CSSProperties} aria-label={t('clan.daily')}>
        {days.map((day, index) => {
          const when = day.partial && until !== null ? `${utcDay(day.day)}, ${t('clan.daily.until', { time: utcTime(until) })}` : utcDay(day.day)
          const label = `${when}: ${t('clans.change.day', { battles: fmtInt(day.battles), wins: fmtInt(day.wins) })}`
          const isPeak = day.battles > 0 && day === peak
          return (
            <li
              key={day.day}
              className={`daily-bars__day${isPeak ? ' is-peak' : ''}${day.partial ? ' is-partial' : ''}${day.battles === 0 ? ' is-empty' : ''}${(days.length - 1 - index) % labelStep === 0 ? ' is-labelled' : ''}`}
              style={{
                '--h': (day.battles / max).toFixed(4),
                '--w': day.battles > 0 ? (day.wins / day.battles).toFixed(4) : '0',
                '--i': index,
              } as CSSProperties}
              title={label}
              aria-label={label}
            >
              <span className="daily-bars__slot" aria-hidden="true">
                {isPeak && <span className="daily-bars__value">{fmtInt(day.battles)}</span>}
                <span className="daily-bars__bar"><span className="daily-bars__wins" /></span>
              </span>
              <span className="daily-bars__label" aria-hidden="true">{new Date(day.day * 1000).getUTCDate()}</span>
            </li>
          )
        })}
      </ol>
      {none && <div className="daily-none">{t('clan.daily.none')}</div>}
      <div className="daily-legend">
        <span><span className="swatch is-win" />{t('battles.filter.wins')}</span>
        <span><span className="swatch is-loss" />{t('battles.filter.losses')}</span>
        <span className="daily-legend__range">{range}</span>
      </div>
    </section>
  )
}

const ROSTER_SORT_KEYS = ['psr', 'nick', 'change', 'activity', 'joined'] as const
type RosterSort = (typeof ROSTER_SORT_KEYS)[number]
type SortDir = 'asc' | 'desc'

/** The roster's sort, filters and length; the URL holds them, so Back from a member's page restores them. */
interface RosterView {
  sort: RosterSort
  dir: SortDir
  query: string
  /** Shown roles; empty — every role. */
  roles: string[]
  /** Only members who joined in the last NEW_MEMBER_DAYS. */
  fresh: boolean
  /** Every row, not only the first ROSTER_PREVIEW. */
  all: boolean
}

/** The nick from A, every figure from the largest, the join date from the newest. */
function defaultRosterDir(key: RosterSort): SortDir {
  return key === 'nick' ? 'asc' : 'desc'
}

function readRosterView(params: URLSearchParams): RosterView {
  const sortParam = params.get('sort')
  const sort = ROSTER_SORT_KEYS.find((key) => key === sortParam) ?? 'psr'
  const dir = params.get('dir')
  const roles = (params.get('role') ?? '').split(',')
  return {
    sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : defaultRosterDir(sort),
    query: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
    roles: ROLES.filter((role) => roles.includes(role)),
    fresh: params.get('new') === '1',
    all: params.get('all') === '1',
  }
}

interface RosterRow {
  member: Member
  /** Place by PSR in the squadron, 1 — the best; the first SQUADRON_TOP count in full. */
  place: number
}

/** Rows without the value come last in either direction; ties keep the PSR order. */
function sortRoster(rows: readonly RosterRow[], key: RosterSort, dir: SortDir): RosterRow[] {
  const sign = dir === 'asc' ? 1 : -1
  if (key === 'psr') return [...rows].sort((left, right) => sign * (right.place - left.place))
  if (key === 'nick') {
    return [...rows].sort((left, right) =>
      sign * left.member.nick.localeCompare(right.member.nick, localeTag(), { sensitivity: 'base' }) || left.place - right.place)
  }
  const value = (row: RosterRow): number | null =>
    key === 'change' ? row.member.delta : key === 'activity' ? row.member.activity : row.member.joinedAt
  return [...rows].sort((left, right) => {
    const a = value(left)
    const b = value(right)
    if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0) || left.place - right.place
    return sign * (a - b) || left.place - right.place
  })
}

function RoleBadge({ role }: { role: string }) {
  const known = (ROLES as readonly string[]).includes(role)
  return <span className={`member-badge role-${known ? role.toLowerCase() : 'other'}`}>{clanRoleLabel(role)}</span>
}

/** A member's last PSR change: a pill, stronger past one battle's worth (PSR_K). */
function MemberChange({ member }: { member: Member }) {
  const value = member.delta
  if (value === null) return <span className="change none" title={t('clan.roster.change.none')}>—</span>
  const title = t('clan.roster.change.title', { time: fmtDateTime(member.seenAt) })
  if (value === 0) return <span className="change flat" title={title}>0</span>
  const size = Math.abs(value)
  const level = size >= MEMBER_CHANGE_HUGE ? 3 : size >= MEMBER_CHANGE_STRONG ? 2 : 1
  return (
    <span className={`change ${value > 0 ? 'up' : 'down'} lvl-${level}`} title={title}>
      {value > 0 ? '+' : '−'}{fmtInt(size)}
    </span>
  )
}

/** Activity as a share of ACTIVITY_MAX and its figure, green from the members' median. */
function ActivityMeter({ value }: { value: number }) {
  const title = value >= ACTIVITY_MAX
    ? t('clan.roster.activity.max')
    : value <= 0 ? t('clan.roster.activity.idle') : undefined
  return (
    <span className={`activity${activityTone(value)}`} title={title}>
      <span className="activity__bar" aria-hidden="true">
        <span className="activity__fill" style={{ width: `${Math.min(100, (value / ACTIVITY_MAX) * 100).toFixed(1)}%` }} />
      </span>
      <span className="activity__value">{fmtInt(value)}</span>
    </span>
  )
}

interface RosterRowContext {
  topRating: number
  pattern: RegExp | null
  nowSec: number
  onOpen: ReturnType<typeof useRowLink>
}

function RosterLine({ row, index, context }: { row: RosterRow; index: number; context: RosterRowContext }) {
  const { member, place } = row
  const href = memberPath(member)
  const counted = place <= SQUADRON_TOP
  const podium = place <= 3 && member.rating > 0
  const share = context.topRating > 0 ? Math.max(0, Math.min(1, member.rating / context.topRating)) : 0
  const classes = ['row-link', counted ? 'is-counted' : null, podium ? `is-podium place-${place}` : null]
    .filter(Boolean)
    .join(' ')
  const psrTitle = member.rating > 0
    ? t('clan.roster.psr.hold', { pct: Math.round(holdWinRate(member.rating) * 100) })
    : t('clan.roster.psr.zero')
  return (
    <tr className={classes} style={cascade(index)} onClick={(event) => context.onOpen(event, href)}>
      <td className="col-rank">
        <span className="rank-num">{fmtInt(place)}</span>
      </td>
      <td className="member-cell">
        <div className="member-cell__inner">
          <Link to={href} className="member-cell__nick"><Marked text={member.nick} pattern={context.pattern} /></Link>
          {member.role !== null && member.role !== 'Private' && <RoleBadge role={member.role} />}
          {isNewMember(member, context.nowSec) && <span className="member-badge is-new">{t('clan.roster.new')}</span>}
        </div>
      </td>
      <td className="num col-psr">
        <div className="rating-cell">
          {/* The share of the squadron's best PSR. */}
          <span className="rating-bar" aria-hidden="true">
            <span className="rating-bar__fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
          </span>
          <span className="rating-cell__value">
            <span className={`rating${psrTone(member.rating)}${member.rating === 0 ? ' is-zero' : ''}`} title={psrTitle}>
              {fmtInt(member.rating)}
            </span>
            {/* On a phone the change column folds under the PSR; zero and "no data" are left out. */}
            {member.delta !== null && member.delta !== 0 && <span className="rating-change"><MemberChange member={member} /></span>}
          </span>
        </div>
      </td>
      <td className="num col-change"><MemberChange member={member} /></td>
      <td className="num col-activity">{member.activity === null ? <span className="muted">—</span> : <ActivityMeter value={member.activity} />}</td>
      <td
        className="num col-joined"
        title={member.joinedAt === null ? undefined : t('clan.roster.joined.title', {
          age: context.nowSec - member.joinedAt < 31 * DAY_SEC
            ? tp('season.days', Math.max(1, Math.floor((context.nowSec - member.joinedAt) / DAY_SEC)))
            : fmtAge(member.joinedAt, context.nowSec),
        })}
      >
        {fmtDate(member.joinedAt)}
      </td>
    </tr>
  )
}

/** The line under the members whose PSR counts in full: everyone below adds SQUADRON_REST_SHARE of theirs. */
function RosterCut({ index }: { index: number }) {
  return (
    <tr className="tier-cut roster-cut" style={cascade(index)}>
      <td colSpan={ROSTER_COLUMNS} title={t('clan.roster.cut.title', { n: SQUADRON_TOP, share: Math.round(SQUADRON_REST_SHARE * 100) })}>
        <div className="tier-cut__inner">
          <span className="tier-cut__label">
            <Triangle size={8} />
            {t('clan.roster.cut', { n: SQUADRON_TOP })}
          </span>
          <span className="tier-cut__line" aria-hidden="true" />
        </div>
      </td>
    </tr>
  )
}

function RosterHead({ label, title, sortKey, view, className, onSort }: {
  label: string
  title?: string | undefined
  sortKey: RosterSort
  view: RosterView
  className: string
  onSort: (key: RosterSort) => void
}) {
  const active = view.sort === sortKey
  return (
    <th className={className} aria-sort={active ? (view.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        className={`sort-button${active ? ' is-active' : ''}`}
        onClick={() => onSort(sortKey)}
        title={title ?? t('a11y.sort', { col: label })}
      >
        {active && <span className="sort-arrow" aria-hidden="true">{view.dir === 'asc' ? '↑' : '↓'}</span>}
        {label}
      </button>
    </th>
  )
}

/**
 * Members by PSR, with a line under those counted in full; search by nick, filters by role and
 * newcomers, sorting by every column. The view lives in the URL.
 */
function RosterCard({ clan, roster }: { clan: Clan; roster: Member[] }) {
  const openRow = useRowLink()
  const [searchParams, setSearchParams] = useSearchParams()
  const view = readRosterView(searchParams)
  const [draft, setDraft] = useState(view.query)
  // The query this card last wrote to the URL: other URL changes (Back, a link) reach the field.
  const writtenQuery = useRef(view.query)
  const [nowSec] = useState(() => Math.floor(Date.now() / 1_000))
  const cardRef = useRef<HTMLElement>(null)
  // Set by a change made below the card's top: the card scrolls back to its head.
  const scrollToHead = useRef(false)
  const topBar = useTopBarHeight()

  useEffect(() => {
    if (view.query === writtenQuery.current) return
    writtenQuery.current = view.query
    setDraft(view.query)
  }, [view.query])

  // The rows follow the field at once, the URL after a pause.
  useEffect(() => {
    const next = draft.trim()
    if (next === writtenQuery.current) return
    const timer = window.setTimeout(() => {
      writtenQuery.current = next
      setSearchParams((params) => {
        const updated = new URLSearchParams(params)
        if (next === '') updated.delete('q')
        else updated.set('q', next)
        return updated
      }, { replace: true })
    }, next === '' ? 0 : SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [draft, setSearchParams])

  const viewKey = [view.sort, view.dir, view.roles.join(','), view.fresh ? 'new' : '', view.all ? 'all' : ''].join('|')
  useLayoutEffect(() => {
    if (!scrollToHead.current) return
    scrollToHead.current = false
    cardRef.current?.scrollIntoView({ block: 'start' })
  }, [viewKey])

  const updateView = (change: (params: URLSearchParams) => void, toHead = true): void => {
    if (toHead && (cardRef.current?.getBoundingClientRect().top ?? 0) < 0) scrollToHead.current = true
    setSearchParams((params) => {
      const updated = new URLSearchParams(params)
      change(updated)
      return updated
    }, { replace: true })
  }
  const applySort = (key: RosterSort, dir: SortDir): void => updateView((params) => {
    if (key === 'psr') params.delete('sort')
    else params.set('sort', key)
    if (dir === defaultRosterDir(key)) params.delete('dir')
    else params.set('dir', dir)
  })
  const sortBy = (key: RosterSort): void => {
    applySort(key, view.sort === key ? (view.dir === 'asc' ? 'desc' : 'asc') : defaultRosterDir(key))
  }
  const toggleRole = (role: string): void => updateView((params) => {
    const roles = view.roles.includes(role) ? view.roles.filter((item) => item !== role) : [...view.roles, role]
    const ordered = ROLES.filter((item) => roles.includes(item))
    if (ordered.length === 0) params.delete('role')
    else params.set('role', ordered.join(','))
  })
  const toggleFlag = (name: string, on: boolean, toHead = true): void => updateView((params) => {
    if (on) params.set(name, '1')
    else params.delete(name)
  }, toHead)
  const reset = (): void => {
    writtenQuery.current = ''
    setDraft('')
    updateView((params) => {
      for (const name of ['sort', 'dir', 'q', 'role', 'new', 'all']) params.delete(name)
    })
  }

  const ranked = useMemo(() => roster.map((member, index) => ({ member, place: index + 1 })), [roster])
  const query = searchKey(draft.trim())
  const matches = ranked.filter(({ member }) =>
    (query === '' || searchKey(member.nick).includes(query))
    && (view.roles.length === 0 || (member.role !== null && view.roles.includes(member.role)))
    && (!view.fresh || isNewMember(member, nowSec)))
  const sorted = sortRoster(matches, view.sort, view.dir)
  const collapsed = !view.all && sorted.length > ROSTER_PREVIEW + ROSTER_PREVIEW_SLACK
  const shown = collapsed ? sorted.slice(0, ROSTER_PREVIEW) : sorted
  // The plain roster reads in PSR order: the line under the members counted in full goes there.
  const plain = view.sort === 'psr' && view.dir === 'desc' && query === '' && view.roles.length === 0 && !view.fresh
  const customized = !plain || view.all
  const roleCounts = new Map<string, number>()
  for (const member of roster) if (member.role !== null) roleCounts.set(member.role, (roleCounts.get(member.role) ?? 0) + 1)
  const newCount = roster.filter((member) => isNewMember(member, nowSec)).length
  const context: RosterRowContext = {
    topRating: Math.max(1, roster[0]?.rating ?? 1),
    pattern: searchPattern(draft.trim()),
    nowSec,
    onOpen: openRow,
  }
  const rows: ReactNode[] = []
  for (const row of shown) {
    rows.push(<RosterLine key={row.member.nick} row={row} index={rows.length} context={context} />)
    if (plain && row.place === SQUADRON_TOP && ranked.length > SQUADRON_TOP) rows.push(<RosterCut key="cut" index={rows.length} />)
  }
  const hasDetails = roster.some((member) => member.role !== null || member.joinedAt !== null || member.activity !== null)
  const sortOptions: { key: RosterSort; label: string }[] = [
    { key: 'psr', label: t('metric.pkr') },
    { key: 'nick', label: t('clan.roster.col.player') },
    { key: 'change', label: t('clan.roster.col.change') },
    { key: 'activity', label: t('clan.official.activity') },
    { key: 'joined', label: t('clan.roster.col.joined') },
  ]
  const share = Math.round(SQUADRON_REST_SHARE * 100)

  if (roster.length === 0) {
    return (
      <section className="card clans-table roster-card">
        <div className="clans-table__head">
          <div className="clans-table__title"><SecHead title={t('clan.roster')} /></div>
        </div>
        <div className="clans-empty">{t('clan.roster.none')}</div>
      </section>
    )
  }

  return (
    // The ranking's table card (ClansPage.tsx): the same head, filters, sticky column heads, rows and lines.
    <section
      ref={cardRef}
      className={`card clans-table roster-card sorted-${view.sort}`}
      style={topBar === null ? undefined : ({ '--sticky-top': `${topBar}px` } as CSSProperties)}
    >
      <div className="clans-table__head">
        <div className="clans-table__title">
          <SecHead title={t('clan.roster')} />
          <div className="clans-table__meta">
            {tp('common.members', roster.length)} · {t('clan.roster.counted', { n: SQUADRON_TOP, share })}
          </div>
        </div>
        <div className="clan-search" role="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" />
            <path d="M20 20l-3.6-3.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && draft !== '') {
                event.preventDefault()
                setDraft('')
              }
            }}
            placeholder={t('clan.roster.search')}
            aria-label={t('clan.roster.search.label')}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
          {draft !== '' && (
            <button type="button" className="clan-search__clear" aria-label={t('clans.search.clear')} onClick={() => setDraft('')}>
              ×
            </button>
          )}
        </div>
      </div>
      <div className="clans-tools">
        <div className="clan-filters">
          {ROLES.filter((role) => roleCounts.has(role) || view.roles.includes(role)).map((role) => (
            <button
              key={role}
              type="button"
              className={`clan-chip role-${role.toLowerCase()}${view.roles.includes(role) ? ' is-on' : ''}`}
              aria-pressed={view.roles.includes(role)}
              onClick={() => toggleRole(role)}
            >
              {clanRoleLabel(role)}
              <b>{fmtInt(roleCounts.get(role) ?? 0)}</b>
            </button>
          ))}
          {(newCount > 0 || view.fresh) && (
            <button
              type="button"
              className={`clan-chip is-new${view.fresh ? ' is-on' : ''}`}
              aria-pressed={view.fresh}
              title={t('clan.roster.filter.new.title', { n: NEW_MEMBER_DAYS })}
              onClick={() => toggleFlag('new', !view.fresh)}
            >
              {t('clan.roster.filter.new')}
              <b>{fmtInt(newCount)}</b>
            </button>
          )}
          {customized && (
            <button type="button" className="clan-filters__reset" onClick={reset}>
              {t('clans.filter.reset')}
            </button>
          )}
        </div>
        {/* Phones hide most columns, and their heads with them: sorting moves here. */}
        <div className="clan-sort">
          <select
            value={view.sort}
            onChange={(event) => {
              const key = ROSTER_SORT_KEYS.find((candidate) => candidate === event.target.value) ?? 'psr'
              applySort(key, defaultRosterDir(key))
            }}
            aria-label={t('clans.sort.label')}
          >
            {sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          <button
            type="button"
            className="clan-sort__dir"
            onClick={() => applySort(view.sort, view.dir === 'asc' ? 'desc' : 'asc')}
            aria-label={t(view.dir === 'asc' ? 'clans.sort.asc' : 'clans.sort.desc')}
            title={t(view.dir === 'asc' ? 'clans.sort.asc' : 'clans.sort.desc')}
          >
            {view.dir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="clans-empty">{t('clan.roster.empty')}</div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th className="col-rank">#</th>
                <RosterHead className="member-cell" label={t('clan.roster.col.player')} sortKey="nick" view={view} onSort={sortBy} />
                <RosterHead
                  className="num col-psr"
                  label={t('metric.pkr')}
                  title={t('clan.roster.col.psr.title', { n: SQUADRON_TOP })}
                  sortKey="psr"
                  view={view}
                  onSort={sortBy}
                />
                <RosterHead
                  className="num col-change"
                  label={t('clan.roster.col.change')}
                  title={t('clan.roster.col.change.title')}
                  sortKey="change"
                  view={view}
                  onSort={sortBy}
                />
                <RosterHead
                  className="num col-activity"
                  label={t('clan.official.activity')}
                  title={t('clan.roster.col.activity.title', {
                    max: fmtInt(ACTIVITY_MAX),
                    median: fmtInt(ACTIVITY_MEDIAN),
                    high: fmtInt(ACTIVITY_HIGH),
                  })}
                  sortKey="activity"
                  view={view}
                  onSort={sortBy}
                />
                <RosterHead className="num col-joined" label={t('clan.roster.col.joined')} sortKey="joined" view={view} onSort={sortBy} />
              </tr>
            </thead>
            {/* A new sort or filter mounts the rows anew, so their entrance plays again; typing does not. */}
            <tbody key={viewKey}>{rows}</tbody>
          </table>
        </div>
      )}
      {(collapsed || (view.all && sorted.length > ROSTER_PREVIEW + ROSTER_PREVIEW_SLACK)) && (
        <div className="clans-table__foot">
          {/* More rows grow below the button; fewer bring the card's head back into view. */}
          <button type="button" className="roster-more" onClick={() => toggleFlag('all', collapsed, !collapsed)} aria-expanded={!collapsed}>
            {collapsed
              ? t('clan.roster.showAll', { n: fmtInt(sorted.length) })
              : t('clan.roster.showFewer', { n: ROSTER_PREVIEW })}
            <svg className={collapsed ? undefined : 'is-up'} width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      {(hasDetails || !clan.rosterKnown) && (
        <p className="roster-card__note">
          {hasDetails && t('clan.roster.details')}
          {hasDetails && !clan.rosterKnown && ' '}
          {!clan.rosterKnown && t('clan.roster.unverified')}
        </p>
      )}
    </section>
  )
}

/**
 * The squadron's battles in the bot's replays over a period: figures toned as the season's, then
 * the latest battles with a win/loss filter.
 */
function ReplayBattlesCard({ detail, days, onDays, refreshing }: {
  detail: ClanDetail
  days: Period
  onDays: (days: Period) => void
  refreshing: boolean
}) {
  const { clan, battles, recent } = detail
  const [outcome, setOutcome] = useState<'all' | 'w' | 'l'>('all')
  const periods = [
    { value: '7', label: t('common.days.7') },
    { value: '30', label: t('common.days.30') },
    { value: '90', label: t('common.days.90') },
  ] as const
  const outcomes = [
    { value: 'all', label: t('common.all') },
    { value: 'w', label: t('battles.filter.wins') },
    { value: 'l', label: t('battles.filter.losses') },
  ] as const
  const decided = battles.wins + battles.losses
  const kd = battles.deaths > 0 ? battles.kills / battles.deaths : null
  const perBattle = battles.total > 0 ? Math.round(battles.score / battles.total) : null
  const few = decided < MIN_RATE_BATTLES ? t('clans.rate.few', { n: MIN_RATE_BATTLES }) : undefined
  const shown = outcome === 'all' ? recent : recent.filter((battle) => battle.clanSide?.won === (outcome === 'w'))
  return (
    <section className={`card clan-replays${refreshing ? ' is-busy' : ''}`} aria-busy={refreshing}>
      <SecHead title={t('clan.battles')}>
        <span className="sec-head__note">{t('clan.battles.hint')}</span>
        <span className="sec-head__end">
          <SegControl options={periods} value={days} onChange={onDays} ariaLabel={t('a11y.period.clanBattles')} />
        </span>
      </SecHead>
      {battles.total === 0 ? (
        <div className="clans-empty clan-replays__empty">
          {battles.collectedSince === null
            ? t('clan.recent.empty')
            : t('clan.battles.none', { date: fmtDate(battles.collectedSince) })}
        </div>
      ) : (
        <>
          <div className="kpis clan-kpis">
            <Kpi label={t('metric.battles')} value={fmtInt(battles.total)} sub={t('clan.battles.noresult', { n: fmtInt(battles.unknownResults) })} />
            <DonutKpi
              label={t('metric.winrate')}
              fraction={battles.winRate}
              text={fmtPercent(battles.winRate)}
              className={`${rateTone(winRateScore(battles.winRate), decided)}${battles.winRate !== null && battles.winRate < 0.5 ? ' is-losing' : ''}`}
              title={few}
              sub={<>
                {/* The number is its own span: only the word is taken from the "{n} wins" template. */}
                <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(battles.wins)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
                <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(battles.losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
              </>}
            />
            <Kpi
              label={t('metric.kd')}
              value={fmtRatio(kd)}
              className={rateTone(kdScore(kd), decided)}
              title={few}
              sub={`${t('metric.kills.count', { n: fmtInt(battles.kills) })} · ${t('metric.deaths.count', { n: fmtInt(battles.deaths) })}`}
            />
            <Kpi label={t('metric.score')} value={fmtInt(battles.score)} sub={perBattle === null ? undefined : t('clan.battles.perBattle', { n: fmtInt(perBattle) })} />
          </div>
          <div className="clan-recent">
            <div className="clan-recent__head">
              <h3>{t('clan.recent')}</h3>
              <SegControl options={outcomes} value={outcome} onChange={setOutcome} ariaLabel={t('a11y.filter.outcome')} />
              <Link to={`/battles?clan=${encodeURIComponent(clan.coreTag)}`} className="clan-recent__all">{t('common.allLink')}</Link>
            </div>
            {shown.length === 0 ? (
              <div className="muted small">{recent.length === 0 ? t('clan.recent.empty') : t('clan.recent.filtered')}</div>
            ) : (
              <div className="clan-recent__list">
                {shown.map((battle, index) => {
                  const versus = battleVersusLabel(battle.teams)
                  const won = battle.clanSide?.won ?? null
                  return (
                    <Link
                      key={battle.sessionId}
                      to={`/battles/${battle.sessionId}`}
                      className={`row-item recent-row${won === null ? '' : won ? ' is-win' : ' is-loss'}`}
                      style={cascade(index)}
                    >
                      <ResultBadge won={won} />
                      <span className="title">
                        {versus ?? battle.missionName}
                        <span className="sub">
                          {/* A phone moves the time here from the row's end, ahead of the map that may be cut. */}
                          <span className="recent-row__time">{fmtRecentTime(battle.startTime)} · </span>
                          {versus !== null ? battle.missionName : tp('common.players', battle.playerCount)}
                        </span>
                      </span>
                      <span className="end" title={fmtDateTime(battle.startTime)}>{fmtRecentTime(battle.startTime)}</span>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** Past seasons' rewards shown at once; older ones are counted. */
const REWARD_SHELF = 12

/**
 * The squadron's profile from the leaderboard and its past rewards as medals in the ranking's
 * colours. The description and announcement are the squadron's own text, shown as text only.
 */
function ClanAboutCard({ clan }: { clan: Clan }) {
  const profile = clan.profile
  const typeLabel = clan.clanType === 'battalion'
    ? t('clan.type.battalion')
    : clan.clanType === 'normal' ? t('clan.type.normal') : null
  const applications = profile ? applicationsText(profile) : null
  const requirements = profile?.requirements ? requirementLines(profile.requirements) : null
  const regalia = profile?.regalia ? clanRewardLabel(profile.regalia) : null
  const rewards = (clan.rewards?.log ?? [])
    .map(([season, titles]) => ({
      season,
      titles,
      labels: titles.map(rewardText).filter((label): label is string => label !== null),
    }))
    .filter((entry) => entry.labels.length > 0)
    .sort((left, right) => right.season - left.season)
  const facts: [string, ReactNode][] = []
  if (clan.region) facts.push([t('clan.about.region'), clan.region])
  if (typeLabel) facts.push([t('clan.about.type'), typeLabel])
  if (clan.foundedAt !== null) facts.push([t('clan.about.founded'), fmtDate(clan.foundedAt)])
  if (applications) facts.push([t('clan.about.applications'), applications])
  if (regalia && profile?.regalia) {
    facts.push([t('clan.about.regalia'), <span className={`reward-medal is-mini${rewardClass(profile.regalia)}`}>{regalia}</span>])
  }
  if (profile === null && clan.slogan === null && facts.length === 0 && rewards.length === 0) return null

  return (
    <section className="card clan-about">
      <SecHead title={t('clan.about')} hint={t('clan.about.hint')} />
      <div className="grid-2">
        <div style={{ minWidth: 0 }}>
          {clan.slogan && <p className="free-text clan-about__slogan">{clan.slogan}</p>}
          {profile?.description
            ? <p className="free-text">{profile.description}</p>
            : <p className="muted small">{t('clan.about.noDescription')}</p>}
          {profile?.announcement && (
            <>
              <div className="muted small" style={{ marginBottom: 4 }}>{t('clan.about.announcement')}</div>
              <p className="free-text">{profile.announcement}</p>
            </>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          {facts.map(([label, value]) => (
            <div className="row" key={label}>
              <span className="muted">{label}</span>
              <span style={{ flexShrink: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
            </div>
          ))}
          {requirements !== null && (
            <div className="row" style={{ display: 'block' }}>
              <div className="muted">{t('clan.about.requirements')}</div>
              {requirements.length === 0
                ? <div>{t('clan.about.requirements.none')}</div>
                : requirements.map((line) => <div key={line}>{line}</div>)}
            </div>
          )}
          {rewards.length > 0 && (
            <div className="reward-shelf-wrap">
              <div className="muted small" style={{ marginBottom: 8 }}>{t('clan.about.rewards')}</div>
              <div className="reward-shelf">
                {rewards.slice(0, REWARD_SHELF).map((entry, index) => (
                  <span
                    key={entry.season}
                    className={`reward-medal${rewardClass(entry.titles[0] ?? '')}`}
                    style={cascade(index)}
                    title={`${t('clan.reward.season', { n: entry.season })}: ${entry.labels.join(', ')}`}
                  >
                    <b className="reward-medal__season">{entry.season}</b>
                    {entry.labels.join(', ')}
                  </span>
                ))}
                {rewards.length > REWARD_SHELF && (
                  <span
                    className="reward-medal is-more"
                    title={rewards.slice(REWARD_SHELF).map((entry) => `${t('clan.reward.season', { n: entry.season })}: ${entry.labels.join(', ')}`).join('\n')}
                  >
                    {t('clan.reward.more', { n: rewards.length - REWARD_SHELF })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export function ClanPage() {
  const { coreTag = '' } = useParams()
  // Every label is built at render: a new language re-renders the page.
  useLocale()
  const [detail, setDetail] = useState<ClanDetail | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [history, setHistory] = useState<ClanHistoryPoint[] | null>(null)
  const [historyTruncated, setHistoryTruncated] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [days, setDays] = useState<Period>('30')
  const [error, setError] = useState<unknown>(null)
  const daily = useMemo(() => history === null ? null : battleDays(history, DAILY_DAYS), [history])

  // Another squadron: the previous one's data is not shown for a moment.
  useEffect(() => {
    setDetail(null)
  }, [coreTag])

  // A new period only reloads the data: the page stays in place, the battles card dims until the answer.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setRefreshing(true)
    fetchClan(coreTag, Number(days))
      .then((body) => { if (!cancelled) setDetail(body) })
      .catch((err) => { if (!cancelled) setError(err) })
      .finally(() => { if (!cancelled) setRefreshing(false) })
    return () => { cancelled = true }
  }, [coreTag, days])

  useEffect(() => {
    let cancelled = false
    setHistory(null)
    setHistoryTruncated(false)
    setHistoryError(null)
    fetchClanHistory(coreTag, 90)
      .then((body) => {
        if (cancelled) return
        setHistory(body.points)
        setHistoryTruncated(body.truncated)
      })
      .catch((err) => { if (!cancelled) setHistoryError(err) })
    return () => { cancelled = true }
  }, [coreTag])

  if (error !== null && detail === null) {
    const message = error instanceof SiteApiError && error.status === 404
      ? t('clan.notFound')
      : undefined
    return (
      <>
        <div className="page-head"><h1>{t('clan.title')}</h1></div>
        {message ? <div className="notice fail">{message}</div> : <ErrorNotice error={error} />}
      </>
    )
  }
  if (!detail) return <Loading text={t('clan.loading')} />

  const { clan } = detail
  // Without the leaderboard's battle counts (a PSR estimate) or with too few readings, the rating
  // chart takes the whole row.
  const dailyShown = clan.official && historyError === null && (daily === null || daily.length > 0)
  return (
    <div className="clan-page">
      <div className="crumbs">
        <Link to="/clans">{t('nav.clans')}</Link>
        <span className="sep">/</span>
        <span className="here">{clan.displayTag}</span>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      <ClanHero detail={detail} />
      <SeasonCard detail={detail} />
      <div className={dailyShown ? 'grid-2 clan-charts' : 'clan-charts'}>
        <RatingChartCard clan={clan} history={history} truncated={historyTruncated} error={historyError} />
        {dailyShown && <DailyBattlesCard days={daily} until={history?.at(-1)?.t ?? null} />}
      </div>
      <RosterCard key={clan.coreTag} clan={clan} roster={detail.roster} />
      <ReplayBattlesCard detail={detail} days={days} onDays={setDays} refreshing={refreshing} />
      <ClanAboutCard clan={clan} />
    </div>
  )
}
