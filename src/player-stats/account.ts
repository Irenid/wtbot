/**
 * Сведения об аккаунте игрока из внешних источников: уровень, звание, даты
 * регистрации и последнего входа, история кланов и ников, места в рейтингах
 * WT. Извлекаются один раз при сохранении снимка — raw_json StatShark весит до
 * мегабайта, разбирать его при каждом просмотре профиля дорого — и хранятся
 * компактным JSON в player_external_snapshots.account_json.
 *
 * Поля внешних источников недоверенные и меняются без предупреждения, поэтому
 * разбор мягкий: незнакомая или битая запись пропускается и не роняет снимок
 * (как блок наций официального профиля).
 */

export interface PlayerAccountSquadron {
  /** Номер клана в игре (тот же, что `_id` лидерборда); null — источник не дал. */
  clanId: number | null
  tag: string
  /** Когда источник заметил игрока в этом клане, Unix-секунды. */
  seenAt: number
}

export interface PlayerAccountName {
  nick: string
  /** Когда источник заметил этот ник, Unix-секунды. */
  seenAt: number
}

/** Метрики рейтингов WT, общие для всех режимов. */
export const PLAYER_RANK_METRICS = ['battles', 'victories', 'winRate', 'score', 'airKills', 'groundKills'] as const
export type PlayerRankMetric = (typeof PLAYER_RANK_METRICS)[number]

/** Рейтинги WT: общие по уровню сложности и отдельные по роду войск. */
export const PLAYER_RANK_MODES = [
  'arcade',
  'historical',
  'simulation',
  'tank_arcade',
  'tank_realistic',
  'tank_simulation',
  'air_arcade',
  'air_realistic',
  'air_simulation',
  'helicopter_arcade',
  'test_ship_arcade',
  'test_ship_realistic',
] as const
export type PlayerRankMode = (typeof PLAYER_RANK_MODES)[number]

export interface PlayerAccountRank {
  mode: PlayerRankMode
  metric: PlayerRankMetric
  /** Значение метрики: число, у winRate — доля побед. */
  value: number
  /** Место в рейтинге WT, с 1. */
  place: number
}

export interface PlayerAccountRankPoint {
  /** Когда источник записал место, Unix-секунды. */
  at: number
  mode: PlayerRankMode
  metric: PlayerRankMetric
  place: number
}

export interface PlayerAccount {
  level: number | null
  title: string | null
  registeredAt: number | null
  /** День последнего входа в игру (точность источника — сутки). */
  lastOnlineAt: number | null
  /** Новые первыми. */
  squadrons: PlayerAccountSquadron[]
  /** Новые первыми. */
  names: PlayerAccountName[]
  ranks: PlayerAccountRank[]
  /** По времени, старые первыми. */
  rankHistory: PlayerAccountRankPoint[]
}

const MAX_SQUADRONS = 30
const MAX_NAMES = 30
const MAX_HISTORY_POINTS = 40
const MAX_TEXT = 64
const MAX_TITLE = 128
/** WT вышла в 2012-м; всё раньше или позже 2100 года — мусор, а не дата. */
const MIN_TIMESTAMP = 1_325_376_000
const MAX_TIMESTAMP = 4_102_444_800
const MAX_PLACE = 100_000_000

/**
 * StatShark отдаёт рейтинги WT как `{value_total, idx}`: idx — позиция с нуля
 * (у метрики без места −1), на сайте место — idx + 1. Фраги в общих режимах
 * называются air_kills/ground_kills, в режимах рода войск — *_player.
 */
const STATSHARK_RANK_METRICS: Readonly<Record<string, PlayerRankMetric>> = {
  each_player_session: 'battles',
  each_player_victories: 'victories',
  victories_battles: 'winRate',
  score: 'score',
  air_kills: 'airKills',
  ground_kills: 'groundKills',
  air_kills_player: 'airKills',
  ground_kills_player: 'groundKills',
}

/** История мест — только для основных рейтингов и двух метрик: иначе сотни точек. */
const HISTORY_MODES: ReadonlySet<PlayerRankMode> = new Set([
  'arcade',
  'historical',
  'simulation',
  'tank_realistic',
  'air_realistic',
])
const HISTORY_METRICS: ReadonlySet<PlayerRankMetric> = new Set(['victories', 'winRate'])

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  // Управляющие символы из чужого JSON на страницу не пускаем.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text === '' || text.length > maxLength ? null : text
}

function integer(value: unknown, min: number, max: number): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim()) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null
}

function timestamp(value: unknown): number | null {
  return integer(value, MIN_TIMESTAMP, MAX_TIMESTAMP)
}

/** «2026-09-29 08:05:58» и ISO «2026-03-10T02:16:21.9768243Z» — время UTC. */
function utcDateTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z?$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number]
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const date = new Date(ms)
  // Date.UTC молча переносит 31 февраля на март — такую дату отбрасываем.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return timestamp(Math.floor(ms / 1_000))
}

/** «10.07.2013» с официального профиля — полночь UTC этого дня. */
function dayMonthYear(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, day, month, year] = match.map(Number) as [number, number, number, number]
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return timestamp(Math.floor(ms / 1_000))
}

