import fastify, { type FastifyInstance } from 'fastify'
import type { WebDeps } from './types.js'
import { apiRoutes } from './routes/api.js'
import { pageRoutes } from './routes/pages.js'
import { playerStatsRoutes } from './routes/player-stats.js'
import { siteRoutes, type SiteRoutesOptions } from './routes/site.js'
import { spaDistAvailable, spaRoutes } from './routes/spa.js'

export function buildServer(deps: WebDeps, site?: SiteRoutesOptions): FastifyInstance {
  const app = fastify({ logger: false })

  app.register(pageRoutes)
  app.register(apiRoutes, { deps })
  app.register(playerStatsRoutes, { deps })
  app.register(siteRoutes, site ? { site } : {})
  // SPA подключается только при собранном frontend/dist: без него бот и API
  // работают как раньше, а /app отдаёт обычный 404.
  if (spaDistAvailable()) app.register(spaRoutes)

  return app
}
