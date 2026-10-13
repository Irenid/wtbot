import { config } from '../../config.js'
import { readResponseText } from '../../http-response.js'
import { absorbSetCookies, directSessionHeaders, wtSessionSignedInAt } from './wt-cookies.js'
import {
  adoptBrowserSession,
  fetchWtResponseInBrowser,
  refreshWtClearance,
  renewWtSessionThroughGaijin,
  setWtBrowserSessionProbe,
  warmupWtBrowser,
  wtBrowserUserAgent,
  type WtSignInRenewal,
} from './wt-browser.js'
import { GAIJIN_ORIGIN, GAIJIN_RELOGIN_URL, reLoginUrlFromHtml } from './wt-sign-in.js'

/** Shared parameters of warthunder.com profile and Replay API requests. */

export const REQUEST_INTERVAL_MS = 1_500
export const RATE_LIMIT_RETRIES = 2
export const DEFAULT_RATE_LIMIT_DELAY_MS = 30_000
/** Cloudflare matches the User-Agent against the browser session the cookies came from. */
export const WT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
const MAX_RETRY_AFTER_MS = 10 * 60_000
const WT_ORIGIN = 'https://warthunder.com'
/**
 * Cloudflare checks single addresses, not all of warthunder.com: in October
 * 2026 the player profile and player search answered a direct request with
 * 403 `cf-mitigated: challenge`, while the Replay API, leaderboards and
 * squadron pages answered normally. Node cannot pass the check even with a
 * fresh cf_clearance: the clearance is bound to the browser's TLS
 * fingerprint. So the transport is chosen per route: a direct request first,
 * the browser only where the direct one fails. A route's mode is re-probed
 * now and then, not before every request.
 */
const DIRECT_REPROBE_MS = 6 * 60 * 60_000
/**
 * Routes that need a signed-in WT session (identity_*). The shared jar owns
 * it: a direct request carries its cookies, and the browser gets it only
 * while such a route goes through it (prepareBrowserSession in wt-browser.ts).
 */
const SESSION_ROUTES: ReadonlySet<string> = new Set(['/en/api/replay'])
/**
 * The scheduled tick: renews the sign-in when due and, while a route goes
 * through the browser, keeps its Cloudflare check fresh (and the session, if
 * the browser carries it).
 */
const COOKIE_REFRESH_INTERVAL_MS = 30 * 60_000
const COOKIE_REFRESH_RETRY_MS = 5 * 60_000
/** The server's limit of one sign-in, which use does not extend (wt-sign-in.ts). */
export const WT_SESSION_LIFETIME_MS = 14 * 24 * 60 * 60_000
/** A sign-in is renewed a day after it happened: if renewals fail, 13 days of warnings remain. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60_000
/** Right after a successful renewal another one cannot help a refused session. */
const SESSION_RENEW_MIN_INTERVAL_MS = 30 * 60_000
/** A request in flight during a renewal carried the replaced session: its retry needs no new renewal. */
const SESSION_RENEW_SETTLE_MS = 2 * 60_000
const SESSION_RENEW_RETRY_MS = 30 * 60_000
const SESSION_WARNING_INTERVAL_MS = 6 * 60 * 60_000
/** The reLogin address is the same for every visitor; the page is reread once a day. */
const RELOGIN_URL_TTL_MS = 24 * 60 * 60_000
const HOME_PAGE_URL = `${WT_ORIGIN}/en/`
const HOME_PAGE_MAX_BYTES = 2 * 1024 * 1024

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

/** External dependencies of the transport; tests replace the queue, the browser and the jar. */
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
  /** `sentCookie` — the Cookie header the request carried. */
  absorbSessionCookies: (response: Response, sentCookie: string) => Promise<void>
  now: () => number
  /** WT_COOKIE is set: only then is a session worth renewing. */
  sessionConfigured: () => boolean
  /** Unix ms of the jar's sign-in, null if unknown. */
  signedInAt: () => Promise<number | null>
  renewSignIn: (reason: string, prepareVisit: () => Promise<string>) => Promise<WtSignInRenewal>
  adoptBrowserSession: () => Promise<boolean>
  refreshClearance: (reason: string, force: boolean, carrier: boolean) => Promise<boolean>
  /** The reLogin address in warthunder.com's page, null if the page has none. */
  fetchReLoginUrl: () => Promise<string | null>
}

