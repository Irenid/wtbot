import { config } from '../../config.js'
import { absorbSetCookies, directSessionHeaders } from './wt-cookies.js'
import {
  adoptBrowserSession,
  fetchWtResponseInBrowser,
  refreshWtClearance,
  setWtBrowserSessionProbe,
  warmupWtBrowser,
  wtBrowserUserAgent,
} from './wt-browser.js'

/** Общие параметры запросов профиля и Replay API warthunder.com. */

export const REQUEST_INTERVAL_MS = 1_500
export const RATE_LIMIT_RETRIES = 2
export const DEFAULT_RATE_LIMIT_DELAY_MS = 30_000
/** Cloudflare сверяет User-Agent с браузерной сессией, из которой взяты cookies. */
export const WT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
const MAX_RETRY_AFTER_MS = 10 * 60_000
const WT_ORIGIN = 'https://warthunder.com'
/**
 * Cloudflare проверяет не весь warthunder.com, а отдельные адреса: в октябре
 * 2026 профиль и поиск игроков отвечали прямому запросу 403 `cf-mitigated:
 * challenge`, а Replay API, лидерборды и страницы полков — обычным ответом.
 * Пройти проверку Node не может даже со свежим cf_clearance: клиренс привязан
 * к TLS-отпечатку браузера. Поэтому способ доступа выбирается для каждого
 * маршрута: сначала прямой запрос, браузер — только там, где прямой не
 * проходит. Режим маршрута изредка перепроверяется, а не пробуется заново
 * перед каждым обращением.
 */
const DIRECT_REPROBE_MS = 6 * 60 * 60_000
/**
 * Маршруты, которым нужна авторизованная сессия WT (identity_*). Сессию ведёт
 * общий jar: прямой запрос несёт её cookies, а браузер получает её, только
 * пока такой маршрут идёт через него (prepareBrowserSession в wt-browser.ts).
 */
const SESSION_ROUTES: ReadonlySet<string> = new Set(['/en/api/replay'])
/** Пока адрес идёт через браузер, держит свежими его проверку Cloudflare и сессию, если он её несёт. */
const COOKIE_REFRESH_INTERVAL_MS = 30 * 60_000
const COOKIE_REFRESH_RETRY_MS = 5 * 60_000

