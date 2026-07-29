import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
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
import { SeasonPanel } from '../components/SeasonPanel'
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

function niceActivityTickStep(maxValue: number): number {
  if (maxValue <= 0) return 1
  const roughStep = maxValue / 5
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalized = roughStep / magnitude
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return Math.max(1, Math.ceil(niceFactor * magnitude))
}

/* Недельная активность: читаемая шкала и семь адаптивных столбцов. */
function WeekActivity({ stats }: { stats: SiteStats }) {
  const battlesByDay = new Map(stats.byDay.map((point) => [point.day, point.battles]))
  const days: { day: string; battles: number }[] = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    days.push({ day: date, battles: battlesByDay.get(date) ?? 0 })
  }
  const maxBattles = Math.max(0, ...days.map((point) => point.battles))
  const tickStep = niceActivityTickStep(maxBattles)
  const axisMax = Math.max(tickStep * 5, Math.ceil(maxBattles / tickStep) * tickStep)
  const ticks = Array.from(
    { length: Math.round(axisMax / tickStep) + 1 },
    (_, index) => axisMax - index * tickStep,
  )
  const peak = days.reduce((best, point) => (point.battles > best.battles ? point : best))

  return (
    <div className="card hoverable week-activity-card">
      <SecHead title={t('home.activity')} hint={t('home.activity.hint')} />
      <div className="week-chart" role="group" aria-label={t('a11y.activityWeek')}>
        <div className="week-chart__body">
          <div className="week-chart__axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick}
                className="week-chart__axis-label"
                style={{ '--tick-position': `${(1 - tick / axisMax) * 100}%` } as CSSProperties}
              >
                {fmtInt(tick)}
              </span>
            ))}
          </div>
          <div className="week-chart__plot">
            <div className="week-chart__grid" aria-hidden="true">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="week-chart__grid-line"
                  style={{ '--tick-position': `${(1 - tick / axisMax) * 100}%` } as CSSProperties}
                />
              ))}
            </div>
            <ol className="week-chart__bars">
              {days.map((point, index) => {
                const barHeight = (point.battles / axisMax) * 100
                const isPeak = point.battles > 0 && point.day === peak.day
                const isToday = index === days.length - 1
                const label = `${weekdayShort(point.day)}: ${tp('common.battles', point.battles)}`
                return (
                  <li
                    key={point.day}
                    className={`week-chart__day${isPeak ? ' is-peak' : ''}${isToday ? ' is-today' : ''}${point.battles === 0 ? ' is-empty' : ''}`}
                    style={{
                      '--bar-height': `${barHeight}%`,
                      '--bar-delay': `${index * 45}ms`,
                    } as CSSProperties}
                    aria-label={label}
                    aria-current={isToday ? 'date' : undefined}
                    tabIndex={0}
                    title={label}
                  >
                    <div className="week-chart__bar-slot" aria-hidden="true">
                      <span className="week-chart__bar-value">{fmtInt(point.battles)}</span>
                      <span className="week-chart__bar" />
                    </div>
                    <time className="week-chart__weekday" dateTime={point.day} aria-hidden="true">
                      {weekdayShort(point.day)}
                    </time>
                  </li>
                )
              })}
            </ol>
          </div>
        </div>
      </div>
      {peak.battles > 0 && (
        <div className="week-chart__summary">
          <span className="week-chart__summary-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <path d="M4 14.5 8.2 10l3 2.8L16 6.5" />
              <path d="M12.5 6.5H16V10" />
            </svg>
          </span>
          <span>
            {t('home.activity.peak', { day: weekdayShort(peak.day) })}{' '}
            <strong>{tp('common.battles', peak.battles)}</strong>
          </span>
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
    fetchClans().then((body) => { if (!cancelled) setClans(body.clans.slice(0, 8)) }).catch(() => {})
    fetchBattles({ limit: 9 }).then((body) => { if (!cancelled) setRecent(body.battles) }).catch(() => {})
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

      {stats !== null && <SeasonPanel context={stats.season} compact />}

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
        <div className="card hoverable home-feed-card">
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

        <div className="card hoverable home-feed-card">
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
