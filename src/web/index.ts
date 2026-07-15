import fastify, { type FastifyInstance } from 'fastify'
import type { WebDeps } from './types.js'
import { apiRoutes } from './routes/api.js'
import { pageRoutes } from './routes/pages.js'

export function buildServer(deps: WebDeps): FastifyInstance {
  const app = fastify({ logger: false })

  app.register(pageRoutes)
  app.register(apiRoutes, { deps })

  return app
}
