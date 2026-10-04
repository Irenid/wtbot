import 'dotenv/config'
import { isIP } from 'node:net'
import { workerResourcePlan } from './runtime-options.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Переменная ${name} не задана в .env`)
  return value
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new Error(`Переменная ${name} должна быть true/false, 1/0, yes/no или on/off`)
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Переменная ${name} должна быть числом от ${min} до ${max}`)
  }
  return parsed
}

/**
 * WEB_TRUST_PROXY для Fastify trustProxy: пусто/false — не доверять
 * X-Forwarded-*; true — доверять всем (только если порт недоступен никому,
 * кроме прокси); иначе список IP/CIDR через запятую либо ключевые слова
 * proxy-addr (loopback, linklocal, uniquelocal). Счёт хопов числом Fastify
 * 5.12 убрал из-за подделки X-Forwarded-* (GHSA-3m5p-2c4r-xxw2).
 */
function envTrustProxy(name: string): boolean | string[] {
  const raw = process.env[name]?.trim() ?? ''
  if (raw === '' || /^(?:false|0|no|off)$/i.test(raw)) return false
  if (/^(?:true|yes|on)$/i.test(raw)) return true
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.split('/')
    const keyword = ['loopback', 'linklocal', 'uniquelocal'].includes(entry.toLowerCase())
    const version = isIP(address)
    const prefixValid = prefix === undefined
      || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 6 ? 128 : 32))
    if (!keyword && (version === 0 || !prefixValid || extra !== undefined)) {
      throw new Error(`Переменная ${name}: «${entry}» не IP, CIDR или loopback/linklocal/uniquelocal`)
    }
  }
  return entries
}

function envCsvUnique(name: string): string[] {
  const values: string[] = []
  const seen = new Set<string>()
  for (const raw of (process.env[name] ?? '').split(',')) {
    const value = raw.trim()
    if (value === '') continue
    const key = value.normalize('NFKC').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    values.push(value)
  }
  return values
}

const workers = workerResourcePlan()

/**
 * Токен Discord-бота. Процессы, которым нужен Discord (бот, deploy:commands),
 * вызывают проверку явно при старте, а оффлайн-тесты, verify:* и CLI вроде
 * db:backup импортируют config без секрета.
 */
export function requireDiscordToken(): string {
  return required('TOKEN')
}

export const config = {
  /** Токен Discord-бота (Developer Portal → Bot → Reset Token); читается лениво. */
  get token(): string {
    return requireDiscordToken()
  },
  /** Application ID — нужен для регистрации slash-команд (npm run deploy:commands) */
  clientId: process.env['CLIENT_ID'],
  /** ID тестового сервера: команды на нём регистрируются мгновенно (опционально) */
  guildId: process.env['GUILD_ID'],
  /** Порт веб-дашборда */
  port: Math.floor(envNumber('PORT', 3000, 1, 65_535)),
  /** Интерфейс веб-сервера; loopback по умолчанию не выставляет API в сеть. */
  webHost: process.env['WEB_HOST']?.trim() || '127.0.0.1',
  /**
   * Общий токен обязателен, если WEB_HOST не loopback: API-клиенты передают его
   * как Bearer, браузер — паролем HTTP Basic (имя пользователя любое).
   */
  webToken: process.env['WEB_TOKEN']?.trim() ?? '',
  /** Доверенные reverse proxy для X-Forwarded-For (см. envTrustProxy); по умолчанию не доверять. */
  webTrustProxy: envTrustProxy('WEB_TRUST_PROXY'),
  /** Разрешить создание новой SQLite только явным флагом. */
  allowNewDb: envBoolean('WTBOT_ALLOW_NEW_DB', false),
  /** Путь к файлу SQLite */
  dbPath: process.env['DB_PATH'] ?? './data/wtbot.db',
  /** Ленивое получение account-статистики известных игроков с профиля warthunder.com. */
  playerStatsEnabled: envBoolean('WT_PLAYER_STATS_ENABLED', true),
  /** Account snapshot через официальный companion API без Cloudflare-транспорта сайта. */
  companionProfilePlayerStatsEnabled: envBoolean('WT_COMPANION_PROFILE_ENABLED', false),
  /** Сессия официального companion-app; не совпадает с WT_COOKIE. */
  companionCookie: process.env['WT_COMPANION_COOKIE'] ?? '',
  /** Дополнительный lazy snapshot StatShark по стабильному WT user id. */
  statSharkPlayerStatsEnabled: envBoolean('STATSHARK_PLAYER_STATS_ENABLED', false),
  /** A nick-only profile looks up its WT user id: public companion search, then the Replay API (WT_COOKIE). */
  playerIdLookupEnabled: envBoolean('WT_PLAYER_ID_LOOKUP_ENABLED', true),
  /** Ники для периодического сбора профилей и реплеев (через запятую). */
  playerNames: envCsvUnique('WT_PLAYER_NAMES'),
  /** Куки залогиненной сессии warthunder.com (identity_*) для WT-парсеров. */
  wtCookie: process.env['WT_COOKIE'] ?? '',
  /**
   * Разрешённые хосты CDN частей реплеев (точное имя или домен-суффикс, через
   * запятую). Пусто — только структурные проверки URL из Replay API.
   */
  replayHosts: envCsvUnique('WT_REPLAY_HOSTS'),
  /** Весь трафик warthunder.com идёт через настоящий Edge: Cloudflare не пропускает Node-fetch. */
  wtBrowserEnabled: envBoolean('WT_BROWSER_ENABLED', true),
  /**
   * Прятать окно Edge. Настоящий headless Cloudflare не пропускает, поэтому
   * окно остаётся обычным и уезжает за пределы экрана; при неудачной проверке
   * оно автоматически возвращается на экран для ручного прохождения.
   */
  wtBrowserHeadless: envBoolean('WT_BROWSER_HEADLESS', true),
  /** Максимальное время ожидания автоматической/ручной проверки Cloudflare. */
  wtBrowserTimeoutMs: envNumber('WT_BROWSER_TIMEOUT_MS', 60_000, 15_000, 180_000),
  /** Профиль Edge для сохранения пройденной проверки между перезапусками. */
  wtBrowserProfileDir: process.env['WT_BROWSER_PROFILE_DIR']?.trim() ?? './data/wt-browser-profile',
  /** Сколько вкладок Edge обслуживают запросы параллельно. */
  wtBrowserPoolSize: Math.floor(envNumber('WT_BROWSER_POOL_SIZE', 3, 1, 8)),
  /** Фиксированный DevTools-порт Edge; 0 — свободный порт, запомненный в профиле. */
  wtBrowserCdpPort: Math.floor(envNumber('WT_BROWSER_CDP_PORT', 0, 0, 65_535)),
  /**
   * Необязательный путь к Edge/Chrome/Chromium. Без него ищется Edge (Windows),
   * а на Linux — Edge, Chrome или Chromium в стандартных путях.
   */
  wtBrowserExecutable: process.env['WT_BROWSER_EXECUTABLE']?.trim() ?? '',
  /**
   * Запуск браузера с --no-sandbox. Нужен в Docker: seccomp по умолчанию
   * запрещает namespace-песочницу Chromium. Вне контейнера оставляйте false.
   */
  wtBrowserNoSandbox: envBoolean('WT_BROWSER_NO_SANDBOX', false),
  /** ID голосовых каналов для наблюдения (через запятую); пусто — все каналы */
  voiceChannelIds: (process.env['WT_VOICE_CHANNELS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  /** ID текстового канала для автоанонса новых боёв; пусто — выключено */
  battlesChannelId: process.env['WT_BATTLES_CHANNEL'] ?? '',
  /**
   * Клан-тег, бои которого анонсировать (например, WLILY); пусто — анонсим
   * все клановые бои. Сравнивается по «ядру» тега без украшений/регистра.
   */
  clanTag: (process.env['WT_CLAN_TAG'] ?? '').trim(),
  /**
   * Бои старше стольких часов (по времени начала) не анонсируются, а
   * помечаются пропущенными: после простоя бота иначе в канал ушла бы вся
   * накопившаяся история. 0 — без ограничения.
   */
  announceMaxAgeHours: envNumber('WT_ANNOUNCE_MAX_AGE_HOURS', 2, 0, 24 * 365),
  /** Лимит кэша картинок боёв data/battles в МБ (перерисовываются из БД) */
  battleCacheMb: envNumber('WT_BATTLE_CACHE_MB', 400, 50, 1_048_576),
  /** Повторно использовать готовые PNG/TXT; новые результаты сохраняются всегда. */
  battleCacheEnabled: envBoolean('WT_BATTLE_CACHE_ENABLED', true),
  /** Настройки отображения авиационной heatmap, передаваемые в CPU worker. */
  heatmapOptions: {
    airAutoZoom: envBoolean('WT_HEATMAP_AIR_AUTO_ZOOM', true),
    airShowGroundMap: envBoolean('WT_HEATMAP_AIR_SHOW_GROUND_MAP', true),
    airShowAirfields: envBoolean('WT_HEATMAP_AIR_SHOW_AIRFIELDS', true),
    airShowSpawns: envBoolean('WT_HEATMAP_AIR_SHOW_SPAWNS', true),
    airPaddingPercent: envNumber('WT_HEATMAP_AIR_PADDING_PERCENT', 6, 0, 50),
  },
  /** Автоматический CPU/RAM-бюджет для тяжёлых worker_threads. */
  workerResources: workers,
  /** Фактическая верхняя граница CPU workers. */
  workerThreads: workers.workerThreads,
  /** AIMD admission ingest; live A/B подтвердил защиту throughput от CDN 429. */
  ingestAdaptiveAdmissionEnabled: envBoolean('WT_INGEST_ADAPTIVE_ENABLED', true),
  /** Staged download → ready → parse pipeline; false возвращает legacy runner. */
  ingestPipelineEnabled: envBoolean('WT_INGEST_PIPELINE_ENABLED', true),
  /** Reservation replay по фактическому размеру; эксперимент, default сохраняет worst-case. */
  replayExactReservationEnabled: envBoolean('WT_REPLAY_EXACT_RESERVATION_ENABLED', false),
  /** Фоновый ingest .wrpl и автоанонс; флаг CLI удобен для облегчённого запуска бота. */
  battleBackgroundEnabled: !process.argv.includes('--no-battle-background'),
}
