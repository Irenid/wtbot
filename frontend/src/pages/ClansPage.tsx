import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchClans, type ClanListEntry } from '../api'
import { fmtDateTime, fmtInt, fmtPercent, fmtRatio } from '../lib/format'
import { localeTag, t, tp } from '../i18n'
import { SeasonPanel } from '../components/SeasonPanel'
import { ErrorNotice, Loading, Pager, SecHead, useRowLink } from '../components/ui'

const PAGE_SIZE = 100
/** One request per pause in typing, not per key: the API allows 60 requests a minute. */
const SEARCH_DELAY_MS = 300
/** The API's limit for a query. */
const MAX_QUERY_LENGTH = 64
const COLUMNS = 8

/**
 * Season reward tiers by place: places 1–3 have their own rewards (medals), the rest share one
 * per tier (see the rewards on a squadron page). A header row opens each tier.
 */
const REWARD_TIERS = [
  { top: 5, from: 4 },
  { top: 10, from: 6 },
  { top: 20, from: 11 },
  { top: 50, from: 21 },
  { top: 100, from: 51 },
] as const

type RewardTier = (typeof REWARD_TIERS)[number]

/** Season win rate from the official leaderboard; null — no data. */
function seasonWinRate(clan: ClanListEntry): number | null {
  return clan.seasonBattles !== null && clan.seasonBattles > 0 && clan.seasonWins !== null
    ? clan.seasonWins / clan.seasonBattles
    : null
}

function seasonWinTitle(clan: ClanListEntry): string | undefined {
  return clan.seasonBattles !== null && clan.seasonWins !== null
    ? t('clans.winRate.title', { wins: fmtInt(clan.seasonWins), battles: fmtInt(clan.seasonBattles) })
    : undefined
}

/** Season kills per death from the leaderboard: air and ground together. */
function seasonKd(clan: ClanListEntry): number | null {
  if (clan.deaths === null || clan.deaths === 0) return null
  if (clan.airKills === null && clan.groundKills === null) return null
  return ((clan.airKills ?? 0) + (clan.groundKills ?? 0)) / clan.deaths
}

function seasonKdTitle(clan: ClanListEntry): string | undefined {
  return clan.deaths === null
    ? undefined
    : `${fmtInt(clan.airKills)} ${t('metric.killsAir')} · ${fmtInt(clan.groundKills)} ${t('metric.killsGround')} · ${t('metric.deaths.count', { n: fmtInt(clan.deaths) })}`
}

/** Crawl time: the time alone today, with the date on other days. */
function fmtCrawlTime(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
    : fmtDateTime(ts)
}

/** The 24 h rating change: signed and coloured; 0 and "no data" stay quiet. */
function Change({ clan }: { clan: ClanListEntry }) {
  const value = clan.delta24h
  if (value === null) {
    // Dropped and PSR-rated rows explain themselves; for the rest the dash is missing history.
    return <span className="change none" title={clan.leaderboard === 'current' ? t('clans.change.none') : undefined}>—</span>
  }
  if (value === 0) return <span className="change flat">0</span>
  return (
    <span className={`change ${value > 0 ? 'up' : 'down'}`}>
      {value > 0 ? '+' : '−'}{fmtInt(Math.abs(value))}
    </span>
  )
}

function ClanRow({ clan, onOpen }: { clan: ClanListEntry; onOpen: ReturnType<typeof useRowLink> }) {
  const href = `/clans/${clan.coreTag}`
  const medal = clan.rank <= 3 && clan.leaderboard === 'current'
  const estimate = clan.leaderboard === null
  const dropped = clan.leaderboard === 'dropped'
  const showName = clan.name !== null && clan.name.toLowerCase() !== clan.displayTag.toLowerCase()
  const classes = ['row-link', medal && clan.rank === 1 ? 'is-leader' : '', dropped ? 'is-dropped' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <tr
      className={classes}
      onClick={(event) => onOpen(event, href)}
      title={dropped ? t('clans.dropped.title', { time: fmtDateTime(clan.lastSeenAt) }) : undefined}
    >
      <td className="col-rank">
        {medal ? <span className={`medal m${clan.rank}`}>{clan.rank}</span> : fmtInt(clan.rank)}
      </td>
      <td className="clan-cell">
        <Link to={href}>{clan.displayTag}</Link>
        {showName && <span className="clan-cell__name">{clan.name}</span>}
      </td>
      <td className="num" title={estimate ? t('clans.psr.title') : undefined}>
        <span className={`rating${estimate ? ' is-estimate' : ''}`}>
          {estimate ? '≈ ' : ''}{fmtInt(clan.totalRating)}
        </span>
        {/* On a phone the 24 h column folds under the rating; zero and "no data" are left out. */}
        {clan.delta24h !== null && clan.delta24h !== 0 && (
          <span className="rating-change"><Change clan={clan} /></span>
        )}
      </td>
      <td className="num col-change"><Change clan={clan} /></td>
      <td className="num col-battles">{fmtInt(clan.seasonBattles)}</td>
      <td className="num col-wr" title={seasonWinTitle(clan)}>{fmtPercent(seasonWinRate(clan))}</td>
      <td className="num col-kd" title={seasonKdTitle(clan)}>{fmtRatio(seasonKd(clan))}</td>
      <td className="num col-members">{fmtInt(clan.members)}</td>
    </tr>
  )
}

function TierHeader({ tier }: { tier: RewardTier }) {
  const reward = t('clan.reward.top', { n: tier.top })
  return (
    <tr className="tier-row">
      <th colSpan={COLUMNS} scope="rowgroup" title={t('clans.tier.title', { from: tier.from, to: tier.top, reward })}>
        <span className="tier-label">{reward}</span>
      </th>
    </tr>
  )
}

