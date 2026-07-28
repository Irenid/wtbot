import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { localeTag, t } from '../i18n'

export interface TimeSeries {
  label: string
  color: string
  values: (number | null)[]
  /** Ступенчатая линия для накопительных метрик (ПКР, бои). */
  stepped?: boolean
}

/** Обёртка uPlot: тёмные оси, ресайз по контейнеру, время по X в секундах. */
export function TimeChart({ xs, series, height = 220, percent = false }: {
  xs: number[]
  series: TimeSeries[]
  height?: number
  percent?: boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box || xs.length === 0) return

    const axisStyle = {
      stroke: '#7d7885',
      grid: { stroke: 'rgba(125, 120, 133, 0.16)', width: 1 },
      ticks: { stroke: 'rgba(125, 120, 133, 0.4)', width: 1 },
      font: '11px "Segoe UI", system-ui, sans-serif',
    }
    const options: uPlot.Options = {
      width: box.clientWidth,
      height,
      series: [
        // Подпись оси X в легенде: без неё uPlot подставляет своё английское «Time».
        { label: t('common.chart.date') },
        ...series.map((entry) => ({
          label: entry.label,
          stroke: entry.color,
          width: 2,
          points: { show: xs.length <= 60, size: 5, fill: entry.color },
          ...(entry.stepped ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
          value: (_u: uPlot, value: number | null) =>
            value === null ? '—' : percent ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(localeTag()),
        })),
      ],
      axes: [
        { ...axisStyle },
        {
          ...axisStyle,
          size: 56,
          values: (_u: uPlot, ticks: number[]) =>
            ticks.map((tick) => (percent ? `${(tick * 100).toFixed(0)}%` : tick.toLocaleString(localeTag()))),
        },
      ],
      cursor: { points: { size: 7 } },
      legend: { show: series.length > 1 },
    }

    const data: uPlot.AlignedData = [xs, ...series.map((entry) => entry.values)] as uPlot.AlignedData
    const plot = new uPlot(options, data, box)
    plotRef.current = plot

    const observer = new ResizeObserver(() => {
      plot.setSize({ width: box.clientWidth, height })
    })
    observer.observe(box)
    return () => {
      observer.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [xs, series, height, percent])

  if (xs.length === 0) return <div className="muted small">{t('common.chart.noData')}</div>
  return <div className="chart-box" ref={boxRef} />
}
