import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchClans, type ClanListEntry, type ClanRecords, type ClanSortKey } from '../api'
import { fmtDateTime, fmtInt, fmtPercent, fmtRatio } from '../lib/format'
import { MAX_FAVORITE_CLANS, toggleFavoriteClan, useFavoriteClans } from '../lib/favorite-clans'
import { REWARD_TIERS, type RewardTier, type TierCutoff } from '../lib/reward-tiers'
import { localeTag, t, tp } from '../i18n'
import { SeasonPanel } from '../components/SeasonPanel'
import { ErrorNotice, Loading, Pager, SecHead, StarIcon, useRowLink } from '../components/ui'

const PAGE_SIZE = 100
/** One request per pause in typing, not per key: the API allows 60 requests a minute. */
const SEARCH_DELAY_MS = 300
/** The API's limit for a query. */
const MAX_QUERY_LENGTH = 64
const COLUMNS = 8
/**
 * Season battles below which a win rate or K/D is noise (2–5 battles gave 100 %): such figures
 * stay grey; the server sorts them after the rest by the same number (MIN_RATE_BATTLES in
 * src/web/clan-ranking.ts).
 */
const MIN_RATE_BATTLES = 50
/**
 * A 24 h change from these sizes up gets a stronger pill: on 2026-10-05 the top 100's |change|
 * had p75 342 and p90 732, so about the busiest quarter and tenth stand out.
 */
const CHANGE_STRONG = 250
const CHANGE_HUGE = 700

type SortDir = 'asc' | 'desc'

const SORT_KEYS: readonly ClanSortKey[] = ['place', 'change', 'battles', 'winRate', 'kd', 'members']

/** What the table shows; the URL holds it, so it survives a reload, Back and a shared link. */
interface View {
  /** 1-based. */
  page: number
  query: string
  sort: ClanSortKey
  dir: SortDir
  live: boolean
  favorites: boolean
}

/** Places up, figures from the largest. */
function defaultDir(key: ClanSortKey): SortDir {
  return key === 'place' ? 'asc' : 'desc'
}

function readView(params: URLSearchParams): View {
  const page = Number(params.get('page') ?? '1')
  const sortParam = params.get('sort')
  const sort = SORT_KEYS.find((key) => key === sortParam) ?? 'place'
  const dir = params.get('dir')
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    query: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
    sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : defaultDir(sort),
    live: params.get('live') === '1',
    favorites: params.get('fav') === '1',
  }
}

/** The plain ranking: tier lines and place numbers read in order. */
function isRankingView(view: View): boolean {
  return view.sort === 'place' && view.dir === 'asc' && view.query === '' && !view.live && !view.favorites
}

/**
 * The reward a squadron holds now, as row classes that colour its place, bar and hover mark: its
 * place (1–3) or its tier; null — outside the top 100 or the leaderboard.
 */
function rewardZone(clan: ClanListEntry): string | null {
  // Only squadrons in the leaderboard compete for its rewards; the ranking puts them first.
  if (clan.leaderboard !== 'current') return null
  if (clan.rank <= 3) return `is-podium place-${clan.rank}`
  const tier = REWARD_TIERS.find((candidate) => clan.rank >= candidate.from && clan.rank <= candidate.top)
  return tier === undefined ? null : `zone-${tier.top}`
}

/**
 * Colour class of a season figure by its score, −1…1 (beyond — clamped): three steps of green
 * above the norm, of red below; '' for a plain one near it.
 */
function toneClass(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return ''
  const level = Math.min(3, Math.floor(Math.abs(score) * 3))
  return level === 0 ? '' : ` tone-${score > 0 ? 'up' : 'down'}-${level}`
}

/** Win rate around 50 %: steps at 60, 70 and 80 % (40, 30, 20 % below). */
function winRateScore(rate: number | null): number | null {
  return rate === null ? null : (rate - 0.5) / 0.3
}

/**
 * K/D on a log scale around 1, steps at 1.26, 1.59 and 2.0 (0.79, 0.63, 0.5 below): on 2026-10-05
 * the middle 80 % of squadrons sat between 0.78 and 1.29, so only the outer tenth on each side
 * gets colour.
 */
