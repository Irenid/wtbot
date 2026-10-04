import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  fetchClan,
  fetchClanHistory,
  SiteApiError,
  type ClanDetail,
  type ClanHistoryPoint,
  type ClanProfile,
  type ClanRequirements,
} from '../api'
import {
  battleVersusLabel,
  clanRewardLabel,
  clanRoleLabel,
  difficultyShortLabel,
  fmtDate,
  fmtDateTime,
  fmtHours,
  fmtInt,
  fmtPercent,
  fmtRatio,
  romanRank,
  unitTypeLabel,
  winRateOf,
} from '../lib/format'
import { Chip, DeltaPill, DonutKpi, ErrorNotice, Kpi, Loading, ResultBadge, SecHead, SegControl, useRowLink } from '../components/ui'
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

/** Звание сезона «place3@historical»; режим подписан, только если это не РБ полковых боёв. */
function rewardText(code: string): string | null {
  const [title = '', mode] = code.split('@')
  const label = clanRewardLabel(title)
  if (label === null) return null
  return mode === undefined || mode === 'historical' ? label : `${label} · ${difficultyShortLabel(mode)}`
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

/** Приём заявок; незнакомый статус не толкуем. */
function applicationsText(profile: ClanProfile): string | null {
  if (profile.status === 'closed') return t('clan.about.applications.closed')
  if (profile.status !== 'open') return null
  if (profile.autoAccept === true) return t('clan.about.applications.auto')
  if (profile.autoAccept === false) return t('clan.about.applications.manual')
  return t('clan.about.applications.open')
}

/** Сезон по лидерборду игры: в отличие от карточки боёв, не зависит от реплеев бота. */
function OfficialSeasonCard({ clan }: { clan: ClanDetail['clan'] }) {
  if (!clan.official || clan.seasonBattles === null) return null
  const kills = clan.airKills === null && clan.groundKills === null
    ? null
    : (clan.airKills ?? 0) + (clan.groundKills ?? 0)
  const kd = kills !== null && clan.deaths ? kills / clan.deaths : null
  const winRate = winRateOf(clan.seasonBattles, clan.seasonWins)
  const losses = clan.seasonWins === null ? null : clan.seasonBattles - clan.seasonWins
  return (
    <div className="card">
      <SecHead title={t('clan.official')} hint={t('clan.official.hint')} />
      <div className="kpis">
        <Kpi label={t('metric.battles')} value={fmtInt(clan.seasonBattles)} />
        <DonutKpi
          label={t('metric.winrate')}
          fraction={winRate}
          text={fmtPercent(winRate)}
          sub={<>
            <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(clan.seasonWins)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
            <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
          </>}
        />
        <Kpi
          label={t('metric.kd')}
          value={fmtRatio(kd)}
          sub={`${fmtInt(clan.airKills)} ${t('metric.killsAir')} · ${fmtInt(clan.groundKills)} ${t('metric.killsGround')} · ${t('metric.deaths.count', { n: fmtInt(clan.deaths) })}`}
        />
        <Kpi label={t('clan.official.flightTime')} value={fmtHours(clan.flightTimeMin === null ? null : clan.flightTimeMin * 60)} />
        <Kpi label={t('clan.official.activity')} value={fmtInt(clan.activity)} />
      </div>
    </div>
  )
}

/** Профиль клана с лидерборда. Описание и объявление пишет клан — только текстом, без ссылок. */
function ClanAboutCard({ clan }: { clan: ClanDetail['clan'] }) {
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
      labels: titles.map(rewardText).filter((label): label is string => label !== null),
    }))
    .filter((entry) => entry.labels.length > 0)
    .sort((left, right) => right.season - left.season)
    .slice(0, 12)
  const facts: [string, string][] = []
  if (clan.region) facts.push([t('clan.about.region'), clan.region])
  if (typeLabel) facts.push([t('clan.about.type'), typeLabel])
  if (clan.foundedAt !== null) facts.push([t('clan.about.founded'), fmtDate(clan.foundedAt)])
  if (applications) facts.push([t('clan.about.applications'), applications])
  if (regalia) facts.push([t('clan.about.regalia'), regalia])
  if (profile === null && clan.slogan === null && facts.length === 0 && rewards.length === 0) return null

  return (
    <div className="card">
      <SecHead title={t('clan.about')} hint={t('clan.about.hint')} />
      <div className="grid-2">
        <div style={{ minWidth: 0 }}>
          {clan.slogan && <p className="free-text" style={{ fontStyle: 'italic' }}>{clan.slogan}</p>}
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
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>{t('clan.about.rewards')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {rewards.map((entry) => (
                  <Chip key={entry.season}>{t('clan.reward.season', { n: entry.season })}: {entry.labels.join(', ')}</Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A roster member's profile: by WT user id or identity when the bot knows one, else by nick. */
function memberPath(member: ClanDetail['roster'][number]): string {
  if (member.wtUserId) return `/players/${member.wtUserId}`
  if (member.identityId !== null) return `/players/id/${member.identityId}`
  return `/players/nick/${encodeURIComponent(member.nick)}`
}

export function ClanPage() {
  const { coreTag = '' } = useParams()
  const { locale } = useLocale()
  const openRow = useRowLink()
  const [detail, setDetail] = useState<ClanDetail | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [history, setHistory] = useState<ClanHistoryPoint[] | null>(null)
  const [historyTruncated, setHistoryTruncated] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [battleFilter, setBattleFilter] = useState<'all' | 'w' | 'l'>('all')
  const [error, setError] = useState<unknown>(null)

  // Labels are rebuilt when the language changes, so they live in the component, not the module.
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

  // Season battles and wins exist only in official rating points; the colors are
  // those of battles and wins on the player page.
  const seasonChart = useMemo(() => {
    const points = (history ?? []).filter((point) => typeof point.battles === 'number' && typeof point.wins === 'number')
    if (points.length < 2) return null
    return {
      xs: points.map((point) => point.t),
      series: [
        { label: t('metric.battles'), color: '#8f7be8', values: points.map((point) => point.battles ?? null), stepped: true },
        { label: t('metric.victories'), color: '#d55181', values: points.map((point) => point.wins ?? null), stepped: true },
      ],
    }
  }, [history, locale])

  // Another squadron: the previous one's data is not shown for a moment.
  useEffect(() => {
    setDetail(null)
  }, [coreTag])

  // A new period only reloads the data: the page stays in place, the battles
  // card dims until the answer.
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
  const hasRosterDetails = roster.some((member) => member.role !== null || member.joinedAt !== null || member.activity !== null)
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

      <OfficialSeasonCard clan={clan} />
      <ClanAboutCard clan={clan} />

      <div className="card" style={refreshing ? { opacity: 0.6, transition: 'opacity 0.2s' } : undefined} aria-busy={refreshing}>
        <SecHead title={t('clan.battles')} hint={t('clan.battles.hint')}>
          <span style={{ marginLeft: 'auto' }}>
            <SegControl options={PERIODS} value={days} onChange={setDays} ariaLabel={t('a11y.period.clanBattles')} />
          </span>
        </SecHead>
        {battles.total === 0 ? (
          <div className="muted small">
            {battles.collectedSince === null
              ? t('clan.recent.empty')
              : t('clan.battles.none', { date: fmtDate(battles.collectedSince) })}
          </div>
        ) : (
          <div className="kpis">
            <Kpi label={t('metric.battles')} value={fmtInt(battles.total)} sub={t('clan.battles.noresult', { n: fmtInt(battles.unknownResults) })} />
            <DonutKpi
              label={t('metric.winrate')}
              fraction={battles.winRate}
              text={battles.winRate === null ? '—' : `${(battles.winRate * 100).toFixed(1)}%`}
              sub={<>
                {/* the number is its own span: only the word is taken from the "{n} wins" template */}
                <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(battles.wins)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
                <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(battles.losses)}</span> {t('metric.losses.count', { n: '' }).trim()}
              </>}
            />
            <Kpi label={t('metric.kd')} value={kd} sub={`${t('metric.kills.count', { n: fmtInt(battles.kills) })} · ${t('metric.deaths.count', { n: fmtInt(battles.deaths) })}`} />
            <Kpi label={t('metric.score')} value={fmtInt(battles.score)} sub={perBattle === null ? undefined : t('clan.battles.perBattle', { n: fmtInt(perBattle) })} />
          </div>
        )}
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
                  const details = [
                    member.joinedAt === null ? null : t('clan.roster.joined', { date: fmtDate(member.joinedAt) }),
                    member.activity === null ? null : t('clan.roster.activity', { n: fmtInt(member.activity) }),
                  ].filter((part): part is string => part !== null).join(' · ')
                  const href = memberPath(member)
                  return (
                    <tr key={member.nick} className="row-link" onClick={(event) => openRow(event, href)}>
                      <td className="rank">{index + 1}</td>
                      <td style={{ minWidth: 200 }}>
                        <Link to={href}>{member.nick}</Link>
                        {/* Private is the default role: only senior ones are marked. */}
                        {member.role !== null && member.role !== 'Private' && (
                          <span style={{ marginLeft: 6 }}><Chip>{clanRoleLabel(member.role)}</Chip></span>
                        )}
                        <TierBadge rating={member.rating} />
                        <div className={`cell-bar${index === 0 ? ' lead' : ''}`}>
                          <div style={{ width: `${Math.max(2, (member.rating / topRating) * 100).toFixed(0)}%` }} />
                        </div>
                        {details && <div className="muted small" style={{ marginTop: 4 }}>{details}</div>}
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
            {hasRosterDetails && <> {t('clan.roster.details')}</>}
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
          {seasonChart !== null && (
            <div className="card" style={{ marginBottom: 0 }}>
              <SecHead title={t('clan.seasonChart')} hint={t('clan.official.hint')} />
              <TimeChart xs={seasonChart.xs} series={seasonChart.series} />
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
