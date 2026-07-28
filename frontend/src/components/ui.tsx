import type { ReactNode } from 'react'
import { localeTag, t } from '../i18n'
import { fmtInt } from '../lib/format'
import { SiteApiError } from '../api'

export function Chip({ children, tone }: { children: ReactNode; tone?: 'ok' | 'fail' | 'accent' }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}`}>{children}</span>
}

export function Kpi({ label, value, sub, children }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub !== undefined && <div className="s">{sub}</div>}
      {children}
    </div>
  )
}

/* Кольцевой индикатор винрейта из макета: дуга по доле, значение в центре. */
export function Donut({ fraction, text }: { fraction: number | null; text: string }) {
  const circumference = 2 * Math.PI * 26
  const clamped = fraction === null ? 0 : Math.max(0, Math.min(1, fraction))
  return (
    <svg width="66" height="66" viewBox="0 0 64 64" style={{ flex: 'none' }} aria-label={t('a11y.winrate', { value: text })}>
      <circle cx="32" cy="32" r="26" fill="none" className="donut-track" strokeWidth="8" />
      <circle
        cx="32" cy="32" r="26" fill="none"
        stroke="var(--ok)" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${(circumference * clamped).toFixed(1)} ${circumference.toFixed(1)}`}
        transform="rotate(-90 32 32)"
        filter="drop-shadow(0 0 4px rgba(142, 230, 161, 0.45))"
      />
      <text x="32" y="36" textAnchor="middle" className="donut-text">{text}</text>
    </svg>
  )
}

/* Винрейт-KPI с донатом слева, как в макете игрока/клана. */
export function DonutKpi({ label, fraction, text, sub }: {
  label: string
  fraction: number | null
  text: string
  sub: ReactNode
}) {
  return (
    <div className="kpi with-donut">
      <Donut fraction={fraction} text={text} />
      <div style={{ minWidth: 0 }}>
        <div className="l">{label}</div>
        <div className="s" style={{ marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  )
}

export function BarTrack({ fraction, color, title, tone }: {
  fraction: number | null
  color?: string
  title?: string
  tone?: 'plain' | 'best' | 'glow'
}) {
  const pct = fraction === null ? 0 : Math.max(0, Math.min(1, fraction)) * 100
  return (
    <div className="bar-track" title={title}>
      <div
        className={`bar-fill${tone ? ` ${tone}` : ''}`}
        style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  )
}

export function BarRow({ label, fraction, right, color }: {
  label: ReactNode
  fraction: number | null
  right: ReactNode
  color?: string
}) {
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <BarTrack fraction={fraction} {...(color ? { color } : {})} />
      <span className="bar-value">{right}</span>
    </div>
  )
}

export const KILL_PARTS = [
  { key: 'airKills' as const, labelKey: 'metric.killsAir' as const, color: 'var(--air)' },
  { key: 'groundKills' as const, labelKey: 'metric.killsGround' as const, color: 'var(--ground)' },
  { key: 'navalKills' as const, labelKey: 'metric.killsNaval' as const, color: 'var(--naval)' },
]

/** Пропорциональный стек «воздух/земля/флот» с легендой и точными значениями. */
export function KillsStack(row: { airKills: number | null; groundKills: number | null; navalKills: number | null }) {
  const values = KILL_PARTS.map((part) => row[part.key])
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return null
  const sum = known.reduce((a, b) => a + b, 0)
  return (
    <div>
      {sum > 0 && (
        <div className="stack">
          {KILL_PARTS.map((part, index) => {
            const value = values[index]
            if (value === null || value === undefined || value <= 0) return null
            return (
              <div
                key={part.key}
                className="seg"
                style={{ background: part.color, flexGrow: value }}
                title={`${t(part.labelKey)}: ${fmtInt(value)} (${((value / sum) * 100).toFixed(1)}%)`}
              />
            )
          })}
        </div>
      )}
      <div className="legend">
        {KILL_PARTS.map((part, index) => {
          const value = values[index] ?? null
          const share = value !== null && sum > 0 ? ` · ${((value / sum) * 100).toFixed(1)}%` : ''
          return (
            <span key={part.key}>
              <span className="swatch" style={{ background: part.color }} />
              {t(part.labelKey)} <b>{fmtInt(value)}</b>{share}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function Delta({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value === null || value === 0) return null
  const positive = value > 0
  const good = invert ? !positive : positive
  return (
    <span className={`delta ${good ? 'up' : 'down'}`}>
      {positive ? '+' : ''}{value.toLocaleString(localeTag())}
    </span>
  )
}

/* Дельта-пилюля с тонированным фоном, как в ростерах и лентах боёв макета. */
export function DeltaPill({ value }: { value: number | null }) {
  if (value === null || value === 0) return null
  const positive = value > 0
  return (
    <span className={`delta-pill ${positive ? 'up' : 'down'}`}>
      {positive ? '+' : '−'}{Math.abs(value).toLocaleString(localeTag())}
    </span>
  )
}

export function ResultBadge({ won }: { won: boolean | null }) {
  if (won === null) return <span className="result-badge unknown" title={t('battlePage.result.unknownTitle')}>?</span>
  return won
    ? <span className="result-badge win">{t('battlePage.result.win')}</span>
    : <span className="result-badge loss">{t('battlePage.result.loss')}</span>
}

/* Место в рейтинге: золотая медалька для первого, нейтральная для остальных. */
export function RankBadge({ rank }: { rank: number }) {
  return <span className={`rank-badge${rank === 1 ? ' gold' : ''}`}>{rank}</span>
}

/* Сегментированный переключатель (периоды, фильтры, скорость плеера). */
export function SegControl<T extends string>({ options, value, onChange, ariaLabel }: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="seg-control" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Panel({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {sub !== undefined && <span className="hint" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{sub}</span>}
      </div>
      {children}
    </section>
  )
}

/* Заголовок секции карточки: золотой маркер + аптайтл + подсказка справа. */
export function SecHead({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h2>{title}</h2>
      {children}
      {hint !== undefined && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Loading({ text }: { text?: string }) {
  return <div className="loading">{text ?? t('common.loading')}</div>
}

/** Известные коды API переводятся; текст сервера (русский) — фолбэк. */
export function ErrorNotice({ error }: { error: unknown }) {
  let message: string
  if (error instanceof SiteApiError) {
    switch (error.code) {
      case 'PLAYER_NOT_FOUND': message = t('apiError.PLAYER_NOT_FOUND'); break
      case 'CLAN_NOT_FOUND': message = t('apiError.CLAN_NOT_FOUND'); break
      case 'BATTLE_NOT_FOUND': message = t('apiError.BATTLE_NOT_FOUND'); break
      case 'RATE_LIMITED': message = t('apiError.RATE_LIMITED'); break
      case 'INVALID_CLAN': message = t('apiError.INVALID_CLAN'); break
      case 'INVALID_BATTLE': message = t('apiError.INVALID_BATTLE'); break
      case 'INVALID_PERIOD': message = t('apiError.INVALID_PERIOD'); break
      default: message = error.message
    }
  } else {
    message = error instanceof Error ? error.message : String(error)
  }
  return <div className="notice fail">{message}</div>
}
