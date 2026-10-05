import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  fetchClan,
  fetchClanHistory,
  SiteApiError,
  type ClanAbout,
  type ClanDetail,
  type ClanHistoryPoint,
  type ClanLink,
  type ClanNeighbor,
  type ClanProfile,
  type ClanRecords,
  type ClanRequirements,
  type ClanSeasonRewards,
  type ClanTextField,
  type ClanTextRequirement,
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
import { DeltaPill, ErrorNotice, Loading, ResultBadge, SecHead, SegControl, StarIcon, useRowLink } from '../components/ui'
import {
  Change,
  cascade,
  joinTitles,
  kdScore,
  Marked,
  MIN_RATE_BATTLES,
  Move,
  REWARD_TIERS,
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
import { seasonHeading, seasonParts } from '../components/SeasonPanel'
import { BrandIcon } from '../components/BrandIcon'
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
/** Members' activity median and upper quartile over every stored roster (2026-10-05): its gold steps. */
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
/** The daily battles chart's span, days. */
const DAILY_DAYS = 30
/** Up to this many days every bar is labelled with its battles; more label only the busiest. */
const DAILY_VALUES_ALL = 10
/** The rating chart's height, px: level with the daily bars beside it. */
const RATING_CHART_HEIGHT = 196
/** The URL's limit for the roster search, as on /clans. */
const MAX_QUERY_LENGTH = 64
/** One URL update per pause in typing: the rows follow the field at once. */
const SEARCH_DELAY_MS = 300
/** Seasons in the rewards chart: 40 (about six and a half years), 20 on a phone; the tally counts every season. */
const REWARD_SEASONS_SHOWN = 40
const REWARD_SEASONS_NARROW = 20
/**
 * The chart's first column names its year unless a year opens within this many columns: a year
 * label (~24 px) centred on that boundary would run into it (columns are 13 px apart).
 */
const REWARD_FIRST_YEAR_GAP = 3
/**
 * Squadron Battles seasons last two calendar months: counted so from the leaderboard's season, the
 * first rewarded season of all but 3 of 185 squadrons fits their founding date, 2017 to 2026
 * (2026-10-05). Without the leaderboard's season, season 62 began on 2026-09-01.
 */
const SEASON_MONTHS = 2
const SEASON_ANCHOR = { seasonId: 62, startsAt: Date.UTC(2026, 8, 1) / 1000 }
/** Links shown under the squadron's name, one plain site among them at most; the About text links the rest. */
const HERO_LINKS = 3

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

/** A reward's height in the rewards chart: place 1 is 8, the top 100 is 1; 0 — not a ranking reward. */
function rewardLevel(code: string): number {
  const [title = ''] = code.split('@')
  const place = /^place([1-3])$/.exec(title)
  if (place) return 9 - Number(place[1])
  const top = /^top(\d{1,3})$/.exec(title)
  const index = top === null ? -1 : REWARD_TIERS.findIndex((tier) => tier.top === Number(top[1]))
  return index === -1 ? 0 : REWARD_TIERS.length - index
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

/** Activity in gold from the members' median up, brightest at the maximum; none is muted. */
function activityTone(activity: number): string {
  if (activity <= 0) return ' is-idle'
  if (activity >= ACTIVITY_MAX) return ' tone-up-3'
  if (activity >= ACTIVITY_HIGH) return ' tone-up-2'
  if (activity >= ACTIVITY_MEDIAN) return ' tone-up-1'
  return ''
}

/** "New": joined within NEW_MEMBER_DAYS by the join date on the squadron's page on warthunder.com. */
function isNewMember(member: Member, nowSec: number): boolean {
  return member.joinedAt !== null && nowSec - member.joinedAt < NEW_MEMBER_DAYS * DAY_SEC
}

/** How long a member has been in the squadron: days for the first month, then months or years. */
function memberAge(joinedAt: number, nowSec: number): string {
  return nowSec - joinedAt < 31 * DAY_SEC
    ? tp('season.days', Math.max(1, Math.floor((nowSec - joinedAt) / DAY_SEC)))
    : fmtAge(joinedAt, nowSec)
}

/** A nick as search compares it: NFKC, locale-neutral lowercase (as the server's nick search). */
function searchKey(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** A counted phrase with its number in bold, wherever the language puts it: "<b>162</b> battles". */
function Counted({ text, n }: { text: string; n: string }) {
  const at = text.indexOf(n)
  if (at === -1) return <>{text}</>
  return <>{text.slice(0, at)}<b>{n}</b>{text.slice(at + n.length)}</>
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

/** A figure that holds a season record: a gold star beside its name, the record named on hover. */
function RecordMark({ title }: { title: string }) {
  return (
    <span className="stat-record" title={title}>
      <StarIcon filled size={10} />
      {t('clan.record')}
    </span>
  )
}

/**
 * One figure of a strip: its name, the value, a line under it. Tone classes colour it above or below
 * the norm, has-record turns it gold.
 */
function Stat({ label, value, sub, className = '', title, record = null }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  className?: string
  title?: string | undefined
  /** The record's tooltip; null — no record. */
  record?: string | null
}) {
  return (
    <div className={`clan-stat${className}`} title={title}>
      <div className="clan-stat__label">
        {label}
        {record !== null && <RecordMark title={record} />}
      </div>
      <div className="clan-stat__value">{value}</div>
      {sub !== undefined && <div className="clan-stat__sub">{sub}</div>}
    </div>
  )
}

/** Win rate and K/D toned as on /clans; fewer than MIN_RATE_BATTLES battles stay grey. */
function rateTone(score: number | null, battles: number): string {
  return battles >= MIN_RATE_BATTLES ? toneClass(score) : ' is-few'
}

function WinsLosses({ wins, losses }: { wins: number | null; losses: number | null }) {
  return (
    <>
      {/* The numbers are their own spans: only the words come from the "{n} wins" templates. */}
      <span className="ok">{fmtInt(wins)}</span> {t('metric.wins.count', { n: '' }).trim()}
      {' · '}
      <span className="fail">{fmtInt(losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
    </>
  )
}

/**
 * The season from the game's leaderboard (not from the bot's replays), on its own band at the foot of
 * the hero: its name, dates and current week, then figures toned against the norm as in the ranking,
 * gold where the squadron holds the season's record.
 */
function SeasonFigures({ detail }: { detail: ClanDetail }) {
  const { clan, ranking } = detail
  if (!clan.official || clan.seasonBattles === null) return null
  const battles = clan.seasonBattles
  const winRate = seasonWinRate(clan)
  const kd = seasonKd(clan)
  const losses = clan.seasonWins === null ? null : battles - clan.seasonWins
  const kills = clan.airKills === null && clan.groundKills === null ? null : (clan.airKills ?? 0) + (clan.groundKills ?? 0)
  const holds = (key: keyof ClanRecords): boolean => ranking.records[key] === clan.coreTag
  const few = battles < MIN_RATE_BATTLES ? t('clans.rate.few', { n: MIN_RATE_BATTLES }) : null
  const heading = seasonHeading(detail.season, detail.officialSeason)
  const parts = seasonParts(detail.season)
  let day: ReactNode
  if (clan.battles24h !== null) {
    day = clan.battles24h > 0
      ? <span className="clan-stat__day">{t('clans.battles.day', { n: fmtInt(clan.battles24h) })}</span>
      : t('clan.stat.day.none')
  }
  return (
    <section className="clan-season" aria-label={heading}>
      <div className="clan-season__head">
        <h2>{heading}</h2>
        {parts !== null && (
          <>
            <span className="clan-season__dates">{parts.range}</span>
            <span className="clan-season__stage">{parts.stage}</span>
          </>
        )}
      </div>
      <div className="clan-stats">
        <Stat
          label={t('metric.battles')}
          value={fmtInt(battles)}
          className={holds('battles') ? ' has-record' : ''}
          record={holds('battles') ? t('clans.record.battles') : null}
          sub={day}
        />
        <Stat
          label={t('metric.winrate')}
          value={fmtPercent(winRate)}
          className={`${rateTone(winRateScore(winRate), battles)}${holds('winRate') ? ' has-record' : ''}`}
          title={few ?? undefined}
          record={holds('winRate') ? t('clans.record.winRate', { n: MIN_RATE_BATTLES }) : null}
          sub={<WinsLosses wins={clan.seasonWins} losses={losses} />}
        />
        <Stat
          label={t('metric.kd')}
          value={fmtRatio(kd)}
          className={`${rateTone(kdScore(kd), battles)}${holds('kd') ? ' has-record' : ''}`}
          title={joinTitles(`${fmtInt(clan.airKills)} ${t('metric.killsAir')} · ${fmtInt(clan.groundKills)} ${t('metric.killsGround')}`, few)}
          record={holds('kd') ? t('clans.record.kd', { n: MIN_RATE_BATTLES }) : null}
          sub={`${t('metric.kills.count', { n: fmtInt(kills) })} · ${t('metric.deaths.count', { n: fmtInt(clan.deaths) })}`}
        />
        <Stat label={t('clan.official.flightTime')} value={fmtHours(clan.flightTimeMin === null ? null : clan.flightTimeMin * 60)} />
        <Stat label={t('clan.official.activity')} value={fmtInt(clan.activity)} />
      </div>
    </section>
  )
}

/**
 * Who the squadron is and how its season goes, in one card: its place in the colour of the reward it
 * holds (the ranking's zones), the rating with its 24 h change and places moved, the gaps to its
 * neighbours, then the season's figures.
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
        <div className="clan-hero__who">
          <div className="clan-hero__title">
            <span
              className="clan-hero__place"
              role="img"
              aria-label={t('clan.hero.place', { n: fmtInt(clan.rank), total: fmtInt(ranking.total) })}
              title={t('clan.hero.place', { n: fmtInt(clan.rank), total: fmtInt(ranking.total) })}
            >
              <span className="clan-hero__hash">#</span>
              {fmtInt(clan.rank)}
            </span>
            <h1>
              <span className="clan-hero__tag">{clan.displayTag}</span>
              {showName && <span className="clan-hero__name">{clan.name}</span>}
            </h1>
          </div>
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
            {heroLinks(clan.about).map((link) => <ClanLinkChip key={link.url} link={link} />)}
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
      <SeasonFigures detail={detail} />
    </header>
  )
}

/** The squadron's own text, cut to a few lines while longer, with a button for the rest. */
function ClampedText({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = (): void => setCut(box.scrollHeight > box.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="clan-about__text">
      <div ref={boxRef} className={`clan-about__clamp${open ? ' is-open' : cut ? ' is-cut' : ''}`}>{children}</div>
      {(cut || open) && (
        <button type="button" className="clan-about__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'clan.about.less' : 'clan.about.more')}
          <svg className={open ? 'is-up' : undefined} width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
}

interface SeasonReward {
  season: number
  /** The season's best title ("top10@historical"): the chart's colour and height. */
  title: string
  /** Every title of the season, as text. */
  labels: string[]
  level: number
}

/** Past seasons' ranking rewards, oldest first, each by its best title. */
function rewardHistory(rewards: ClanSeasonRewards | null): SeasonReward[] {
  const history: SeasonReward[] = []
  for (const [season, titles] of rewards?.log ?? []) {
    let best: { title: string; level: number } | null = null
    for (const title of titles) {
      const level = rewardLevel(title)
      if (level > 0 && (best === null || level > best.level)) best = { title, level }
    }
    if (best === null) continue
    const labels = titles.map(rewardText).filter((label): label is string => label !== null)
    history.push({ season, title: best.title, labels, level: best.level })
  }
  return history.sort((left, right) => left.season - right.season)
}

/** The reward the squadron's place holds in the current season, as a title; null — none. */
function liveTitle(clan: Clan): string | null {
  if (clan.leaderboard !== 'current') return null
  if (clan.rank <= 3) return `place${clan.rank}`
  const tier = rewardTierOf(clan.rank)
  return tier === undefined ? null : `top${tier.top}`
}

/** A bar's height in the rewards chart: the top 100 a fifth of the plot, place 1 all of it. */
function rewardHeight(level: number): string {
  return (0.2 + (0.8 * (level - 1)) / 7).toFixed(3)
}

type SeasonAnchor = { seasonId: number; startsAt: number }

/** A season's first and last month (UTC), counting two-month seasons back from the anchor. */
function seasonSpan(season: number, anchor: SeasonAnchor): [Date, Date] {
  const base = new Date(anchor.startsAt * 1000)
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - SEASON_MONTHS * (anchor.seasonId - season), 1))
  return [start, new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + SEASON_MONTHS - 1, 1))]
}

/** "Jul – Aug 2026". */
function seasonDates(season: number, anchor: SeasonAnchor): string {
  const [start, end] = seasonSpan(season, anchor)
  return new Intl.DateTimeFormat(localeTag(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).formatRange(start, end)
}

/**
 * Season rewards: a legend of how often the squadron took each reward, then a bar per season in the
 * reward's colour and height (a season without one is a dot) up to the current season, whose dashed
 * bar is the reward its place holds so far. A line marks where a year opens, its year centred under
 * it; the first column names its own year.
 */
function RewardHistory({ history, live, anchor }: {
  history: SeasonReward[]
  live: { season: number; title: string } | null
  anchor: SeasonAnchor
}) {
  const latest = history[history.length - 1]!.season
  const last = live === null ? latest : Math.max(latest, live.season - 1)
  const first = Math.max(history[0]!.season, last - REWARD_SEASONS_SHOWN + 1)
  const bySeason = new Map(history.map((entry) => [entry.season, entry]))
  const seasons: number[] = []
  for (let season = first; season <= last; season += 1) seasons.push(season)
  const current = live !== null && live.season === last + 1
    ? { ...live, label: t('clan.rewards.live', { n: live.season, reward: rewardText(live.title) ?? '' }) }
    : null

  const tally = new Map<string, { title: string; level: number; count: number }>()
  for (const entry of history) {
    const label = rewardText(entry.title)
    if (label === null) continue
    const item = tally.get(label)
    if (item) item.count += 1
    else tally.set(label, { title: entry.title, level: entry.level, count: 1 })
  }
  // Best first; a mode other than RB (" · AB") after RB's own.
  const legend = [...tally.entries()].sort(([leftLabel, left], [rightLabel, right]) =>
    right.level - left.level || leftLabel.length - rightLabel.length)

  // A phone shows only the last REWARD_SEASONS_NARROW seasons and names the first of them itself.
  const yearOf = (season: number): number => seasonSpan(season, anchor)[0].getUTCFullYear()
  const narrowFirst = Math.max(0, seasons.length - REWARD_SEASONS_NARROW)
  const opensYear = (index: number): boolean => index > 0 && yearOf(seasons[index]!) !== yearOf(seasons[index - 1]!)
  const firstYear = (from: number): number | null => {
    for (let index = from + 1; index <= from + REWARD_FIRST_YEAR_GAP && index < seasons.length; index += 1) {
      if (opensYear(index)) return null
    }
    return yearOf(seasons[from]!)
  }
  const wideFirst = firstYear(0)
  const narrowYear = narrowFirst > 0 ? firstYear(narrowFirst) : null
  const liveOpens = current !== null && yearOf(current.season) !== yearOf(last)

  return (
    <div className="clan-rewards">
      <div className="clan-rewards__head">
        <h3>{t('clan.about.rewards')}</h3>
        <ul className="reward-legend">
          {legend.map(([label, item], index) => (
            <li
              key={label}
              className={`reward-legend__item${rewardClass(item.title)}`}
              style={cascade(index)}
              title={tp('clan.rewards.tally', item.count, { reward: label })}
            >
              <i aria-hidden="true" />
              {label}
              <b>×{fmtInt(item.count)}</b>
            </li>
          ))}
        </ul>
      </div>
      <ol className="reward-ladder" aria-label={t('clan.about.rewards')}>
        {seasons.map((season, index) => {
          // A phone leaves the earliest seasons out (theme.css): their bars would be slivers.
          const early = index < narrowFirst
          const entry = bySeason.get(season)
          const when = t('clan.rewards.season', { n: season, dates: seasonDates(season, anchor) })
          const label = entry ? `${when}: ${entry.labels.join(', ')}` : t('clan.rewards.none', { season: when })
          const opens = opensYear(index)
          // A phone's first column names its year itself, left-aligned, whether or not it opens one.
          const narrow = index === narrowFirst && narrowFirst > 0
          const classes = [
            'reward-ladder__season',
            entry ? rewardClass(entry.title).trim() : 'is-empty',
            early ? 'is-early' : null,
            opens ? 'opens-year' : null,
            narrow ? 'is-narrow-first' : null,
          ].filter(Boolean).join(' ')
          return (
            <li
              key={season}
              className={classes}
              style={{ '--h': entry ? rewardHeight(entry.level) : '0', '--i': index } as CSSProperties}
              title={label}
              aria-label={label}
            >
              <span className="reward-ladder__bar" aria-hidden="true" />
              {(opens || (index === 0 && wideFirst !== null)) && (
                <span className={`reward-ladder__year${opens ? '' : ' is-first'}`} aria-hidden="true">{yearOf(season)}</span>
              )}
              {narrow && !opens && narrowYear !== null && (
                <span className="reward-ladder__year is-first is-narrow" aria-hidden="true">{narrowYear}</span>
              )}
            </li>
          )
        })}
        {current !== null && (
          <li
            key="live"
            className={`reward-ladder__season is-live${rewardClass(current.title)}${liveOpens ? ' opens-year' : ''}`}
            style={{ '--h': rewardHeight(rewardLevel(current.title)), '--i': seasons.length } as CSSProperties}
            title={current.label}
            aria-label={current.label}
          >
            <span className="reward-ladder__bar" aria-hidden="true" />
            {liveOpens && <span className="reward-ladder__year" aria-hidden="true">{yearOf(current.season)}</span>}
          </li>
        )}
      </ol>
    </div>
  )
}

/**
 * The squadron's own text with its links clickable: the API's spans are offsets into this very text.
 * The leaderboard keeps some line breaks as a literal "\n"; they break the line here.
 */
function LinkedText({ text, field, about }: { text: string; field: ClanTextField; about: ClanAbout | null }) {
  const plain = (part: string): string => part.replaceAll('\\n', '\n')
  const parts: ReactNode[] = []
  let at = 0
  for (const [where, start, end, index] of about?.spans ?? []) {
    const link = about!.links[index]
    if (where !== field || link === undefined || start < at || end > text.length) continue
    parts.push(plain(text.slice(at, start)))
    parts.push(
      <a key={start} className="clan-about__link" href={link.url} target="_blank" rel="noopener noreferrer nofollow ugc">
        {text.slice(start, end)}
      </a>,
    )
    at = end
  }
  parts.push(plain(text.slice(at)))
  return <>{parts}</>
}

/** "1.0", "0.75", "10.7": K/D and BR with a dot in every language, as the game writes them. */
function fmtThreshold(value: number): string {
  const text = String(Math.round(value * 100) / 100)
  return text.includes('.') ? text : `${text}.0`
}

/** A language's own name in the page's language: "English", "Английский". */
function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([localeTag()], { type: 'language' }).of(code) ?? code
    return name.charAt(0).toLocaleUpperCase(localeTag()) + name.slice(1)
  } catch {
    return code
  }
}

/**
 * Requirements read from the squadron's texts as short chips, one per kind: a K/D, BR or vehicle
 * rank asked per branch joins its values ("K/D 1.0+ ground / 0.8+ air").
 */
function requirementChips(items: ClanTextRequirement[]): { key: string; kind: ClanTextRequirement['kind']; text: string; title: string }[] {
  const chips: { key: string; kind: ClanTextRequirement['kind']; text: string; title: string }[] = []
  const kinds = [...new Set(items.map((item) => item.kind))]
  for (const kind of kinds) {
    const group = items.filter((item) => item.kind === kind)
    const title = group.map((item) => t('clan.req.from', { text: item.source })).filter((line, index, all) => all.indexOf(line) === index).join('\n')
    if (kind === 'language') {
      for (const item of group) {
        if (item.language !== null) chips.push({ key: `language-${item.language}`, kind, text: languageName(item.language), title })
      }
      continue
    }
    const value = (item: ClanTextRequirement): string => {
      const n = item.min ?? 0
      const shown = kind === 'rank' ? romanRank(n) : kind === 'kd' || kind === 'br' ? fmtThreshold(n) : fmtInt(n)
      return item.branch === null
        ? t('clan.req.value', { n: shown })
        : t('clan.req.value.branch', { n: shown, branch: t(item.branch === 'air' ? 'clan.req.branch.air' : 'clan.req.branch.ground') })
    }
    // Either branch first, then ground and air, as the game lists them.
    const sorted = [...group].sort((left, right) => branchOrder(left.branch) - branchOrder(right.branch))
    const values = sorted.map(value).join(' / ')
    const text = kind === 'mic' || kind === 'discord' || kind === 'topTier'
      ? t(`clan.req.text.${kind}`)
      : t(`clan.req.text.${kind}`, { values })
    chips.push({ key: kind, kind, text, title })
  }
  return chips
}

function branchOrder(branch: ClanTextRequirement['branch']): number {
  return branch === null ? 0 : branch === 'ground' ? 1 : 2
}

/** The links under the squadron's name: services first as written, one plain site at most. */
function heroLinks(about: ClanAbout | null): ClanLink[] {
  const sites = (about?.links ?? []).filter((link) => link.kind === 'web').slice(0, 1)
  return (about?.links ?? []).filter((link) => link.kind !== 'web' || sites.includes(link)).slice(0, HERO_LINKS)
}

/** A link from the squadron's texts: the service's logo, then the address; it opens in a new tab. */
function ClanLinkChip({ link }: { link: ClanLink }) {
  return (
    <a
      className={`clan-link is-${link.kind}`}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      title={t('clan.link.title', { address: link.label })}
    >
      <BrandIcon kind={link.kind} size={13} />
      <span className="clan-link__label">{link.label}</span>
    </a>
  )
}

/**
 * The squadron's profile from the leaderboard: its own text (cut while long, links clickable) with
 * its season rewards under it, the facts beside them. Requirements join the game's own conditions
 * with those its text states.
 */
function ClanAboutCard({ detail }: { detail: ClanDetail }) {
  const { clan } = detail
  const profile = clan.profile
  const about = clan.about
  const typeLabel = clan.clanType === 'battalion'
    ? t('clan.type.battalion')
    : clan.clanType === 'normal' ? t('clan.type.normal') : null
  const applications = profile ? applicationsText(profile) : null
  const official = profile?.requirements ? requirementLines(profile.requirements) : null
  const chips = requirementChips(about?.requirements ?? [])
  // A requirement naming a service the texts link to ("Discord") opens that link.
  const chipLink = (kind: ClanTextRequirement['kind']): ClanLink | undefined => about?.links.find((link) => link.kind === kind)
  const history = rewardHistory(clan.rewards)
  const title = liveTitle(clan)
  const live = title !== null && detail.officialSeason !== null ? { season: detail.officialSeason.seasonId, title } : null
  const anchor = detail.officialSeason ?? SEASON_ANCHOR
  // The tag's decoration is last season's reward: the chart shows it, unless the log lacks it.
  const regalia = profile?.regalia ?? null
  const regaliaLabel = regalia !== null && history.at(-1)?.title.split('@')[0] !== regalia ? clanRewardLabel(regalia) : null
  const facts: [string, ReactNode][] = []
  if (clan.region) facts.push([t('clan.about.region'), clan.region])
  if (typeLabel) facts.push([t('clan.about.type'), typeLabel])
  if (clan.foundedAt !== null) {
    facts.push([t('clan.about.founded'), <>{fmtDate(clan.foundedAt)}<span className="clan-facts__note"> · {fmtAge(clan.foundedAt)}</span></>])
  }
  if (applications) facts.push([t('clan.about.applications'), applications])
  if (official !== null || chips.length > 0) {
    facts.push([
      t('clan.about.requirements'),
      <>
        {official?.map((line) => <div key={line}>{line}</div>)}
        {official !== null && official.length === 0 && chips.length === 0 && t('clan.about.requirements.none')}
        {chips.length > 0 && (
          <ul className="clan-reqs">
            {chips.map((chip) => {
              const link = chipLink(chip.kind)
              const body = <>{chip.kind === 'discord' && <BrandIcon kind="discord" size={12} />}{chip.text}</>
              return (
                <li key={chip.key}>
                  {link === undefined ? (
                    <span className={`clan-req is-${chip.kind}`} title={chip.title}>{body}</span>
                  ) : (
                    <a
                      className={`clan-req is-${chip.kind} is-link`}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      title={`${t('clan.link.title', { address: link.label })}\n${chip.title}`}
                    >
                      {body}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </>,
    ])
  }
  if (regalia !== null && regaliaLabel !== null) {
    facts.push([t('clan.about.regalia'), <span className={`reward-legend__item is-fact${rewardClass(regalia)}`}><i aria-hidden="true" />{regaliaLabel}</span>])
  }
  const hasText = Boolean(clan.slogan || profile?.description || profile?.announcement)
  if (profile === null && !hasText && facts.length === 0 && history.length === 0) return null

  return (
    <section className="card clan-about">
      <SecHead title={t('clan.about')} hint={t('clan.about.hint')} />
      <div className={`clan-about__grid${facts.length === 0 ? ' is-single' : ''}`}>
        <ClampedText>
          {clan.slogan && <p className="free-text clan-about__slogan"><LinkedText text={clan.slogan} field="slogan" about={about} /></p>}
          {profile?.description && <p className="free-text"><LinkedText text={profile.description} field="description" about={about} /></p>}
          {!clan.slogan && !profile?.description && <p className="muted small">{t('clan.about.noDescription')}</p>}
          {profile?.announcement && (
            <>
              <div className="clan-about__label">{t('clan.about.announcement')}</div>
              <p className="free-text"><LinkedText text={profile.announcement} field="announcement" about={about} /></p>
            </>
          )}
        </ClampedText>
        {facts.length > 0 && (
          <dl className="clan-facts">
            {facts.map(([label, value]) => (
              <div className="clan-facts__row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {history.length > 0 && <RewardHistory history={history} live={live} anchor={anchor} />}
      </div>
    </section>
  )
}

/** The rating over the season's last 90 days: the official one, or the members' PSR sum. */
function RatingPane({ clan, history, truncated, error }: {
  clan: Clan
  history: ClanHistoryPoint[] | null
  truncated: boolean
  error: unknown
}) {
  const { locale } = useLocale()
  const [hover, setHover] = useState<number | null>(null)
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
  const point = hover === null ? null : history?.[hover] ?? null
  // The hovered reading takes the hint's place: uPlot's own legend is off for a single line.
  const hint = point !== null
    ? <span className="clan-chart__readout">{fmtDateTime(point.t)} · <b>{fmtInt(point.total)}</b></span>
    : `${t(clan.official ? 'clan.dynamics.hint.official' : 'clan.dynamics.hint')}${truncated ? ` · ${t('clan.dynamics.truncated')}` : ''}`
  let body: ReactNode
  if (error !== null) body = <ErrorNotice error={error} />
  else if (chart === null) body = <div className="clan-chart__wait"><Loading /></div>
  else if (chart.xs.length < 2) body = <div className="clan-chart__wait muted small">{t('common.chart.noData')}</div>
  else body = <TimeChart xs={chart.xs} series={chart.series} height={RATING_CHART_HEIGHT} dayTicks onCursor={setHover} />
  return (
    <div className="clan-dynamics__pane clan-chart">
      <SecHead title={t('clan.dynamics')} hint={hint}>
        {clan.delta30d !== null && clan.delta30d !== 0 && (
          <span className="clan-chart__month" title={t(clan.official ? 'clan.deltaTooltip.official' : 'clan.deltaTooltip')}>
            {t('clan.dynamics.month')} <DeltaPill value={clan.delta30d} />
          </span>
        )}
      </SecHead>
      {body}
    </div>
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
 * Battles per day, each bar split into wins and losses, over a line at the average of the full days:
 * days at or above it are bright, the busiest is labelled in gold, the day still counting is hatched.
 * Above the bars the period's totals, the win rate toned as the season's.
 */
function DailyPane({ days, until }: { days: BattleDay[] | null; until: number | null }) {
  const head = (
    <SecHead title={t('clan.daily')} hint={t('clan.daily.hint')} />
  )
  if (days === null) {
    return (
      <div className="clan-dynamics__pane clan-daily">
        {head}
        <div className="clan-chart__wait"><Loading /></div>
      </div>
    )
  }
  const total = days.reduce((sum, day) => sum + day.battles, 0)
  const wins = days.reduce((sum, day) => sum + day.wins, 0)
  const full = days.filter((day) => !day.partial)
  const base = full.length > 0 ? full : days
  const average = base.reduce((sum, day) => sum + day.battles, 0) / base.length
  const max = Math.max(1, ...days.map((day) => day.battles))
  const peak = days.reduce((best, day) => (day.battles > best.battles ? day : best))
  const winRate = total > 0 ? wins / total : null
  const none = total === 0
  const compare = days.length >= 3 && average > 0
  // Day numbers under every day, every second or every fourth, counted back from the last one;
  // the month by the first label and wherever it changes.
  const labelStep = days.length > 20 ? 4 : days.length > 10 ? 2 : 1
  let lastMonth = -1
  return (
    <div className={`clan-dynamics__pane clan-daily${none ? ' is-none' : ''}`}>
      {head}
      <div className="daily-summary">
        {none ? (
          <span className="daily-summary__none">{t('clan.daily.since', { date: utcDay(days[0]!.day) })}</span>
        ) : (
          <>
            <span><Counted text={tp('common.battles', total)} n={fmtInt(total)} /></span>
            <span className={`daily-summary__rate${rateTone(winRateScore(winRate), total)}`}>
              <Counted text={t('clan.daily.winRate', { pct: fmtPercent(winRate) })} n={fmtPercent(winRate)} />
            </span>
            <span className={compare ? 'daily-summary__avg' : undefined} title={t('clan.daily.avg.title')}>
              <Counted text={t('clan.daily.avg', { n: fmtInt(Math.round(average)) })} n={fmtInt(Math.round(average))} />
            </span>
          </>
        )}
        {!none && (
          <span className="daily-summary__legend" aria-hidden="true">
            <span><i className="swatch is-win" />{t('battles.filter.wins')}</span>
            <span><i className="swatch is-loss" />{t('battles.filter.losses')}</span>
          </span>
        )}
      </div>
      {/* The dashed line at the average matches the underline of the average in the summary. */}
      <ol
        className={`daily-bars${compare && !none ? ' has-avg' : ''}`}
        style={{ '--n': days.length, '--a': (average / max).toFixed(4) } as CSSProperties}
        aria-label={t('clan.daily')}
      >
        {days.map((day, index) => {
          const when = day.partial && until !== null ? `${utcDay(day.day)}, ${t('clan.daily.until', { time: utcTime(until) })}` : utcDay(day.day)
          const label = `${when}: ${t('clans.change.day', { battles: fmtInt(day.battles), wins: fmtInt(day.wins) })}`
          const isPeak = day.battles > 0 && day === peak
          const high = compare && day.battles > 0 && day.battles >= average
          const date = new Date(day.day * 1000)
          const shown = (days.length - 1 - index) % labelStep === 0
          let text = ''
          if (shown) {
            text = lastMonth === date.getUTCMonth() ? String(date.getUTCDate()) : utcDay(day.day)
            lastMonth = date.getUTCMonth()
          }
          return (
            <li
              key={day.day}
              className={`daily-bars__day${isPeak ? ' is-peak' : ''}${high ? ' is-high' : ''}${day.partial ? ' is-partial' : ''}${day.battles === 0 ? ' is-empty' : ''}`}
              style={{
                '--h': (day.battles / max).toFixed(4),
                '--w': day.battles > 0 ? (day.wins / day.battles).toFixed(4) : '0',
                '--i': index,
              } as CSSProperties}
              title={label}
              aria-label={label}
            >
              <span className="daily-bars__slot" aria-hidden="true">
                {day.battles > 0 && (isPeak || days.length <= DAILY_VALUES_ALL) && (
                  <span className="daily-bars__value">{fmtInt(day.battles)}</span>
                )}
                <span className="daily-bars__bar"><span className="daily-bars__wins" /></span>
              </span>
              <span className="daily-bars__label" aria-hidden="true">{text}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The season's course in one card: the rating line and, beside it, the battles per day from the
 * same readings (a PSR estimate has no battle counts, a failed history no days: the line takes the row).
 */
function DynamicsCard({ clan, history, truncated, error }: {
  clan: Clan
  history: ClanHistoryPoint[] | null
  truncated: boolean
  error: unknown
}) {
  const daily = useMemo(() => history === null ? null : battleDays(history, DAILY_DAYS), [history])
  const dailyShown = clan.official && error === null && (daily === null || daily.length > 0)
  return (
    <section className={`card clan-dynamics${dailyShown ? ' has-daily' : ''}`}>
      <RatingPane clan={clan} history={history} truncated={truncated} error={error} />
      {dailyShown && <DailyPane days={daily} until={history?.at(-1)?.t ?? null} />}
    </section>
  )
}

const ROSTER_SORT_KEYS = ['place', 'psr', 'nick', 'change', 'activity', 'joined'] as const
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

/** The place and the nick from the top, every figure from the largest, the join date from the newest. */
function defaultRosterDir(key: RosterSort): SortDir {
  return key === 'nick' || key === 'place' ? 'asc' : 'desc'
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

/** Rows without the value come last in either direction; ties keep the PSR order. The place is the PSR order. */
function sortRoster(rows: readonly RosterRow[], key: RosterSort, dir: SortDir): RosterRow[] {
  const sign = dir === 'asc' ? 1 : -1
  if (key === 'place') return [...rows].sort((left, right) => sign * (left.place - right.place))
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

/** Activity as a share of ACTIVITY_MAX and its figure, gold from the members' median. */
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
  /** Some member has a PSR change: the column is shown. */
  changes: boolean
  onOpen: ReturnType<typeof useRowLink>
}

function RosterLine({ row, index, context }: { row: RosterRow; index: number; context: RosterRowContext }) {
  const { member, place } = row
  const href = memberPath(member)
  // The place in the ranking's tier colours (metal for 1–3, then gold to blue); past 100 or no PSR — slate.
  const zone = member.rating > 0 ? rewardZone(place, 'current') : null
  const share = context.topRating > 0 ? Math.max(0, Math.min(1, member.rating / context.topRating)) : 0
  const classes = ['row-link', zone].filter(Boolean).join(' ')
  const psrTitle = member.rating > 0
    ? t('clan.roster.psr.hold', { pct: Math.round(holdWinRate(member.rating) * 100) })
    : t('clan.roster.psr.zero')
  const age = member.joinedAt === null ? null : t('clan.roster.joined.title', { age: memberAge(member.joinedAt, context.nowSec) })
  return (
    <tr className={classes} style={cascade(index)} onClick={(event) => context.onOpen(event, href)}>
      <td className="col-rank">
        <span className="rank-num">{fmtInt(place)}</span>
      </td>
      <td className="member-cell">
        <div className="member-cell__inner">
          <Link to={href} className="member-cell__nick"><Marked text={member.nick} pattern={context.pattern} /></Link>
          {member.role !== null && member.role !== 'Private' && <RoleBadge role={member.role} />}
          {isNewMember(member, context.nowSec) && <span className="member-badge is-new" title={age ?? undefined}>{t('clan.roster.new')}</span>}
        </div>
      </td>
      <td className="num col-psr">
        <div className="rating-cell">
          {/* The share of the squadron's best PSR. */}
          <span className="rating-bar" aria-hidden="true">
            <span className="rating-bar__fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
          </span>
          <span className="rating-cell__value">
            <span className={`rating${member.rating === 0 ? ' is-zero' : ''}`} title={psrTitle}>
              {fmtInt(member.rating)}
            </span>
            {/* On a phone the change column folds under the PSR; zero and "no data" are left out. */}
            {member.delta !== null && member.delta !== 0 && <span className="rating-change"><MemberChange member={member} /></span>}
          </span>
        </div>
      </td>
      {context.changes && <td className="num col-change"><MemberChange member={member} /></td>}
      <td className="num col-activity">{member.activity === null ? <span className="muted">—</span> : <ActivityMeter value={member.activity} />}</td>
      <td className="num col-joined" title={age ?? undefined}>{fmtDate(member.joinedAt)}</td>
    </tr>
  )
}

/** The line under the members whose PSR counts in full: everyone below adds SQUADRON_REST_SHARE of theirs. */
function RosterCut({ index, columns }: { index: number; columns: number }) {
  return (
    <tr className="tier-cut roster-cut" style={cascade(index)}>
      <td colSpan={columns} title={t('clan.roster.cut.title', { n: SQUADRON_TOP, share: Math.round(SQUADRON_REST_SHARE * 100) })}>
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
 * newcomers, sorting by every column (the place is the PSR order). The view lives in the URL.
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
  const psrOrder = (view.sort === 'psr' && view.dir === 'desc') || (view.sort === 'place' && view.dir === 'asc')
  const plain = psrOrder && query === '' && view.roles.length === 0 && !view.fresh
  const customized = !plain || view.all
  const roleCounts = new Map<string, number>()
  for (const member of roster) if (member.role !== null) roleCounts.set(member.role, (roleCounts.get(member.role) ?? 0) + 1)
  const newCount = roster.filter((member) => isNewMember(member, nowSec)).length
  // Before a member's second reading this season every change is "—": the column waits for one.
  const changes = roster.some((member) => member.delta !== null)
  const context: RosterRowContext = {
    topRating: Math.max(1, roster[0]?.rating ?? 1),
    pattern: searchPattern(draft.trim()),
    nowSec,
    changes,
    onOpen: openRow,
  }
  const rows: ReactNode[] = []
  for (const row of shown) {
    rows.push(<RosterLine key={row.member.nick} row={row} index={rows.length} context={context} />)
    if (plain && row.place === SQUADRON_TOP && ranked.length > SQUADRON_TOP) {
      rows.push(<RosterCut key="cut" index={rows.length} columns={changes ? 6 : 5} />)
    }
  }
  const hasDetails = roster.some((member) => member.role !== null || member.joinedAt !== null || member.activity !== null)
  const sortOptions: { key: RosterSort; label: string }[] = [
    { key: 'psr', label: t('metric.pkr') },
    { key: 'nick', label: t('clan.roster.col.player') },
    ...(changes || view.sort === 'change' ? [{ key: 'change' as const, label: t('clan.roster.col.change') }] : []),
    { key: 'activity', label: t('clan.official.activity') },
    { key: 'joined', label: t('clan.roster.col.joined') },
    ...(view.sort === 'place' ? [{ key: 'place' as const, label: t('clans.col.place') }] : []),
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
      className={`card clans-table roster-card sorted-${view.sort}${changes ? '' : ' no-changes'}`}
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
                <RosterHead className="col-rank" label="#" title={t('clan.roster.col.place.title')} sortKey="place" view={view} onSort={sortBy} />
                <RosterHead className="member-cell" label={t('clan.roster.col.player')} sortKey="nick" view={view} onSort={sortBy} />
                <RosterHead
                  className="num col-psr"
                  label={t('metric.pkr')}
                  title={t('clan.roster.col.psr.title', { n: SQUADRON_TOP })}
                  sortKey="psr"
                  view={view}
                  onSort={sortBy}
                />
                {changes && (
                  <RosterHead
                    className="num col-change"
                    label={t('clan.roster.col.change')}
                    title={t('clan.roster.col.change.title')}
                    sortKey="change"
                    view={view}
                    onSort={sortBy}
                  />
                )}
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
          <div className="clan-stats is-four">
            <Stat
              label={t('metric.battles')}
              value={fmtInt(battles.total)}
              sub={battles.unknownResults > 0 ? t('clan.battles.noresult', { n: fmtInt(battles.unknownResults) }) : undefined}
            />
            <Stat
              label={t('metric.winrate')}
              value={fmtPercent(battles.winRate)}
              className={rateTone(winRateScore(battles.winRate), decided)}
              title={few}
              sub={<WinsLosses wins={battles.wins} losses={battles.losses} />}
            />
            <Stat
              label={t('metric.kd')}
              value={fmtRatio(kd)}
              className={rateTone(kdScore(kd), decided)}
              title={few}
              sub={`${t('metric.kills.count', { n: fmtInt(battles.kills) })} · ${t('metric.deaths.count', { n: fmtInt(battles.deaths) })}`}
            />
            <Stat
              label={t('metric.score')}
              value={fmtInt(battles.score)}
              sub={perBattle === null ? undefined : t('clan.battles.perBattle', { n: fmtInt(perBattle) })}
            />
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
  return (
    <div className="clan-page">
      <div className="crumbs">
        <Link to="/clans">{t('nav.clans')}</Link>
        <span className="sep">/</span>
        <span className="here">{clan.displayTag}</span>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      <ClanHero detail={detail} />
      <ClanAboutCard detail={detail} />
      <DynamicsCard clan={clan} history={history} truncated={historyTruncated} error={historyError} />
      <RosterCard key={clan.coreTag} clan={clan} roster={detail.roster} />
      <ReplayBattlesCard detail={detail} days={days} onDays={setDays} refreshing={refreshing} />
    </div>
  )
}
