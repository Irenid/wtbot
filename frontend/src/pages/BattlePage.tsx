import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  fetchBattle,
  fetchBattleScene,
  fetchVehicleDict,
  SiteApiError,
  type BattleScene,
  type BattleScoreboard,
  type ScoreboardPlayer,
  type VehicleDict,
} from '../api'
import { fmtDateTime, fmtDuration, fmtInt, modeLabel, vehicleClassLabel } from '../lib/format'
import { Chip, ErrorNotice, Loading, SecHead } from '../components/ui'
import { ScenePlayer } from '../components/ScenePlayer'
import { t, tp } from '../i18n'

function vehicleTitle(dict: VehicleDict, player: ScoreboardPlayer): string {
  const names = player.vehicles.length > 0 ? player.vehicles : player.vehicle ? [player.vehicle] : []
  return names
    .map((id) => {
      const info = dict[id]
      return info ? `${info.name} (${vehicleClassLabel(info.cls)})` : id
    })
    .join(', ')
}

function vehicleLabel(dict: VehicleDict, player: ScoreboardPlayer): string {
  const id = player.vehicle ?? player.vehicles[0]
  if (!id) return '—'
  const name = dict[id]?.name ?? id
  const extra = player.vehicles.length > 1 ? ` +${player.vehicles.length - 1}` : ''
  return `${name}${extra}`
}

/* Название команды для шапки: доминирующий клан-тег, иначе «Команда N». */
function teamLabel(players: ScoreboardPlayer[], team: number): string {
  const counts = new Map<string, number>()
  for (const player of players) {
    if (player.clanTag) counts.set(player.clanTag, (counts.get(player.clanTag) ?? 0) + 1)
  }
  let top: string | null = null
  let topCount = 0
  for (const [tag, count] of counts) {
    if (count > topCount) { top = tag; topCount = count }
  }
  return top !== null && topCount >= 2 ? `${t('battlePage.team', { n: team })} · ${top}` : t('battlePage.team', { n: team })
}

type SceneState =
  | { status: 'loading' }
  | { status: 'ready'; scene: BattleScene }
  | { status: 'unavailable' }
  | { status: 'busy' }