/** The WT sign-in for /api/stats; times in Unix seconds. */
export interface WtSessionStatus {
  /** The jar's sign-in as last read; null — unknown (a WT_COOKIE seed). */
  signedInAt: number | null
  /** When that sign-in stops working (WT_SESSION_LIFETIME_MS). */
  expiresAt: number | null
  lastRenewal: WtSignInRenewal | null
  lastRenewalAt: number | null
}

let nextRequestAt = 0
let requestTail: Promise<void> = Promise.resolve()
const routeTransports = new Map<string, RouteTransport>()
let cookieRefreshActive = false
let cookieRefreshTimer: NodeJS.Timeout | null = null
let sessionRefreshTail: Promise<boolean> | null = null
let nextSessionRefreshAt = 0
let renewalTail: Promise<WtSignInRenewal | 'skipped'> | null = null
let lastRenewedAt = Number.NEGATIVE_INFINITY
let nextRenewalAt = 0
let nextSessionWarningAt = 0
let reLoginUrl: { url: string; at: number } | null = null
let sessionStatus: WtSessionStatus = emptySessionStatus()

function emptySessionStatus(): WtSessionStatus {
  return { signedInAt: null, expiresAt: null, lastRenewal: null, lastRenewalAt: null }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reserves the next slot. The queue serves more than one source: the
 * scheduler starts sources together, and a plain timestamp would let two
 * requests through at the same moment.
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

/** Delays the next slot after a 429, keeping the shared spacing. */
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
  try {
    await renewWtSessionIfDue()
  } catch (error) {
    console.warn(`[wt-cookies] The scheduled sign-in check failed: ${errorMessage(error)}`)
  }
  if (!cookieRefreshActive) return
  // While no route goes through the browser, its Cloudflare check is not worth
  // keeping: the browser starts with the first route that needs it.
  if (![...routeTransports.values()].some((route) => route.mode === 'browser')) {
    scheduleCookieRefresh(COOKIE_REFRESH_INTERVAL_MS)
    return
  }
  let refreshed = false
  try {
    // The scheduled refresh takes the parsers' global queue: a separate timer
    // must not bypass warthunder.com's request spacing.
    await waitForRequestSlot()
    if (!cookieRefreshActive) return
    refreshed = await refreshWtClearance('scheduled cookie refresh', false)
  } catch (error) {
    console.warn(`[wt-cookies] The scheduled refresh failed: ${errorMessage(error)}`)
  }
  if (cookieRefreshActive) {
    scheduleCookieRefresh(refreshed ? COOKIE_REFRESH_INTERVAL_MS : COOKIE_REFRESH_RETRY_MS)
  }
}

function rememberSignedInAt(signedInAt: number | null): void {
  sessionStatus.signedInAt = signedInAt === null ? null : Math.floor(signedInAt / 1_000)
  sessionStatus.expiresAt = signedInAt === null ? null : Math.floor((signedInAt + WT_SESSION_LIFETIME_MS) / 1_000)
}

async function refreshSessionStatus(): Promise<number | null> {
  const signedInAt = await transportDeps.signedInAt()
  rememberSignedInAt(signedInAt)
  return signedInAt
}

function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Names what to do and when the current sign-in ends; at most every SESSION_WARNING_INTERVAL_MS. */
async function warnSessionNotRenewed(result: Exclude<WtSignInRenewal, 'renewed'>): Promise<void> {
  const now = transportDeps.now()
  if (now < nextSessionWarningAt) return
  nextSessionWarningAt = now + SESSION_WARNING_INTERVAL_MS
  const signedInAt = await transportDeps.signedInAt().catch(() => null)
  const current = signedInAt === null
    ? 'the current sign-in is of unknown age'
    : `the sign-in of ${utcMinute(signedInAt)} works until about ${utcMinute(signedInAt + WT_SESSION_LIFETIME_MS)}`
  console.warn(
    result === 'signed-out'
      ? `[wt-cookies] The WT session cannot renew itself: sign in once at ${GAIJIN_ORIGIN} in the bot's browser (VNC, README); ${current}`
      : `[wt-cookies] The WT session renewal failed, next try in ${SESSION_RENEW_RETRY_MS / 60_000} min; ${current}`,
  )
}

