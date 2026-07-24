import type {
  PlayerStatsLookupInput,
  PlayerStatsLookupResult,
} from '../player-stats/comparison.js'

export interface BotStatus {
  online: boolean
  tag: string | null
  guilds: number
  uptimeSec: number
}

/** Зависимости веб-модуля: сайт не знает про discord.js напрямую, только про этот интерфейс */
export interface WebDeps {
  getBotStatus(): BotStatus
  /** Пересканировать голосовые каналы и освежить ПКР — кнопка «Обновить» на дашборде */
  refreshVoice(): Promise<{ players: number; clans: number }>
  playerStats: {
    lookup(input: PlayerStatsLookupInput): PlayerStatsLookupResult
  }
}
