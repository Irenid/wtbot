import type { Page, Response as PlaywrightResponse, Route } from 'playwright-core'
import { config } from '../config.js'
import { withEdgeBrowserPage } from '../parsers/sources/wt-browser.js'

const STATSHARK_ORIGIN = 'https://statshark.net'
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const TOKEN_MAX_AGE_MS = 30 * 60 * 1_000
const TOKEN_POLL_MS = 250
const AUTOMATIC_RESPONSE_GRACE_MS = 1_500
const MANUAL_WINDOW_DELAY_MS = 8_000

type StatSharkEndpoint =
  | 'profile'
  | 'vehicleHistory'
  | 'leaderboardHistory'
  | 'vehicleInfo'

interface CapturedJson {
  status: number
  value: unknown
}

interface InPageResult {
  status: number
  body: string
  tooLarge: boolean
}

interface EndpointRequest {
  method: 'GET' | 'POST'
  url: string
  body: string | null
}

export interface StatSharkBundle {
  schemaVersion: 1
  playerId: string
  profile: unknown
  vehicleHistory: unknown
  leaderboardHistory: unknown
  vehicleInfo: unknown
}

export interface StatSharkClientOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  update?: boolean
  withPage?: typeof withEdgeBrowserPage
}

export class StatSharkClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly endpoint: StatSharkEndpoint | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'StatSharkClientError'
  }
}

function playerIdValue(playerId: string): string {
  const normalized = playerId.trim()
  if (!/^\d+$/.test(normalized)) {
    throw new StatSharkClientError('StatShark player id должен состоять только из цифр')
  }
  return normalized
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} должен быть положительным целым числом`)
  }
  return value
}

function endpointRequests(playerId: string, update: boolean): Record<StatSharkEndpoint, EndpointRequest> {
  const suffix = update ? '?update=true' : ''
  return {
    profile: {
      method: 'POST',
      url: `${STATSHARK_ORIGIN}/api/stat/MakeStatRequestById/${playerId}${suffix}`,
      body: '{}',
    },
    vehicleHistory: {
      method: 'GET',
      url: `${STATSHARK_ORIGIN}/api/stat/GetVehicleHistoryById/${playerId}`,
      body: null,
    },
    leaderboardHistory: {
      method: 'GET',
      url: `${STATSHARK_ORIGIN}/api/stat/GetLeaderboardHistoryById/${playerId}`,
      body: null,
    },
    vehicleInfo: {
      method: 'POST',
      url: `${STATSHARK_ORIGIN}/api/misc/getVehicleinfo`,
      body: '{}',
    },
  }
}

function endpointForResponse(
  response: PlaywrightResponse,
  playerId: string,
): StatSharkEndpoint | null {
  let path: string
  try {
    const parsed = new URL(response.url())
    if (parsed.origin !== STATSHARK_ORIGIN) return null
    path = parsed.pathname.toLowerCase()
  } catch {
    return null
  }
  const id = playerId.toLowerCase()
  if (path === `/api/stat/makestatrequestbyid/${id}`) return 'profile'
  if (path === `/api/stat/getvehiclehistorybyid/${id}`) return 'vehicleHistory'
  if (path === `/api/stat/getleaderboardhistorybyid/${id}`) return 'leaderboardHistory'
  if (path === '/api/misc/getvehicleinfo') return 'vehicleInfo'
  return null
}

function parseJsonBody(body: string, endpoint: StatSharkEndpoint): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new StatSharkClientError(
      `StatShark ${endpoint}: ответ не является JSON`,
      null,
      endpoint,
      { cause: error },
    )
  }
}

async function captureResponse(
  response: PlaywrightResponse,
  endpoint: StatSharkEndpoint,
  maxBytes: number,
): Promise<CapturedJson> {
  const status = response.status()
  const body = await response.body()
  if (body.byteLength > maxBytes) {
    throw new StatSharkClientError(
      `StatShark ${endpoint}: ответ превышает лимит ${maxBytes} байт`,
      status,
      endpoint,
    )
  }
  return {
    status,
    value: parseJsonBody(body.toString('utf8'), endpoint),
  }
}

function validStoredToken(page: Page): Promise<boolean> {
  return page.evaluate(({ maxAgeMs }) => {
    const token = localStorage.getItem('turnstile_token')
    const timestamp = Number(localStorage.getItem('turnstile_timestamp'))
    return token !== null
      && token.trim() !== ''
      && Number.isFinite(timestamp)
      && Date.now() - timestamp <= maxAgeMs
  }, { maxAgeMs: TOKEN_MAX_AGE_MS }).catch(() => false)
}

async function clearStoredToken(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('turnstile_token')
    localStorage.removeItem('turnstile_timestamp')
  }).catch(() => undefined)
}

async function showBrowserWindow(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget') as { windowId: number }
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 80, top: 80, width: 1365, height: 900, windowState: 'normal' },
    })
    await session.detach().catch(() => undefined)
    console.warn('[statshark] Окно Edge показано — завершите штатную проверку Turnstile вручную')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[statshark] Не удалось показать окно Edge (${message.slice(0, 300)})`)
  }
}