/**
 * One Gaijin sign-in at a time, shared by the schedule and refreshWtSession.
 * After a success the next waits SESSION_RENEW_MIN_INTERVAL_MS, after a
 * failure SESSION_RENEW_RETRY_MS; "signed-out" costs no request while
 * nothing changes (renewWtSessionThroughGaijin), so it waits for nothing.
 */
function renewSession(reason: string): Promise<WtSignInRenewal | 'skipped'> {
  if (renewalTail !== null) return renewalTail
  const now = transportDeps.now()
  if (now - lastRenewedAt < SESSION_RENEW_MIN_INTERVAL_MS || now < nextRenewalAt) return Promise.resolve('skipped')
  const run = (async (): Promise<WtSignInRenewal> => {
    const result = await transportDeps.renewSignIn(reason, prepareSignInVisit).catch((error: unknown) => {
      console.warn(`[wt-cookies] The Gaijin sign-in failed: ${errorMessage(error)}`)
      return 'failed' as const
    })
    const at = transportDeps.now()
    sessionStatus.lastRenewal = result
    sessionStatus.lastRenewalAt = Math.floor(at / 1_000)
    if (result === 'renewed') {
      lastRenewedAt = at
      nextSessionWarningAt = 0
      await refreshSessionStatus().catch(() => null)
    } else {
      if (result === 'failed') nextRenewalAt = at + SESSION_RENEW_RETRY_MS
      await warnSessionNotRenewed(result)
    }
    return result
  })().finally(() => {
    renewalTail = null
  })
  renewalTail = run
  return run
}

/** Reserves a request slot for the sign-in visit (it ends on warthunder.com) and returns the reLogin address. */
async function prepareSignInVisit(): Promise<string> {
  const url = await gaijinReLoginUrl()
  await transportDeps.waitSlot()
  return url
}

async function gaijinReLoginUrl(): Promise<string> {
  const now = transportDeps.now()
  if (reLoginUrl !== null && now - reLoginUrl.at < RELOGIN_URL_TTL_MS) return reLoginUrl.url
  const found = await transportDeps.fetchReLoginUrl().catch((error: unknown) => {
    console.warn(`[wt-cookies] Could not read the reLogin address: ${errorMessage(error)}`)
    return undefined
  })
  if (found === null) console.warn('[wt-cookies] The warthunder.com page has no reLogin address: using the built-in one')
  reLoginUrl = { url: found ?? GAIJIN_RELOGIN_URL, at: now }
  return reLoginUrl.url
}

async function fetchReLoginUrl(): Promise<string | null> {
  const label = 'warthunder.com home page'
  const response = await fetchWtResponse(HOME_PAGE_URL, { headers: { accept: 'text/html' } }, label, HOME_PAGE_MAX_BYTES)
  return reLoginUrlFromHtml(await readResponseText(response, HOME_PAGE_MAX_BYTES, label))
}

/**
 * Renews the sign-in SESSION_RENEW_AFTER_MS after it happened, long before
 * the server's limit (WT_SESSION_LIFETIME_MS); an unknown sign-in time (a
 * WT_COOKIE seed, a session taken from the browser) counts as due.
 */
export async function renewWtSessionIfDue(): Promise<WtSignInRenewal | 'skipped'> {
  if (!transportDeps.browserEnabled() || !transportDeps.sessionConfigured()) return 'skipped'
  const signedInAt = await refreshSessionStatus()
  if (signedInAt !== null && transportDeps.now() - signedInAt < SESSION_RENEW_AFTER_MS) return 'skipped'
  return renewSession('scheduled renewal')
}

/**
 * Restores the session after an application-level sign of its loss (the
 * Replay API answers HTTP 200 with an empty list): a new Gaijin sign-in, the
 * browser's own session, a refresh through the browser carrying the session,
 * or the session route moved to the browser. Parallel consumers share one
 * attempt, and repeated failures do not run the browser every 20 seconds.
 */
