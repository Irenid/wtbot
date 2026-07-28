// Форматирование по текущей локали интерфейса; правила из Discord-борда:
// null → «—» (не ноль), винрейт с одним знаком.
import { localeTag, t } from '../i18n'

export function fmtInt(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString(localeTag())
}

export function fmtPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

export function fmtRatio(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2)
}

function hoursValue(seconds: number): string {
  return Math.round(seconds / 3600).toLocaleString(localeTag())
}

export function fmtHours(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  return t('common.hours.short', { n: hoursValue(seconds) })
}

/** «{n} ч в бою» — часы с пояснением для KPI игрока. */
export function fmtHoursInBattle(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  return t('metric.hoursInBattle', { n: hoursValue(seconds) })
}

/** Только число часов — для шаблонов, где единица уже внутри перевода. */
export function fmtHoursNumber(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? '—' : hoursValue(seconds)
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  if (d > 0) return t('common.duration.dhm', { d, h, m })
  if (h > 0) return t('common.duration.hm', { h, m })
  return t('common.duration.m', { m })
}

export function fmtDateTime(ts: number | null | undefined): string {
  return ts === null || ts === undefined
    ? '—'
    : new Date(ts * 1000).toLocaleString(localeTag(), { dateStyle: 'short', timeStyle: 'short' })
}

export function fmtDate(ts: number | null | undefined): string {
  return ts === null || ts === undefined ? '—' : new Date(ts * 1000).toLocaleDateString(localeTag())
}

export function winRateOf(battles: number | null, victories: number | null): number | null {
  if (!battles || victories === null) return null
  return victories / battles
}

export function sumKills(row: { airKills: number | null; groundKills: number | null; navalKills: number | null }): number | null {
  const parts = [row.airKills, row.groundKills, row.navalKills].filter((v): v is number => v !== null)
  if (parts.length === 0) return null
  return parts.reduce((a, b) => a + b, 0)
}

/** Убирает игровые рамки клан-тега по краям (═AURI║ → AURI), как clanDisplayName на сервере. */
export function cleanClanTag(tag: string): string {
  const stripped = tag.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return stripped || tag
}

/** Ядро клан-тега для URL: зеркало серверного plainClanTag — только буквы/цифры, в нижнем регистре. */
export function coreClanTag(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

/** Заголовок боя «AURI против WOLF»; null — ни одна команда не клановая. */
export function battleVersusLabel(teams: { team: number; clanTag: string | null }[]): string | null {
  if (teams.length < 2) return null
  if (teams.every((team) => team.clanTag === null)) return null
  const name = (entry: { clanTag: string | null }): string => entry.clanTag ?? t('battle.versus.randoms')
  return t('battle.versus', { a: name(teams[0]!), b: name(teams[1]!) })
}

/** Короткий день недели для оси активности (byDay приходит датой YYYY-MM-DD). */
export function weekdayShort(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(localeTag(), { weekday: 'short', timeZone: 'UTC' })
}

/** Название режима War Thunder с принятым сокращением (АБ/РБ/СБ, AB/RB/SB…). */
export function modeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case 'arcade': return t('mode.arcade')
    case 'realistic': return t('mode.realistic')
    case 'simulation':
    case 'simulator': return t('mode.simulator')
    default: return mode ?? '—'
  }
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'statshark': return t('source.statshark')
    case 'official-profile': return t('source.official-profile')
    default: return source
  }
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'ok': return t('state.ok')
    case 'private': return t('state.private')
    case 'not_found': return t('state.not_found')
    case 'rate_limited': return t('state.rate_limited')
    case 'schema_error': return t('state.schema_error')
    case 'error': return t('state.error')
    default: return state
  }
}

export function vehicleClassLabel(cls: string): string {
  switch (cls) {
    case 'F': return t('vehicleClass.F')
    case 'H': return t('vehicleClass.H')
    case 'T': return t('vehicleClass.T')
    case 'L': return t('vehicleClass.L')
    case 'AA': return t('vehicleClass.AA')
    default: return t('vehicleClass.unknown')
  }
}
