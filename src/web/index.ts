import { timingSafeEqual } from 'node:crypto'
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
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

function isProtectedPathname(pathname: string): boolean {
  return pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')
    || pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * Нормализует сырой request-target к пути, по которому маршрутизирует Fastify:
 * снимает absolute-form (`http://host/...`, приходит через прокси или HTTP/2),
 * query и fragment, затем разово декодирует percent-escapes. Используется
 * только как fallback (см. isProtectedRequest), когда маршрут не определён.
 */
function normalizedPathname(rawUrl: string): string {
  let pathname = rawUrl
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    } catch {
      // некорректный absolute URL — разбираем строку как есть
    }
  }
  pathname = pathname.split('?', 1)[0] ?? pathname
  pathname = pathname.split('#', 1)[0] ?? pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // битый percent-escape — сравниваем сырой путь
  }
  return pathname
}

/**
 * Требует ли запрос авторизации. Решение принимается по фактически выбранному
 * Fastify маршруту (`routeOptions.url`), а не по сырой строке `request.url`:
 * закодированный (`/%61pi/...`) или absolute-form (`http://host/api/...`) путь
 * иначе расходится с представлением роутера и обходит проверку. Если маршрут
 * не найден (routeOptions.url отсутствует), запрос до защищённого обработчика
 * не дойдёт, но на всякий случай отклоняем и по нормализованному пути.
 */
function isProtectedRequest(request: FastifyRequest): boolean {
  const routeUrl = request.routeOptions?.url
  if (routeUrl !== undefined) return isProtectedPathname(routeUrl)
  return isProtectedPathname(normalizedPathname(request.url))
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
    if (!requireToken || !isProtectedRequest(request)) return
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