export class WtRequestError extends Error {
  constructor(
    readonly status: number,
    readonly cloudflareChallenge: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'WtRequestError'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type TransportMode = 'unknown' | 'direct' | 'browser'

interface RouteTransport {
  mode: TransportMode
  checkedAt: number
}

/** Внешние зависимости транспорта; тесты подменяют очередь, браузер и jar. */
interface WtTransportDeps {
  waitSlot: () => Promise<void>
  browserEnabled: () => boolean
  browserFetch: (
    url: string | URL,
    init: RequestInit,
    maxBytes: number,
    label: string,
    options: { session?: boolean },
  ) => Promise<Response>
  sessionHeaders: () => Promise<{ cookie: string; userAgent: string | null }>
  absorbSessionCookies: (response: Response) => Promise<void>
  now: () => number
}

let nextRequestAt = 0
let requestTail: Promise<void> = Promise.resolve()
const routeTransports = new Map<string, RouteTransport>()
let cookieRefreshActive = false
let cookieRefreshTimer: NodeJS.Timeout | null = null
let sessionRefreshTail: Promise<boolean> | null = null
let nextSessionRefreshAt = 0

/**
 * Резервирует следующий слот. Очередь нужна не только для одного source:
 * scheduler запускает источники одновременно, и простой timestamp позволил
 * бы двум запросам пройти в один момент.
 */
export function waitForRequestSlot(): Promise<void> {
  const slot = requestTail.then(async () => {
    for (;;) {
      const waitMs = nextRequestAt - Date.now()
      if (waitMs <= 0) break
      await sleep(waitMs)
    }
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS
  })
  requestTail = slot.then(() => undefined, () => undefined)
  return slot
}

/** Откладывает следующий слот после ответа 429, сохраняя общий интервал. */
export function deferRequestSlot(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) return
  nextRequestAt = Math.max(
    nextRequestAt,
    Date.now() + Math.max(REQUEST_INTERVAL_MS, Math.min(delayMs, MAX_RETRY_AFTER_MS)),
  )
}

function scheduleCookieRefresh(delayMs: number): void {
  if (!cookieRefreshActive || !config.wtBrowserEnabled || cookieRefreshTimer !== null) return
  cookieRefreshTimer = setTimeout(() => {
    cookieRefreshTimer = null
    void runCookieRefresh()
  }, delayMs)
  cookieRefreshTimer.unref()
}

async function runCookieRefresh(): Promise<void> {
  if (!cookieRefreshActive) return
  // Пока ни один адрес не идёт через браузер, держать его проверку Cloudflare
  // незачем: браузер поднимется при первом адресе, которому он нужен.
  if (![...routeTransports.values()].some((route) => route.mode === 'browser')) {
    scheduleCookieRefresh(COOKIE_REFRESH_INTERVAL_MS)
    return
  }
  let refreshed = false
  try {
    // Плановое обновление участвует в той же глобальной очереди, что парсеры:
    // отдельный таймер не должен обходить интервал запросов warthunder.com.
    await waitForRequestSlot()
    if (!cookieRefreshActive) return
    refreshed = await refreshWtClearance('плановое обновление cookies', false)
  } catch (error) {
    console.warn(
      `[wt-cookies] Плановое обновление не удалось: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (cookieRefreshActive) {
    scheduleCookieRefresh(refreshed ? COOKIE_REFRESH_INTERVAL_MS : COOKIE_REFRESH_RETRY_MS)
  }
}

/**
 * Восстанавливает сессию после прикладного признака её потери (Replay API
 * маскирует её под HTTP 200 с пустым списком): берёт собственную сессию
 * браузера, обновляет сессию, которую несёт браузер, или переводит маршрут
 * с сессией на браузер. Параллельные потребители делят одну попытку, а
 * повторные ошибки не заставляют браузер работать каждые 20 секунд.
 */
async function refreshWtSession(reason: string): Promise<boolean> {
  if (!config.wtBrowserEnabled) return false
  if (sessionRefreshTail !== null) return sessionRefreshTail

  const now = Date.now()
  if (now < nextSessionRefreshAt) return false
  nextSessionRefreshAt = now + COOKIE_REFRESH_RETRY_MS

  const refresh = (async () => {
    // Своя сессия браузера, отличная от jar (вход через VNC), — первая надежда.
    if (await adoptBrowserSession()) {
      console.warn(`[wt-cookies] ${reason} — беру сессию из браузера`)
      return true
    }
    if (sessionCarriedByBrowser()) {
      console.warn(`[wt-cookies] ${reason} — пробую автоматически обновить сессию через браузер`)
      await waitForRequestSlot()
      return refreshWtClearance(reason, true, true)
    }
    // Сессию нёс прямой путь, и сервер её не принял: та же сессия из браузера
    // может пройти. Маршрут вернётся к прямому пути после DIRECT_REPROBE_MS.
    for (const route of SESSION_ROUTES) markTransport(route, 'browser', 'сервер не принял сессию без браузера')
    return true
  })()
  sessionRefreshTail = refresh
  try {
    return await refresh
  } finally {
    if (sessionRefreshTail === refresh) sessionRefreshTail = null
  }
}

/**
 * Повторяет прикладной запрос ровно один раз, если его результат означает
 * потерю WT-сессии и Edge смог обновить cookies.
 */
export async function retryAfterWtSessionRefresh<T>(
  request: () => Promise<T>,
  isSessionExpired: (value: T) => boolean,
  reason: string,
  refreshSession: (reason: string) => Promise<boolean> = refreshWtSession,
): Promise<T> {
  const initial = await request()
  if (!isSessionExpired(initial)) return initial
  if (!(await refreshSession(reason))) return initial
  return request()
}

/**
 * Периодически проходит проверку Cloudflare в браузере, пока хоть один адрес
 * идёт через него; пока браузер несёт сессию WT, заодно продлевает её и
 * переносит cookies в общий jar.
 */
export function startWtCookieRefresh(): void {
  if (!config.wtBrowserEnabled || cookieRefreshActive) return
  cookieRefreshActive = true
  scheduleCookieRefresh(COOKIE_REFRESH_INTERVAL_MS)
  console.log('[wt-cookies] Автообновление включено: каждые 30 минут, пока адресу нужен браузер')
}

/** Запрещает новые плановые запросы и снимает ожидающий таймер. */
export function stopWtCookieRefresh(): void {
  cookieRefreshActive = false
  if (cookieRefreshTimer !== null) clearTimeout(cookieRefreshTimer)
  cookieRefreshTimer = null
}

/** Разбирает Retry-After как секунды или HTTP-date. */
export function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after')?.trim()
  if (value !== undefined && value !== '') {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    }

    const date = Date.parse(value)
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS)
    }
  }
  return DEFAULT_RATE_LIMIT_DELAY_MS
}

function isCloudflareChallenge(response: Response): boolean {
  return response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge'
}

const defaultTransportDeps: WtTransportDeps = {
  waitSlot: waitForRequestSlot,
  browserEnabled: () => config.wtBrowserEnabled,
  browserFetch: fetchWtResponseInBrowser,
  sessionHeaders: directSessionHeaders,
  absorbSessionCookies: absorbSetCookies,
  now: () => Date.now(),
}
let transportDeps = defaultTransportDeps

/** Сбрасывает режимы маршрутов (изоляция тестов); overrides подменяют очередь, браузер и jar. */
export function resetWtTransportState(overrides: Partial<WtTransportDeps> = {}): void {
  routeTransports.clear()
  transportDeps = { ...defaultTransportDeps, ...overrides }
}

/**
 * Маршрут запроса — первые три сегмента пути: /en/api/replay,
 * /en/community/userinfo, /en/community/getclansleaderboard.
 */
export function wtRouteOf(url: string | URL): string {
  const { pathname } = new URL(String(url), WT_ORIGIN)
  return `/${pathname.split('/').filter(Boolean).slice(0, 3).join('/')}`
}

/** Сессию WT несёт браузер, пока через него идёт маршрут, которому она нужна. */
function sessionCarriedByBrowser(): boolean {
  if (!transportDeps.browserEnabled()) return false
  for (const route of SESSION_ROUTES) {
    if (routeTransports.get(route)?.mode === 'browser') return true
  }
  return false
}

setWtBrowserSessionProbe(sessionCarriedByBrowser)

/** Режимы адресов warthunder.com для /api/stats. */
export function wtTransportRoutes(): Record<string, TransportMode> {
  return Object.fromEntries(
    [...routeTransports]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([route, transport]) => [route, transport.mode]),
  )
}

/** Сводный режим для /api/stats: mixed — часть адресов идёт через браузер. */
export function wtTransportMode(): TransportMode | 'mixed' {
  const modes = new Set([...routeTransports.values()].map((transport) => transport.mode))
  if (modes.has('browser')) return modes.has('direct') ? 'mixed' : 'browser'
  return modes.has('direct') ? 'direct' : 'unknown'
}

function useBrowserTransport(route: string): boolean {
  if (!transportDeps.browserEnabled()) return false
  const transport = routeTransports.get(route)
  if (transport?.mode !== 'browser') return false
  if (transportDeps.now() - transport.checkedAt < DIRECT_REPROBE_MS) return true
  // Раз в несколько часов прямой путь получает шанс: вдруг сайт снял защиту.
  routeTransports.set(route, { mode: 'unknown', checkedAt: transportDeps.now() })
  return false
}

function markTransport(route: string, mode: Exclude<TransportMode, 'unknown'>, reason = ''): void {
  if (routeTransports.get(route)?.mode !== mode) {
    console.log(
      mode === 'browser'
        ? `[wt-request] ${route}: ${reason || 'прямой запрос не проходит'} — адрес идёт через браузер`
        : `[wt-request] ${route}: прямые запросы проходят без браузера`,
    )
  }
  routeTransports.set(route, { mode, checkedAt: transportDeps.now() })
}

/**
 * Прямой запрос. Сессию jar несут только маршруты, которым она нужна:
 * публичный ответ не может ротировать identity_sid, которым живёт Replay API.
 */
async function directFetch(url: string | URL, init: RequestInit, session: boolean): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  delete headers['cookie']
  let userAgent = wtBrowserUserAgent()
  if (session) {
    const jar = await transportDeps.sessionHeaders()
    if (jar.cookie !== '') headers['cookie'] = jar.cookie
    // Сессию выдал браузер: запрос с её cookies представляется тем же браузером.
    userAgent ??= jar.userAgent
  }
  headers['user-agent'] = userAgent ?? headers['user-agent'] ?? WT_USER_AGENT
  return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) })
}

/**
 * Выполняет WT-запрос с общим rate limit: сначала напрямую, через браузер —
 * только адреса, которые прямой запрос не пропускает. Браузерный путь сам
 * проходит проверку Cloudflare и повторяет запрос.
 */
export async function fetchWtResponse(
  url: string | URL,
  init: RequestInit,
  label: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<Response> {
  const route = wtRouteOf(url)
  const session = SESSION_ROUTES.has(route)
  let rateAttempt = 0
  let networkFallback = false
  for (;;) {
    const viaBrowser = networkFallback || useBrowserTransport(route)
    await transportDeps.waitSlot()

    let response: Response
    try {
      response = viaBrowser
        ? await transportDeps.browserFetch(url, init, maxBytes, label, { session })
        : await directFetch(url, init, session)
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : 'неизвестная ошибка'
      if (!viaBrowser && transportDeps.browserEnabled()) {
        // Сетевой сбой прямого запроса повторяем через браузер один раз, но
        // маршрут не переводим: разовый таймаут — не повод отдать адрес
        // браузеру на часы.
        networkFallback = true
        continue
      }
      throw new WtRequestError(0, false, `${label}: сетевой запрос не выполнен (${detail})`)
    }
    if (!viaBrowser && session) await transportDeps.absorbSessionCookies(response)

    if (response.status === 429) {
      const delayMs = retryAfterMs(response)
      await response.body?.cancel().catch(() => undefined)
      deferRequestSlot(delayMs)
      if (rateAttempt < RATE_LIMIT_RETRIES) {
        rateAttempt += 1
        continue
      }
      throw new WtRequestError(429, false, `${label}: HTTP 429 после ${RATE_LIMIT_RETRIES + 1} попыток`)
    }

    if (response.status === 401 || response.status === 403) {
      const cloudflareChallenge = response.status === 403 && isCloudflareChallenge(response)
      await response.body?.cancel().catch(() => undefined)
      if (cloudflareChallenge && !viaBrowser && transportDeps.browserEnabled()) {
        markTransport(route, 'browser', 'Cloudflare требует проверку')
        continue
      }
      if (cloudflareChallenge) {
        // Браузерный путь уже пытался пройти проверку внутри себя.
        throw new WtRequestError(
          response.status,
          true,
          `${label}: HTTP 403 — Cloudflare требует проверку, а пройти её не удалось`,
        )
      }
      throw new WtRequestError(
        response.status,
        false,
        `${label}: HTTP ${response.status} — сессия WT истекла или доступ запрещён; обновите WT_COOKIE`,
      )
    }

    if (!viaBrowser && response.ok) markTransport(route, 'direct')

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new WtRequestError(response.status, false, `${label}: HTTP ${response.status}`)
    }
    return response
  }
}

/**
 * Прогрев браузера для ручных smoke-скриптов. Бот при старте его не вызывает:
 * браузер поднимается при первом адресе, которому он нужен.
 */
export async function warmupWtTransport(): Promise<void> {
  if (!config.wtBrowserEnabled) return
  await warmupWtBrowser()
}

export { refreshWtClearance }