function isRankMode(value: string): value is PlayerRankMode {
  return (PLAYER_RANK_MODES as readonly string[]).includes(value)
}

function isRankMetric(value: string): value is PlayerRankMetric {
  return (PLAYER_RANK_METRICS as readonly string[]).includes(value)
}

function emptyAccount(): PlayerAccount {
  return {
    level: null,
    title: null,
    registeredAt: null,
    lastOnlineAt: null,
    squadrons: [],
    names: [],
    ranks: [],
    rankHistory: [],
  }
}

function isEmptyAccount(account: PlayerAccount): boolean {
  return account.level === null
    && account.title === null
    && account.registeredAt === null
    && account.lastOnlineAt === null
    && account.squadrons.length === 0
    && account.names.length === 0
    && account.ranks.length === 0
    && account.rankHistory.length === 0
}

function statSharkSquadrons(value: unknown): PlayerAccountSquadron[] {
  if (!Array.isArray(value)) return []
  const squadrons: PlayerAccountSquadron[] = []
  for (const item of value) {
    const entry = asRecord(item)
    const tag = cleanText(entry?.['ClanTag'], MAX_TEXT)
    const seenAt = utcDateTime(entry?.['Date'])
    if (tag === null || seenAt === null) continue
    squadrons.push({ clanId: integer(entry?.['ClanID'], 1, Number.MAX_SAFE_INTEGER), tag, seenAt })
  }
  return squadrons.sort((left, right) => right.seenAt - left.seenAt).slice(0, MAX_SQUADRONS)
}

function statSharkNames(value: unknown): PlayerAccountName[] {
  if (!Array.isArray(value)) return []
  const names: PlayerAccountName[] = []
  for (const item of value) {
    const entry = asRecord(item)
    const nick = cleanText(entry?.['IGN'], MAX_TEXT)
    const seenAt = utcDateTime(entry?.['Date'])
    if (nick === null || seenAt === null) continue
    names.push({ nick, seenAt })
  }
  return names.sort((left, right) => right.seenAt - left.seenAt).slice(0, MAX_NAMES)
}

/** Место метрики из записи `{<valueKey>: число, idx: позиция с нуля}`. */
function rankEntry(value: unknown, valueKey: string): { value: number; place: number } | null {
  const entry = asRecord(value)
  const raw = entry?.[valueKey]
  const metricValue = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
  const idx = integer(entry?.['idx'], 0, MAX_PLACE - 1)
  return metricValue === null || idx === null ? null : { value: metricValue, place: idx + 1 }
}

function statSharkRanks(leaderboard: unknown): PlayerAccountRank[] {
  const modes = asRecord(leaderboard)
  if (modes === null) return []
  const ranks: PlayerAccountRank[] = []
  for (const mode of PLAYER_RANK_MODES) {
    // В старых снимках режим бывает просто `true` — такой пропускаем.
    const metrics = asRecord(asRecord(modes[mode])?.['value_total'])
    if (metrics === null) continue
    const seen = new Set<PlayerRankMetric>()
    for (const [key, metric] of Object.entries(STATSHARK_RANK_METRICS)) {
      if (seen.has(metric)) continue
      const rank = rankEntry(metrics[key], 'value_total')
      if (rank === null) continue
      seen.add(metric)
      ranks.push({ mode, metric, ...rank })
    }
  }
  return ranks
}

function statSharkRankHistory(value: unknown): PlayerAccountRankPoint[] {
  if (!Array.isArray(value)) return []
  const entries = value
    .map((item) => {
      const entry = asRecord(item)
      return { at: utcDateTime(entry?.['date']), data: asRecord(entry?.['data']) }
    })
    .filter((entry): entry is { at: number; data: JsonRecord } => entry.at !== null && entry.data !== null)
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_HISTORY_POINTS)
  const points: PlayerAccountRankPoint[] = []
  for (const { at, data } of entries) {
    for (const mode of HISTORY_MODES) {
      // В истории значения лежат под ключом t (весь срок), рядом — m (месяц).
      const metrics = asRecord(asRecord(data[mode])?.['t'])
      if (metrics === null) continue
      const seen = new Set<PlayerRankMetric>()
      for (const [key, metric] of Object.entries(STATSHARK_RANK_METRICS)) {
        if (!HISTORY_METRICS.has(metric) || seen.has(metric)) continue
        const rank = rankEntry(metrics[key], 't')
        if (rank === null) continue
        seen.add(metric)
        points.push({ at, mode, metric, place: rank.place })
      }
    }
  }
  return points
}

/**
 * Аккаунт из ответа StatShark: Basics (уровень, звание), Misc (регистрация,
 * последний вход, история кланов и ников), Profile.Leaderboard (места) и
 * leaderboardHistory (места во времени).
 */
