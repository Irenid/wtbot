import type { PlayerAccount, PlayerRankMetric } from '../../api'
import { SecHead } from '../../components/ui'
import { fmtDate, fmtInt, fmtPercent, fmtPlace, rankMetricLabel, rankModeLabel } from '../../lib/format'
import { t } from '../../i18n'

const METRICS: readonly PlayerRankMetric[] = ['battles', 'victories', 'winRate', 'score', 'airKills', 'groundKills']
/** Порядок строк: общие рейтинги, затем танки, авиация, вертолёты, флот. */
const MODE_ORDER = [
  'historical', 'arcade', 'simulation',
  'tank_realistic', 'tank_arcade', 'tank_simulation',
  'air_realistic', 'air_arcade', 'air_simulation',
  'helicopter_arcade', 'test_ship_realistic', 'test_ship_arcade',
]

function metricValue(metric: PlayerRankMetric, value: number): string {
  return metric === 'winRate' ? fmtPercent(value) : fmtInt(Math.round(value))
}

/**
 * Места игрока среди всех игроков WT по данным StatShark: строки — рейтинги
 * (общие и по родам войск), колонки — метрики. Ниже — как менялось место по
 * победам (первая и последняя точка истории).
 */
export function PlayerRanks({ account }: { account: PlayerAccount }) {
  const byMode = new Map<string, Map<PlayerRankMetric, { value: number; place: number }>>()
  for (const rank of account.ranks) {
    const metrics = byMode.get(rank.mode) ?? new Map()
    metrics.set(rank.metric, { value: rank.value, place: rank.place })
    byMode.set(rank.mode, metrics)
  }
  const modes = [...byMode.keys()].sort((left, right) => MODE_ORDER.indexOf(left) - MODE_ORDER.indexOf(right))
  const columns = METRICS.filter((metric) => modes.some((mode) => byMode.get(mode)?.has(metric)))
  const best = Math.min(...account.ranks.map((rank) => rank.place))

  const trends = [...new Set(account.rankHistory.map((point) => point.mode))]
    .sort((left, right) => MODE_ORDER.indexOf(left) - MODE_ORDER.indexOf(right))
    .map((mode) => {
      const points = account.rankHistory.filter((point) => point.mode === mode && point.metric === 'victories')
      const first = points[0]
      const last = byMode.get(mode)?.get('victories')?.place ?? points.at(-1)?.place
      return first && last !== undefined && points.length > 0 ? { mode, first, last } : null
    })
    .filter((trend): trend is NonNullable<typeof trend> => trend !== null)

  if (modes.length === 0) return <div className="card"><SecHead title={t('player.ranks')} /><div className="muted small">{t('player.ranks.empty')}</div></div>
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px 0' }}>
        <SecHead title={t('player.ranks')} hint={t('player.ranks.hint')} />
      </div>
      <div className="tbl-scroll" style={{ margin: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('player.ranks.col.mode')}</th>
              {columns.map((metric) => <th key={metric} className="num">{rankMetricLabel(metric)}</th>)}
            </tr>
          </thead>
          <tbody>
            {modes.map((mode) => (
              <tr key={mode}>
                <td>{rankModeLabel(mode)}</td>
                {columns.map((metric) => {
                  const rank = byMode.get(mode)?.get(metric)
                  if (!rank) return <td key={metric} className="num muted">—</td>
                  return (
                    <td key={metric} className="num" title={`${rankMetricLabel(metric)}: ${metricValue(metric, rank.value)}`}>
                      <span style={rank.place === best ? { color: 'var(--accent)', fontWeight: 700 } : undefined}>{fmtPlace(rank.place)}</span>
                      <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{metricValue(metric, rank.value)}</div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trends.length > 0 && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
          <div className="muted small" style={{ marginBottom: 6 }}>{t('player.ranks.trend')}</div>
          {trends.map(({ mode, first, last }) => {
            const gained = first.place - last
            return (
              <div className="row" key={mode}>
                <span>{rankModeLabel(mode)}</span>
                <span>
                  {t('player.ranks.trendRow', { from: fmtPlace(first.place), date: fmtDate(first.at), to: fmtPlace(last) })}
                  {gained !== 0 && (
                    <b className={gained > 0 ? 'ok' : 'fail'} style={{ marginLeft: 8 }}>
                      {gained > 0 ? '▲' : '▼'} {fmtInt(Math.abs(gained))}
                    </b>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
