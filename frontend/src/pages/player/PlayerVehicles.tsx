import { useMemo, useState } from 'react'
import type { AccountView, ExternalVehicle, VehicleDict } from '../../api'
import { BarTrack, SecHead, SegControl } from '../../components/ui'
import { fmtInt, fmtPercent, fmtRatio, modeLabel, modeShortLabel, nationLabel, sourceLabel, sumKills, vehicleClassLabel } from '../../lib/format'
import { t } from '../../i18n'

type SortKey = 'flyouts' | 'victories' | 'rate' | 'kills' | 'deaths' | 'kd'
type ModeFilter = 'all' | 'arcade' | 'realistic' | 'simulator'

const COLLAPSED_ROWS = 15

interface VehicleRow {
  vehicle: ExternalVehicle
  name: string
  cls: string
  country: string
  kills: number | null
  rate: number | null
  kd: number | null
}

function sortValue(row: VehicleRow, key: SortKey): number {
  switch (key) {
    case 'flyouts': return row.vehicle.flyouts ?? -1
    case 'victories': return row.vehicle.victories ?? -1
    case 'rate': return row.rate ?? -1
    case 'kills': return row.kills ?? -1
    case 'deaths': return row.vehicle.deaths ?? -1
    case 'kd': return row.kd ?? -1
  }
}

/** Режимы источника: realistic/simulator у StatShark, как и в modeLabel. */
function modeOf(mode: string | null): ModeFilter | null {
  if (mode === 'arcade') return 'arcade'
  if (mode === 'realistic') return 'realistic'
  if (mode === 'simulator' || mode === 'simulation') return 'simulator'
  return null
}

/**
 * Техника аккаунта (до 300 строк источника по вылетам): поиск, фильтры по
 * режиму, классу и нации из словаря техники, сортировка по любому столбцу.
 */