function kdScore(kd: number | null): number | null {
  return kd === null || kd <= 0 ? null : Math.log2(kd)
}

/** A search query as a case-insensitive pattern; null — no query. */
function searchPattern(query: string): RegExp | null {
  return query === '' ? null : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
}

/** A name with the first match of the search marked. */
function Marked({ text, pattern }: { text: string; pattern: RegExp | null }) {
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

/** Season win rate from the official leaderboard; null — no data. */
function seasonWinRate(clan: ClanListEntry): number | null {
  return clan.seasonBattles !== null && clan.seasonBattles > 0 && clan.seasonWins !== null
    ? clan.seasonWins / clan.seasonBattles
    : null
}

/** Season kills per death from the leaderboard: air and ground together. */
function seasonKd(clan: ClanListEntry): number | null {
  if (clan.deaths === null || clan.deaths === 0) return null
  if (clan.airKills === null && clan.groundKills === null) return null
  return ((clan.airKills ?? 0) + (clan.groundKills ?? 0)) / clan.deaths
}

/** Tooltip parts joined; undefined — none. */
function joinTitles(...parts: (string | null | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return present.length > 0 ? present.join(' · ') : undefined
}

/** Crawl time: the time alone today, with the date on other days. */
function fmtCrawlTime(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
    : fmtDateTime(ts)
}

/** The rating cell's tooltip: the share of the leader, the gap to the place above and to the next tier. */
function ratingTitle(clan: ClanListEntry, leaderRating: number, cutoffs: readonly TierCutoff[]): string {
  if (clan.leaderboard === null) return t('clans.psr.title')
  const share = leaderRating > 0 ? Math.max(0, Math.min(1, clan.totalRating / leaderRating)) : 0
  const parts = [t('home.share.leader', { pct: Math.round(share * 100) })]
  if (clan.leaderboard === 'current' && clan.aboveRating !== null) {
    parts.push(t('clans.gap.above', { n: fmtInt(clan.aboveRating - clan.totalRating), place: clan.rank - 1 }))
    // The nearest tier above, unless its last place is the one right above.
    const tier = cutoffs.filter((cutoff) => cutoff.place < clan.rank - 1).at(-1)
    if (tier !== undefined) parts.push(t('clans.gap.tier', { n: fmtInt(tier.rating - clan.totalRating), top: tier.place }))
  }
  return parts.join(' · ')
}

function Triangle({ size = 7, down = false }: { size?: number; down?: boolean }) {
  return (
    <svg className={down ? 'is-down' : undefined} width={size} height={size} viewBox="0 0 8 8" aria-hidden="true">
      <path d="M4 1.2 7.4 6.6H.6z" fill="currentColor" />
    </svg>
  )
}

/** Places gained or lost over the day, next to the place. */
function Move({ value }: { value: number | null }) {
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

/**
 * The 24 h rating change: a signed pill, stronger for a big move; 0 and "no data" stay quiet. The
 * tooltip names the window: below the top 100 only full crawls read a squadron, hours apart, so it
 * is a day give or take a few hours.
 */
function Change({ clan, note = null }: { clan: ClanListEntry; note?: string | null }) {
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

/** Adds or removes a squadron from the viewer's favourites; the row's own click does not fire. */
function FavoriteButton({ clan, active, full }: { clan: ClanListEntry; active: boolean; full: boolean }) {
  const label = active
    ? t('clans.favorite.remove')
    : full ? t('clans.favorite.full', { n: MAX_FAVORITE_CLANS }) : t('clans.favorite.add')
  return (
    <button
      type="button"
      className={`fav-star${active ? ' is-on' : ''}`}
      aria-pressed={active}
      aria-disabled={!active && full}
      aria-label={`${label}: ${clan.displayTag}`}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        toggleFavoriteClan(clan.coreTag)
      }}
    >
      <StarIcon filled={active} />
    </button>
  )
}

/** A row's place in the entrance cascade: CSS staggers the row and its bar or tier line by it. */
function cascade(index: number): CSSProperties {
  return { '--i': index } as CSSProperties
}

interface RowContext {
  leaderRating: number
  cutoffs: readonly TierCutoff[]
  records: ClanRecords
  favorites: ReadonlySet<string>
  favoritesFull: boolean
  /** The "playing now" window, minutes. */
  liveMinutes: number
  pattern: RegExp | null
  onOpen: ReturnType<typeof useRowLink>
}

function ClanRow({ clan, index, context }: { clan: ClanListEntry; index: number; context: RowContext }) {
  const href = `/clans/${clan.coreTag}`
  const estimate = clan.leaderboard === null
  const dropped = clan.leaderboard === 'dropped'
  const showName = clan.name !== null && clan.name.toLowerCase() !== clan.displayTag.toLowerCase()
  const share = context.leaderRating > 0 ? Math.max(0, Math.min(1, clan.totalRating / context.leaderRating)) : 0
  const winRate = seasonWinRate(clan)
  const kd = seasonKd(clan)
  // A rate from a handful of battles says nothing: grey, no colour, no record.
  const reliable = clan.seasonBattles !== null && clan.seasonBattles >= MIN_RATE_BATTLES
  const fewTitle = reliable ? null : t('clans.rate.few', { n: MIN_RATE_BATTLES })
  const { records } = context
  const record = (key: keyof ClanRecords): boolean => records[key] === clan.coreTag
  const classes = ['row-link', rewardZone(clan), dropped ? 'is-dropped' : null, estimate ? 'is-estimate' : null]
    .filter(Boolean)
    .join(' ')
  return (
    <tr
      className={classes}
      style={cascade(index)}
      onClick={(event) => context.onOpen(event, href)}
      title={dropped ? t('clans.dropped.title', { time: fmtDateTime(clan.lastSeenAt) }) : undefined}
    >
      <td className="col-rank">
        <span className="rank-num">{fmtInt(clan.rank)}</span>
        <Move value={clan.rankChange24h} />
      </td>
      <td className="clan-cell">
        <div className="clan-cell__inner">
          <span className="clan-cell__text">
            <Link to={href}><Marked text={clan.displayTag} pattern={context.pattern} /></Link>
            {clan.recentBattles > 0 && (
              <span
                className="live-dot"
                role="img"
                aria-label={t('clans.filter.live')}
                title={tp('clans.live.title', clan.recentBattles, { min: context.liveMinutes })}
              />
            )}
            {showName && <span className="clan-cell__name"><Marked text={clan.name ?? ''} pattern={context.pattern} /></span>}
          </span>
          <FavoriteButton clan={clan} active={context.favorites.has(clan.coreTag)} full={context.favoritesFull} />
        </div>
      </td>
      <td className="num" title={ratingTitle(clan, context.leaderRating, context.cutoffs)}>
        <div className="rating-cell">
          {/* The share of the overall leader's rating. */}
          <span className="rating-bar" aria-hidden="true">
            <span className="rating-bar__fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
          </span>
          <span className="rating-cell__value">
            <span className="rating">{estimate ? '≈ ' : ''}{fmtInt(clan.totalRating)}</span>
            {/* On a phone the 24 h column folds under the rating; zero and "no data" are left out. */}
            {clan.delta24h !== null && clan.delta24h !== 0 && (
              <span className="rating-change"><Change clan={clan} /></span>
            )}
          </span>
        </div>
      </td>
      <td
        className={`num col-change${record('gain') ? ' has-record' : ''}`}
        title={record('gain') ? t('clans.record.gain') : undefined}
      >
        <Change clan={clan} note={record('gain') ? t('clans.record.gain') : null} />
      </td>
      <td
        className={`num col-battles${record('battles') ? ' has-record' : ''}`}
        title={joinTitles(
          record('battles') ? t('clans.record.battles') : null,
          clan.battles24h !== null && clan.battles24h > 0 ? t('clans.battles.day', { n: fmtInt(clan.battles24h) }) : null,
        )}
      >
        {fmtInt(clan.seasonBattles)}
      </td>
      <td
        className={`num col-wr${reliable ? toneClass(winRateScore(winRate)) : winRate !== null ? ' is-few' : ''}${record('winRate') ? ' has-record' : ''}`}
        title={joinTitles(
          record('winRate') ? t('clans.record.winRate', { n: MIN_RATE_BATTLES }) : null,
          clan.seasonBattles !== null && clan.seasonWins !== null
            ? t('clans.winRate.title', { wins: fmtInt(clan.seasonWins), battles: fmtInt(clan.seasonBattles) })
            : null,
          winRate !== null ? fewTitle : null,
        )}
      >
        {fmtPercent(winRate)}
      </td>
      <td
        className={`num col-kd${reliable ? toneClass(kdScore(kd)) : kd !== null ? ' is-few' : ''}${record('kd') ? ' has-record' : ''}`}
        title={joinTitles(
          record('kd') ? t('clans.record.kd', { n: MIN_RATE_BATTLES }) : null,
          clan.deaths === null
            ? null
            : `${fmtInt(clan.airKills)} ${t('metric.killsAir')} · ${fmtInt(clan.groundKills)} ${t('metric.killsGround')} · ${t('metric.deaths.count', { n: fmtInt(clan.deaths) })}`,
          kd !== null ? fewTitle : null,
        )}
      >
        {fmtRatio(kd)}
      </td>
      <td className="num col-members">{fmtInt(clan.members)}</td>
    </tr>
  )
}

/** The line under a reward tier's last place closes the tier: every squadron above it is in that top. */
function TierCut({ tier, index }: { tier: RewardTier; index: number }) {
  const reward = t('clan.reward.top', { n: tier.top })
  return (
    <tr className={`tier-cut zone-${tier.top}`} style={cascade(index)}>
      <td colSpan={COLUMNS} title={t('clans.tier.title', { from: tier.from, to: tier.top, reward })}>
        <div className="tier-cut__inner">
          <span className="tier-cut__label">
            <Triangle size={8} />
            {reward}
          </span>
          <span className="tier-cut__line" aria-hidden="true" />
        </div>
      </td>
    </tr>
  )
}

/** The page's rows; in the plain ranking a tier line follows each tier's last place. */
function rankingRows(clans: readonly ClanListEntry[], withTiers: boolean, context: RowContext): ReactNode[] {
  const rows: ReactNode[] = []
  for (const clan of clans) {
    rows.push(<ClanRow key={clan.coreTag} clan={clan} index={rows.length} context={context} />)
    const tier = withTiers && clan.leaderboard === 'current'
      ? REWARD_TIERS.find((candidate) => candidate.top === clan.rank)
      : undefined
    if (tier !== undefined) rows.push(<TierCut key={`top-${tier.top}`} tier={tier} index={rows.length} />)
  }
  return rows
}

/** A sortable column head. */
function SortHeader({ label, title, sortKey, view, className, onSort }: {
  label: string
  title?: string
  sortKey: ClanSortKey
  view: View
  className: string
  onSort: (key: ClanSortKey) => void
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

/** Height of the sticky top bar (App.tsx): the table head sticks right under it. */
function useTopBarHeight(): number | null {
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

type ClansResponse = Awaited<ReturnType<typeof fetchClans>>

export function ClansPage() {
  const openRow = useRowLink()
  const [searchParams, setSearchParams] = useSearchParams()
  const view = readView(searchParams)
  const { page, query, sort, dir, live } = view
  const favoriteList = useFavoriteClans()
  // The favourites filter asks the server for these tags; without it a new star changes nothing there.
  const favoriteTags = view.favorites ? favoriteList.join(',') : null
  const requestKey = [page, query, sort, dir, live ? 'live' : '', favoriteTags ?? ''].join('|')
  const [draft, setDraft] = useState(query)
  // The query this page last wrote to the URL: other URL changes (Back, a link) reach the field.
  const writtenQuery = useRef(query)
  const [loaded, setLoaded] = useState<{ key: string; view: View; body: ClansResponse } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set by the pager and by a sort or filter picked below the table's top: the new rows open at it.
  const scrollOnLoad = useRef(false)
  const filtersRef = useRef<HTMLDivElement>(null)
  const topBar = useTopBarHeight()

  useEffect(() => {
    if (query === writtenQuery.current) return
    writtenQuery.current = query
    setDraft(query)
  }, [query])

  // The URL follows typing after a pause (at once when cleared); a new query starts at page 1.
  useEffect(() => {
    const next = draft.trim()
    if (next === writtenQuery.current) return
    const timer = window.setTimeout(() => {
      writtenQuery.current = next
      setSearchParams((params) => {
        const updated = new URLSearchParams(params)
        if (next === '') updated.delete('q')
        else updated.set('q', next)
        updated.delete('page')
        return updated
      }, { replace: true })
    }, next === '' ? 0 : SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [draft, setSearchParams])

  // "/" jumps to the search, as on most sites with one; not while typing elsewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (inputRef.current === null) return
      event.preventDefault()
      inputRef.current.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    const requested: View = { page, query, sort, dir, live, favorites: favoriteTags !== null }
    fetchClans({
      ...(query !== '' ? { query } : {}),
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
      ...(sort !== 'place' || dir !== 'asc' ? { sort, dir } : {}),
      ...(live ? { live: true } : {}),
      ...(favoriteTags !== null ? { tags: favoriteTags === '' ? [] : favoriteTags.split(',') } : {}),
    })
      .then((body) => {
        if (cancelled) return
        const lastPage = Math.max(1, Math.ceil(body.total / PAGE_SIZE))
        if (page > lastPage) {
          // A stale link past the end (the ranking shrank) opens the last page.
          setSearchParams((params) => {
            const next = new URLSearchParams(params)
            if (lastPage === 1) next.delete('page')
            else next.set('page', String(lastPage))
            return next
          }, { replace: true })
          return
        }
        setLoaded({ key: requestKey, view: requested, body })
      })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
    // requestKey sums up every input above.
  }, [requestKey, setSearchParams])

  // Before paint, so the old scroll position does not flash with the new rows.
  useLayoutEffect(() => {
    if (loaded === null || !scrollOnLoad.current) return
    scrollOnLoad.current = false
    tableRef.current?.scrollIntoView({ block: 'start' })
  }, [loaded])

  // A phone scrolls the chips sideways: the chosen filter (from a link or Back) comes into view.
  const activeFilters = [live ? 'live' : '', view.favorites ? 'fav' : ''].join('|')
  const hasRows = loaded !== null
  useLayoutEffect(() => {
    const row = filtersRef.current
    if (row === null || row.scrollWidth <= row.clientWidth) return
    const chips = row.querySelectorAll<HTMLElement>('.clan-chip.is-on')
    const chip = chips[chips.length - 1]
    if (chip === undefined) return
    const rowBox = row.getBoundingClientRect()
    const box = chip.getBoundingClientRect()
    if (box.left >= rowBox.left && box.right <= rowBox.right) return
    row.scrollLeft += box.left + box.width / 2 - (rowBox.left + rowBox.width / 2)
  }, [activeFilters, hasRows])

  const goToPage = (next: number): void => {
    scrollOnLoad.current = true
    setSearchParams((params) => {
      const updated = new URLSearchParams(params)
      if (next <= 1) updated.delete('page')
      else updated.set('page', String(next))
      return updated
    })
  }

  /** A new sort or filter: back to page 1, and to the table's top if it is scrolled past. */
  const updateView = (change: (params: URLSearchParams) => void): void => {
    if ((tableRef.current?.getBoundingClientRect().top ?? 0) < 0) scrollOnLoad.current = true
    setSearchParams((params) => {
      const updated = new URLSearchParams(params)
      change(updated)
      updated.delete('page')
      return updated
    }, { replace: true })
  }

  const applySort = (key: ClanSortKey, nextDir: SortDir): void => updateView((params) => {
    if (key === 'place' && nextDir === 'asc') params.delete('sort')
    else params.set('sort', key)
    if (nextDir === defaultDir(key)) params.delete('dir')
    else params.set('dir', nextDir)
  })
  const sortBy = (key: ClanSortKey): void => {
    applySort(key, sort === key ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir(key))
  }
  const toggleParam = (name: string, on: boolean): void => updateView((params) => {
    if (on) params.set(name, '1')
    else params.delete(name)
  })
  const resetView = (): void => {
    writtenQuery.current = ''
    setDraft('')
    if ((tableRef.current?.getBoundingClientRect().top ?? 0) < 0) scrollOnLoad.current = true
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  const clearSearch = (): void => {
    setDraft('')
    inputRef.current?.focus()
  }

  const body = loaded?.body ?? null
  // A failed request leaves the previous rows in place, under the error.
  const busy = loaded !== null && error === null && loaded.key !== requestKey
  const customized = query !== '' || sort !== 'place' || dir !== 'asc' || live || view.favorites

  let content: ReactNode = null
  if (loaded === null || body === null) {
    content = error === null ? <Loading /> : null
  } else if (body.total === 0 && isRankingView(loaded.view)) {
    content = (
      <>
        {error !== null && <ErrorNotice error={error} />}
        <div className="notice">{t('clans.empty')}</div>
      </>
    )
  } else {
    const shown = loaded.view
    const offset = (shown.page - 1) * PAGE_SIZE
    const liveMinutes = Math.round((body.live?.windowSec ?? 2_700) / 60)
    const plain = isRankingView(shown)
    const meta = [
      plain
        ? t('clans.places', { from: fmtInt(offset + 1), to: fmtInt(offset + body.clans.length), total: fmtInt(body.total) })
        : tp('clans.found', body.total),
      ...(body.updatedAt !== null ? [t('clans.updated', { time: fmtCrawlTime(body.updatedAt) })] : []),
    ].join(' · ')
    const context: RowContext = {
      leaderRating: body.leaderRating ?? 0,
      cutoffs: body.tierCutoffs,
      records: body.records,
      favorites: new Set(favoriteList),
      favoritesFull: favoriteList.length >= MAX_FAVORITE_CLANS,
      liveMinutes,
      pattern: searchPattern(shown.query),
      onOpen: openRow,
    }
    const filtered = shown.live || shown.favorites
    let empty: string
    if (shown.favorites && favoriteList.length === 0) empty = t('clans.empty.favorites')
    else if (shown.query !== '' && !filtered) empty = t('clans.search.empty', { q: shown.query })
    else if (shown.live && !shown.favorites && shown.query === '') empty = t('clans.empty.live', { min: liveMinutes })
    else empty = t('clans.empty.filtered')
    const liveOff = body.live === null || body.live.count === 0
    const sortOptions: { key: ClanSortKey; label: string }[] = [
      { key: 'place', label: t('clans.col.place') },
      { key: 'change', label: t('clans.col.change') },
      { key: 'battles', label: t('metric.battles') },
      { key: 'winRate', label: t('metric.winrate') },
      { key: 'kd', label: t('clans.col.kd') },
      { key: 'members', label: t('clans.col.members') },
    ]
    content = (
      <div
        ref={tableRef}
        className={`card clans-table sorted-${sort}${busy ? ' is-busy' : ''}`}
        aria-busy={busy}
        style={topBar === null ? undefined : ({ '--sticky-top': `${topBar}px` } as CSSProperties)}
      >
        <div className="clans-table__head">
          <div className="clans-table__title">
            <SecHead title={t('clans.ranking')} />
            <div className="clans-table__meta" aria-live="polite">{meta}</div>
          </div>
          <div className="clan-search" role="search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" />
              <path d="M20 20l-3.6-3.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && draft !== '') {
                  event.preventDefault()
                  setDraft('')
                }
              }}
              placeholder={t('clans.search.placeholder')}
              aria-label={t('clans.search.label')}
              aria-keyshortcuts="/"
              maxLength={MAX_QUERY_LENGTH}
              autoComplete="off"
              spellCheck={false}
            />
            {draft === '' && <kbd className="clan-search__key" aria-hidden="true">/</kbd>}
            {draft !== '' && (
              <button type="button" className="clan-search__clear" aria-label={t('clans.search.clear')} onClick={clearSearch}>
                ×
              </button>
            )}
          </div>
        </div>
        <div className="clans-tools">
          <div className="clan-filters" ref={filtersRef}>
            <button
              type="button"
              className={`clan-chip is-live${live ? ' is-on' : ''}`}
              aria-pressed={live}
              disabled={!live && liveOff}
              title={body.live === null
                ? t('clans.filter.live.stale')
                : t('clans.filter.live.title', { min: liveMinutes })}
              onClick={() => toggleParam('live', !live)}
            >
              <span className="clan-chip__pulse" aria-hidden="true" />
              {t('clans.filter.live')}
              {body.live !== null && <b>{fmtInt(body.live.count)}</b>}
            </button>
            {(favoriteList.length > 0 || view.favorites) && (
              <button
                type="button"
                className={`clan-chip is-fav${view.favorites ? ' is-on' : ''}`}
                aria-pressed={view.favorites}
                onClick={() => toggleParam('fav', !view.favorites)}
              >
                <StarIcon filled size={12} />
                {t('clans.filter.favorites')}
                <b>{fmtInt(favoriteList.length)}</b>
              </button>
            )}
            {customized && (
              <button type="button" className="clan-filters__reset" onClick={resetView}>
                {t('clans.filter.reset')}
              </button>
            )}
          </div>
          {/* Phones hide most columns, and their heads with them: sorting moves here. */}
          <div className="clan-sort">
            <select
              value={sort}
              onChange={(event) => {
                const key = SORT_KEYS.find((candidate) => candidate === event.target.value) ?? 'place'
                applySort(key, defaultDir(key))
              }}
              aria-label={t('clans.sort.label')}
            >
              {sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
            <button
              type="button"
              className="clan-sort__dir"
              onClick={() => applySort(sort, dir === 'asc' ? 'desc' : 'asc')}
              aria-label={t(dir === 'asc' ? 'clans.sort.asc' : 'clans.sort.desc')}
              title={t(dir === 'asc' ? 'clans.sort.asc' : 'clans.sort.desc')}
            >
              {dir === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
        {error !== null && <div className="clans-table__error"><ErrorNotice error={error} /></div>}
        {body.clans.length === 0 ? (
          <div className="clans-empty">{empty}</div>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <SortHeader
                    className="col-rank"
                    label="#"
                    title={t('a11y.sort', { col: t('clans.col.place') })}
                    sortKey="place"
                    view={view}
                    onSort={sortBy}
                  />
                  <th className="clan-cell">{t('clans.col.clan')}</th>
                  <th className="num">{t('clans.col.rating')}</th>
                  <SortHeader
                    className="num col-change"
                    label={t('clans.col.change')}
                    title={t('clans.col.change.title')}
                    sortKey="change"
                    view={view}
                    onSort={sortBy}
                  />
                  <SortHeader className="num col-battles" label={t('metric.battles')} sortKey="battles" view={view} onSort={sortBy} />
                  <SortHeader
                    className="num col-wr"
                    label={t('metric.winrate')}
                    title={t('clans.col.wr.title', { n: MIN_RATE_BATTLES })}
                    sortKey="winRate"
                    view={view}
                    onSort={sortBy}
                  />
                  <SortHeader
                    className="num col-kd"
                    label={t('clans.col.kd')}
                    title={t('clans.col.kd.title', { n: MIN_RATE_BATTLES })}
                    sortKey="kd"
                    view={view}
                    onSort={sortBy}
                  />
                  <SortHeader className="num col-members" label={t('clans.col.members')} sortKey="members" view={view} onSort={sortBy} />
                </tr>
              </thead>
              {/* New rows (a page, query, sort or filter) mount anew, so their entrance plays again. */}
              <tbody key={loaded.key}>
                {rankingRows(body.clans, isRankingView(shown), context)}
              </tbody>
            </table>
          </div>
        )}
        <div className="clans-table__foot">
          <Pager page={shown.page} pages={Math.max(1, Math.ceil(body.total / PAGE_SIZE))} onChange={goToPage} />
          <p className="muted small">
            {t('clans.footnote')} <Link to="/guides/updates#site">{t('clans.footnote.link')}</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('clans.title')}</h1>
      </div>
      {error !== null && loaded === null && <ErrorNotice error={error} />}
      {body !== null && (
        <SeasonPanel
          context={body.season}
          official={body.officialSeason}
          rewards={{ cutoffs: body.tierCutoffs, leaderRating: body.leaderRating }}
        />
      )}
      {content}
    </>
  )
}
