import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { localeTag } from '../../i18n'

/** **bold** and [label](href) in guide strings (i18n/guide/types.ts). */
const MARKUP = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** A guide string as React nodes: text never becomes HTML; "/…" links go through the router. */
export function Rich({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(MARKUP)) {
    const whole = match[0] ?? ''
    const index = match.index ?? 0
    const [, bold, label, href] = match
    if (index > last) nodes.push(text.slice(last, index))
    if (bold !== undefined) nodes.push(<b key={index}>{bold}</b>)
    else if (label !== undefined && href !== undefined) {
      nodes.push(href.startsWith('/')
        ? <Link key={index} to={href}>{label}</Link>
        : <a key={index} href={href} rel="noopener noreferrer">{label}</a>)
    }
    last = index + whole.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

export function Paras({ items }: { items: readonly string[] }) {
  return <>{items.map((text, index) => <p key={index} className="guide-p"><Rich text={text} /></p>)}</>
}

/** Count or sum with the locale's grouping and decimals. */
export function num(value: number, digits = 0): string {
  return value.toLocaleString(localeTag(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Share 0..1 as "52,4%": locale decimals, no space before %, as fmtPercent elsewhere on the site. */
export function pct(share: number, digits = 1): string {
  return `${num(share * 100, digits)}%`
}

/** PSR as the game shows it: a whole number without grouping. */
export function psrText(value: number): string {
  return String(Math.round(value))
}

/** Signed number with a true minus sign; a value that rounds to zero has no sign. */
export function signed(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return num(0, digits)
  return `${rounded > 0 ? '+' : '−'}${num(Math.abs(rounded), digits)}`
}

/** A signed change coloured by direction. */
export function Change({ value, digits = 0 }: { value: number; digits?: number }) {
  const text = signed(value, digits)
  const tone = Number(value.toFixed(digits)) > 0 ? 'guide-win' : Number(value.toFixed(digits)) < 0 ? 'guide-loss' : undefined
  return <span className={tone}>{text}</span>
}

/** Day in the locale's long form, UTC: "3 октября 2026 г.", "October 3, 2026". */
export function longDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** Day and month without the year, UTC: "23 сентября", "September 23". */
export function dayMonth(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', timeZone: 'UTC' })
}

/** UTC time of day, 24-hour, for texts that say "UTC". */
export function utcTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
}

/** A whole UTC hour as the visitor's local time today (the offset of today, DST included). */
export function localHour(utcHour: number): string {
  const now = new Date()
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour))
  return at.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' })
}

/** Table: the first column is a label, the rest are right-aligned numbers. */
export function GuideTable({ head, rows, mark }: {
  head: readonly string[]
  rows: readonly (readonly ReactNode[])[]
  /** Index of the row to highlight. */
  mark?: number | undefined
}) {
  return (
    <div className="tbl-scroll guide-tbl">
      <table className="tbl">
        <thead>
          <tr>{head.map((cell, index) => <th key={index} className={index === 0 ? undefined : 'num'}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === mark ? 'guide-mark' : undefined}>
              {row.map((cell, index) => <td key={index} className={index === 0 ? undefined : 'num'}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Monospace formula lines, scrolled sideways on narrow screens instead of wrapped. */
export function FormulaBlock({ lines }: { lines: readonly string[] }) {
  return <pre className="guide-formula">{lines.join('\n')}</pre>
}
