import type { FastifyPluginAsync } from 'fastify'
import type { WebDeps } from '../types.js'
import {
  getCommandStats,
  getIngestStats,
  getItemStats,
  getLatestItems,
  getLatestParsePerSource,
  getParseHistory,
  getVoiceDashboardRows,
} from '../../db/index.js'
import { decorateTag } from '../../wrpl/render-battle.js'

// JSON API — его же можно дергать из будущего фронтенда (React/Vue),
// когда простой встроенной страницы станет мало.
export const apiRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  const voiceRefreshRateLimitMs = 5_000
  let voiceRefreshNotBefore = 0
  let voiceRefreshInFlight: ReturnType<WebDeps['refreshVoice']> | null = null

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
    const rows = getVoiceDashboardRows()
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
      channel.players.push({
        displayName: row.displayName,
        wtNick: row.wtNick,
        joinedAt: row.joinedAt,
        clanTag: row.clanTag ? decorateTag(row.clanTag) : null,
        rating: row.rating,
        delta: row.delta,
        battles: row.battles,
        lastBattleAt: row.lastBattleAt,
      })
    }
    return { channels: [...channels.values()] }
  })

  // Кнопка «Обновить» на дашборде: пересканировать каналы и освежить ПКР
  // (сам поход на сайт WT троттлится в voice-tracker, спам кнопкой безопасен)
  app.post('/api/voice/refresh', async (_request, reply) => {
    if (voiceRefreshInFlight) return { ok: true, ...(await voiceRefreshInFlight) }
    const now = Date.now()
    if (now < voiceRefreshNotBefore) {
      const retryAfterSec = Math.max(1, Math.ceil((voiceRefreshNotBefore - now) / 1_000))
      return reply
        .header('Retry-After', String(retryAfterSec))
        .code(429)
        .send({ ok: false, error: 'Обновление уже выполнялось недавно', retryAfterSec })
    }

    voiceRefreshNotBefore = now + voiceRefreshRateLimitMs
    const refresh = deps.refreshVoice()
    voiceRefreshInFlight = refresh
    try {
      return { ok: true, ...(await refresh) }
    } finally {
      if (voiceRefreshInFlight === refresh) voiceRefreshInFlight = null
    }
  })
}
