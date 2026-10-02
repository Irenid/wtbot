import { Link } from 'react-router-dom'
import type { PlayerInsightPlayer, PlayerInsights, VehicleDict } from '../../api'
import { BarRow, BarTrack, ErrorNotice, Loading, Panel, SecHead, SegControl } from '../../components/ui'
import { cleanClanTag, coreClanTag, fmtInt, fmtPercent, fmtRatio } from '../../lib/format'
import { t, tp } from '../../i18n'
import { ActivityHeatmap } from './ActivityHeatmap'

export type InsightDays = '30' | '90' | '400'

const rate = (wins: number, decided: number) => (decided > 0 ? wins / decided : null)

function RateCell({ value }: { value: number | null }) {
  return (
    <div className="bar-row" style={{ gridTemplateColumns: '1fr 50px', padding: 0, minWidth: 110 }}>
      <BarTrack fraction={value} title={t('a11y.winrate', { value: fmtPercent(value) })} />
      <span className="bar-value small">{fmtPercent(value)}</span>
    </div>
  )
}

function vehicleName(dict: VehicleDict, id: string): string {
  return dict[id]?.name ?? id
}

/** Оружие из battle_kills: словарь техники знает только часть id — остальным читаемый вид. */
function weaponName(dict: VehicleDict, id: string): string {
  return dict[id]?.name ?? id.replace(/_/g, ' ')
}

/** Счётчик по игрокам со ссылкой на профиль по WT user id. */
function PlayerCounts({ title, rows }: { title: string; rows: PlayerInsightPlayer[] }) {
  const max = Math.max(1, ...rows.map((row) => row.count))
  return (
    <Panel title={title}>
      {rows.length === 0 ? <div className="muted small">{t('player.insights.empty')}</div> : rows.map((row) => (
        <BarRow
          key={row.userId}
          label={<Link to={`/players/${row.userId}`}>{row.nick}</Link>}
          fraction={row.count / max}
          right={tp('common.kills', row.count)}
        />
      ))}
    </Panel>
  )
}

function VehicleCounts({ title, rows, dict }: { title: string; rows: { vehicleId: string; kills: number }[]; dict: VehicleDict }) {
  const max = Math.max(1, ...rows.map((row) => row.kills))
  return (
    <Panel title={title}>
      {rows.length === 0 ? <div className="muted small">{t('player.insights.empty')}</div> : rows.map((row) => (
        <BarRow key={row.vehicleId} label={vehicleName(dict, row.vehicleId)} fraction={row.kills / max} right={tp('common.kills', row.kills)} />
      ))}
    </Panel>
  )
}

/**
 * Разбор локальных реплеев за период: на каких картах, на чём и против кого
 * игрок воюет, с кем в команде, чем и кого уничтожает и когда играет.
 */
export function PlayerInsightsSection({ insights, error, days, onDays, dict }: {
  insights: PlayerInsights | null | undefined
  error: unknown
  days: InsightDays
  onDays: (days: InsightDays) => void
  dict: VehicleDict
}) {
  const periods = [
    { value: '30' as const, label: t('common.days.30') },
    { value: '90' as const, label: t('common.days.90') },
    { value: '400' as const, label: t('common.days.400') },
  ]
  const hint = insights
    ? `${t('player.insights.hint', { days })} · ${tp('common.battles', insights.battles)}${insights.capped ? ` · ${t('player.insights.capped', { n: insights.battles })}` : ''}`
    : t('player.insights.hint', { days })
  return (
    <div className="card">
      <SecHead title={t('player.insights')} hint={hint}>
        <span style={{ marginLeft: 'auto' }}>
          <SegControl options={periods} value={days} onChange={onDays} ariaLabel={t('a11y.period.history')} />
        </span>
      </SecHead>
      {error !== null && error !== undefined ? <ErrorNotice error={error} />
        : insights === undefined ? <Loading text={t('player.insights.loading')} />
          : insights === null ? <div className="muted small">{t('player.insights.noId')}</div>
            : insights.battles === 0 ? <div className="muted small">{t('player.insights.none')}</div>
              : <InsightsBody insights={insights} dict={dict} />}
    </div>
  )
}

