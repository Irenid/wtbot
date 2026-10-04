import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

/** Built SPA directory; relative to the working directory, like data/*. */
export const SPA_DIST_DIR = path.resolve('frontend/dist')

/** The SPA lived under this prefix until 2026-10-04; old links and bookmarks redirect to the root. */
export const LEGACY_SPA_PREFIX = '/app'

export function spaDistAvailable(): boolean {
  return existsSync(path.join(SPA_DIST_DIR, 'index.html'))
}

/** Decoded path of a request target, also of an absolute-form one, as the router sees it. */
function requestPathname(rawUrl: string): string {
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return rawUrl
  }
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/**
 * The same page without the legacy prefix, query kept. Leading slashes and
 * backslashes collapse into one: `/app//host` must not become the
 * protocol-relative `//host` of another site.
 */
export function legacySpaTarget(rawUrl: string): string {
  let target = rawUrl
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      const url = new URL(target)
      target = `${url.pathname}${url.search}`
    } catch {
      target = '/'
    }
  }
  const rest = target.startsWith(LEGACY_SPA_PREFIX) ? target.slice(LEGACY_SPA_PREFIX.length) : target
  return `/${rest.replace(/^[/\\]+/, '')}`
}

/** Old /app links: registered with or without a build, so they never end on a 404. */
export const legacySpaRoutes: FastifyPluginAsync = async (app) => {
  const redirect = async (request: FastifyRequest, reply: FastifyReply) => reply.redirect(legacySpaTarget(request.url), 301)
  app.get(LEGACY_SPA_PREFIX, redirect)
  app.get(`${LEGACY_SPA_PREFIX}/*`, redirect)
}

/**
 * A GET for a page of the SPA: everything outside the API and the build's
 * hashed assets (a missing asset after a deploy is a 404, not HTML a browser
 * would try to run as a script).
 */
function isSpaPageRequest(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const pathname = requestPathname(request.url)
  return !(pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/assets/'))
}

/**
 * The built SPA at the site root: Vite files plus index.html for client-side
 * routes. Registered only when the build exists, so the bot and the API work
 * without the frontend. Named routes (/api/*, /health, the dashboard
 * DASHBOARD_PATH in pages.ts) win over the static wildcard.
 */
export const spaRoutes: FastifyPluginAsync = async (app) => {
  await app.register(fastifyStatic, {
    root: SPA_DIST_DIR,
    prefix: '/',
    index: false,
    wildcard: true,
    // Vite asset names carry a content hash, so they are cached for a week;
    // index.html is not cached, so a deploy shows up at once.
    setHeaders: (reply, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        reply.header('Cache-Control', 'public, max-age=604800, immutable')
      } else {
        reply.header('Cache-Control', 'no-cache')
      }
    },
  })
  // With index: false the static plugin answers the bare root with 403.
  app.get('/', async (_request, reply) => reply.sendFile('index.html'))
  app.setNotFoundHandler(async (request, reply) => {
    if (isSpaPageRequest(request)) return reply.sendFile('index.html')
    return reply.code(404).send({ ok: false, code: 'NOT_FOUND', error: 'Not found' })
  })
}
