import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchBattles, fetchClans, type BattleListEntry, type ClanListEntry } from '../api'
import { battleVersusLabel, fmtDateTime, fmtDuration, fmtInt, modeLabel } from '../lib/format'
import { Chip, ErrorNotice, Loading, ResultBadge, SegControl } from '../components/ui'
import { t, tp, useLocale } from '../i18n'

/* Плитка режима боя: В — воздух (синяя), З — земля (оранжевая), ? — неизвестно. */
function ModeTile({ gameMode }: { gameMode: string | null }) {
  const air = gameMode !== null && gameMode.toLowerCase().includes('air')
  const known = gameMode !== null
  const background = !known ? 'var(--elevated)' : air ? 'rgba(127, 155, 255, 0.14)' : 'rgba(242, 152, 74, 0.14)'
  const color = !known ? 'var(--muted)' : air ? 'var(--team1-bright)' : 'var(--team2-bright)'
  return (
    <span
      title={gameMode === null ? t('mode.unknown') : modeLabel(gameMode)}
      style={{
        width: 40, height: 40, flex: 'none', borderRadius: 10, background, color,
        display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 15,
        fontFamily: 'var(--font-display)',
      }}
    >
      {!known ? '?' : air ? t('mode.air.letter') : t('mode.ground.letter')}
    </span>
  )
}

export function BattlesPage() {
  const { locale } = useLocale()
  const [searchParams, setSearchParams] = useSearchParams()
  const player = searchParams.get('player') ?? undefined
  const clan = searchParams.get('clan') ?? undefined
  const [battles, setBattles] = useState<BattleListEntry[] | null>(null)
  const [clans, setClans] = useState<ClanListEntry[]>([])
  const [outcome, setOutcome] = useState<'all' | 'w' | 'l'>('all')
  const [mode, setMode] = useState<'all' | 'ground' | 'air'>('all')
  const [error, setError] = useState<unknown>(null)

  const OUTCOMES = useMemo(() => [
    { value: 'all', label: t('common.all') },
    { value: 'w', label: t('battles.filter.wins') },
    { value: 'l', label: t('battles.filter.losses') },
  ] as const, [locale])

  const MODES = useMemo(() => [
    { value: 'all', label: t('common.all') },
    { value: 'ground', label: t('battles.filter.ground') },
    { value: 'air', label: t('battles.filter.air') },
  ] as const, [locale])

  useEffect(() => {
    let cancelled = false
    setBattles(null)
    setError(null)
    setOutcome('all')
    fetchBattles({ ...(player ? { player } : {}), ...(clan ? { clan } : {}), limit: 50 })
      .then((body) => { if (!cancelled) setBattles(body.battles) })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [player, clan])

  useEffect(() => {
    let cancelled = false
    fetchClans().then((body) => { if (!cancelled) setClans(body.clans.slice(0, 3)) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Исход известен из личного результата (player=) или стороны клана (clan=).
  const outcomeAvailable = Boolean(player || clan)
  const filtered = useMemo(() => {
    if (battles === null) return null
    return battles.filter((battle) => {
      if (mode !== 'all') {
        const air = battle.gameMode !== null && battle.gameMode.toLowerCase().includes('air')
        if (battle.gameMode === null) return false
        if (mode === 'air' ? !air : air) return false
      }
      if (outcome !== 'all' && outcomeAvailable) {
        const won = battle.player?.won ?? battle.clanSide?.won ?? null
        if (won !== (outcome === 'w')) return false
      }
      return true
    })
  }, [battles, outcome, mode, outcomeAvailable])

  const setClanParam = (core: string | null): void => {
    const next = new URLSearchParams(searchParams)
    if (core === null) next.delete('clan')
    else next.set('clan', core)
    next.delete('player')
    setSearchParams(next)
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('battles.title')}</h1>
        {player && <Chip tone="accent">{t('battles.chip.player', { id: player })}</Chip>}
        <span className="muted small">
          {t('battles.subtitle')}
          {battles !== null && <> · {t('battles.shown', { shown: filtered?.length ?? 0, total: battles.length })}</>}
        </span>
      </div>
      <div className="tabs">
        {outcomeAvailable && (
          <>
            <span className="label">{t('battles.filter.outcome')}</span>
            <SegControl options={OUTCOMES} value={outcome} onChange={setOutcome} ariaLabel={t('a11y.filter.outcome')} />
          </>
        )}
        <span className="label">{t('battles.filter.mode')}</span>
        <SegControl options={MODES} value={mode} onChange={setMode} ariaLabel={t('a11y.filter.mode')} />
        {clans.length > 0 && (
          <>
            <span className="label">{t('battles.filter.clan')}</span>
            <div className="seg-control" role="group" aria-label={t('a11y.filter.clan')}>
              <button type="button" className={clan === undefined ? 'active' : ''} onClick={() => setClanParam(null)}>{t('common.all')}</button>
              {clans.map((entry) => (
                <button
                  key={entry.coreTag}
                  type="button"
                  className={clan === entry.coreTag ? 'active' : ''}
                  onClick={() => setClanParam(entry.coreTag)}
                >
                  {entry.displayTag}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {error !== null && <ErrorNotice error={error} />}
      {filtered === null ? <Loading /> : filtered.length === 0 ? (
        <div className="notice">{mode !== 'all' || outcome !== 'all' ? t('battles.empty.filtered') : t('battles.empty')}</div>
      ) : (
        <div className="card" style={{ padding: 10 }}>
          {filtered.map((battle) => {
            const versus = battleVersusLabel(battle.teams)
            const won = battle.player?.won ?? battle.clanSide?.won ?? null
            return (
              <Link key={battle.sessionId} to={`/battles/${battle.sessionId}`} className="row-item" style={{ padding: '11px 14px' }}>
                <ModeTile gameMode={battle.gameMode} />
                <span className="title">
                  {versus ?? battle.missionName}
                  <span className="sub">
                    {versus !== null && `${battle.missionName} · `}
                    {battle.gameMode === null ? t('mode.unknown') : modeLabel(battle.gameMode)} · {tp('common.players', battle.playerCount)} · {tp('common.kills', battle.killCount)}
                  </span>
                </span>
                {outcomeAvailable && <ResultBadge won={won} />}
                {battle.player?.score !== null && battle.player?.score !== undefined && (
                  <span className="end" style={{ color: 'var(--ink2)' }}>{t('battles.score.count', { n: fmtInt(battle.player.score) })}</span>
                )}
                <span className="end">{fmtDuration(battle.durationSec)}</span>
                <span className="end">{fmtDateTime(battle.startTime)}</span>
              </Link>
            )
          })}
          <div className="muted small" style={{ padding: '10px 14px 4px' }}>
            {t('battles.hint')}
          </div>
        </div>
      )}
    </>
  )
}
