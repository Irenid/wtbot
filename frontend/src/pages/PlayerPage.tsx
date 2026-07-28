import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  fetchBattles,
  fetchPlayerHistory,
  fetchPlayerProfile,
  fetchVehicleDict,
  SiteApiError,
  type AccountView,
  type BattleListEntry,
  type ExternalTotal,
  type PlayerHistory,
  type PlayerProfile,
  type VehicleDict,
} from '../api'
import {
  cleanClanTag,
  coreClanTag,
  fmtDateTime,
  fmtDuration,
  fmtHoursInBattle,
  fmtHoursNumber,
  fmtInt,
  fmtPercent,
  fmtRatio,
  modeLabel,
  sourceLabel,
  stateLabel,
  sumKills,
  winRateOf,
} from '../lib/format'
import {
  BarRow,
  BarTrack,
  Chip,
  DeltaPill,
  DonutKpi,
  ErrorNotice,
  KILL_PARTS,
  KillsStack,
  Kpi,
  Loading,
  Panel,
  ResultBadge,
  SecHead,
  SegControl,
} from '../components/ui'
import { TimeChart } from '../components/TimeChart'
import { t, tp, useLocale } from '../i18n'

function aggregateOf(account: AccountView): ExternalTotal | null {
  return account.totals.find((t) => t.gameType === null && t.mode === null && t.category === null) ?? null
}

function modeRows(account: AccountView): ExternalTotal[] {
  const seen = new Set<string>()
  const rows: ExternalTotal[] = []
  for (const total of account.totals) {
    if (total.mode === null) continue
    if (total.gameType !== null && total.gameType !== 'all') continue
    if (total.category !== null && total.category !== 'all' && total.category !== 'pvp') continue
    if (seen.has(total.mode)) continue
    seen.add(total.mode)
    rows.push(total)
  }
  return rows
}

function vehicleName(dict: VehicleDict, id: string): string {
  return dict[id]?.name ?? id
}

// Ключ стека фрагов → акцентный цвет «любимого класса» (подпись берётся из словаря).
const KILL_BRIGHT: Record<string, string> = {
  airKills: 'var(--team1-bright)',
  groundKills: 'var(--team2-bright)',
  navalKills: 'var(--naval)',
}

