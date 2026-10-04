import { timingSafeEqual } from 'node:crypto'
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { WebDeps } from './types.js'
import { apiRoutes } from './routes/api.js'
import { pageRoutes } from './routes/pages.js'
import { playerStatsRoutes } from './routes/player-stats.js'
import { siteRoutes, type SiteRoutesOptions } from './routes/site.js'
import { legacySpaRoutes, spaDistAvailable, spaRoutes } from './routes/spa.js'

export interface WebSecurityOptions {
  host?: string
  token?: string
  /** Fastify trustProxy: адреса reverse proxy, которым доверяется X-Forwarded-For. */
  trustProxy?: boolean | string[] | undefined
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/** Имя хоста из заголовка Host без порта; IPv6 — без квадратных скобок. */
function hostHeaderName(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text === '') return null
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end > 1 ? text.slice(1, end) : null
  }
  const colon = text.indexOf(':')
  return colon >= 0 ? text.slice(0, colon) : text
}

/**
 * Защита от DNS rebinding в loopback-режиме: страница злоумышленника может
 * перепривязать своё имя на 127.0.0.1 и читать API из браузера оператора, но
 * Host у такого запроса останется её именем. `*.localhost` браузеры всегда
 * резолвят локально, поэтому его подделать нельзя.
 */
function hasLoopbackHostHeader(value: string | string[] | undefined): boolean {
  const name = hostHeaderName(value)
  if (name === null) return false
  return name === '127.0.0.1' || name === '::1' || name === 'localhost' || name.endsWith('.localhost')
}

/**
 * Токен из Authorization: `Bearer <WEB_TOKEN>` для API-клиентов или HTTP Basic
 * с паролем WEB_TOKEN (имя пользователя любое) — браузер сам показывает окно
 * входа и затем отправляет его с каждой навигацией и fetch к этому origin.
 */
function providedToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== 'string') return null
  const bearer = /^bearer\s+(.+)$/i.exec(authorization.trim())
  if (bearer !== null) return bearer[1] ?? null
  const basic = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization.trim())
  if (basic === null) return null
  const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon >= 0 ? decoded.slice(colon + 1) : null
}

function hasValidToken(request: { headers: Record<string, string | string[] | undefined> }, token: string): boolean {
  const value = providedToken(request.headers['authorization'])
  if (value === null) return false
  const provided = Buffer.from(value, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/**
 * With WEB_TOKEN every path is private except the health probe: the SPA serves
 * index.html for any page path at the root, and a list of protected prefixes
 * would leave every new route public.
 */
function isProtectedPathname(pathname: string): boolean {
  return pathname !== '/health'
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

function isSafePostOrigin(request: FastifyRequest): boolean {
  const fetchSite = request.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false
  }
  const origin = request.headers['origin']
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  // request.host учитывает X-Forwarded-Host, если включён trustProxy: за reverse
  // proxy браузер видит внешнее имя, а сырой Host — адрес upstream.
  const host = request.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
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

  // trustProxy только явным opt-in (WEB_TRUST_PROXY): безусловное доверие дало
  // бы любому клиенту подделать X-Forwarded-For и обойти лимиты по IP.
  const app = fastify({ logger: false, trustProxy: security.trustProxy ?? false })

  app.addHook('onRequest', async (request, reply) => {
    if (!requireToken && !hasLoopbackHostHeader(request.headers['host'])) {
      return reply.code(421).send({
        ok: false,
        code: 'HOST_NOT_ALLOWED',
        error: 'Недопустимый заголовок Host для локального сервера',
      })
    }
    if (requireToken && isProtectedRequest(request) && !hasValidToken(request, token)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="wtbot", charset="UTF-8"')
        .send({
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Требуется авторизация',
        })
    }
    // CSRF: POST принимается только same-origin в любом режиме — на loopback
    // запрос с чужой страницы тоже приходит из браузера оператора.
    if (request.method === 'POST' && !isSafePostOrigin(request)) {
      return reply.code(403).send({
        ok: false,
        code: 'CSRF_BLOCKED',
        error: 'Кросс-доменный POST запрещён',
      })
    }
  })

  if (requireToken) {
    // Ответ за авторизацией нельзя хранить в общем кэше reverse proxy: иначе
    // он ушёл бы следующему клиенту без проверки токена.
    app.addHook('onSend', async (request, reply, payload) => {
      const cacheControl = reply.getHeader('cache-control')
      if (typeof cacheControl === 'string' && /\bpublic\b/i.test(cacheControl) && isProtectedRequest(request)) {
        reply.header('cache-control', cacheControl.replace(/\bpublic\b/gi, 'private'))
      }
      return payload
    })
  }

  app.register(pageRoutes)
  app.register(apiRoutes, { deps })
  app.register(playerStatsRoutes, { deps })
  app.register(siteRoutes, site ? { site } : {})
  app.register(legacySpaRoutes)
  // The SPA is served only from a built frontend/dist: without it the bot,
  // the API and the dashboard work as before, and page paths get a plain 404.
  const hasSpa = spaDistAvailable()
  if (hasSpa) {
    app.register(spaRoutes)
  } else {
    app.setNotFoundHandler((_request, reply) => {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', error: 'Not found' })
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