export function BattlePage() {
  const { battleKey = '' } = useParams()
  const [scoreboard, setScoreboard] = useState<BattleScoreboard | null>(null)
  const [scene, setScene] = useState<SceneState>({ status: 'loading' })
  const [dict, setDict] = useState<VehicleDict>({})
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    setScoreboard(null)
    setScene({ status: 'loading' })
    setError(null)
    fetchBattle(battleKey)
      .then((body) => { if (!cancelled) setScoreboard(body) })
      .catch((err) => { if (!cancelled) setError(err) })
    fetchVehicleDict().then((loaded) => { if (!cancelled) setDict(loaded) })
    const loadScene = (attempt: number): void => {
      fetchBattleScene(battleKey)
        .then((body) => { if (!cancelled) setScene({ status: 'ready', scene: body }) })
        .catch((err) => {
          if (cancelled) return
          // Сборщик сцен занят — повторяем несколько раз с паузой.
          if (err instanceof SiteApiError && err.status === 503 && attempt < 5) {
            setScene({ status: 'busy' })
            window.setTimeout(() => { if (!cancelled) loadScene(attempt + 1) }, 5_000)
            return
          }
          setScene({ status: 'unavailable' })
        })
    }
    loadScene(0)
    return () => { cancelled = true }
  }, [battleKey])

  if (error !== null) {
    const message = error instanceof SiteApiError && error.status === 404
      ? t('battlePage.notFound')
      : undefined
    return (
      <>
        <div className="page-head"><h1>{t('battlePage.title')}</h1></div>
        {message ? <div className="notice fail">{message}</div> : <ErrorNotice error={error} />}
      </>
    )
  }
  if (!scoreboard) return <Loading text={t('battlePage.loading')} />

  const { battle, teams } = scoreboard
  const winner = teams.find((team) => team.won === true) ?? null
  const maxScore = Math.max(1, ...teams.flatMap((team) => team.players.map((player) => player.score)))
  const mvp = teams
    .flatMap((team) => team.players)
    .reduce<ScoreboardPlayer | null>((best, player) => (best === null || player.score > best.score ? player : best), null)

  return (
    <>
      <div className="crumbs">
        <Link to="/battles">{t('nav.battles')}</Link>
        <span className="sep">/</span>
        <span className="here">{battle.missionName}</span>
      </div>

      <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(24px, 3.4vw, 30px)', fontWeight: 700, letterSpacing: '-0.01em', marginRight: 4 }}>
          {battle.missionName}
        </h1>
        {battle.winnerKnown && winner !== null
          ? <Chip tone="ok">{t('battlePage.victory', { team: teamLabel(winner.players, winner.team) })}</Chip>
          : <Chip>{t('battlePage.unknownOutcome')}</Chip>}
        {battle.gameMode && <Chip>{modeLabel(battle.gameMode)}</Chip>}
        <Chip>{fmtDateTime(battle.startTime)} · {fmtDuration(battle.durationSec)}</Chip>
        {battle.gameVersion && <Chip>v{battle.gameVersion}</Chip>}
        <a
          className="chip accent"
          style={{ marginLeft: 'auto' }}
          href={`https://warthunder.com/en/tournament/replay/${battle.sessionId}`}
          target="_blank"
          rel="noreferrer"
        >
          {t('battlePage.replayLink')}
        </a>
      </header>
      <div className="muted small" style={{ marginBottom: 14 }}>
        {t('battlePage.matchMeta', { id: battle.sessionId, players: battle.playerCount, kills: battle.killCount })}
      </div>

      <div className="card">
        <SecHead title={t('battlePage.map')} hint={t('battlePage.map.hint')} />
        {scene.status === 'loading' && <Loading text={t('battlePage.scene.preparing')} />}
        {scene.status === 'busy' && <Loading text={t('battlePage.scene.busy')} />}
        {scene.status === 'unavailable' && (
          <div className="muted small">{t('battlePage.scene.unavailable')}</div>
        )}
        {scene.status === 'ready' && <ScenePlayer scene={scene.scene} dict={dict} battleKey={battleKey} />}
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        {teams.map((team) => (
          // Цвет привязан к номеру команды, как в плеере сцены (1 — синяя, 2 — оранжевая),
          // а не к порядку сортировки по счёту.
          <section className={`team-card ${team.team === 1 ? 't1' : 't2'}`} key={team.team} style={{ marginBottom: 16 }}>
            <div className="team-head">
              <span className="team-dot" style={{ background: team.team === 1 ? 'var(--team1-bright)' : 'var(--team2-bright)' }} />
              <h2>{teamLabel(team.players, team.team)}</h2>
              <span className="muted" style={{ fontSize: 11 }}>{tp('common.players', team.players.length)} · {t('battlePage.team.score', { n: fmtInt(team.totalScore) })}</span>
              <span style={{ marginLeft: 'auto' }}>
                {team.won === true && <span className="result-badge win">{t('battlePage.result.win')}</span>}
                {team.won === false && <span className="result-badge loss">{t('battlePage.result.loss')}</span>}
                {team.won === null && <span className="result-badge unknown">?</span>}
              </span>
            </div>
            <div className="tbl-scroll">
              <table className="tbl" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>{t('battlePage.col.player')}</th><th>{t('battlePage.col.vehicle')}</th>
                    <th className="num" title={t('battlePage.col.air.title')}>{t('battlePage.col.air')}</th>
                    <th className="num" title={t('battlePage.col.ground.title')}>{t('battlePage.col.ground')}</th>
                    <th className="num" title={t('battlePage.col.naval.title')}>{t('battlePage.col.naval')}</th>
                    <th className="num" title={t('battlePage.col.ai.title')}>{t('battlePage.col.ai')}</th>
                    <th className="num">{t('battlePage.col.assists')}</th>
                    <th className="num">{t('battlePage.col.captures')}</th>
                    <th className="num">{t('battlePage.col.deaths')}</th>
                    <th className="num">{t('battlePage.col.score')}</th>
                  </tr>
                </thead>
                <tbody>
                  {team.players.map((player) => {
                    const isMvp = mvp !== null && player === mvp && battle.playerCount > 1
                    return (
                      <tr
                        key={`${player.userId}:${player.nick}`}
                        style={{
                          ...(player.disconnected ? { opacity: 0.55 } : {}),
                          ...(isMvp ? { background: 'rgba(245, 188, 74, 0.05)' } : {}),
                        }}
                      >
                        <td>
                          {player.clanTag && (
                            <span className="muted" style={{ fontWeight: 400 }}>
                              {player.clanCore ? <Link to={`/clans/${player.clanCore}`} style={{ fontWeight: 400 }}>{player.clanTag}</Link> : player.clanTag}
                              {' '}
                            </span>
                          )}
                          {player.userId ? <Link to={`/players/${player.userId}`}>{player.nick}</Link> : <span style={{ fontWeight: 600 }}>{player.nick}</span>}
                          {isMvp && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>{t('battlePage.mvp')}</span>}
                          {player.disconnected && <span className="muted small" style={{ fontWeight: 400 }}> {t('battlePage.disconnected')}</span>}
                        </td>
                        <td className="muted" style={{ fontWeight: 400 }} title={vehicleTitle(dict, player)}>{vehicleLabel(dict, player)}</td>
                        <td className="num" style={player.airKills > 0 ? { color: 'var(--ok)', fontWeight: 700 } : undefined}>{fmtInt(player.airKills)}</td>
                        <td className="num" style={player.groundKills > 0 ? { color: 'var(--ok)', fontWeight: 700 } : undefined}>{fmtInt(player.groundKills)}</td>
                        <td className="num" style={player.navalKills > 0 ? { color: 'var(--ok)', fontWeight: 700 } : undefined}>{fmtInt(player.navalKills)}</td>
                        <td className="num muted">{fmtInt(player.aiAirKills + player.aiGroundKills)}</td>
                        <td className="num">{fmtInt(player.assists)}</td>
                        <td className="num" style={player.captureZone > 0 ? { color: 'var(--accent)', fontWeight: 700 } : undefined}>{fmtInt(player.captureZone)}</td>
                        <td className="num" style={player.deaths > 0 ? { color: 'var(--fail)' } : undefined}>{fmtInt(player.deaths)}</td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {fmtInt(player.score)}
                          <div className="cell-bar" style={{ maxWidth: 64, marginLeft: 'auto' }}>
                            <div style={{ width: `${Math.max(2, (player.score / maxScore) * 100).toFixed(0)}%` }} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