export function PlayerPage({ kind }: { kind: 'wt' | 'identity' }) {
  const params = useParams()
  const { locale } = useLocale()
  const key = (kind === 'wt' ? params['wtUserId'] : params['identityId']) ?? ''
  const [profile, setProfile] = useState<PlayerProfile | null>(null)
  const [history, setHistory] = useState<PlayerHistory | null>(null)
  const [battles, setBattles] = useState<BattleListEntry[] | null>(null)
  const [dict, setDict] = useState<VehicleDict>({})
  const [days, setDays] = useState<'30' | '90' | '400'>('90')
  const [error, setError] = useState<unknown>(null)

  // Подписи пересобираются при смене языка — поэтому внутри компонента, а не на уровне модуля.
  const HISTORY_DAYS = useMemo(() => [
    { value: '30', label: t('common.days.30') },
    { value: '90', label: t('common.days.90') },
    { value: '400', label: t('common.days.400') },
  ] as const, [locale])

  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setError(null)
    setBattles(null)
    fetchPlayerProfile(kind, key)
      .then((body) => {
        if (cancelled) return
        setProfile(body)
        if (body.player.wtUserId) {
          fetchBattles({ player: body.player.wtUserId, limit: 15 })
            .then((list) => { if (!cancelled) setBattles(list.battles) })
            .catch(() => { if (!cancelled) setBattles([]) })
        } else {
          setBattles([])
        }
      })
      .catch((err) => { if (!cancelled) setError(err) })
    fetchVehicleDict().then((loaded) => { if (!cancelled) setDict(loaded) })
    return () => { cancelled = true }
  }, [kind, key])

  useEffect(() => {
    let cancelled = false
    setHistory(null)
    fetchPlayerHistory(kind, key, Number(days))
      .then((body) => { if (!cancelled) setHistory(body) })
      .catch(() => { if (!cancelled) setHistory(null) })
    return () => { cancelled = true }
  }, [kind, key, days])

  const ratingChart = useMemo(() => {
    if (!history || history.rating.length < 2) return null
    return {
      xs: history.rating.map((point) => point.seenAt),
      series: [{ label: t('metric.pkr'), color: '#f5bc4a', values: history.rating.map((point) => point.rating), stepped: true }],
    }
  }, [history, locale])

  const accountCharts = useMemo(() => {
    if (!history) return []
    return Object.entries(history.account)
      .filter(([, points]) => points.length >= 2)
      .map(([source, points]) => ({
        source,
        battles: {
          xs: points.map((point) => point.checkedAt),
          series: [{ label: t('metric.battles'), color: '#8f7be8', values: points.map((point) => point.battles), stepped: true }],
        },
        winRate: {
          xs: points.map((point) => point.checkedAt),
          series: [{
            label: t('metric.winrate'),
            color: '#d55181',
            values: points.map((point) => winRateOf(point.battles, point.victories)),
          }],
        },
      }))
  }, [history, locale])

  const activityChart = useMemo(() => {
    if (!history || history.activity.length === 0) return null
    return {
      xs: history.activity.map((point) => Math.floor(new Date(`${point.day}T00:00:00Z`).getTime() / 1000)),
      series: [
        { label: t('metric.battles'), color: '#8f7be8', values: history.activity.map((point) => point.battles), stepped: true },
        { label: t('metric.victories'), color: '#d55181', values: history.activity.map((point) => point.wins), stepped: true },
      ],
    }
  }, [history, locale])

  if (error !== null) {
    const message = error instanceof SiteApiError && error.status === 404
      ? t('player.notFound')
      : undefined
    return (
      <>
        <div className="page-head"><h1>{t('player.title')}</h1></div>
        {message ? <div className="notice fail">{message}</div> : <ErrorNotice error={error} />}
      </>
    )
  }
  if (!profile) return <Loading text={t('player.loading')} />

  const { player, rating, accounts, replay } = profile
  const primaryAccount = accounts.find((account) => aggregateOf(account) !== null) ?? null
  const primaryAggregate = primaryAccount ? aggregateOf(primaryAccount) : null
  const vehiclesAccount = accounts.find((account) => account.vehicles.length > 0) ?? null

  // «Любимый класс» — по фрагам аккаунта: честная замена распределения по боям,
  // которого внешние источники не публикуют.
  const favouriteClass = (() => {
    if (!primaryAggregate) return null
    const parts = KILL_PARTS
      .map((part) => ({ key: part.key, label: t(part.labelKey), value: primaryAggregate[part.key] ?? 0 }))
      .filter((part) => part.value > 0)
    if (parts.length === 0) return null
    const total = parts.reduce((sum, part) => sum + part.value, 0)
    const top = parts.reduce((best, part) => (part.value > best.value ? part : best))
    return { key: top.key, label: top.label, share: top.value / total }
  })()

  const modeList = primaryAccount ? modeRows(primaryAccount) : []
  const bestModeRate = modeList.reduce<number | null>((best, row) => {
    const rate = winRateOf(row.battles, row.victories)
    return rate !== null && (best === null || rate > best) ? rate : best
  }, null)

  return (
    <>
      <div className="crumbs">
        <Link to="/">{t('player.crumb.search')}</Link>
        <span className="sep">/</span>
        <span className="here">{player.nick}</span>
      </div>

      <header className="hero-card blue">
        <span className="avatar-tile">{player.nick.slice(0, 1).toUpperCase()}</span>
        <div className="who">
          <h1>{player.nick}</h1>
          <div className="chips">
            {rating && (coreClanTag(rating.clanTag)
              ? (
                <Link to={`/clans/${coreClanTag(rating.clanTag)}`} className="chip accent">
                  {cleanClanTag(rating.clanTag)}
                </Link>
              )
              : <Chip tone="accent">{cleanClanTag(rating.clanTag)}</Chip>)}
            {player.wtUserId && <Chip>{t('player.id', { id: player.wtUserId })}</Chip>}
            {player.platform && <Chip>{player.platform}</Chip>}
            {primaryAccount && (
              <Chip>{t('player.updatedChip', { when: fmtDateTime(primaryAccount.sourceUpdatedAt ?? primaryAccount.checkedAt) })}</Chip>
            )}
          </div>
        </div>
        {rating && (
          <div className="aside">
            <div className="big">
              {fmtInt(rating.rating)}
              {rating.delta !== null && rating.delta !== 0 && (
                <span style={{ marginLeft: 8, verticalAlign: 'middle' }}><DeltaPill value={rating.delta} /></span>
              )}
            </div>
            <div className="label">{t('metric.pkr.personal')}</div>
          </div>
        )}
      </header>

      {primaryAccount && primaryAggregate && (
        <>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <Kpi label={t('metric.battles')} value={fmtInt(primaryAggregate.battles)} sub={fmtHoursInBattle(primaryAggregate.timePlayedSec)} />
            <DonutKpi
              label={t('metric.winrate')}
              fraction={winRateOf(primaryAggregate.battles, primaryAggregate.victories)}
              text={fmtPercent(winRateOf(primaryAggregate.battles, primaryAggregate.victories))}
              sub={<>
                {/* число выделено отдельным span — из шаблона «{n} побед» берём только слово */}
                <span className="ok" style={{ fontWeight: 700 }}>{fmtInt(primaryAggregate.victories)}</span> {t('metric.wins.count', { n: '' }).trim()}<br />
                <span className="fail" style={{ fontWeight: 700 }}>{fmtInt(primaryAggregate.defeats)}</span> {t('metric.losses.count', { n: '' }).trim()}
              </>}
            />
            <Kpi
              label={t('metric.kd')}
              value={primaryAggregate.deaths ? fmtRatio((sumKills(primaryAggregate) ?? 0) / primaryAggregate.deaths) : '—'}
              sub={`${t('metric.kills.count', { n: fmtInt(sumKills(primaryAggregate)) })} · ${t('metric.deaths.count', { n: fmtInt(primaryAggregate.deaths) })}`}
            />
            {favouriteClass ? (
              <div className="kpi">
                <div className="l">{t('player.favClass')}</div>
                <div className="v" style={{ color: KILL_BRIGHT[favouriteClass.key] ?? 'var(--ink)' }}>
                  {favouriteClass.label}
                </div>
                <div className="s">
                  {t('player.favClass.hint', {
                    pct: (favouriteClass.share * 100).toFixed(1),
                    source: sourceLabel(primaryAccount.source),
                  })}
                </div>
              </div>
            ) : (
              <Kpi label={t('player.source')} value={sourceLabel(primaryAccount.source)} />
            )}
          </div>

          <div className="card">
            <SecHead
              title={t('player.killsSplit')}
              hint={t('player.killsSplit.hint', {
                n: fmtInt(sumKills(primaryAggregate)),
                source: sourceLabel(primaryAccount.source),
              })}
            />
            <KillsStack
              airKills={primaryAggregate.airKills}
              groundKills={primaryAggregate.groundKills}
              navalKills={primaryAggregate.navalKills}
            />
          </div>

          {modeList.length > 0 && (
            <div className="card">
              <SecHead title={t('player.modes')} hint={t('player.modes.hint')} />
              {modeList.map((row, index) => {
                const rate = winRateOf(row.battles, row.victories)
                const kills = sumKills(row)
                const kd = row.deaths && kills !== null ? fmtRatio(kills / row.deaths) : '—'
                const best = rate !== null && rate === bestModeRate
                return (
                  <div key={`${row.mode}:${row.category}`} style={{ padding: '12px 0', borderBottom: index < modeList.length - 1 ? '1px solid var(--line)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <b style={{ fontWeight: 600 }}>{modeLabel(row.mode)}</b>
                      <span className="muted" style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                        {t('player.modes.meta', {
                          battles: fmtInt(row.battles),
                          kd,
                          hours: fmtHoursNumber(row.timePlayedSec),
                        })}
                      </span>
                      <span style={{ marginLeft: 'auto', fontWeight: 700, fontVariantNumeric: 'tabular-nums', ...(best ? { color: 'var(--ok)' } : {}) }}>
                        {fmtPercent(rate)}
                      </span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <BarTrack fraction={rate} {...(best ? { tone: 'best' as const } : {})} title={t('a11y.winrate', { value: fmtPercent(rate) })} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      <div className="card">
        <SecHead title={t('player.history')}>
          <span style={{ marginLeft: 'auto' }}>
            <SegControl options={HISTORY_DAYS} value={days} onChange={setDays} ariaLabel={t('a11y.period.history')} />
          </span>
        </SecHead>
        {history === null ? <Loading text={t('player.history.building')} /> : (
          <div className="grid-2">
            {ratingChart && (
              <Panel title={t('player.history.pkr')} sub={t('player.history.pkr.hint')}>
                <TimeChart xs={ratingChart.xs} series={ratingChart.series} />
              </Panel>
            )}
            {accountCharts.map((chart) => (
              <Panel
                key={`${chart.source}-battles`}
                title={t('player.history.battles', { source: sourceLabel(chart.source) })}
                sub={t('player.history.hint.snapshots')}
              >
                <TimeChart xs={chart.battles.xs} series={chart.battles.series} />
              </Panel>
            ))}
            {accountCharts.map((chart) => (
              <Panel
                key={`${chart.source}-wr`}
                title={t('player.history.winrate', { source: sourceLabel(chart.source) })}
                sub={t('player.history.hint.snapshots')}
              >
                <TimeChart xs={chart.winRate.xs} series={chart.winRate.series} percent />
              </Panel>
            ))}
            {activityChart && (
              <Panel title={t('player.history.activity')} sub={t('player.history.activity.hint')}>
                <TimeChart xs={activityChart.xs} series={activityChart.series} />
              </Panel>
            )}
            {!ratingChart && accountCharts.length === 0 && !activityChart && (
              <div className="muted small">{t('player.history.empty')}</div>
            )}
          </div>
        )}
      </div>

      {accounts.length > 0 && (
        <div className="card">
          <SecHead title={t('player.sources')} hint={t('player.sources.hint')} />
          <div className="src-grid">
            {accounts.map((account) => {
              const aggregate = aggregateOf(account) ?? account.totals[0] ?? null
              return (
                <div className="panel" key={account.source} style={{ marginTop: 0 }}>
                  <div className="panel-head">
                    <h3>{sourceLabel(account.source)}</h3>
                    <span style={{ marginLeft: 'auto' }}>
                      <Chip tone={account.status === 'ok' ? 'ok' : 'fail'}>
                        {stateLabel(account.status)}
                      </Chip>
                    </span>
                  </div>
                  <div className="row"><span className="muted">{t('player.sources.battlesWins')}</span><span>{aggregate ? `${fmtInt(aggregate.battles)} / ${fmtInt(aggregate.victories)}` : '—'}</span></div>
                  <div className="row"><span className="muted">{t('metric.winrate')}</span><span>{fmtPercent(aggregate ? winRateOf(aggregate.battles, aggregate.victories) : null)}</span></div>
                  <div className="row"><span className="muted">{t('player.sources.vehicles')}</span><span>{fmtInt(account.vehicleCount)}</span></div>
                  <div className="row"><span className="muted">{t('player.sources.checked')}</span><span>{fmtDateTime(account.checkedAt)}</span></div>
                  {account.error && <div className="notice fail small">{account.error}</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {vehiclesAccount && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 20px 0' }}>
            <SecHead
              title={t('player.vehicles', { source: sourceLabel(vehiclesAccount.source) })}
              hint={vehiclesAccount.vehicleCount > 12
                ? t('common.showRest', { shown: 12, total: fmtInt(vehiclesAccount.vehicleCount) })
                : t('player.vehicles.hint.byFlyouts')}
            />
          </div>
          <div className="tbl-scroll" style={{ margin: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('player.vehicles.col.vehicle')}</th><th>{t('player.vehicles.col.mode')}</th><th className="num">{t('metric.flyouts')}</th>
                  <th className="num">{t('metric.victories')}</th><th className="num">{t('metric.deaths')}</th>
                  <th className="num">{t('metric.kills')}</th><th style={{ minWidth: 130 }}>{t('metric.winsPerFlyout')}</th>
                </tr>
              </thead>
              <tbody>
                {vehiclesAccount.vehicles.slice(0, 12).map((vehicle) => {
                  const rate = vehicle.flyouts && vehicle.victories !== null
                    ? Math.min(1, vehicle.victories / vehicle.flyouts)
                    : null
                  return (
                    <tr key={`${vehicle.mode}:${vehicle.vehicleId}`}>
                      <td title={vehicle.vehicleId}>{vehicleName(dict, vehicle.vehicleId)}</td>
                      <td className="muted" style={{ fontWeight: 400 }}>{modeLabel(vehicle.mode)}</td>
                      <td className="num">{fmtInt(vehicle.flyouts)}</td>
                      <td className="num">{fmtInt(vehicle.victories)}</td>
                      <td className="num">{fmtInt(vehicle.deaths)}</td>
                      <td className="num">{fmtInt(sumKills(vehicle))}</td>
                      <td>
                        <div className="bar-row" style={{ gridTemplateColumns: '1fr 54px', padding: 0 }}>
                          <BarTrack fraction={rate} title={`${t('metric.winsPerFlyout')}: ${fmtPercent(rate)}`} />
                          <span className="bar-value small">{fmtPercent(rate)}</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <SecHead title={t('player.replay')} hint={t('player.replay.hint')} />
          {replay === null ? (
            <div className="muted small">{t('player.replay.noId')}</div>
          ) : (
            <>
              <div className="kpis">
                <Kpi
                  label={t('metric.battles')}
                  value={fmtInt(replay.battles)}
                  sub={`${t('metric.wins.count', { n: fmtInt(replay.wins) })} · ${t('metric.losses.count', { n: fmtInt(replay.losses) })}`}
                />
                <DonutKpi
                  label={t('metric.winrate')}
                  fraction={replay.winRate}
                  text={fmtPercent(replay.winRate)}
                  sub={t('player.replay.noresult', { n: fmtInt(replay.unknownResults) })}
                />
                <Kpi
                  label={t('metric.kd')}
                  value={replay.deaths ? fmtRatio((replay.airKills + replay.groundKills + replay.navalKills) / replay.deaths) : '—'}
                  sub={t('metric.assists.count', { n: fmtInt(replay.assists) })}
                />
                <Kpi label={t('metric.score')} value={fmtInt(replay.score)} />
              </div>
              <div style={{ marginTop: 12 }}>
                <KillsStack airKills={replay.airKills} groundKills={replay.groundKills} navalKills={replay.navalKills} />
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="row"><span className="muted">{t('player.replay.observed')}</span><span>{fmtDuration(replay.observedBattleTimeSec)}</span></div>
                <div className="row"><span className="muted">{t('player.replay.firstLast')}</span><span>{fmtDateTime(replay.firstBattleAt)} / {fmtDateTime(replay.lastBattleAt)}</span></div>
              </div>
              {replay.vehicles.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="muted small" style={{ marginBottom: 4 }}>{t('player.replay.vehicles')}</div>
                  {replay.vehicles.slice(0, 8).map((vehicle) => {
                    const max = replay.vehicles[0]?.battles ?? 1
                    return (
                      <BarRow
                        key={vehicle.vehicleId}
                        label={vehicleName(dict, vehicle.vehicleId)}
                        fraction={max > 0 ? vehicle.battles / max : 0}
                        right={tp('common.battles', vehicle.battles)}
                      />
                    )
                  })}
                  {replay.vehicles.length > 8 && (
                    <div className="muted small">{t('common.showRest', { shown: 8, total: fmtInt(replay.vehicles.length) })}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="card">
          <SecHead title={t('player.recent')}>
            {player.wtUserId && (
              <Link to={`/battles?player=${player.wtUserId}`} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600 }}>{t('common.allLink')}</Link>
            )}
          </SecHead>
          {battles === null ? <Loading /> : battles.length === 0 ? (
            <div className="muted small">{t('player.recent.empty')}</div>
          ) : (
            battles.map((battle) => (
              <Link key={battle.sessionId} to={`/battles/${battle.sessionId}`} className="row-item" style={{ padding: '9px 12px' }}>
                <ResultBadge won={battle.player?.won ?? null} />
                <span className="title">{battle.missionName}</span>
                {battle.player && (
                  <span className="end" style={{ color: 'var(--ink2)' }}>
                    {t('player.recent.meta', {
                      frags: fmtInt(battle.player.frags),
                      deaths: fmtInt(battle.player.deaths),
                      score: fmtInt(battle.player.score),
                    })}
                  </span>
                )}
                <span className="end">{fmtDateTime(battle.startTime)}</span>
              </Link>
            ))
          )}
        </div>
      </div>

      {player.aliases.length > 1 && (
        <div className="card">
          <SecHead title={t('player.aliases')} />
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>{t('player.aliases.col.nick')}</th><th>{t('player.aliases.col.source')}</th><th>{t('player.aliases.col.first')}</th><th>{t('player.aliases.col.last')}</th></tr></thead>
              <tbody>
                {player.aliases.map((alias) => (
                  <tr key={`${alias.source}:${alias.nick}`}>
                    <td>{alias.nick}</td>
                    <td className="muted" style={{ fontWeight: 400 }}>{alias.source}</td>
                    <td className="muted" style={{ fontWeight: 400 }}>{fmtDateTime(alias.firstSeenAt)}</td>
                    <td className="muted" style={{ fontWeight: 400 }}>{fmtDateTime(alias.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="notice muted small">{t('player.disclaimer')}</div>
    </>
  )
}
