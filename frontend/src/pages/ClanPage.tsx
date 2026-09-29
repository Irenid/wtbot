import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fetchClan, fetchClanHistory, SiteApiError, type ClanDetail, type ClanHistoryPoint } from '../api'
import { battleVersusLabel, fmtDateTime, fmtInt } from '../lib/format'
import { Chip, DeltaPill, DonutKpi, ErrorNotice, Kpi, Loading, ResultBadge, SecHead, SegControl } from '../components/ui'
import { SeasonPanel } from '../components/SeasonPanel'
import { TimeChart } from '../components/TimeChart'
import { t, tp, useLocale } from '../i18n'

/* Условные ранги по ПКР — пороги видны в подсказке, чтобы не выдавать их за игровые. */
function TierBadge({ rating }: { rating: number }) {
  const tier = rating >= 1700
    ? { label: t('clan.tier.elite'), tone: 'accent' as const }
    : rating >= 1400
      ? { label: t('clan.tier.good'), tone: 'ok' as const }
      : { label: t('clan.tier.normal'), tone: undefined }
  return (
    <span title={t('clan.tier.tooltip')} style={{ marginLeft: 6 }}>
      <Chip {...(tier.tone ? { tone: tier.tone } : {})}>{tier.label}</Chip>
    </span>
  )
}