async function refreshWtSession(reason: string): Promise<boolean> {
  if (!transportDeps.browserEnabled()) return false
  if (sessionRefreshTail !== null) return sessionRefreshTail

  const now = transportDeps.now()
  // A renewal replaced the session while the request was in flight: retry with the new one.
  if (now - lastRenewedAt < SESSION_RENEW_SETTLE_MS) return true
  if (now < nextSessionRefreshAt) return false
  nextSessionRefreshAt = now + COOKIE_REFRESH_RETRY_MS

  const refresh = (async () => {
    // Only a new sign-in brings back a session the server has dropped (its 14-day limit).
    if ((await renewSession(reason)) === 'renewed') return true
    // The browser's own sign-in, different from the jar's (a VNC sign-in at warthunder.com).
    if (await transportDeps.adoptBrowserSession()) {
      console.warn(`[wt-cookies] ${reason}: taking the browser's own session`)
      return true
    }
    if (sessionCarriedByBrowser()) {
      console.warn(`[wt-cookies] ${reason}: refreshing the session through the browser`)
      await transportDeps.waitSlot()
      return transportDeps.refreshClearance(reason, true, true)
    }
    // The direct path carried the session and the server refused it: the same
    // session may pass through the browser. The route returns to the direct
    // path after DIRECT_REPROBE_MS.
    for (const route of SESSION_ROUTES) {
      markTransport(route, 'browser', 'the server refused the session without the browser')
    }
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
 * Repeats an application request exactly once when its result means the WT
 * session is lost and refreshing it succeeded.
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
 * Starts the scheduled tick (COOKIE_REFRESH_INTERVAL_MS): the WT sign-in is
 * renewed once a day, and while a route goes through the browser its
 * Cloudflare check stays fresh (with the session, while the browser carries
 * it).
 */
export function startWtCookieRefresh(): void {
  if (!config.wtBrowserEnabled || cookieRefreshActive) return
  cookieRefreshActive = true
  scheduleCookieRefresh(COOKIE_REFRESH_INTERVAL_MS)
  refreshSessionStatus().catch((error: unknown) => {
    console.warn(`[wt-cookies] Could not read the sign-in time: ${errorMessage(error)}`)
  })
  console.log('[wt-cookies] Auto-refresh is on: every 30 minutes, the WT sign-in renewed once a day')
}

/** Allows no new scheduled requests and clears the pending timer. */
export function stopWtCookieRefresh(): void {
  cookieRefreshActive = false
  if (cookieRefreshTimer !== null) clearTimeout(cookieRefreshTimer)
  cookieRefreshTimer = null
}

/** The WT sign-in and its last renewal, for /api/stats. */
export function wtSessionStatus(): WtSessionStatus {
  return { ...sessionStatus }
}

/** Parses Retry-After as seconds or an HTTP date. */
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
  sessionConfigured: () => config.wtCookie.trim() !== '',
  signedInAt: wtSessionSignedInAt,
  renewSignIn: renewWtSessionThroughGaijin,
  adoptBrowserSession,
  refreshClearance: refreshWtClearance,
  fetchReLoginUrl,
}
let transportDeps = defaultTransportDeps

/** Resets route modes and the session state (test isolation); overrides replace the queue, the browser and the jar. */
export function resetWtTransportState(overrides: Partial<WtTransportDeps> = {}): void {
  routeTransports.clear()
  sessionRefreshTail = null
  nextSessionRefreshAt = 0
  renewalTail = null
  lastRenewedAt = Number.NEGATIVE_INFINITY
  nextRenewalAt = 0
  nextSessionWarningAt = 0
  reLoginUrl = null
  sessionStatus = emptySessionStatus()
  transportDeps = { ...defaultTransportDeps, ...overrides }
}

/**
 * A request's route is the first three path segments: /en/api/replay,
 * /en/community/userinfo, /en/community/getclansleaderboard.
 */
export function wtRouteOf(url: string | URL): string {
  const { pathname } = new URL(String(url), WT_ORIGIN)
  return `/${pathname.split('/').filter(Boolean).slice(0, 3).join('/')}`
}

/** The browser carries the WT session while a route that needs it goes through the browser. */
function sessionCarriedByBrowser(): boolean {
  if (!transportDeps.browserEnabled()) return false
  for (const route of SESSION_ROUTES) {
    if (routeTransports.get(route)?.mode === 'browser') return true
  }
  return false
}

setWtBrowserSessionProbe(sessionCarriedByBrowser)

/** warthunder.com route modes for /api/stats. */
export function wtTransportRoutes(): Record<string, TransportMode> {
  return Object.fromEntries(
    [...routeTransports]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([route, transport]) => [route, transport.mode]),
  )
}

/** The overall mode for /api/stats: mixed — some routes go through the browser. */
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
  // Every few hours the direct path gets a chance: the site may have lifted the check.
  routeTransports.set(route, { mode: 'unknown', checkedAt: transportDeps.now() })
  return false
}

