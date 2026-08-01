import type { FastifyPluginAsync } from 'fastify'
import type { WebDeps } from '../types.js'
import {
  getCommandStats,
  getClanSeasonContext,
  getIngestStats,
  getItemStats,
  getLatestItemSummaries,
  getLatestItems,
  getLatestParsePerSource,
  getParseHistory,
  getVoiceDashboardRows,
  getVoicePresence,
} from '../../db/index.js'
import { decorateTag } from '../../wrpl/render-battle.js'
import { wtBrowserMetrics } from '../../parsers/sources/wt-browser.js'
import { wtTransportMode } from '../../parsers/sources/wt-request.js'

const DASHBOARD_SNAPSHOT_TTL_MS = 15_000

function voiceDashboardPayload() {
  if (getVoicePresence().length === 0) return { channels: [] }
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
}

// JSON API — его же можно дергать из будущего фронтенда (React/Vue),
// когда простой встроенной страницы станет мало.
export const apiRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  const voiceRefreshRateLimitMs = 5_000
  let voiceRefreshNotBefore = 0
  let voiceRefreshInFlight: ReturnType<WebDeps['refreshVoice']> | null = null
  let dashboardSnapshot: {
    builtAt: number
    data: {
      commands: ReturnType<typeof getCommandStats>
      parsers: ReturnType<typeof getLatestParsePerSource>
      items: ReturnType<typeof getItemStats>
      ingest: ReturnType<typeof getIngestStats>
      season: ReturnType<typeof getClanSeasonContext>
      voice: ReturnType<typeof voiceDashboardPayload>
      recentItems: ReturnType<typeof getLatestItemSummaries>
    }
  } | null = null

  function cachedDashboardSnapshot(now = Date.now()) {
    if (!dashboardSnapshot || now - dashboardSnapshot.builtAt >= DASHBOARD_SNAPSHOT_TTL_MS) {
      dashboardSnapshot = {
        builtAt: now,
        data: {
          commands: getCommandStats(),
          parsers: getLatestParsePerSource(),
          items: getItemStats(),
          ingest: getIngestStats(),
          season: getClanSeasonContext(Math.floor(now / 1_000)),
          voice: voiceDashboardPayload(),
          recentItems: getLatestItemSummaries(8),
        },
      }
    }
    return dashboardSnapshot
  }

  app.get('/health', async () => ({ ok: true }))

  app.get('/api/stats', async (_request, reply) => {
    const snapshot = cachedDashboardSnapshot()
    void reply.header('Cache-Control', 'private, max-age=5, stale-while-revalidate=10')
    return {
      bot: deps.getBotStatus(),
      commands: snapshot.data.commands,
      parsers: snapshot.data.parsers,
      items: snapshot.data.items,
      ingest: snapshot.data.ingest,
      season: snapshot.data.season,
      wtTransport: { mode: wtTransportMode(), ...wtBrowserMetrics() },
    }
  })

  app.get('/api/dashboard', async (_request, reply) => {
    const now = Date.now()
    const snapshot = cachedDashboardSnapshot(now)
    void reply.header('Cache-Control', 'private, max-age=5, stale-while-revalidate=10')
    return {
      ok: true,
      generatedAt: now,
      snapshotAt: snapshot.builtAt,
      refreshAfterMs: DASHBOARD_SNAPSHOT_TTL_MS,
      bot: deps.getBotStatus(),
      runtime: deps.getRuntimeStats?.() ?? null,
      wtTransport: { mode: wtTransportMode(), ...wtBrowserMetrics() },
      ...snapshot.data,
    }
  })

  // Собранные записи (с результатом анализа, если есть):
  // GET /api/items?limit=20&source=demo-feed
  app.get<{ Querystring: { source?: string; limit?: number } }>('/api/items', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request) => {
    return { items: getLatestItems(request.query.limit ?? 20, request.query.source) }
  })

  app.get<{ Params: { source: string } }>('/api/parsers/:source/history', async (request) => ({
    history: getParseHistory(request.params.source),
  }))

  // Кто сидит в голосовых каналах (пишет бот, см. bot/voice-tracker.ts) +
  // статистика War Thunder по нику из серверного ника «WTНик (Имя)»:
  // ПКР с дельтой и клан — из снимков clan_rating_snapshots,
  // количество клановых боёв — по собранным реплеям в items.
  app.get('/api/voice', async () => {
    return { season: getClanSeasonContext(), ...voiceDashboardPayload() }
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
      const result = await refresh
      dashboardSnapshot = null
      return { ok: true, ...result }
    } finally {
      if (voiceRefreshInFlight === refresh) voiceRefreshInFlight = null
    }
  })
}
