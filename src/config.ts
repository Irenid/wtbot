import 'dotenv/config'
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

const workers = workerResourcePlan()

export const config = {
  /** Токен Discord-бота (Developer Portal → Bot → Reset Token) */
  token: required('TOKEN'),
  /** Application ID — нужен для регистрации slash-команд (npm run deploy:commands) */
  clientId: process.env['CLIENT_ID'],
  /** ID тестового сервера: команды на нём регистрируются мгновенно (опционально) */
  guildId: process.env['GUILD_ID'],
  /** Порт веб-дашборда */
  port: Number(process.env['PORT'] ?? 3000),
  /** Путь к файлу SQLite */
  dbPath: process.env['DB_PATH'] ?? './data/wtbot.db',
  /** Ленивое получение account-статистики известных игроков через публичный ThunderInsights API. */
  playerStatsEnabled: envBoolean('WT_PLAYER_STATS_ENABLED', true),
  /** Куки залогиненной сессии warthunder.com (identity_*) для парсера wt-replays */
  wtCookie: process.env['WT_COOKIE'] ?? '',
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
  /** Лимит кэша картинок боёв data/battles в МБ (перерисовываются из БД) */
  battleCacheMb: process.env['WT_BATTLE_CACHE_MB'] ?? '400',
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
  /** Фоновый ingest .wrpl и автоанонс; флаг CLI удобен для облегчённого запуска бота. */
  battleBackgroundEnabled: !process.argv.includes('--no-battle-background'),
}
