import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchBattles, fetchClans, type BattleListEntry, type ClanListEntry } from '../api'
import { battleVersusLabel, fmtDateTime, fmtDuration, fmtInt, modeLabel, modeShortLabel } from '../lib/format'
import { Chip, ErrorNotice, Loading, ResultBadge, SegControl } from '../components/ui'
import { t, tp, useLocale } from '../i18n'

/** Столько боёв приходит за один запрос (предел API — 100). */
const PAGE_SIZE = 50

/*
 * Плитка режима реализма: АБ/РБ/СБ. Род войск по game_mode определить нельзя —
 * это уровень реализма, а клановые бои в собранных данных наземные с авиацией.
 */
function ModeTile({ gameMode }: { gameMode: string | null }) {
  const known = gameMode !== null
  return (
    <span
      title={known ? modeLabel(gameMode) : t('mode.unknown')}
      style={{
        width: 40, height: 40, flex: 'none', borderRadius: 10,
        background: known ? 'rgba(242, 152, 74, 0.14)' : 'var(--elevated)',
        color: known ? 'var(--team2-bright)' : 'var(--muted)',
        display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13,
        fontFamily: 'var(--font-display)',
      }}
    >
      {known ? modeShortLabel(gameMode) : '?'}
    </span>
  )
}

export function BattlesPage() {
  const { locale } = useLocale()
  const [searchParams, setSearchParams] = useSearchParams()
  const player = searchParams.get('player') ?? undefined
  const clan = searchParams.get('clan') ?? undefined
  const [battles, setBattles] = useState<BattleListEntry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)
  const [clans, setClans] = useState<ClanListEntry[]>([])
  const [outcome, setOutcome] = useState<'all' | 'w' | 'l'>('all')
  const [error, setError] = useState<unknown>(null)
  // Поколение запросов: ответ «показать ещё» по старым фильтрам отбрасывается.
  const generation = useRef(0)

  const OUTCOMES = useMemo(() => [
    { value: 'all', label: t('common.all') },
    { value: 'w', label: t('battles.filter.wins') },
    { value: 'l', label: t('battles.filter.losses') },
  ] as const, [locale])

  useEffect(() => {
    const current = ++generation.current
    setBattles(null)
    setError(null)
    setOutcome('all')
    setHasMore(false)
    setMoreError(null)
    setLoadingMore(false)
    fetchBattles({ ...(player ? { player } : {}), ...(clan ? { clan } : {}), limit: PAGE_SIZE })
      .then((body) => {
        if (current !== generation.current) return
        setBattles(body.battles)
        setHasMore(body.battles.length === PAGE_SIZE)
      })
      .catch((err) => { if (current === generation.current) setError(err) })
  }, [player, clan])

  useEffect(() => {
    let cancelled = false
    // Быстрые ссылки на кланы — вспомогательные: без них фильтр по клану доступен из URL.
    fetchClans().then((body) => { if (!cancelled) setClans(body.clans.slice(0, 3)) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const loadMore = (): void => {
    const oldest = battles?.[battles.length - 1]
    if (oldest === undefined || loadingMore) return
    const current = generation.current
    setLoadingMore(true)
    setMoreError(null)
    // Граница `to` исключающая: +1 захватывает бои с тем же временем старта,
    // уже показанные отбрасываются по sessionId.
    fetchBattles({
      ...(player ? { player } : {}),
      ...(clan ? { clan } : {}),
      limit: PAGE_SIZE,
      to: oldest.startTime + 1,
    })
      .then((body) => {
        if (current !== generation.current) return
        setBattles((previous) => {
          const shown = previous ?? []
          const known = new Set(shown.map((battle) => battle.sessionId))
          return [...shown, ...body.battles.filter((battle) => !known.has(battle.sessionId))]
        })
        setHasMore(body.battles.length === PAGE_SIZE)
      })
      .catch((err) => { if (current === generation.current) setMoreError(err) })
      .finally(() => { if (current === generation.current) setLoadingMore(false) })
  }

  // Исход известен из личного результата (player=) или стороны клана (clan=).
  const outcomeAvailable = Boolean(player || clan)
  const filtered = useMemo(() => {
    if (battles === null) return null
    if (outcome === 'all' || !outcomeAvailable) return battles
    return battles.filter((battle) => {
      const won = battle.player?.won ?? battle.clanSide?.won ?? null
      return won === (outcome === 'w')
    })
  }, [battles, outcome, outcomeAvailable])

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
        {clans.length > 0 && (
          <>
            <span className="label">{t('battles.filter.clan')}</span>
            <div className="seg-control" role="group" aria-label={t('a11y.filter.clan')}>
              <button
                type="button"
                className={clan === undefined ? 'active' : ''}
                aria-pressed={clan === undefined}
                onClick={() => setClanParam(null)}
              >
                {t('common.all')}
              </button>
              {clans.map((entry) => (
                <button
                  key={entry.coreTag}
                  type="button"
                  className={clan === entry.coreTag ? 'active' : ''}
                  aria-pressed={clan === entry.coreTag}
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
      {error !== null ? null : filtered === null ? <Loading /> : filtered.length === 0 && !hasMore ? (
        <div className="notice">{outcome !== 'all' ? t('battles.empty.filtered') : t('battles.empty')}</div>
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
          {moreError !== null && <ErrorNotice error={moreError} />}
          <div className="muted small" style={{ padding: '10px 14px 4px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {hasMore ? (
              <button type="button" className="btn small" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
                {loadingMore ? t('common.loading') : t('battles.more')}
              </button>
            ) : (
              <span>{t('battles.end')}</span>
            )}
            <span>{t('battles.hint')}</span>
          </div>
        </div>
      )}
    </>
  )
}