async function waitForToken(
  page: Page,
  deadline: number,
  revealAt: number,
): Promise<boolean> {
  let revealed = false
  while (Date.now() < deadline) {
    if (await validStoredToken(page)) return true
    if (!revealed && Date.now() >= revealAt) {
      revealed = true
      await showBrowserWindow(page)
    }
    await page.waitForTimeout(TOKEN_POLL_MS).catch(() => undefined)
  }
  return false
}

async function requestInPage(
  page: Page,
  request: EndpointRequest,
  maxBytes: number,
): Promise<InPageResult> {
  return await page.evaluate(async ({ target, limit }) => {
    const token = localStorage.getItem('turnstile_token')
    if (token === null || token.trim() === '') {
      return { status: 0, body: '', tooLarge: false }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const headers: Record<string, string> = {
        accept: 'application/json, text/plain, */*',
        'x-turnstile-token': token,
      }
      if (target.body !== null) headers['content-type'] = 'application/json'
      const init: RequestInit = {
        method: target.method,
        headers,
        credentials: 'include',
        signal: controller.signal,
      }
      if (target.body !== null) init.body = target.body
      const response = await fetch(target.url, init)
      const contentLength = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(contentLength) && contentLength > limit) {
        return { status: response.status, body: '', tooLarge: true }
      }
      const body = await response.text()
      return {
        status: response.status,
        body,
        tooLarge: new TextEncoder().encode(body).byteLength > limit,
      }
    } finally {
      clearTimeout(timeout)
    }
  }, { target: request, limit: maxBytes }) as InPageResult
}

function statusError(
  endpoint: StatSharkEndpoint,
  result: InPageResult | CapturedJson,
): StatSharkClientError {
  const suffix = result.status === 404
    ? 'игрок или данные не найдены'
    : result.status === 406
      ? 'нужна новая проверка Turnstile'
      : result.status === 429
        ? 'лимит запросов исчерпан'
        : `HTTP ${result.status}`
  return new StatSharkClientError(`StatShark ${endpoint}: ${suffix}`, result.status, endpoint)
}