/** Rows split by reward tier: places 1–3 open the table without a header. */
function tierGroups(
  clans: readonly ClanListEntry[],
  withTiers: boolean,
): { tier: RewardTier | null; clans: ClanListEntry[] }[] {
  const groups: { tier: RewardTier | null; clans: ClanListEntry[] }[] = [{ tier: null, clans: [] }]
  for (const clan of clans) {
    // Only squadrons in the leaderboard compete for its rewards; the ranking puts them first.
    const tier = withTiers && clan.leaderboard === 'current'
      ? REWARD_TIERS.find((candidate) => candidate.from === clan.rank)
      : undefined
    if (tier !== undefined) groups.push({ tier, clans: [] })
    groups[groups.length - 1]!.clans.push(clan)
  }
  return groups.filter((group) => group.clans.length > 0)
}

type ClansResponse = Awaited<ReturnType<typeof fetchClans>>

export function ClansPage() {
  const openRow = useRowLink()
  const [searchParams, setSearchParams] = useSearchParams()
  // 1-based page and the query in the URL: they survive a reload, Back and a shared link.
  const pageParam = Number(searchParams.get('page') ?? '1')
  const page = Number.isSafeInteger(pageParam) && pageParam >= 1 ? pageParam : 1
  const query = (searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  const [draft, setDraft] = useState(query)
  // The query this page last wrote to the URL: other URL changes (Back, a link) reach the field.
  const writtenQuery = useRef(query)
  const [loaded, setLoaded] = useState<{ page: number; query: string; body: ClansResponse } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set by the pager under the table: the new page opens at the table's top.
  const scrollOnLoad = useRef(false)

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

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchClans({ ...(query !== '' ? { query } : {}), offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE })
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
        setLoaded({ page, query, body })
      })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [page, query, setSearchParams])

  // Before paint, so the old scroll position does not flash with the new page.
  useLayoutEffect(() => {
    if (loaded === null || !scrollOnLoad.current) return
    scrollOnLoad.current = false
    tableRef.current?.scrollIntoView({ block: 'start' })
  }, [loaded])

  const goToPage = (next: number): void => {
    scrollOnLoad.current = true
    setSearchParams((params) => {
      const updated = new URLSearchParams(params)
      if (next <= 1) updated.delete('page')
      else updated.set('page', String(next))
      return updated
    })
  }

  const clearSearch = (): void => {
    setDraft('')
    inputRef.current?.focus()
  }

  const body = loaded?.body ?? null
  // A failed request leaves the previous page in place, under the error.
  const busy = loaded !== null && error === null && (loaded.page !== page || loaded.query !== query)

  let content: ReactNode = null
  if (loaded === null || body === null) {
    content = error === null ? <Loading /> : null
  } else if (body.total === 0 && loaded.query === '') {
    content = (
      <>
        {error !== null && <ErrorNotice error={error} />}
        <div className="notice">{t('clans.empty')}</div>
      </>
    )
  } else {
    const searching = loaded.query !== ''
    const offset = (loaded.page - 1) * PAGE_SIZE
    const meta = searching
      ? body.total > 0 ? tp('clans.found', body.total) : null
      : [
          t('clans.places', { from: fmtInt(offset + 1), to: fmtInt(offset + body.clans.length), total: fmtInt(body.total) }),
          ...(body.updatedAt !== null ? [t('clans.updated', { time: fmtCrawlTime(body.updatedAt) })] : []),
        ].join(' · ')
    content = (
      <div ref={tableRef} className={`card clans-table${busy ? ' is-busy' : ''}`} aria-busy={busy}>
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
              maxLength={MAX_QUERY_LENGTH}
              autoComplete="off"
              spellCheck={false}
            />
            {draft !== '' && (
              <button type="button" className="clan-search__clear" aria-label={t('clans.search.clear')} onClick={clearSearch}>
                ×
              </button>
            )}
          </div>
        </div>
        {error !== null && <div className="clans-table__error"><ErrorNotice error={error} /></div>}
        {body.clans.length === 0 ? (
          <div className="clans-empty">{t('clans.search.empty', { q: loaded.query })}</div>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="col-rank">#</th>
                  <th className="clan-cell">{t('clans.col.clan')}</th>
                  <th className="num">{t('clans.col.rating')}</th>
                  <th className="num col-change" title={t('clans.col.change.title')}>{t('clans.col.change')}</th>
                  <th className="num col-battles">{t('metric.battles')}</th>
                  <th className="num col-wr">{t('metric.winrate')}</th>
                  <th className="num col-kd" title={t('metric.kd')}>{t('clans.col.kd')}</th>
                  <th className="num col-members">{t('clans.col.members')}</th>
                </tr>
              </thead>
              {tierGroups(body.clans, !searching).map((group) => (
                <tbody key={group.clans[0]!.coreTag}>
                  {group.tier !== null && <TierHeader tier={group.tier} />}
                  {group.clans.map((clan) => <ClanRow key={clan.coreTag} clan={clan} onOpen={openRow} />)}
                </tbody>
              ))}
            </table>
          </div>
        )}
        <div className="clans-table__foot">
          <Pager page={loaded.page} pages={Math.max(1, Math.ceil(body.total / PAGE_SIZE))} onChange={goToPage} />
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
      {body !== null && <SeasonPanel context={body.season} official={body.officialSeason} />}
      {content}
    </>
  )
}
