import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  fetchClanHistory,
  fetchClans,
  type ClanHistoryPoint,
  type ClanListEntry,
} from '../api'
import { fmtDateTime, fmtInt, fmtPercent, fmtRatio } from '../lib/format'
import { t } from '../i18n'
import { SeasonPanel } from '../components/SeasonPanel'
import { BarTrack, DeltaPill, ErrorNotice, Loading, Pager, SecHead, useRowLink } from '../components/ui'

/* Мини-спарклайн суммы ПКР на витринной карточке клана (как в макете). */
function Sparkline({ points, gold }: { points: ClanHistoryPoint[]; gold: boolean }) {
  if (points.length < 2) return null
  const t0 = points[0]!.t
  const t1 = points[points.length - 1]!.t
  const values = points.map((point) => point.total)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spanT = Math.max(1, t1 - t0)
  const spanV = Math.max(1, max - min)
  const coords = points.map((point) => {
    const x = ((point.t - t0) / spanT) * 260
    const y = 40 - ((point.total - min) / spanV) * 34
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const color = gold ? '#f5bc4a' : '#b8b3ac'
  const id = gold ? 'clan-spark-gold' : 'clan-spark-gray'
  return (
    <svg viewBox="0 0 260 44" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 44, marginTop: 12 }} aria-label={t('clan.dynamics')}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,44 ${coords.join(' ')} 260,44`} fill={`url(#${id})`} />
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="2"
        {...(gold ? { filter: 'drop-shadow(0 0 4px rgba(245, 188, 74, 0.55))' } : {})}
      />
    </svg>
  )
}

/* Доля побед в сезоне по официальному лидерборду; null — данных нет. */
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

/* Фраги на смерть за сезон по лидерборду: воздух и земля вместе. */
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

function ClanHeroCard({ clan, rank, leaderRating, history }: {
  clan: ClanListEntry
  rank: number
  leaderRating: number
  history: ClanHistoryPoint[] | undefined
}) {
  const leader = rank === 1
  return (
    <Link
      to={`/clans/${clan.coreTag}`}
      className="card hoverable"
      style={{
        position: 'relative', overflow: 'hidden', display: 'block', color: 'inherit', marginBottom: 0,
        ...(leader ? { background: 'linear-gradient(150deg, rgba(245,188,74,0.14), rgba(31,29,36,0.9) 55%), var(--elevated)', borderColor: 'rgba(245,188,74,0.35)' } : {}),
      }}
    >
      <span className={`ghost-num${leader ? '' : ' gray'}`}>{rank}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          className="avatar-tile"
          style={{ width: 40, height: 40, fontSize: 15, borderRadius: 10, ...(leader ? {} : { background: 'linear-gradient(135deg, var(--line2), var(--muted))', color: 'var(--ink)', boxShadow: 'none' }) }}
        >
          {clan.coreTag.slice(0, 2).toUpperCase()}
        </span>
        <span style={{ minWidth: 0 }}>
          <b style={{ display: 'block', fontSize: 17, color: 'var(--ink)' }}>{clan.displayTag}</b>
          <span className="muted small">{clan.name ?? '—'}</span>
        </span>
        {leader && <span className="chip accent" style={{ marginLeft: 'auto' }}>{t('clans.leader')}</span>}
      </div>
      <div className="clan-hero__kpis">
        <span className="clan-hero__kpi">
          <span className="v">
            {fmtInt(clan.totalRating)}
            {clan.delta30d !== null && <span style={{ marginLeft: 6, verticalAlign: 'middle' }}><DeltaPill value={clan.delta30d} /></span>}
          </span>
          <span className="l">{t('clans.sumDelta')}</span>
        </span>
        <span className="clan-hero__kpi" title={seasonWinTitle(clan)}>
          <span className="v">{fmtPercent(seasonWinRate(clan))}</span>
          <span className="l">{t('clans.winRate')}</span>
        </span>
        <span className="clan-hero__kpi">
          <span className="v">{fmtInt(clan.members)}</span>
          <span className="l">{t('clans.members')}</span>
        </span>
      </div>
      {history !== undefined && history.length >= 2 ? (
        <Sparkline points={history} gold={leader} />
      ) : (
        <div style={{ marginTop: 12 }}>
          <BarTrack
            fraction={clan.totalRating / leaderRating}
            {...(leader ? { tone: 'glow' as const } : {})}
            title={t('home.share.leader', { pct: ((clan.totalRating / leaderRating) * 100).toFixed(0) })}
          />
        </div>
      )}
    </Link>
  )
}

const PAGE_SIZE = 100

type ClansResponse = Awaited<ReturnType<typeof fetchClans>>

export function ClansPage() {
  const openRow = useRowLink()
  const [searchParams, setSearchParams] = useSearchParams()
  // 1-based page in the URL: it survives a reload, Back and a shared link.
  const pageParam = Number(searchParams.get('page') ?? '1')
  const page = Number.isSafeInteger(pageParam) && pageParam >= 1 ? pageParam : 1
  const [loaded, setLoaded] = useState<{ page: number; body: ClansResponse } | null>(null)
  const [histories, setHistories] = useState<Record<string, ClanHistoryPoint[]>>({})
  const [error, setError] = useState<unknown>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  // Set by the pager under the table: the new page opens at the table's top.
  const scrollOnLoad = useRef(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchClans({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE })
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
        setLoaded({ page, body })
      })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [page, setSearchParams])

  // Sparklines only for the two hero cards of the first page, one request each.
  const heroTags = loaded?.page === 1 ? loaded.body.clans.slice(0, 2).map((clan) => clan.coreTag) : []
  const heroKey = heroTags.join(' ')
  useEffect(() => {
    if (heroKey === '') return
    let cancelled = false
    for (const coreTag of heroKey.split(' ')) {
      fetchClanHistory(coreTag, 90)
        .then((history) => {
          if (!cancelled) setHistories((prev) => ({ ...prev, [coreTag]: history.points }))
        })
        // The sparkline is decorative: the card is complete without it, so no error is shown.
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [heroKey])

  // Before paint: the first page's hero cards vanish on page 2 and would shift the table.
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

  const body = loaded?.body ?? null
  const clans = body?.clans ?? null
  const offset = ((loaded?.page ?? 1) - 1) * PAGE_SIZE
  const leaderRating = Math.max(body?.leaderRating ?? 1, 1)
  const busy = loaded !== null && loaded.page !== page

  return (
    <>
      <div className="page-head">
        <h1>{t('clans.title')}</h1>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      {body !== null && <SeasonPanel context={body.season} official={body.officialSeason} />}
      {error !== null ? null : clans === null || body === null ? <Loading /> : clans.length === 0 ? (
        <div className="notice">{t('clans.empty')}</div>
      ) : (
        <>
          {loaded?.page === 1 && (
            <div className="grid-2" style={{ marginBottom: 16 }}>
              {clans.slice(0, 2).map((clan) => (
                <ClanHeroCard
                  key={clan.coreTag}
                  clan={clan}
                  rank={clan.rank}
                  leaderRating={leaderRating}
                  history={histories[clan.coreTag]}
                />
              ))}
            </div>
          )}

          <div
            ref={tableRef}
            className="card clans-table"
            style={{ padding: 0, ...(busy ? { opacity: 0.6 } : {}) }}
            aria-busy={busy}
          >
            <div className="clans-table__head">
              <SecHead
                title={t('clans.fullRating')}
                hint={t('clans.fullRating.hint', {
                  from: fmtInt(offset + 1),
                  to: fmtInt(offset + clans.length),
                  total: fmtInt(body.total),
                })}
              />
            </div>
            <div className="tbl-scroll" style={{ margin: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th className="clan-cell">{t('clans.col.clan')}</th>
                    <th>{t('clans.col.sum')}</th>
                    <th className="num">{t('clans.col.winRate')}</th>
                    <th className="num col-kd" title={t('metric.kd')}>{t('clans.col.kd')}</th>
                    <th className="num col-members">{t('clans.col.members')}</th>
                    <th className="num col-delta">{t('clans.col.delta30')}</th>
                    <th className="col-updated">{t('clans.col.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {clans.map((clan) => (
                    <tr key={clan.coreTag} className="row-link" onClick={(event) => openRow(event, `/clans/${clan.coreTag}`)}>
                      <td className="rank">{clan.rank}</td>
                      <td className="clan-cell">
                        <Link to={`/clans/${clan.coreTag}`}>{clan.displayTag}</Link>
                        {clan.name && <span className="clan-cell__name">{clan.name}</span>}
                      </td>
                      <td>
                        <div className="rating-cell">
                          <span className="rating-cell__value">{fmtInt(clan.totalRating)}</span>
                          <BarTrack fraction={clan.totalRating / leaderRating} {...(clan.rank === 1 ? { tone: 'glow' as const } : {})} />
                        </div>
                      </td>
                      <td className="num" title={seasonWinTitle(clan)}>{fmtPercent(seasonWinRate(clan))}</td>
                      <td className="num col-kd" title={seasonKdTitle(clan)}>{fmtRatio(seasonKd(clan))}</td>
                      <td className="num col-members">{fmtInt(clan.members)}</td>
                      <td className="num col-delta">{clan.delta30d === null ? <span className="muted">—</span> : <DeltaPill value={clan.delta30d} />}</td>
                      <td className="muted col-updated" style={{ fontWeight: 400 }}>{fmtDateTime(clan.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted small clans-table__foot">
              <Pager page={page} pages={Math.max(1, Math.ceil(body.total / PAGE_SIZE))} onChange={goToPage} />
              <span>{t('clans.footnote')}</span>
            </div>
          </div>
        </>
      )}
    </>
  )
}