export function PlayerVehicles({ account, dict }: { account: AccountView; dict: VehicleDict }) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<ModeFilter>('all')
  const [cls, setCls] = useState('all')
  const [country, setCountry] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'flyouts', desc: true })
  const [expanded, setExpanded] = useState(false)

  const rows = useMemo<VehicleRow[]>(() => account.vehicles.map((vehicle) => {
    const info = dict[vehicle.vehicleId]
    const kills = sumKills(vehicle)
    return {
      vehicle,
      name: info?.name ?? vehicle.vehicleId,
      cls: info?.cls ?? '?',
      country: info?.country ?? '',
      kills,
      rate: vehicle.flyouts && vehicle.victories !== null ? Math.min(1, vehicle.victories / vehicle.flyouts) : null,
      kd: vehicle.deaths && kills !== null ? kills / vehicle.deaths : null,
    }
  }), [account.vehicles, dict])

  const classes = useMemo(() => [...new Set(rows.map((row) => row.cls))].filter((value) => value !== '?').sort(), [rows])
  const countries = useMemo(() => [...new Set(rows.map((row) => row.country))].filter(Boolean).sort(), [rows])
  const modes = useMemo(() => {
    const present = new Set(rows.map((row) => modeOf(row.vehicle.mode)))
    return [
      { value: 'all' as const, label: t('common.all') },
      ...(['arcade', 'realistic', 'simulator'] as const)
        .filter((value) => present.has(value))
        .map((value) => ({ value, label: modeShortLabel(value) })),
    ]
  }, [rows])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return rows
      .filter((row) => mode === 'all' || modeOf(row.vehicle.mode) === mode)
      .filter((row) => cls === 'all' || row.cls === cls)
      .filter((row) => country === 'all' || row.country === country)
      .filter((row) => needle === '' || row.name.toLocaleLowerCase().includes(needle) || row.vehicle.vehicleId.includes(needle))
      .sort((left, right) => (sortValue(right, sort.key) - sortValue(left, sort.key)) * (sort.desc ? 1 : -1))
  }, [rows, query, mode, cls, country, sort])
  const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_ROWS)

  const header = (key: SortKey, label: string) => (
    <th className="num" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="sort-button"
        onClick={() => setSort((current) => ({ key, desc: current.key === key ? !current.desc : true }))}
        title={t('a11y.sort', { col: label })}
      >
        {label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px 0' }}>
        <SecHead
          title={t('player.vehicles', { source: sourceLabel(account.source) })}
          hint={t('player.vehicles.hint.top', { n: fmtInt(account.vehicles.length), total: fmtInt(account.vehicleCount) })}
        />
        <div className="toolbar">
          <input
            className="input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('player.vehicles.search')}
            aria-label={t('player.vehicles.search')}
          />
          {modes.length > 2 && <SegControl options={modes} value={mode} onChange={setMode} ariaLabel={t('a11y.vehicles.mode')} />}
          <select className="select" value={cls} onChange={(event) => setCls(event.target.value)} aria-label={t('a11y.vehicles.class')}>
            <option value="all">{t('player.vehicles.class.all')}</option>
            {classes.map((value) => <option key={value} value={value}>{vehicleClassLabel(value)}</option>)}
          </select>
          <select className="select" value={country} onChange={(event) => setCountry(event.target.value)} aria-label={t('a11y.vehicles.nation')}>
            <option value="all">{t('player.vehicles.nation.all')}</option>
            {countries.map((value) => <option key={value} value={value}>{nationLabel(value)}</option>)}
          </select>
        </div>
      </div>
      <div className="tbl-scroll" style={{ margin: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('player.vehicles.col.vehicle')}</th>
              <th>{t('player.vehicles.col.mode')}</th>
              {header('flyouts', t('metric.flyouts'))}
              {header('victories', t('metric.victories'))}
              {header('kills', t('metric.kills'))}
              {header('deaths', t('metric.deaths'))}
              {header('kd', t('player.vehicles.col.kd'))}
              <th style={{ minWidth: 130 }} className="num">
                <button type="button" className="sort-button" onClick={() => setSort((current) => ({ key: 'rate', desc: current.key === 'rate' ? !current.desc : true }))} title={t('a11y.sort', { col: t('metric.winsPerFlyout') })}>
                  {t('metric.winsPerFlyout')}{sort.key === 'rate' ? (sort.desc ? ' ↓' : ' ↑') : ''}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={`${row.vehicle.mode}:${row.vehicle.vehicleId}`}>
                <td title={row.vehicle.vehicleId}>
                  {row.name}
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                    {[row.country ? nationLabel(row.country) : null, row.cls !== '?' ? vehicleClassLabel(row.cls) : null].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="muted" style={{ fontWeight: 400 }}>{modeLabel(row.vehicle.mode)}</td>
                <td className="num">{fmtInt(row.vehicle.flyouts)}</td>
                <td className="num">{fmtInt(row.vehicle.victories)}</td>
                <td className="num">{fmtInt(row.kills)}</td>
                <td className="num">{fmtInt(row.vehicle.deaths)}</td>
                <td className="num">{fmtRatio(row.kd)}</td>
                <td>
                  <div className="bar-row" style={{ gridTemplateColumns: '1fr 54px', padding: 0 }}>
                    <BarTrack fraction={row.rate} title={`${t('metric.winsPerFlyout')}: ${fmtPercent(row.rate)}`} />
                    <span className="bar-value small">{fmtPercent(row.rate)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="muted small" style={{ padding: '12px 20px' }}>{t('player.vehicles.empty')}</div>}
      </div>
      {filtered.length > COLLAPSED_ROWS && (
        <div style={{ padding: '10px 20px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" className="btn small" onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('player.vehicles.showLess') : t('player.vehicles.showAll', { n: fmtInt(filtered.length) })}
          </button>
          <span className="muted small">{t('player.vehicles.shown', { shown: fmtInt(visible.length), total: fmtInt(filtered.length) })}</span>
        </div>
      )}
    </div>
  )
}