export function statSharkAccount(bundle: { profile: unknown; leaderboardHistory?: unknown }): PlayerAccount {
  const profile = asRecord(bundle.profile)
  const basics = asRecord(profile?.['Basics'])
  const misc = asRecord(profile?.['Misc'])
  const stats = asRecord(profile?.['Profile'])
  return {
    level: integer(basics?.['level'], 1, 1_000),
    title: cleanText(basics?.['title'], MAX_TITLE),
    registeredAt: timestamp(misc?.['registerDay']),
    lastOnlineAt: timestamp(misc?.['lastDayOnline']),
    squadrons: statSharkSquadrons(misc?.['SquadronHistory']),
    names: statSharkNames(misc?.['NameHistory']),
    ranks: statSharkRanks(stats?.['Leaderboard']),
    rankHistory: statSharkRankHistory(bundle.leaderboardHistory),
  }
}

/** Account from the companion-app profile: level and title (no dates or history there). */
export function companionProfileAccount(document: { level?: unknown; title?: unknown }): PlayerAccount {
  return {
    ...emptyAccount(),
    level: integer(document.level, 1, 1_000),
    title: cleanText(document.title, MAX_TITLE),
  }
}

/** Аккаунт из шапки официального профиля: уровень и дата регистрации. */
export function officialProfileAccount(document: { level?: unknown; registrationDate?: unknown }): PlayerAccount {
  return {
    ...emptyAccount(),
    level: integer(document.level, 1, 1_000),
    registeredAt: dayMonthYear(document.registrationDate),
  }
}

/**
 * Проверка перед записью и после чтения account_json: всё, что не прошло,
 * отбрасывается. Пустой аккаунт — null, чтобы не хранить пустую обёртку.
 */
export function sanitizePlayerAccount(value: unknown): PlayerAccount | null {
  const input = asRecord(value)
  if (input === null) return null
  const squadrons = (Array.isArray(input['squadrons']) ? input['squadrons'] : [])
    .map((item): PlayerAccountSquadron | null => {
      const entry = asRecord(item)
      const tag = cleanText(entry?.['tag'], MAX_TEXT)
      const seenAt = timestamp(entry?.['seenAt'])
      if (tag === null || seenAt === null) return null
      const clanId = entry?.['clanId'] === null ? null : integer(entry?.['clanId'], 1, Number.MAX_SAFE_INTEGER)
      return { clanId, tag, seenAt }
    })
    .filter((entry): entry is PlayerAccountSquadron => entry !== null)
    .slice(0, MAX_SQUADRONS)
  const names = (Array.isArray(input['names']) ? input['names'] : [])
    .map((item): PlayerAccountName | null => {
      const entry = asRecord(item)
      const nick = cleanText(entry?.['nick'], MAX_TEXT)
      const seenAt = timestamp(entry?.['seenAt'])
      return nick === null || seenAt === null ? null : { nick, seenAt }
    })
    .filter((entry): entry is PlayerAccountName => entry !== null)
    .slice(0, MAX_NAMES)
  const rankKeys = new Set<string>()
  const ranks = (Array.isArray(input['ranks']) ? input['ranks'] : [])
    .map((item): PlayerAccountRank | null => {
      const entry = asRecord(item)
      const mode = typeof entry?.['mode'] === 'string' ? entry['mode'] : ''
      const metric = typeof entry?.['metric'] === 'string' ? entry['metric'] : ''
      const metricValue = entry?.['value']
      const place = integer(entry?.['place'], 1, MAX_PLACE)
      if (!isRankMode(mode) || !isRankMetric(metric) || place === null) return null
      if (typeof metricValue !== 'number' || !Number.isFinite(metricValue) || metricValue < 0) return null
      const key = `${mode}:${metric}`
      if (rankKeys.has(key)) return null
      rankKeys.add(key)
      return { mode, metric, value: metricValue, place }
    })
    .filter((entry): entry is PlayerAccountRank => entry !== null)
  const rankHistory = (Array.isArray(input['rankHistory']) ? input['rankHistory'] : [])
    .map((item): PlayerAccountRankPoint | null => {
      const entry = asRecord(item)
      const mode = typeof entry?.['mode'] === 'string' ? entry['mode'] : ''
      const metric = typeof entry?.['metric'] === 'string' ? entry['metric'] : ''
      const at = timestamp(entry?.['at'])
      const place = integer(entry?.['place'], 1, MAX_PLACE)
      if (!isRankMode(mode) || !isRankMetric(metric) || at === null || place === null) return null
      return { at, mode, metric, place }
    })
    .filter((entry): entry is PlayerAccountRankPoint => entry !== null)
    .slice(0, MAX_HISTORY_POINTS * HISTORY_MODES.size * HISTORY_METRICS.size)
  const account: PlayerAccount = {
    level: input['level'] === null ? null : integer(input['level'], 1, 1_000),
    title: cleanText(input['title'], MAX_TITLE),
    registeredAt: input['registeredAt'] === null ? null : timestamp(input['registeredAt']),
    lastOnlineAt: input['lastOnlineAt'] === null ? null : timestamp(input['lastOnlineAt']),
    squadrons,
    names,
    ranks,
    rankHistory,
  }
  return isEmptyAccount(account) ? null : account
}
