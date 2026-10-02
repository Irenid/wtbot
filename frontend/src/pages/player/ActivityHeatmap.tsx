import { useMemo } from 'react'
import { localeTag, t, tp } from '../../i18n'

/** Понедельник первым: 2024-01-01 — понедельник. */
function weekdayNames(): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    new Date(Date.UTC(2024, 0, 1 + index)).toLocaleDateString(localeTag(), { weekday: 'short', timeZone: 'UTC' }))
}

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

/**
 * Когда игрок играет: бои по дням недели и часам в поясе браузера. Одна
 * последовательная шкала (яркость акцента), точные числа — в подсказке ячейки
 * и в строке пика, поэтому цвет не единственный носитель значения.
 */
export function ActivityHeatmap({ starts }: { starts: readonly number[] }) {
  const { grid, max, peak } = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
    for (const start of starts) {
      const date = new Date(start * 1000)
      const weekday = (date.getDay() + 6) % 7
      cells[weekday]![date.getHours()]! += 1
    }
    let best = { weekday: 0, hour: 0, count: 0 }
    cells.forEach((row, weekday) => row.forEach((count, hour) => {
      if (count > best.count) best = { weekday, hour, count }
    }))
    return { grid: cells, max: best.count, peak: best }
  }, [starts])
  const days = weekdayNames()
  if (max === 0) return <div className="muted small">{t('player.insights.empty')}</div>
  return (
    <div>
      <div className="heatmap" role="img" aria-label={t('player.insights.activity.peak', {
        day: days[peak.weekday]!, from: hourLabel(peak.hour), to: hourLabel((peak.hour + 1) % 24),
      })}>
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={`h${hour}`} className="heatmap-hour">{hour % 3 === 0 ? hour : ''}</span>
        ))}
        {grid.map((row, weekday) => [
          <span key={`d${weekday}`} className="heatmap-day">{days[weekday]}</span>,
          ...row.map((count, hour) => (
            <span
              key={`${weekday}:${hour}`}
              className="heatmap-cell"
              style={{ opacity: count === 0 ? 1 : 0.18 + 0.82 * (count / max) }}
              data-empty={count === 0 ? '' : undefined}
              title={t('player.insights.activity.cell', {
                day: days[weekday]!, from: hourLabel(hour), to: hourLabel((hour + 1) % 24), n: tp('common.battles', count),
              })}
            />
          )),
        ])}
      </div>
      <div className="heatmap-foot small muted">
        <span>{t('player.insights.activity.peak', { day: days[peak.weekday]!, from: hourLabel(peak.hour), to: hourLabel((peak.hour + 1) % 24) })}</span>
        <span className="heatmap-legend" aria-hidden="true">
          {t('player.insights.activity.less')}
          {[0.18, 0.45, 0.72, 1].map((opacity) => <span key={opacity} className="heatmap-cell" style={{ opacity }} />)}
          {t('player.insights.activity.more')}
        </span>
      </div>
    </div>
  )
}