function InsightsBody({ insights, dict }: { insights: PlayerInsights; dict: VehicleDict }) {
  const weaponMax = Math.max(1, ...insights.weapons.map((row) => row.kills))
  return (
    <>
      <div className="insights-grid">
        <Panel title={t('player.insights.maps')}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>{t('player.insights.col.map')}</th><th className="num">{t('player.insights.col.battles')}</th><th className="num">{t('player.insights.col.record')}</th><th>{t('metric.winrate')}</th></tr></thead>
              <tbody>
                {insights.maps.map((map) => (
                  <tr key={map.mission}>
                    <td>{map.mission}</td>
                    <td className="num">{fmtInt(map.battles)}</td>
                    <td className="num"><span className="ok">{map.wins}</span>–<span className="fail">{map.losses}</span></td>
                    <td><RateCell value={rate(map.wins, map.wins + map.losses)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title={t('player.insights.vehicles')}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>{t('player.vehicles.col.vehicle')}</th><th className="num">{t('player.insights.col.battles')}</th><th className="num">{t('metric.kills')}</th><th className="num">{t('player.vehicles.col.kd')}</th><th>{t('metric.winrate')}</th></tr></thead>
              <tbody>
                {insights.vehicles.slice(0, 15).map((vehicle) => (
                  <tr key={vehicle.vehicleId}>
                    <td title={vehicle.vehicleId}>{vehicleName(dict, vehicle.vehicleId)}</td>
                    <td className="num">{fmtInt(vehicle.battles)}</td>
                    <td className="num">{fmtInt(vehicle.kills)}</td>
                    <td className="num">{vehicle.deaths > 0 ? fmtRatio(vehicle.kills / vehicle.deaths) : '—'}</td>
                    <td><RateCell value={rate(vehicle.wins, vehicle.battles)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title={t('player.insights.opponents')}>
          {insights.opponents.length === 0 ? <div className="muted small">{t('player.insights.empty')}</div> : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr><th>{t('player.insights.col.clan')}</th><th className="num">{t('player.insights.col.battles')}</th><th className="num">{t('player.insights.col.record')}</th><th>{t('metric.winrate')}</th></tr></thead>
                <tbody>
                  {insights.opponents.map((clan) => (
                    <tr key={clan.clanTag}>
                      <td><Link to={`/clans/${coreClanTag(clan.clanTag)}`}>{cleanClanTag(clan.clanTag)}</Link></td>
                      <td className="num">{fmtInt(clan.battles)}</td>
                      <td className="num"><span className="ok">{clan.wins}</span>–<span className="fail">{clan.losses}</span></td>
                      <td><RateCell value={rate(clan.wins, clan.wins + clan.losses)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={t('player.insights.teammates')}>
          {insights.teammates.length === 0 ? <div className="muted small">{t('player.insights.empty')}</div> : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr><th>{t('player.insights.col.player')}</th><th className="num">{t('player.insights.col.together')}</th><th>{t('metric.winrate')}</th></tr></thead>
                <tbody>
                  {insights.teammates.map((mate) => (
                    <tr key={mate.userId}>
                      <td><Link to={`/players/${mate.userId}`}>{mate.nick}</Link></td>
                      <td className="num">{fmtInt(mate.count)}</td>
                      <td><RateCell value={rate(mate.wins, mate.count)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={t('player.insights.weapons')}>
          {insights.weapons.length === 0 ? <div className="muted small">{t('player.insights.empty')}</div> : insights.weapons.map((row) => (
            <BarRow
              key={row.weapon}
              label={<span title={row.weapon}>{weaponName(dict, row.weapon)}</span>}
              fraction={row.kills / weaponMax}
              right={tp('common.kills', row.kills)}
            />
          ))}
        </Panel>

        <Panel title={t('player.insights.activity')} sub={t('player.insights.activity.hint')}>
          <ActivityHeatmap starts={insights.starts} />
        </Panel>

        <VehicleCounts title={t('player.insights.victims')} rows={insights.victims} dict={dict} />
        <VehicleCounts title={t('player.insights.killers')} rows={insights.killers} dict={dict} />
        <PlayerCounts title={t('player.insights.preys')} rows={insights.preys} />
        <PlayerCounts title={t('player.insights.nemeses')} rows={insights.nemeses} />
      </div>
    </>
  )
}
