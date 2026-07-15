import type { FastifyPluginAsync } from 'fastify'
import type { WebDeps } from '../types.js'
import {
  getCommandStats,
  getItemStats,
  getLatestItems,
  getLatestParsePerSource,
  getParseHistory,
} from '../../db/index.js'

// JSON API — его же можно дергать из будущего фронтенда (React/Vue),
// когда простой встроенной страницы станет мало.
export const apiRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  app.get('/health', async () => ({ ok: true }))

  app.get('/api/stats', async () => ({
    bot: deps.getBotStatus(),
    commands: getCommandStats(),
    parsers: getLatestParsePerSource(),
    items: getItemStats(),
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
}
