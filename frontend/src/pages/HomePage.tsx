import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  fetchBattles,
  fetchClans,
  fetchSiteStats,
  searchPlayers,
  SiteApiError,
  type BattleListEntry,
  type ClanListEntry,
  type PlayerSearchEntry,
  type SiteStats,
} from '../api'
import { t, tp } from '../i18n'
import type { MessageKey } from '../i18n/ru'
import { battleVersusLabel, fmtDateTime, fmtInt, modeLabel, weekdayShort } from '../lib/format'
import { BarTrack, Chip, ErrorNotice, Loading, RankBadge, SecHead } from '../components/ui'

function playerHref(entry: PlayerSearchEntry): string | null {
  if (entry.wtUserId) return `/players/${entry.wtUserId}`
  if (entry.identityId !== null) return `/players/id/${entry.identityId}`
  return null
}

const ORIGIN_LABELS: Record<PlayerSearchEntry['origin'], MessageKey> = {
  identity: 'home.origin.identity',
  alias: 'home.origin.alias',
  replay: 'home.origin.replay',
}

/* Недельная активность из макета: золотые столбики «боёв в день». */
function WeekActivity({ stats }: { stats: SiteStats }) {
  const days: { day: string; battles: number }[] = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    days.push({ day: date, battles: stats.byDay.find((point) => point.day === date)?.battles ?? 0 })
  }
  const max = Math.max(1, ...days.map((point) => point.battles))
  const peak = days.reduce((best, point) => (point.battles > best.battles ? point : best))
  return (
    <div className="card hoverable">
      <SecHead title={t('home.activity')} hint={t('home.activity.hint')} />
      <svg viewBox="0 0 700 120" style={{ width: '100%', height: 130, display: 'block' }} preserveAspectRatio="none" aria-label={t('a11y.activityWeek')}>
        <defs>
          <linearGradient id="week-bars" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffd873" stopOpacity="0.95" />
            <stop offset="1" stopColor="#e89b1f" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <line x1="0" y1="110" x2="700" y2="110" stroke="var(--line)" strokeWidth="1" />
        {days.map((point, index) => {
          const height = point.battles === 0 ? 3 : Math.max(6, (point.battles / max) * 84)
          const x = 22 + index * 96
          return point.battles === 0
            ? <rect key={point.day} x={x} y={107} width="54" height="3" rx="1.5" fill="var(--line)" />
            : <rect key={point.day} x={x} y={110 - height} width="54" height={height} rx="5" fill="url(#week-bars)">
                <title>{`${point.day}: ${point.battles}`}</title>
              </rect>
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--muted)', padding: '6px 4px 0' }}>
        {days.map((point) => <span key={point.day}>{weekdayShort(point.day)}</span>)}
      </div>
      {peak.battles > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ink2)' }}>
          {t('home.activity.peak', { day: weekdayShort(peak.day) })} <b style={{ color: 'var(--ink)' }}>{tp('common.battles', peak.battles)}</b>
        </div>
      )}
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<PlayerSearchEntry[] | null>(null)
  const [suggestions, setSuggestions] = useState<PlayerSearchEntry[]>([])
  const [error, setError] = useState<unknown>(null)
  const [clans, setClans] = useState<ClanListEntry[] | null>(null)
  const [recent, setRecent] = useState<BattleListEntry[] | null>(null)
  const [stats, setStats] = useState<SiteStats | null>(null)
  // Номер поколения запросов подсказок: устаревшие ответы отбрасываются.
  const suggestSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    fetchClans().then((body) => { if (!cancelled) setClans(body.clans.slice(0, 6)) }).catch(() => {})
    fetchBattles({ limit: 8 }).then((body) => { if (!cancelled) setRecent(body.battles) }).catch(() => {})
    fetchSiteStats().then((body) => { if (!cancelled) setStats(body) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Живые подсказки из макета: топ-5 совпадений через 300 мс после ввода.
  useEffect(() => {
    const normalized = query.trim()
    const seq = ++suggestSeq.current
    if (normalized.length < 2) {
      setSuggestions([])
      return
    }
    const timer = window.setTimeout(() => {
      searchPlayers(normalized, 5)
        .then((body) => { if (seq === suggestSeq.current) setSuggestions(body.players) })
        .catch(() => { if (seq === suggestSeq.current) setSuggestions([]) })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized.length < 2) return
    setBusy(true)
    setError(null)
    suggestSeq.current += 1
    setSuggestions([])
    try {
      const body = await searchPlayers(normalized)
      setResults(body.players)
      // Единственное точное совпадение открываем сразу — меньше кликов.
      const exact = body.players.filter((entry) => entry.nick.toLowerCase() === normalized.toLowerCase())
      const single = exact.length === 1 ? exact[0] : body.players.length === 1 ? body.players[0] : undefined
      if (single) {
        const href = playerHref(single)
        if (href) navigate(href)
      }
    } catch (err) {
      setResults(null)
      setError(err instanceof SiteApiError ? err : new Error(t('apiError.searchFailed')))
    } finally {
      setBusy(false)
    }
  }

  const leaderRating = Math.max(clans?.[0]?.totalRating ?? 1, 1)

  return (
    <>
      <section className="hero">
        {stats?.lastBattleAt != null && (
          <div className="live-badge">
            <span className="dot" />
            {t('home.lastBattle', { when: fmtDateTime(stats.lastBattleAt) })}
          </div>
        )}
        <h1>{t('home.title.before')} <span className="gold">War Thunder</span><br />{t('home.title.after')}</h1>
        <p>{t('home.subtitle')}</p>
        <div className="hero-search">
          <form onSubmit={submit}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ margin: 'auto 2px auto 10px', flex: 'none' }} aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="var(--muted)" strokeWidth="2" />
              <path d="M20 20l-3.6-3.6" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('home.search.placeholder')}
              maxLength={64}
              autoFocus
            />
            <button className="btn gold" type="submit" disabled={busy || query.trim().length < 2}>
              {busy ? t('home.search.busy') : t('home.search.submit')}
            </button>
          </form>
          {suggestions.length > 0 && (
            <div className="suggest-box">
              {suggestions.map((entry) => {
                const href = playerHref(entry)
                const row = (
                  <>
                    <span className="avatar-tile" style={{ width: 30, height: 30, fontSize: 12, borderRadius: 8, boxShadow: 'none' }}>
                      {entry.nick.slice(0, 1).toUpperCase()}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <b style={{ fontWeight: 600 }}>{entry.nick}</b>{' '}
                      <span className="muted" style={{ fontSize: 12 }}>{t(ORIGIN_LABELS[entry.origin])}</span>
                    </span>
                    <span className="muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      {entry.wtUserId ? t('player.id', { id: entry.wtUserId }) : '—'}
                    </span>
                  </>
                )
                return href
                  ? <Link key={`${entry.origin}:${entry.nick}`} to={href} className="suggest-row">{row}</Link>
                  : <span key={`${entry.origin}:${entry.nick}`} className="suggest-row">{row}</span>
              })}
            </div>
          )}
        </div>
        {clans !== null && clans.length > 0 && (
          <div className="quick-chips">
            <span style={{ whiteSpace: 'nowrap' }}>{t('home.topClans')}</span>
            {clans.slice(0, 3).map((clan) => (
              <Link key={clan.coreTag} to={`/clans/${clan.coreTag}`} className="chip">{clan.displayTag}</Link>
            ))}
          </div>
        )}
      </section>

      {stats !== null && (
        <section className="stat-tiles" style={{ marginBottom: 26 }}>
          <div className="stat-tile"><div className="v">{fmtInt(stats.players)}</div><div className="l">{t('home.stats.players')}</div></div>
          <div className="stat-tile"><div className="v">{fmtInt(stats.clans)}</div><div className="l">{tp('home.stats.clans', stats.clans)}</div></div>
          <div className="stat-tile"><div className="v">{fmtInt(stats.battlesTotal)}</div><div className="l">{t('home.stats.battlesTotal')}</div></div>
          <div className="stat-tile"><div className="v">{fmtInt(stats.battlesWeek)}</div><div className="l">{t('home.stats.battlesWeek')}</div></div>
        </section>
      )}

      {error !== null && <ErrorNotice error={error} />}
      {results !== null && results.length === 0 && (
        <div className="notice">{t('home.results.empty')}</div>
      )}
      {results !== null && results.length > 0 && (
        <div className="card" style={{ animation: 'riseIn 0.3s ease both' }}>
          <SecHead title={t('home.results')} hint={`${results.length}`} />
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr><th>{t('home.results.nick')}</th><th>WT id</th><th>{t('home.results.source')}</th><th>{t('home.results.platform')}</th></tr>
              </thead>
              <tbody>
                {results.map((entry) => {
                  const href = playerHref(entry)
                  return (
                    <tr key={`${entry.origin}:${entry.identityId ?? entry.wtUserId}:${entry.nick}`}>
                      <td>{href ? <Link to={href}>{entry.nick}</Link> : entry.nick}</td>
                      <td className="num">{entry.wtUserId ?? '—'}</td>
                      <td><Chip>{t(ORIGIN_LABELS[entry.origin])}</Chip></td>
                      <td className="muted">{entry.platform ?? 'pc'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card hoverable">
          <SecHead title={t('home.card.topClans')} hint={t('home.card.topClans.hint')} />
          {clans === null ? <Loading /> : clans.length === 0 ? (
            <div className="muted small">{t('home.card.clans.empty')}</div>
          ) : (
            <>
              {clans.map((clan, index) => (
                <Link key={clan.coreTag} to={`/clans/${clan.coreTag}`} className="row-item" style={{ display: 'block' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <RankBadge rank={index + 1} />
                    <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{clan.displayTag}</span>
                    {clan.name && <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clan.name}</span>}
                    <span style={{ marginLeft: 'auto', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>{fmtInt(clan.totalRating)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <div style={{ flex: 1 }}>
                      <BarTrack fraction={clan.totalRating / leaderRating} title={t('home.share.leader', { pct: ((clan.totalRating / leaderRating) * 100).toFixed(0) })} />
                    </div>
                    <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{tp('common.members', clan.members)}</span>
                  </div>
                </Link>
              ))}
              <div className="small" style={{ marginTop: 12 }}><Link to="/clans" style={{ fontWeight: 600 }}>{t('home.allClans')}</Link></div>
            </>
          )}
        </div>

        <div className="card hoverable">
          <SecHead title={t('home.card.recent')} />
          {recent === null ? <Loading /> : recent.length === 0 ? (
            <div className="muted small">{t('home.card.recent.empty')}</div>
          ) : (
            <>
              {recent.map((battle) => {
                const versus = battleVersusLabel(battle.teams)
                return (
                  <Link key={battle.sessionId} to={`/battles/${battle.sessionId}`} className="row-item">
                    <span className="title">
                      {versus ?? battle.missionName}
                      <span className="sub">
                        {versus !== null && `${battle.missionName} · `}
                        {modeLabel(battle.gameMode)} · {tp('common.players', battle.playerCount)} · {t('common.minutes.short', { n: Math.round(battle.durationSec / 60) })}
                      </span>
                    </span>
                    <span className="end">{fmtDateTime(battle.startTime)}</span>
                  </Link>
                )
              })}
              <div className="small" style={{ marginTop: 12 }}><Link to="/battles" style={{ fontWeight: 600 }}>{t('home.allBattles')}</Link></div>
            </>
          )}
        </div>

        {stats !== null && stats.byDay.length > 0 && <WeekActivity stats={stats} />}
      </div>
    </>
  )
}
