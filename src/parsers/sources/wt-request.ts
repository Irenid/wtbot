import { config } from '../../config.js'
import { absorbSetCookies, cookieHeader } from './wt-cookies.js'
import {
  fetchWtResponseInBrowser,
  refreshWtClearance,
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
/**
 * Прямой Node-запрос отбрасывается Cloudflare (403 cf-mitigated: challenge)
 * даже со свежим cf_clearance: клиренс привязан к TLS-отпечатку браузера.
 * Поэтому режим определяется один раз пробой и потом изредка перепроверяется,
 * вместо провального запроса перед каждым обращением.
 */
const DIRECT_REPROBE_MS = 6 * 60 * 60_000
/** Поддерживает скользящую browser-сессию даже в периоды без полезных запросов. */
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

let nextRequestAt = 0
let requestTail: Promise<void> = Promise.resolve()
let transportMode: TransportMode = 'unknown'
let transportCheckedAt = 0
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
 * Принудительно обновляет browser-сессию после прикладного признака потери
 * авторизации (Replay API маскирует её под HTTP 200 с пустым списком).
 * Параллельные потребители делят одну попытку, а повторные ошибки не заставляют
 * Edge прогреваться каждые 20 секунд.
 */
async function refreshWtSession(reason: string): Promise<boolean> {
  if (!config.wtBrowserEnabled) return false
  if (sessionRefreshTail !== null) return sessionRefreshTail

  const now = Date.now()
  if (now < nextSessionRefreshAt) return false
  nextSessionRefreshAt = now + COOKIE_REFRESH_RETRY_MS

  console.warn(`[wt-cookies] ${reason} — пробую автоматически обновить сессию через Edge`)
  const refresh = (async () => {
    await waitForRequestSlot()
    return refreshWtClearance(reason, true)
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
 * Периодически продлевает browser-сессию и переносит актуальные cookies в
 * общий jar. Первый прогрев по-прежнему выполняется отдельно при старте.
 */
export function startWtCookieRefresh(): void {
  if (!config.wtBrowserEnabled || cookieRefreshActive) return
  cookieRefreshActive = true
  scheduleCookieRefresh(COOKIE_REFRESH_INTERVAL_MS)
  console.log('[wt-cookies] Автообновление включено (каждые 30 минут)')
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

/** Текущий режим транспорта; для диагностики в /api/stats. */
export function wtTransportMode(): TransportMode {
  return transportMode
}

function useBrowserTransport(): boolean {
  if (!config.wtBrowserEnabled) return false
  if (transportMode === 'browser') {
    if (Date.now() - transportCheckedAt < DIRECT_REPROBE_MS) return true
    // Раз в несколько часов даём прямому пути шанс: вдруг сайт снял защиту.
    transportMode = 'unknown'
    return false
  }
  return false
}

function markTransport(mode: Exclude<TransportMode, 'unknown'>): void {
  if (transportMode !== mode) {
    console.log(
      mode === 'browser'
        ? '[wt-request] Cloudflare отклоняет прямые запросы — перехожу на браузерный транспорт'
        : '[wt-request] Прямые запросы к warthunder.com проходят без браузера',
    )
  }
  transportMode = mode
  transportCheckedAt = Date.now()
}

async function directFetch(url: string | URL, init: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  headers['cookie'] = await cookieHeader()
  // UA должен совпадать с браузером, выдавшим clearance, иначе Cloudflare
  // отклонит запрос даже с валидной cookie.
  headers['user-agent'] = wtBrowserUserAgent() ?? headers['user-agent'] ?? WT_USER_AGENT
  return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) })
}

/**
 * Выполняет WT-запрос с общим cookie jar, rate limit и выбором транспорта.
 * Браузерный путь сам проходит проверку Cloudflare и повторяет запрос.
 */
export async function fetchWtResponse(
  url: string | URL,
  init: RequestInit,
  label: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<Response> {
  let rateAttempt = 0
  let directRetried = false
  for (;;) {
    const viaBrowser = useBrowserTransport()
    await waitForRequestSlot()

    let response: Response
    try {
      response = viaBrowser
        ? await fetchWtResponseInBrowser(url, init, maxBytes, label)
        : await directFetch(url, init)
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : 'неизвестная ошибка'
      if (!viaBrowser && config.wtBrowserEnabled && !directRetried) {
        // Прямой путь мог отвалиться по сети; браузерный транспорт остаётся
        // единственным рабочим вариантом, поэтому пробуем его один раз.
        directRetried = true
        markTransport('browser')
        continue
      }
      throw new WtRequestError(0, false, `${label}: сетевой запрос не выполнен (${detail})`)
    }
    if (!viaBrowser) await absorbSetCookies(response)

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
      if (cloudflareChallenge && !viaBrowser && config.wtBrowserEnabled && !directRetried) {
        directRetried = true
        markTransport('browser')
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

    if (!viaBrowser && response.ok) markTransport('direct')

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new WtRequestError(response.status, false, `${label}: HTTP ${response.status}`)
    }
    return response
  }
}

/** Прогрев браузера при старте, чтобы первый парсер не ждал проверку. */
export async function warmupWtTransport(): Promise<void> {
  if (!config.wtBrowserEnabled) return
  if (await warmupWtBrowser()) markTransport('browser')
}

export { refreshWtClearance }
