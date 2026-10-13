/**
 * Rules for renewing the warthunder.com sign-in, kept apart from
 * wt-browser.ts so they are testable without a browser.
 *
 * Measured 2026-10-12/13:
 * - a warthunder.com sign-in lives 14 days and use does not extend it: the
 *   identity_* cookies carry a 14-day Max-Age, and the session signed in on
 *   2026-09-28 20:52 UTC stopped working on 2026-10-12 20:46 UTC;
 * - identity_token stays the same for the whole sign-in (the jar's equalled
 *   the WT_COOKIE seed's after 14 days), identity_sid rotates in responses,
 *   and anonymous visitors get identity_sid alone;
 * - the site signs in again through Gaijin's SSO: its page script
 *   (login.gaijin.net/gsea/gsea.js) asks `api/gsea/fetch` with the page's
 *   queryContext as `q`, gets the Gaijin session's refresh token `rt` and
 *   opens /extLogin?refresh_token=<rt>. The bot's Chromium blocks that
 *   cross-site request's cookies as third-party, so the bot sends it itself
 *   from the browser context (gseaFetchUrl); the reLogin and sso/login pages
 *   are no way round: signed in, the first asks for the password again ("your
 *   session has expired") and the second for a click on the account;
 * - the same script (login.gaijin.net/gsea/gsea.js) compares that answer with
 *   the account the page was rendered for, and on "no account" the page posts
 *   /<lang>/logout (its onLogout): a signed-in page in the bot's browser may
 *   end its own session, so the browser never sends it (isSiteLogout).
 */

export const GAIJIN_ORIGIN = 'https://login.gaijin.net'
const SITE_ORIGIN = 'https://warthunder.com'

/**
 * `GSEA_init.queryContext` of https://warthunder.com/en/ on 2026-10-13, the
 * same for every visitor: used when the page cannot be read.
 */
export const GAIJIN_RELOGIN_URL = `${GAIJIN_ORIGIN}/en/sso/reLogin/?return_url=aHR0cHM6Ly93YXJ0aHVuZGVyLmNvbS9lbi8%3D`
  + '&crc=d4183ab74f380c8d70377439c8770948&public_key=IwdDDrPgUfXo3CYkaiwR&domain=warthunder.com'
  + '&base_return_url=1&refresh_token=1'

const QUERY_CONTEXT = /\bqueryContext:\s*'([^'\s]{1,2048})'/
/** GSEA_init's account id: empty on a page rendered for an anonymous visitor. */
const PAGE_UID = /\buid:\s*'([^'\s]{0,64})'/

/** gsea.js's request ids are UUIDs; its tokens are URL-safe. */
const REFRESH_TOKEN = /^[\w.~+/=-]{8,4096}$/
const GSEA_ANSWER = /^window\.postMessage\((\{.*\})\s*,\s*"[^"]*"\);?$/s

export type GseaSession = { signedIn: true, refreshToken: string } | { signedIn: false }

interface CookieValue {
  name: string
  value: string
}

/** warthunder.com's sign-out address (any language prefix). */
export function isSiteLogout(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  return (host === 'warthunder.com' || host.endsWith('.warthunder.com')) && /\/logout\/?$/i.test(url.pathname)
}

/**
 * gsea.js's session request (`fetch`, apiVersion 1) as the site's page sends
 * it: `q` — the page's queryContext in gsea.js's base64 (`+/=` → `._-`); with
 * it the answer carries the refresh token.
 */
export function gseaFetchUrl(queryContext: string, requestId: string): string {
  const q = Buffer.from(queryContext, 'latin1').toString('base64')
    .replaceAll('+', '.').replaceAll('/', '_').replaceAll('=', '-')
  return `${GAIJIN_ORIGIN}/api/gsea/fetch?${new URLSearchParams({ q, $reqID: requestId, origin: SITE_ORIGIN })}`
}

/**
 * The answer of gseaFetchUrl, a `window.postMessage({...}, origin)` script:
 * a session with its refresh token, no session, or null for anything else
 * (an unknown format must not read as "signed out").
 */
export function gseaSessionFromScript(body: string): GseaSession | null {
  const json = GSEA_ANSWER.exec(body.trim())?.[1]
  if (json === undefined) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || (data as { gsea?: unknown }).gsea !== true) return null
  const payload = (data as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return null
  const { status, uid, rt } = payload as { status?: unknown, uid?: unknown, rt?: unknown }
  if (status !== 'ok' || typeof uid !== 'string' || uid === '') return { signedIn: false }
  return typeof rt === 'string' && REFRESH_TOKEN.test(rt) ? { signedIn: true, refreshToken: rt } : null
}

/** The site's own sign-in step after GSEA (GSEA_init's 'change' handler). */
export function extLoginUrl(refreshToken: string): string {
  return `${SITE_ORIGIN}/extLogin?refresh_token=${encodeURIComponent(refreshToken)}`
}

/** The reLogin address in a warthunder.com page, or null unless it is a Gaijin SSO page. */
export function reLoginUrlFromHtml(html: string): string | null {
  const raw = QUERY_CONTEXT.exec(html)?.[1]
  if (raw === undefined) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return url.origin === GAIJIN_ORIGIN && url.pathname.includes('/sso/') ? url.href : null
}

/**
 * The account id a warthunder.com page was rendered for: '' — anonymous,
 * null — the page has no GSEA_init. The site's own script signs in again
 * whenever the SSO's account differs from this one, so a page rendered for a
 * signed-in visitor must name its account (inferred from that script on
 * 2026-10-13, not yet seen signed in).
 */
export function pageAccountId(html: string): string | null {
  return PAGE_UID.exec(html)?.[1] ?? null
}

/** identity_token of a cookie set, or null: one value per sign-in, so it tells sessions apart. */
export function sessionToken(cookies: readonly CookieValue[]): string | null {
  const value = cookies.find(({ name }) => name === 'identity_token')?.value
  return value === undefined || value === '' ? null : value
}

/** A signed-in set names the account (identity_id) and carries its token. */
export function isSignedInSession(cookies: readonly CookieValue[]): boolean {
  return sessionToken(cookies) !== null && cookies.some(({ name, value }) => name === 'identity_id' && value !== '')
}
