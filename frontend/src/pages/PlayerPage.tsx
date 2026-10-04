import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchBattles,
  fetchPlayerHistory,
  fetchPlayerInsights,
  fetchPlayerProfile,
  fetchVehicleDict,
  lookupPlayerId,
  requestPlayerStatsRefresh,
  SiteApiError,
  type AccountView,
  type BattleListEntry,
  type ExternalTotal,
  type PlayerHistory,
  type PlayerInsights,
  type PlayerKind,
  type PlayerProfile,
  type VehicleDict,
} from '../api'
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtHoursInBattle,
  fmtHoursNumber,
  fmtInt,
  fmtPercent,
  fmtRatio,
  modeLabel,
  nationLabel,
  sourceLabel,
  stateLabel,
  sumKills,
  winRateOf,
} from '../lib/format'
import {
  BarTrack,
  Chip,
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
import { t, useLocale } from '../i18n'
import { PlayerClanSection } from './player/PlayerClanSection'
import { PlayerHero, type RefreshState } from './player/PlayerHero'
import { PlayerInsightsSection, type InsightDays } from './player/PlayerInsightsSection'
import { PlayerRanks } from './player/PlayerRanks'
import { PlayerVehicles } from './player/PlayerVehicles'
import { SectionNav, type PageSection } from './player/SectionNav'

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

/** Самая свежая проверка источников — по ней видно, что обновление пришло. */
function checkedAtBySource(profile: PlayerProfile): Map<string, number> {
  return new Map(profile.accounts.map((account) => [account.source, account.checkedAt ?? 0]))
}

// Ключ стека фрагов → акцентный цвет «любимого класса» (подпись берётся из словаря).
const KILL_BRIGHT: Record<string, string> = {
  airKills: 'var(--team1-bright)',
  groundKills: 'var(--team2-bright)',
  navalKills: 'var(--naval)',
}

const BATTLES_PAGE = 15
/** A queued source answers in seconds (StatShark through the bot's browser: up to a minute); then the page gives up. */
const REFRESH_POLLS = 30
const REFRESH_POLL_MS = 4_000
/** The server waits up to 15 s per lookup; `pending` is asked again this many times. */
const ID_LOOKUP_ATTEMPTS = 4
const ID_LOOKUP_RETRY_MS = 5_000

/**
 * A profile without an id (a squadron member never seen in replays): the bot looks
 * the account up and the page moves to /players/<id>; any other answer keeps it.
 */
async function openFoundAccount(nick: string, isCurrent: () => boolean, open: (path: string) => void): Promise<void> {
  for (let attempt = 0; attempt < ID_LOOKUP_ATTEMPTS; attempt += 1) {
    const answer = await lookupPlayerId(nick).catch(() => null)
    if (answer === null || !isCurrent()) return
    if (answer.status === 'found' && answer.wtUserId) {
      open(`/players/${answer.wtUserId}`)
      return
    }
    if (answer.status !== 'pending') return
    await new Promise((resolve) => setTimeout(resolve, ID_LOOKUP_RETRY_MS))
    if (!isCurrent()) return
  }
}

export function PlayerPage({ kind }: { kind: PlayerKind }) {
  const params = useParams()
  const navigate = useNavigate()
  const { locale } = useLocale()
  const key = params[kind === 'wt' ? 'wtUserId' : kind === 'identity' ? 'identityId' : 'nick'] ?? ''
  const [profile, setProfile] = useState<PlayerProfile | null>(null)
  const [history, setHistory] = useState<PlayerHistory | null>(null)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [battles, setBattles] = useState<BattleListEntry[] | null>(null)
  const [battlesError, setBattlesError] = useState<unknown>(null)
  const [battlesMore, setBattlesMore] = useState<'idle' | 'loading' | 'end'>('idle')
  const [insights, setInsights] = useState<PlayerInsights | null | undefined>(undefined)
  const [insightsError, setInsightsError] = useState<unknown>(null)
  const [insightDays, setInsightDays] = useState<InsightDays>('90')
  const [dict, setDict] = useState<VehicleDict>({})
  const [days, setDays] = useState<'30' | '90' | '400'>('90')
  const [refresh, setRefresh] = useState<RefreshState>('idle')
  // Bumped after a refresh: the charts reread the new account snapshots.
  const [historyVersion, setHistoryVersion] = useState(0)
  const [error, setError] = useState<unknown>(null)
  // Page generation: answers for the previous player and polling after leaving the page are dropped.
  const generation = useRef(0)

  // Labels are rebuilt when the language changes, so they live in the component, not the module.
  const HISTORY_DAYS = useMemo(() => [
    { value: '30', label: t('common.days.30') },
    { value: '90', label: t('common.days.90') },
    { value: '400', label: t('common.days.400') },
  ] as const, [locale])

  useEffect(() => {
    const current = ++generation.current
    setProfile(null)
    setError(null)
    setBattles(null)
    setBattlesError(null)
    setBattlesMore('idle')
    setRefresh('idle')
    fetchPlayerProfile(kind, key)
      .then((body) => {
        if (generation.current !== current) return
        setProfile(body)
        void refreshSources(body, current, true)
        if (body.player.wtUserId) {
          // A failed request is not "the player has no battles": show the error, not an empty list.
          fetchBattles({ player: body.player.wtUserId, limit: BATTLES_PAGE })
            .then((list) => {
              if (generation.current !== current) return
              setBattles(list.battles)
              if (list.battles.length < BATTLES_PAGE) setBattlesMore('end')
            })
            .catch((err) => { if (generation.current === current) setBattlesError(err) })
        } else {
          setBattles([])
          setBattlesMore('end')
          if (kind !== 'wt') {
            void openFoundAccount(
              body.player.nick,
              () => generation.current === current,
              (path) => navigate(path, { replace: true }),
            )
          }
        }
      })
      .catch((err) => { if (generation.current === current) setError(err) })
    fetchVehicleDict().then((loaded) => { if (generation.current === current) setDict(loaded) })
    return () => { generation.current += 1 }
  }, [kind, key])

  useEffect(() => {
    let cancelled = false
    setHistory(null)
    setHistoryError(null)
    // Without its own error state a failure looked like endless loading.
    fetchPlayerHistory(kind, key, Number(days))
      .then((body) => { if (!cancelled) setHistory(body) })
      .catch((err) => { if (!cancelled) setHistoryError(err) })
    return () => { cancelled = true }
  }, [kind, key, days, historyVersion])

  useEffect(() => {
    let cancelled = false
    setInsights(undefined)
    setInsightsError(null)
    fetchPlayerInsights(kind, key, Number(insightDays))
      .then((body) => { if (!cancelled) setInsights(body.insights) })
      .catch((err) => { if (!cancelled) setInsightsError(err) })
    return () => { cancelled = true }
  }, [kind, key, insightDays])

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

  const loadMoreBattles = () => {
    const wtUserId = profile?.player.wtUserId
    const last = battles?.at(-1)
    if (!wtUserId || !last || battlesMore !== 'idle') return
    const current = generation.current
    setBattlesMore('loading')
    fetchBattles({ player: wtUserId, limit: BATTLES_PAGE, to: last.startTime })
      .then((list) => {
        if (generation.current !== current) return
        setBattles((previous) => [...(previous ?? []), ...list.battles])
        setBattlesMore(list.battles.length < BATTLES_PAGE ? 'end' : 'idle')
      })
      .catch((err) => {
        if (generation.current !== current) return
        setBattlesError(err)
        setBattlesMore('idle')
      })
  }

  /**
   * Asks the bot to reread the external sources (on opening the page and on a
   * retry), then rereads the profile until every queued source has a newer check.
   * Nothing queued (all checked less than a day ago) shows nothing; on opening, a
   * rate limit or an unknown/ambiguous nick stays silent too.
   */
  const refreshSources = async (shown: PlayerProfile, current: number, opened: boolean) => {
    setRefresh('checking')
    try {
      const answer = await requestPlayerStatsRefresh(shown.player.wtUserId ?? shown.player.nick)
      if (generation.current !== current) return
      const queued = answer.stats.accountSources.filter((source) => source.refreshQueued).map((source) => source.source)
      if (queued.length === 0) {
        setRefresh('idle')
        return
      }
      setRefresh('updating')
      const before = checkedAtBySource(shown)
      for (let attempt = 0; attempt < REFRESH_POLLS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS))
        if (generation.current !== current) return
        const next = await fetchPlayerProfile(kind, key)
        if (generation.current !== current) return
        const after = checkedAtBySource(next)
        const updated = queued.filter((source) => (after.get(source) ?? 0) > (before.get(source) ?? 0))
        // Shows each source as it lands, not only when the slowest one is done.
        if (updated.length > 0) setProfile(next)
        if (updated.length === queued.length) {
          setHistoryVersion((version) => version + 1)
          setRefresh('done')
          return
        }
      }
      setHistoryVersion((version) => version + 1)
      setRefresh('slow')
    } catch (err) {
      if (generation.current !== current) return
      const quiet = opened && err instanceof SiteApiError && [404, 409, 429].includes(err.status)
      setRefresh(quiet ? 'idle' : 'failed')
    }
  }

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

  const { player, rating, clan, accounts, replay } = profile
  const primaryAccount = accounts.find((account) => aggregateOf(account) !== null) ?? null
  const primaryAggregate = primaryAccount ? aggregateOf(primaryAccount) : null
  const vehiclesAccount = accounts.find((account) => account.vehicles.length > 0) ?? null
  const nationsAccount = accounts.find((account) => account.countries.length > 0) ?? null
  const topNationVehicles = Math.max(1, ...(nationsAccount?.countries ?? []).map((row) => row.vehicles ?? 0))
  const statShark = accounts.find((account) => account.source === 'statshark')?.account ?? null
  const official = accounts.find((account) => account.source === 'official-profile')?.account ?? null
  const heroAccount = {
    level: statShark?.level ?? official?.level ?? null,
    title: statShark?.title ?? null,
    registeredAt: statShark?.registeredAt ?? official?.registeredAt ?? null,
    lastOnlineAt: statShark?.lastOnlineAt ?? null,
  }
  const updatedAt = primaryAccount ? primaryAccount.sourceUpdatedAt ?? primaryAccount.checkedAt : null
  // Nicks: local aliases and the StatShark nick history in one table.
  const knownNicks = new Set(player.aliases.map((alias) => alias.nick))
  const nickRows = [
    ...player.aliases.map((alias) => ({ nick: alias.nick, source: alias.source, first: alias.firstSeenAt, last: alias.lastSeenAt as number | null })),
    ...(statShark?.names ?? [])
      .filter((name) => !knownNicks.has(name.nick))
      .map((name) => ({ nick: name.nick, source: sourceLabel('statshark'), first: name.seenAt, last: null as number | null })),
  ]

  // "Favourite class" by the account's kills: an honest stand-in for a split by
  // battles, which the external sources do not publish.
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

  const sections: PageSection[] = [
    ...(primaryAggregate ? [{ id: 'overview', label: t('player.nav.overview') }] : []),
    { id: 'clan', label: t('player.nav.clan') },
    ...(statShark && statShark.ranks.length > 0 ? [{ id: 'ranks', label: t('player.nav.ranks') }] : []),
    ...(vehiclesAccount ? [{ id: 'vehicles', label: t('player.nav.vehicles') }] : []),
    ...(nationsAccount ? [{ id: 'nations', label: t('player.nav.nations') }] : []),
    { id: 'replays', label: t('player.nav.replays') },
    { id: 'history', label: t('player.nav.history') },
    { id: 'battles', label: t('player.nav.battles') },
    ...(nickRows.length > 1 ? [{ id: 'nicks', label: t('player.nav.nicks') }] : []),
    ...(accounts.length > 0 ? [{ id: 'sources', label: t('player.nav.sources') }] : []),
  ]

  return (
    <>
      <div className="crumbs">
        <Link to="/">{t('player.crumb.search')}</Link>
        <span className="sep">/</span>
        <span className="here">{player.nick}</span>
      </div>

      <PlayerHero
        profile={profile}
        clan={clan}
        account={heroAccount}
        updatedAt={updatedAt}
        refresh={refresh}
        onRetry={() => { void refreshSources(profile, generation.current, false) }}
      />

      <SectionNav sections={sections} />

      {primaryAccount && primaryAggregate && (
        <section id="overview" className="player-section">
          <div className="kpis" style={{ marginBottom: 16 }}>
            <Kpi label={t('metric.battles')} value={fmtInt(primaryAggregate.battles)} sub={fmtHoursInBattle(primaryAggregate.timePlayedSec)} />
            <DonutKpi
              label={t('metric.winrate')}
              fraction={winRateOf(primaryAggregate.battles, primaryAggregate.victories)}
              text={fmtPercent(winRateOf(primaryAggregate.battles, primaryAggregate.victories))}
              sub={<>
                {/* the number is its own span: only the word is taken from the "{n} wins" template */}
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
        </section>
      )}

      <section id="clan" className="player-section" style={{ marginBottom: 16 }}>
        <PlayerClanSection
          clan={clan}
          rating={rating}
          squadrons={statShark?.squadrons ?? []}
          playedFor={insights?.playedFor ?? null}
        />
      </section>

      {statShark && statShark.ranks.length > 0 && (
        <section id="ranks" className="player-section">
          <PlayerRanks account={statShark} />
        </section>
      )}

      {vehiclesAccount && (
        <section id="vehicles" className="player-section">
          <PlayerVehicles account={vehiclesAccount} dict={dict} />
        </section>
      )}

      {nationsAccount && (
        <section id="nations" className="player-section">
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px 0' }}>
              <SecHead title={t('player.nations')} hint={t('player.nations.hint')} />
            </div>
            <div className="tbl-scroll" style={{ margin: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('player.nations.col.nation')}</th>
                    <th style={{ minWidth: 160 }}>{t('player.nations.col.vehicles')}</th>
                    <th className="num">{t('player.nations.col.elite')}</th>
                    <th className="num">{t('player.nations.col.medals')}</th>
                  </tr>
                </thead>
                <tbody>
                  {nationsAccount.countries.map((row) => (
                    <tr key={row.country}>
                      <td title={row.country}>{nationLabel(row.country)}</td>
                      <td>
                        <div className="bar-row" style={{ gridTemplateColumns: '1fr 54px', padding: 0 }}>
                          <BarTrack fraction={row.vehicles === null ? null : row.vehicles / topNationVehicles} />
                          <span className="bar-value small">{fmtInt(row.vehicles)}</span>
                        </div>
                      </td>
                      <td className="num">{fmtInt(row.eliteVehicles)}</td>
                      <td className="num">{fmtInt(row.medals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section id="replays" className="player-section">
        <div className="card">
          <SecHead title={t('player.replay')} hint={`${t('player.replay.hint')} · ${t('player.replay.allTime')}`} />
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
                <Kpi label={t('metric.score')} value={fmtInt(replay.score)} sub={replay.battles > 0 ? t('clan.battles.perBattle', { n: fmtInt(Math.round(replay.score / replay.battles)) }) : undefined} />
              </div>
              <div style={{ marginTop: 12 }}>
                <KillsStack airKills={replay.airKills} groundKills={replay.groundKills} navalKills={replay.navalKills} />
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="row"><span className="muted">{t('player.replay.observed')}</span><span>{fmtDuration(replay.observedBattleTimeSec)}</span></div>
                <div className="row"><span className="muted">{t('player.replay.firstLast')}</span><span>{fmtDateTime(replay.firstBattleAt)} / {fmtDateTime(replay.lastBattleAt)}</span></div>
                {(replay.aiAirKills > 0 || replay.aiGroundKills > 0) && (
                  <div className="row"><span className="muted">{t('player.replay.aiKills')}</span><span>{fmtInt(replay.aiAirKills + replay.aiGroundKills)}</span></div>
                )}
                {replay.teamKills > 0 && (
                  <div className="row"><span className="muted">{t('player.replay.teamKills')}</span><span>{fmtInt(replay.teamKills)}</span></div>
                )}
              </div>
            </>
          )}
        </div>

        <PlayerInsightsSection
          insights={insights}
          error={insightsError}
          days={insightDays}
          onDays={setInsightDays}
          dict={dict}
        />
      </section>

      <section id="history" className="player-section">
        <div className="card">
          <SecHead title={t('player.history')}>
            <span style={{ marginLeft: 'auto' }}>
              <SegControl options={HISTORY_DAYS} value={days} onChange={setDays} ariaLabel={t('a11y.period.history')} />
            </span>
          </SecHead>
          {historyError !== null ? <ErrorNotice error={historyError} /> : history === null ? <Loading text={t('player.history.building')} /> : (
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
      </section>

      <section id="battles" className="player-section">
        <div className="card">
          <SecHead title={t('player.recent')}>
            {player.wtUserId && (
              <Link to={`/battles?player=${player.wtUserId}`} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600 }}>{t('common.allLink')}</Link>
            )}
          </SecHead>
          {battlesError !== null && <ErrorNotice error={battlesError} />}
          {battles === null ? (battlesError === null && <Loading />) : battles.length === 0 ? (
            <div className="muted small">{t('player.recent.empty')}</div>
          ) : (
            <>
              {battles.map((battle) => (
                <Link key={battle.sessionId} to={`/battles/${battle.sessionId}`} className="row-item" style={{ padding: '9px 12px' }}>
                  <ResultBadge won={battle.player?.won ?? null} />
                  <span className="title">
                    {battle.missionName}
                    {battle.player?.vehicle && <span className="sub">{vehicleName(dict, battle.player.vehicle)}</span>}
                  </span>
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
              ))}
              {battlesMore !== 'end' && (
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn small" onClick={loadMoreBattles} disabled={battlesMore === 'loading'}>
                    {battlesMore === 'loading' ? t('common.loading') : t('player.recent.more')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {nickRows.length > 1 && (
        <section id="nicks" className="player-section">
          <div className="card">
            <SecHead title={t('player.aliases')} />
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr><th>{t('player.aliases.col.nick')}</th><th>{t('player.aliases.col.source')}</th><th>{t('player.aliases.col.first')}</th><th>{t('player.aliases.col.last')}</th></tr></thead>
                <tbody>
                  {nickRows.map((row) => (
                    <tr key={`${row.source}:${row.nick}:${row.first}`}>
                      <td>{row.nick}</td>
                      <td className="muted" style={{ fontWeight: 400 }}>{row.source}</td>
                      <td className="muted" style={{ fontWeight: 400 }}>{row.last === null ? fmtDate(row.first) : fmtDateTime(row.first)}</td>
                      <td className="muted" style={{ fontWeight: 400 }}>{row.last === null ? '—' : fmtDateTime(row.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {accounts.length > 0 && (
        <section id="sources" className="player-section">
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
        </section>
      )}

      <div className="notice muted small">{t('player.disclaimer')}</div>
    </>
  )
}
