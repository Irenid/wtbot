import fastify, { type FastifyInstance } from 'fastify'
import type { WebDeps } from './types.js'
import { apiRoutes } from './routes/api.js'
import { pageRoutes } from './routes/pages.js'
import { playerStatsRoutes } from './routes/player-stats.js'

export function buildServer(deps: WebDeps): FastifyInstance {
  const app = fastify({ logger: false })

  app.register(pageRoutes)
  app.register(apiRoutes, { deps })
  app.register(playerStatsRoutes, { deps })

  return app
}
