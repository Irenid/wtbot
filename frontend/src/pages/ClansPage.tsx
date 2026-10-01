import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchClanHistory,
  fetchClans,
  type ClanHistoryPoint,
  type ClanListEntry,
  type ClanSeasonContext,
  type OfficialClanSeason,
} from '../api'
import { fmtDateTime, fmtInt, fmtPercent, fmtRatio } from '../lib/format'
import { t } from '../i18n'
import { SeasonPanel } from '../components/SeasonPanel'
import { BarTrack, DeltaPill, ErrorNotice, Loading, SecHead } from '../components/ui'

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
      <div style={{ display: 'flex', gap: 20, marginTop: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span>
          <span style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {fmtInt(clan.totalRating)}
            {clan.delta30d !== null && <span style={{ marginLeft: 6, verticalAlign: 'middle' }}><DeltaPill value={clan.delta30d} /></span>}
          </span>
          <span className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{t('clans.sumDelta')}</span>
        </span>
        <span title={seasonWinTitle(clan)}>
          <span style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtPercent(seasonWinRate(clan))}</span>
          <span className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{t('clans.winRate')}</span>
        </span>
        <span>
          <span style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(clan.members)}</span>
          <span className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{t('clans.members')}</span>
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

export function ClansPage() {
  const [clans, setClans] = useState<ClanListEntry[] | null>(null)
  const [season, setSeason] = useState<ClanSeasonContext | null>(null)
  const [officialSeason, setOfficialSeason] = useState<OfficialClanSeason | null>(null)
  const [histories, setHistories] = useState<Record<string, ClanHistoryPoint[]>>({})
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    fetchClans()
      .then((body) => {
        if (cancelled) return
        setSeason(body.season)
        setOfficialSeason(body.officialSeason)
        setClans(body.clans)
        // Спарклайны только для двух витринных карточек — по одному запросу.
        for (const clan of body.clans.slice(0, 2)) {
          fetchClanHistory(clan.coreTag, 90)
            .then((history) => {
              if (!cancelled) setHistories((prev) => ({ ...prev, [clan.coreTag]: history.points }))
            })
            // Спарклайн декоративный: без него карточка остаётся полной, ошибку не показываем.
            .catch(() => {})
        }
      })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [])

  const leaderRating = Math.max(clans?.[0]?.totalRating ?? 1, 1)
  const updatedAt = clans?.[0]?.lastSeenAt ?? null

  return (
    <>
      <div className="page-head">
        <h1>{t('clans.title')}</h1>
        <span className="muted small">
          {t('clans.subtitle')}
          {updatedAt !== null && <> · {t('common.updated', { when: fmtDateTime(updatedAt) })}</>}
        </span>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      {season !== null && <SeasonPanel context={season} official={officialSeason} />}
      {clans === null ? <Loading /> : clans.length === 0 ? (
        <div className="notice">{t('clans.empty')}</div>
      ) : (
        <>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            {clans.slice(0, 2).map((clan, index) => (
              <ClanHeroCard
                key={clan.coreTag}
                clan={clan}
                rank={index + 1}
                leaderRating={leaderRating}
                history={histories[clan.coreTag]}
              />
            ))}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px 0' }}>
              <SecHead title={t('clans.fullRating')} hint={t('clans.fullRating.hint', { n: clans.length })} />
            </div>
            <div className="tbl-scroll" style={{ margin: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th><th>{t('clans.col.clan')}</th>
                    <th style={{ width: '26%' }}>{t('clans.col.sum')}</th>
                    <th className="num">{t('clans.col.winRate')}</th>
                    <th className="num" title={t('metric.kd')}>{t('clans.col.kd')}</th>
                    <th className="num">{t('clans.col.members')}</th>
                    <th className="num">{t('clans.col.delta30')}</th>
                    <th>{t('clans.col.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {clans.map((clan, index) => (
                    <tr key={clan.coreTag}>
                      <td className="rank">{index + 1}</td>
                      <td>
                        <Link to={`/clans/${clan.coreTag}`}>{clan.displayTag}</Link>
                        {clan.name && <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>{clan.name}</span>}
                      </td>
                      <td style={{ minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 52 }}>{fmtInt(clan.totalRating)}</span>
                          <div style={{ flex: 1 }}>
                            <BarTrack fraction={clan.totalRating / leaderRating} {...(index === 0 ? { tone: 'glow' as const } : {})} />
                          </div>
                        </div>
                      </td>
                      <td className="num" title={seasonWinTitle(clan)}>{fmtPercent(seasonWinRate(clan))}</td>
                      <td className="num" title={seasonKdTitle(clan)}>{fmtRatio(seasonKd(clan))}</td>
                      <td className="num">{fmtInt(clan.members)}</td>
                      <td className="num">{clan.delta30d === null ? <span className="muted">—</span> : <DeltaPill value={clan.delta30d} />}</td>
                      <td className="muted" style={{ fontWeight: 400 }}>{fmtDateTime(clan.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted small" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
              {t('clans.footnote')}
            </div>
          </div>
        </>
      )}
    </>
  )
}
