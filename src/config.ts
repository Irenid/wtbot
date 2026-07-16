import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Переменная ${name} не задана в .env`)
  return value
}

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
  /** Куки залогиненной сессии warthunder.com (identity_*) для парсера wt-replays */
  wtCookie: process.env['WT_COOKIE'] ?? '',
  /** ID голосовых каналов для наблюдения (через запятую); пусто — все каналы */
  voiceChannelIds: (process.env['WT_VOICE_CHANNELS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  /** ID текстового канала для автоанонса новых боёв; пусто — выключено */
  battlesChannelId: process.env['WT_BATTLES_CHANNEL'] ?? '',
}
