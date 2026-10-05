// Форматирование по текущей локали интерфейса; правила из Discord-борда:
// null → «—» (не ноль), винрейт с одним знаком.
import { localeTag, t, tp } from '../i18n'

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

/** The time alone today, with the date on other days: a crawl, a recent battle. */
export function fmtRecentTime(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
    : fmtDateTime(ts)
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

/** Короткое обозначение режима для плиток: АБ/РБ/СБ (AB/RB/SB…); '?' — неизвестен. */
export function modeShortLabel(mode: string | null | undefined): string {
  switch (mode) {
    case 'arcade': return t('mode.arcade.short')
    case 'realistic': return t('mode.realistic.short')
    case 'simulation':
    case 'simulator': return t('mode.simulator.short')
    default: return '?'
  }
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
    case 'companion-profile': return t('source.companion-profile')
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

/** Режим из данных лидерборда (historical — РБ) в принятое сокращение; неизвестный — как есть. */
export function difficultyShortLabel(difficulty: string): string {
  switch (difficulty) {
    case 'arcade': return t('mode.arcade.short')
    case 'historical':
    case 'realistic': return t('mode.realistic.short')
    case 'simulation':
    case 'simulator': return t('mode.simulator.short')
    default: return difficulty
  }
}

const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const

/** Ранг техники римскими цифрами, как в игре. */
export function romanRank(rank: number): string {
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > 39) return String(rank)
  let rest = rank
  let text = ''
  for (const [value, digit] of ROMAN) {
    while (rest >= value) {
      text += digit
      rest -= value
    }
  }
  return text
}

/** Ветка техники из условий вступления в клан. */
export function unitTypeLabel(unitType: string): string {
  switch (unitType) {
    case 'Aircraft': return t('unitType.Aircraft')
    case 'Tank': return t('unitType.Tank')
    case 'Helicopter': return t('unitType.Helicopter')
    case 'Ship': return t('unitType.Ship')
    case 'Boat': return t('unitType.Boat')
    default: return unitType
  }
}

/** Роль участника клана со страницы claninfo; неизвестная — как есть. */
export function clanRoleLabel(role: string): string {
  switch (role) {
    case 'Commander': return t('clan.role.Commander')
    case 'Deputy': return t('clan.role.Deputy')
    case 'Officer': return t('clan.role.Officer')
    case 'Sergeant': return t('clan.role.Sergeant')
    case 'Private': return t('clan.role.Private')
    default: return role
  }
}

/** Звание за сезон («place3», «top50»), без режима; common и незнакомое — null. */
export function clanRewardLabel(title: string): string | null {
  const place = /^place([1-9])$/.exec(title)
  if (place) return t('clan.reward.place', { n: place[1]! })
  const top = /^top([1-9]\d{0,3})$/.exec(title)
  return top ? t('clan.reward.top', { n: top[1]! }) : null
}

/** Нация, как подписана на английской странице профиля; незнакомая — как есть. */
export function nationLabel(country: string): string {
  switch (country.toLowerCase().replace(/[^a-z]/g, '')) {
    case 'usa': return t('nation.usa')
    case 'germany': return t('nation.germany')
    case 'ussr': return t('nation.ussr')
    case 'greatbritain':
    case 'britain': return t('nation.britain')
    case 'japan': return t('nation.japan')
    case 'china': return t('nation.china')
    case 'italy': return t('nation.italy')
    case 'france': return t('nation.france')
    case 'sweden': return t('nation.sweden')
    case 'israel': return t('nation.israel')
    default: return country
  }
}

/** Место в рейтинге: «#3 778». */
export function fmtPlace(place: number | null | undefined): string {
  return place === null || place === undefined ? '—' : `#${fmtInt(place)}`
}

/** Рейтинг WT StatShark: «Все · РБ», «Танки · АБ». */
export function rankModeLabel(mode: string): string {
  const [branch, difficulty] = mode.includes('_') ? mode.split(/_(?=[a-z]+$)/) as [string, string] : ['all', mode]
  const branchLabel = branch === 'tank' ? t('rankMode.tank')
    : branch === 'air' ? t('rankMode.air')
      : branch === 'helicopter' ? t('rankMode.helicopter')
        : branch === 'test_ship' ? t('rankMode.ship')
          : t('rankMode.all')
  return `${branchLabel} · ${difficultyShortLabel(difficulty)}`
}

export function rankMetricLabel(metric: string): string {
  switch (metric) {
    case 'battles': return t('player.rankMetric.battles')
    case 'victories': return t('player.rankMetric.victories')
    case 'winRate': return t('player.rankMetric.winRate')
    case 'score': return t('player.rankMetric.score')
    case 'airKills': return t('player.rankMetric.airKills')
    case 'groundKills': return t('player.rankMetric.groundKills')
    default: return metric
  }
}

/** Давность: «13 лет», «3 месяца» (меньше месяца — «0 месяцев»). */
export function fmtAge(fromTs: number, nowTs: number = Math.floor(Date.now() / 1000)): string {
  const days = Math.max(0, (nowTs - fromTs) / 86_400)
  const years = Math.floor(days / 365.25)
  return years >= 1 ? tp('common.years', years) : tp('common.months', Math.floor(days / 30.44))
}