async function settlePending(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

async function fetchOnPage(
  page: Page,
  playerId: string,
  requests: Record<StatSharkEndpoint, EndpointRequest>,
  timeoutMs: number,
  maxBytes: number,
): Promise<StatSharkBundle> {
  const captured = new Map<StatSharkEndpoint, CapturedJson>()
  const captureErrors = new Map<StatSharkEndpoint, unknown>()
  const pending = new Set<Promise<void>>()
  const routeHandler = (route: Route): void => {
    // Отказ abort (страницу уже закрыли) не должен стать необработанным
    // rejection: он запускает аварийный shutdown всего бота (src/index.ts).
    void route.abort('blockedbyclient').catch(() => undefined)
  }
  const responseHandler = (response: PlaywrightResponse): void => {
    const endpoint = endpointForResponse(response, playerId)
    if (endpoint === null || captured.has(endpoint)) return
    let task!: Promise<void>
    task = captureResponse(response, endpoint, maxBytes)
      .then((result) => {
        if (result.status >= 200 && result.status < 300) captured.set(endpoint, result)
        else captureErrors.set(endpoint, statusError(endpoint, result))
      })
      .catch((error: unknown) => {
        captureErrors.set(endpoint, error)
      })
      .finally(() => pending.delete(task))
    pending.add(task)
  }

  await page.route('**/analytics/**', routeHandler)
  page.on('response', responseHandler)
  try {
    const pageUrl = `${STATSHARK_ORIGIN}/player/${playerId}`
    const deadline = Date.now() + timeoutMs
    let turnstileRetried = false
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
      const revealAt = Math.min(
        deadline,
        Date.now() + Math.min(MANUAL_WINDOW_DELAY_MS, Math.floor(timeoutMs / 3)),
      )
      const tokenReady = await waitForToken(page, deadline, revealAt)
      if (!tokenReady) {
        throw new StatSharkClientError(
          `StatShark: Turnstile не пройден за ${timeoutMs} мс`,
          406,
          'profile',
        )
      }

      const graceDeadline = Math.min(deadline, Date.now() + AUTOMATIC_RESPONSE_GRACE_MS)
      while (Date.now() < graceDeadline && captured.size < 4) {
        await page.waitForTimeout(TOKEN_POLL_MS).catch(() => undefined)
      }
      await settlePending(pending)

      let retryTurnstile = false
      // Fallback-запросы используют один Turnstile token последовательно:
      // первый 406 обязан остановить batch, очистить token и перезапустить страницу.
      for (const endpoint of Object.keys(requests) as StatSharkEndpoint[]) {
        if (captured.has(endpoint)) continue
        let result: InPageResult
        try {
          result = await requestInPage(page, requests[endpoint], maxBytes)
        } catch (error) {
          throw new StatSharkClientError(
            `StatShark ${endpoint}: запрос в странице не выполнен`,
            null,
            endpoint,
            { cause: error },
          )
        }
        if (result.tooLarge) {
          throw new StatSharkClientError(
            `StatShark ${endpoint}: ответ превышает лимит ${maxBytes} байт`,
            result.status,
            endpoint,
          )
        }
        if (result.status === 406 && !turnstileRetried) {
          retryTurnstile = true
          break
        }
        if (result.status < 200 || result.status >= 300) throw statusError(endpoint, result)
        captured.set(endpoint, {
          status: result.status,
          value: parseJsonBody(result.body, endpoint),
        })
      }

      if (!retryTurnstile) break
      turnstileRetried = true
      await clearStoredToken(page)
      if (attempt === 2 || Date.now() >= deadline) {
        throw new StatSharkClientError(
          'StatShark: сервер отклонил повторную проверку Turnstile',
          406,
          'profile',
        )
      }
    }
    await settlePending(pending)

    for (const endpoint of Object.keys(requests) as StatSharkEndpoint[]) {
      if (captured.has(endpoint)) continue
      const cause = captureErrors.get(endpoint)
      if (cause instanceof StatSharkClientError) throw cause
      throw new StatSharkClientError(
        `StatShark ${endpoint}: ответ не получен`,
        null,
        endpoint,
        cause === undefined ? undefined : { cause },
      )
    }

    return {
      schemaVersion: 1,
      playerId,
      profile: captured.get('profile')!.value,
      vehicleHistory: captured.get('vehicleHistory')!.value,
      leaderboardHistory: captured.get('leaderboardHistory')!.value,
      vehicleInfo: captured.get('vehicleInfo')!.value,
    }
  } finally {
    page.off('response', responseHandler)
    await page.unroute('**/analytics/**', routeHandler).catch(() => undefined)
  }
}

/**
 * Получает ровно те публичные документы, которые использует страница игрока
 * StatShark. Turnstile-токен остаётся внутри origin/localStorage и никогда не
 * возвращается в Node, БД или логи.
 */
export async function fetchStatSharkBundle(
  rawPlayerId: string,
  options: StatSharkClientOptions = {},
): Promise<StatSharkBundle> {
  const playerId = playerIdValue(rawPlayerId)
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    config.wtBrowserTimeoutMs,
    'StatShark timeoutMs',
  )
  const maxBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    'StatShark maxResponseBytes',
  )
  const requests = endpointRequests(playerId, options.update ?? true)
  const withPage = options.withPage ?? withEdgeBrowserPage
  return withPage((page) => fetchOnPage(page, playerId, requests, timeoutMs, maxBytes))
}