export function ClanPage() {
  const { coreTag = '' } = useParams()
  const { locale } = useLocale()
  const [detail, setDetail] = useState<ClanDetail | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [history, setHistory] = useState<ClanHistoryPoint[] | null>(null)
  const [historyTruncated, setHistoryTruncated] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [battleFilter, setBattleFilter] = useState<'all' | 'w' | 'l'>('all')
  const [error, setError] = useState<unknown>(null)

  // Подписи пересобираются при смене языка — поэтому внутри компонента, а не на уровне модуля.
  const PERIODS = useMemo(() => [
    { value: '7', label: t('common.days.7') },
    { value: '30', label: t('common.days.30') },
    { value: '90', label: t('common.days.90') },
  ] as const, [locale])

  const BATTLE_FILTERS = useMemo(() => [
    { value: 'all', label: t('common.all') },
    { value: 'w', label: t('battles.filter.wins') },
    { value: 'l', label: t('battles.filter.losses') },
  ] as const, [locale])

  // Другой клан — прежние данные не показываем ни мгновения.
  useEffect(() => {
    setDetail(null)
  }, [coreTag])

  // Смена периода обновляет только данные: страница остаётся на месте,
  // карточка боёв приглушается до ответа.
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

  const { clan, roster, battles, recent } = detail
  const { rank, delta30d } = clan
  const kd = battles.deaths > 0 ? (battles.kills / battles.deaths).toFixed(2) : '—'
  const perBattle = battles.total > 0 ? Math.round(battles.score / battles.total) : null
  const topRating = Math.max(roster[0]?.rating ?? 1, 1)
  const filteredRecent = battleFilter === 'all'
    ? recent
    : recent.filter((battle) => battle.clanSide?.won === (battleFilter === 'w'))

  return (
    <>
      <div className="crumbs">
        <Link to="/clans">{t('nav.clans')}</Link>
        <span className="sep">/</span>
        <span className="here">{clan.displayTag}</span>
      </div>

      <SeasonPanel context={detail.season} compact />
      {error !== null && <ErrorNotice error={error} />}

      <header className="hero-card">
        <span className="avatar-tile">{clan.coreTag.slice(0, 2).toUpperCase()}</span>
        <div className="who">
          <h1>{clan.displayTag} {clan.name && <span className="sub">{clan.name}</span>}</h1>
          <div className="chips">
            <Chip tone="accent">{t('clan.rank', { n: rank })}</Chip>
            <Chip>{tp('common.members', clan.members)}</Chip>
            {clan.seasonBattles !== null && clan.seasonWins !== null && (
              <Chip>{t('clan.seasonRecord', { wins: fmtInt(clan.seasonWins), battles: fmtInt(clan.seasonBattles) })}</Chip>
            )}
            <Chip>{t('common.updated', { when: fmtDateTime(clan.lastSeenAt) })}</Chip>
          </div>
        </div>
        <div className="aside">
          <div className="big">
            {fmtInt(clan.totalRating)}
            {delta30d !== null && delta30d !== 0 && (
              <span
                style={{ marginLeft: 8, verticalAlign: 'middle' }}
                title={t(clan.official ? 'clan.deltaTooltip.official' : 'clan.deltaTooltip')}
              >
                <DeltaPill value={delta30d} />
              </span>
            )}
          </div>
          <div className="label">
            {t(clan.official ? 'clan.officialRating' : 'metric.pkr.sum')}
            {delta30d !== null && delta30d !== 0 ? ` · Δ ${t('common.days.30')}` : ''}
          </div>
        </div>
      </header>

      <div className="card" style={refreshing ? { opacity: 0.6, transition: 'opacity 0.2s' } : undefined} aria-busy={refreshing}>
        <SecHead title={t('clan.battles')} hint={t('clan.battles.hint')}>
          <span style={{ marginLeft: 'auto' }}>
            <SegControl options={PERIODS} value={days} onChange={setDays} ariaLabel={t('a11y.period.clanBattles')} />
          </span>
        </SecHead>
        <div className="kpis">
          <Kpi label={t('metric.battles')} value={fmtInt(battles.total)} sub={t('clan.battles.noresult', { n: fmtInt(battles.unknownResults) })} />
          <DonutKpi
            label={t('metric.winrate')}
            fraction={battles.winRate}
            text={battles.winRate === null ? '—' : `${(battles.winRate * 100).toFixed(1)}%`}
            sub={<>
              {/* число выделено отдельным span — из шаблона «{n} побед» берём только слово */}
              <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(battles.wins)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
              <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(battles.losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
            </>}
          />
          <Kpi label={t('metric.kd')} value={kd} sub={`${t('metric.kills.count', { n: fmtInt(battles.kills) })} · ${t('metric.deaths.count', { n: fmtInt(battles.deaths) })}`} />
          <Kpi label={t('metric.score')} value={fmtInt(battles.score)} sub={perBattle === null ? undefined : t('clan.battles.perBattle', { n: fmtInt(perBattle) })} />
        </div>
      </div>

      <div className="grid-2">
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 20px 0' }}>
            <SecHead title={t('clan.roster')} hint={t('clan.roster.hint')} />
          </div>
          <div className="tbl-scroll" style={{ margin: 0 }}>
            <table className="tbl">
              <tbody>
                {roster.map((member, index) => {
                  const href = member.wtUserId
                    ? `/players/${member.wtUserId}`
                    : member.identityId !== null
                      ? `/players/id/${member.identityId}`
                      : null
                  return (
                    <tr key={member.nick}>
                      <td className="rank">{index + 1}</td>
                      <td style={{ minWidth: 200 }}>
                        {href ? <Link to={href}>{member.nick}</Link> : <span style={{ fontWeight: 600 }}>{member.nick}</span>}
                        <TierBadge rating={member.rating} />
                        <div className={`cell-bar${index === 0 ? ' lead' : ''}`}>
                          <div style={{ width: `${Math.max(2, (member.rating / topRating) * 100).toFixed(0)}%` }} />
                        </div>
                      </td>
                      <td className="num" style={{ fontWeight: 700, width: 64 }}>{fmtInt(member.rating)}</td>
                      <td className="num" style={{ width: 52 }}><DeltaPill value={member.delta} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="muted small" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
            {t('clan.roster.footnote')}
            {!clan.rosterKnown && <> {t('clan.roster.unverified')}</>}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {historyError !== null && (
            <div className="card" style={{ marginBottom: 0 }}>
              <SecHead title={t('clan.dynamics')} />
              <ErrorNotice error={historyError} />
            </div>
          )}
          {history !== null && history.length >= 2 && (
            <div className="card" style={{ marginBottom: 0 }}>
              <SecHead
                title={t('clan.dynamics')}
                hint={`${t(clan.official ? 'clan.dynamics.hint.official' : 'clan.dynamics.hint')}${historyTruncated ? ` · ${t('clan.dynamics.truncated')}` : ''}`}
              />
              <TimeChart
                xs={history.map((point) => point.t)}
                series={[{ label: t('clan.dynamics.series'), color: '#f5bc4a', values: history.map((point) => point.total), stepped: true }]}
              />
            </div>
          )}

          <div className="card" style={{ marginBottom: 0 }}>
            <SecHead title={t('clan.recent')} hint={t('clan.recent.hint', { days })}>
              <span style={{ marginLeft: 8 }}>
                <SegControl options={BATTLE_FILTERS} value={battleFilter} onChange={setBattleFilter} ariaLabel={t('a11y.filter.outcome')} />
              </span>
              <Link to={`/battles?clan=${encodeURIComponent(clan.coreTag)}`} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600 }}>{t('common.allLink')}</Link>
            </SecHead>
            {filteredRecent.length === 0 ? (
              <div className="muted small">
                {recent.length === 0 ? t('clan.recent.empty') : t('clan.recent.filtered')}
              </div>
            ) : (
              filteredRecent.map((battle) => {
                const versus = battleVersusLabel(battle.teams)
                return (
                  <Link key={battle.sessionId} to={`/battles/${battle.sessionId}`} className="row-item" style={{ padding: '9px 12px' }}>
                    <ResultBadge won={battle.clanSide?.won ?? null} />
                    <span className="title">
                      {versus ?? battle.missionName}
                      <span className="sub">{versus !== null && `${battle.missionName} · `}{tp('common.players', battle.playerCount)}</span>
                    </span>
                    <span className="end">{fmtDateTime(battle.startTime)}</span>
                  </Link>
                )
              })
            )}
          </div>
        </div>
      </div>
    </>
  )
}