function markTransport(route: string, mode: Exclude<TransportMode, 'unknown'>, reason = ''): void {
  if (routeTransports.get(route)?.mode !== mode) {
    console.log(
      mode === 'browser'
        ? `[wt-request] ${route}: ${reason || 'direct requests fail'}; the route goes through the browser`
        : `[wt-request] ${route}: direct requests pass without the browser`,
    )
  }
  routeTransports.set(route, { mode, checkedAt: transportDeps.now() })
}

/**
 * A direct request. Only routes that need the jar's session carry it: a
 * public response must not rotate the identity_sid the Replay API lives on.
 * `cookie` — the Cookie header sent.
 */
async function directFetch(
  url: string | URL,
  init: RequestInit,
  session: boolean,
): Promise<{ response: Response; cookie: string }> {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  delete headers['cookie']
  let userAgent = wtBrowserUserAgent()
  let cookie = ''
  if (session) {
    const jar = await transportDeps.sessionHeaders()
    cookie = jar.cookie
    if (cookie !== '') headers['cookie'] = cookie
    // The browser issued the session: a request with its cookies presents itself as that browser.
    userAgent ??= jar.userAgent
  }
  headers['user-agent'] = userAgent ?? headers['user-agent'] ?? WT_USER_AGENT
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) })
  return { response, cookie }
}

/**
 * Runs a WT request under the shared rate limit: directly first, through the
 * browser only for routes a direct request cannot pass. The browser path
 * passes the Cloudflare check itself and repeats the request.
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
    let sentCookie = ''
    try {
      if (viaBrowser) {
        response = await transportDeps.browserFetch(url, init, maxBytes, label, { session })
      } else {
        const direct = await directFetch(url, init, session)
        response = direct.response
        sentCookie = direct.cookie
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
      if (!viaBrowser && transportDeps.browserEnabled()) {
        // A network failure of a direct request is retried once through the
        // browser without moving the route: one timeout is no reason to hand
        // the route to the browser for hours.
        networkFallback = true
        continue
      }
      throw new WtRequestError(0, false, `${label}: network request failed (${detail})`)
    }
    if (!viaBrowser && session) await transportDeps.absorbSessionCookies(response, sentCookie)

    if (response.status === 429) {
      const delayMs = retryAfterMs(response)
      await response.body?.cancel().catch(() => undefined)
      deferRequestSlot(delayMs)
      if (rateAttempt < RATE_LIMIT_RETRIES) {
        rateAttempt += 1
        continue
      }
      throw new WtRequestError(429, false, `${label}: HTTP 429 after ${RATE_LIMIT_RETRIES + 1} attempts`)
    }

    if (response.status === 401 || response.status === 403) {
      const cloudflareChallenge = response.status === 403 && isCloudflareChallenge(response)
      await response.body?.cancel().catch(() => undefined)
      if (cloudflareChallenge && !viaBrowser && transportDeps.browserEnabled()) {
        markTransport(route, 'browser', 'Cloudflare asks for a check')
        continue
      }
      if (cloudflareChallenge) {
        // The browser path has already tried to pass the check.
        throw new WtRequestError(
          response.status,
          true,
          `${label}: HTTP 403, Cloudflare asks for a check that could not be passed`,
        )
      }
      throw new WtRequestError(
        response.status,
        false,
        `${label}: HTTP ${response.status}, the WT session expired or access is denied`,
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
 * Warms the browser up for manual smoke scripts. The bot does not call it at
 * startup: the browser starts with the first route that needs it.
 */
export async function warmupWtTransport(): Promise<void> {
  if (!config.wtBrowserEnabled) return
  await warmupWtBrowser()
}

export { refreshWtClearance }
