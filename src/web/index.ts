import { timingSafeEqual } from 'node:crypto'
import fastify, { type FastifyInstance } from 'fastify'
import type { WebDeps } from './types.js'
import { apiRoutes } from './routes/api.js'
import { pageRoutes } from './routes/pages.js'
import { playerStatsRoutes } from './routes/player-stats.js'
import { siteRoutes, type SiteRoutesOptions } from './routes/site.js'
import { spaDistAvailable, spaRoutes } from './routes/spa.js'

export interface WebSecurityOptions {
  host?: string
  token?: string
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function hasValidBearerToken(request: { headers: Record<string, string | string[] | undefined> }, token: string): boolean {
  const authorization = request.headers['authorization']
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const provided = Buffer.from(authorization.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function pathWithoutQuery(url: string): string {
  return url.split('?', 1)[0] ?? url
}

function isProtectedPath(url: string): boolean {
  const pathname = pathWithoutQuery(url)
  return pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')
    || pathname === '/api' || pathname.startsWith('/api/')
}

function isSafePostOrigin(request: {
  headers: Record<string, string | string[] | undefined>
}): boolean {
  const fetchSite = request.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false
  }
  const origin = request.headers['origin']
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  const host = request.headers['host']
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function errorDetails(error: unknown): { statusCode: number | undefined; message: string; stack: string | undefined } {
  if (!(error instanceof Error)) {
    return { statusCode: undefined, message: String(error), stack: undefined }
  }
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined
  return { statusCode, message: error.message, stack: error.stack }
}

export function buildServer(
  deps: WebDeps,
  site?: SiteRoutesOptions,
  security: WebSecurityOptions = {},
): FastifyInstance {
  const host = security.host?.trim() || '127.0.0.1'
  const token = security.token?.trim() ?? ''
  const requireToken = !isLoopbackHost(host)
  if (requireToken && token === '') {
    throw new Error('WEB_TOKEN обязателен, если WEB_HOST не указывает loopback-интерфейс')
  }

  const app = fastify({ logger: false })

  app.addHook('onRequest', async (request, reply) => {
    if (!requireToken || !isProtectedPath(request.url)) return
    if (!hasValidBearerToken(request, token)) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Требуется авторизация',
      })
      return
    }
    if (request.method === 'POST' && !isSafePostOrigin(request)) {
      reply.code(403).send({
        ok: false,
        code: 'CSRF_BLOCKED',
        error: 'Кросс-доменный POST запрещён',
      })
    }
  })

  app.register(pageRoutes)
  app.register(apiRoutes, { deps })
  app.register(playerStatsRoutes, { deps })
  app.register(siteRoutes, site ? { site } : {})
  // SPA подключается только при собранном frontend/dist: без него бот и API
  // работают как раньше, а /app отдаёт обычный 404.
  const hasSpa = spaDistAvailable()
  if (hasSpa) {
    app.register(spaRoutes)
  } else {
    app.setNotFoundHandler((_request, reply) => {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', error: 'Не найдено' })
    })
  }

  app.setErrorHandler((error, request, reply) => {
    const details = errorDetails(error)
    const statusCode = details.statusCode !== undefined && details.statusCode >= 400 && details.statusCode < 500
      ? details.statusCode
      : 500
    const code = statusCode === 400 ? 'INVALID_REQUEST' : statusCode === 404 ? 'NOT_FOUND' : statusCode >= 500 ? 'INTERNAL' : 'REQUEST_FAILED'
    if (statusCode >= 500) {
      console.error(`[web] ${request.method} ${request.url} — ${details.stack ?? details.message}`)
      return reply.code(500).send({ ok: false, code, error: 'Внутренняя ошибка сервера' })
    }
    return reply.code(statusCode).send({
      ok: false,
      code,
      error: statusCode === 400 ? 'Некорректный запрос' : details.message,
    })
  })

  return app
}
