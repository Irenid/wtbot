import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { localeTag, t } from '../i18n'

export interface TimeSeries {
  label: string
  color: string
  values: (number | null)[]
  /** A stepped line for running totals (PSR, battles). */
  stepped?: boolean
  /** A gradient under the line, from `top` at the plot's top edge to `bottom` at its foot; none by default. */
  area?: { top: string; bottom: string }
}

/** The area's gradient spans the plot box, which uPlot measures anew on every resize and redraw. */
function areaFill(plot: uPlot, area: { top: string; bottom: string }): CanvasGradient {
  const { top, height } = plot.bbox
  const gradient = plot.ctx.createLinearGradient(0, top, 0, top + height)
  gradient.addColorStop(0, area.top)
  gradient.addColorStop(1, area.bottom)
  return gradient
}

/** A uPlot wrapper: dark axes, sized to its container, time on X in seconds. */
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
        // The X axis's legend label: without it uPlot shows its own English "Time".
        { label: t('common.chart.date') },
        ...series.map((entry) => ({
          label: entry.label,
          stroke: entry.color,
          width: 2,
          points: { show: xs.length <= 60, size: 5, fill: entry.color },
          ...(entry.stepped ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
          ...(entry.area !== undefined ? { fill: (plot: uPlot) => areaFill(plot, entry.area!) } : {}),
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
