import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync } from 'fastify'

/** Каталог собранного SPA; путь зависит от рабочего каталога, как и data/*. */
export const SPA_DIST_DIR = path.resolve('frontend/dist')

export function spaDistAvailable(): boolean {
  return existsSync(path.join(SPA_DIST_DIR, 'index.html'))
}

/**
 * Раздача собранного SPA на /app: файлы Vite-сборки + fallback на index.html
 * для клиентского роутинга. Регистрируется только когда сборка существует,
 * поэтому бот и API работают и без собранного фронтенда.
 */
export const spaRoutes: FastifyPluginAsync = async (app) => {
  await app.register(fastifyStatic, {
    root: SPA_DIST_DIR,
    prefix: '/app/',
    index: false,
    wildcard: true,
    // Имена ассетов Vite содержат content-hash — их можно кэшировать надолго;
    // index.html не кэшируется, чтобы деплой подхватывался сразу.
    setHeaders: (reply, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        reply.header('Cache-Control', 'public, max-age=604800, immutable')
      } else {
        reply.header('Cache-Control', 'no-cache')
      }
    },
  })
  app.get('/app', async (_request, reply) => reply.sendFile('index.html'))
  // Корень префикса: @fastify/static с index: false отдавал на /app/ 403.
  app.get('/app/', async (_request, reply) => reply.sendFile('index.html'))
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && request.url.startsWith('/app/')) {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ ok: false, code: 'NOT_FOUND', error: 'Не найдено' })
  })
}
