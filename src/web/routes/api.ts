import type { FastifyPluginAsync } from 'fastify'
import type { WebDeps } from '../types.js'
import {
  getCommandStats,
  getIngestStats,
  getItemStats,
  getLatestItems,
  getLatestParsePerSource,
  getParseHistory,
  getPlayerBattleStats,
  getPlayerRating,
  getVoicePresence,
} from '../../db/index.js'
import { decorateTag } from '../../wrpl/render-battle.js'

// JSON API — его же можно дергать из будущего фронтенда (React/Vue),
// когда простой встроенной страницы станет мало.
export const apiRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  app.get('/health', async () => ({ ok: true }))

  app.get('/api/stats', async () => ({
    bot: deps.getBotStatus(),
    commands: getCommandStats(),
    parsers: getLatestParsePerSource(),
    items: getItemStats(),
    ingest: getIngestStats(),
  }))

  // Собранные записи (с результатом анализа, если есть):
  // GET /api/items?limit=20&source=demo-feed
  app.get<{ Querystring: { source?: string; limit?: string } }>('/api/items', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 20) || 20, 100)
    return { items: getLatestItems(limit, request.query.source) }
  })

  app.get<{ Params: { source: string } }>('/api/parsers/:source/history', async (request) => ({
    history: getParseHistory(request.params.source),
  }))

  // Кто сидит в голосовых каналах (пишет бот, см. bot/voice-tracker.ts) +
  // статистика War Thunder по нику из серверного ника «WTНик (Имя)»:
  // ПКР с дельтой и клан — из снимков clan_rating_snapshots,
  // количество клановых боёв — по собранным реплеям в items.
  app.get('/api/voice', async () => {
    const rows = getVoicePresence()
    const channels = new Map<
      string,
      {
        guildName: string
        channelName: string
        players: {
          displayName: string
          wtNick: string
          joinedAt: number
          clanTag: string | null
          rating: number | null
          delta: number | null
          battles: number
          lastBattleAt: number | null
        }[]
      }
    >()
    for (const row of rows) {
      const key = `${row.guildId}/${row.channelId}`
      let channel = channels.get(key)
      if (!channel) {
        channel = { guildName: row.guildName, channelName: row.channelName, players: [] }
        channels.set(key, channel)
      }
      const rating = getPlayerRating(row.wtNick)
      const battleStats = getPlayerBattleStats(row.wtNick)
      channel.players.push({
        displayName: row.displayName,
        wtNick: row.wtNick,
        joinedAt: row.joinedAt,
        clanTag: rating ? decorateTag(rating.clanTag) : null,
        rating: rating?.rating ?? null,
        delta: rating?.delta ?? null,
        battles: battleStats.battles,
        lastBattleAt: battleStats.lastBattleAt,
      })
    }
    return { channels: [...channels.values()] }
  })

  // Кнопка «Обновить» на дашборде: пересканировать каналы и освежить ПКР
  // (сам поход на сайт WT троттлится в voice-tracker, спам кнопкой безопасен)
  app.post('/api/voice/refresh', async () => {
    const result = await deps.refreshVoice()
    return { ok: true, ...result }
  })
}
