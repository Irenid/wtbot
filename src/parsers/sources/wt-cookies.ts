import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../../atomic-file.js'
import { config } from '../../config.js'
import { withRecoverableFileLock } from '../../recoverable-file-lock.js'
import { sessionToken } from './wt-sign-in.js'

/**
 * The WT cookie jar, written atomically under an inter-process lock. Responses
 * rotate identity_sid, but nothing extends the sign-in itself (14 days,
 * wt-sign-in.ts): wt-request.ts renews it.
 */

const JAR_FILE = './data/wt-cookies.json'
const LOCK_FILE = `${JAR_FILE}.lock`
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 60_000
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_USER_AGENT_LENGTH = 512

interface JarFileV2 {
  version: 2
  /** The seed's hash notices a new WT_COOKIE without a second copy of the secret on disk. */
  seedHash: string
  cookies: Record<string, string>
  /**
   * User-Agent of the browser that issued the session: a direct request with
   * its cookies presents itself as that browser. Optional, like signedInAt:
   * older bot versions do not read either.
   */
  userAgent?: string
  /** Unix ms of the sign-in behind identity_token; absent — unknown (a WT_COOKIE seed). */
  signedInAt?: number
}

interface LegacyJarFile {
  seed: string
  cookies: Record<string, string>
}

interface JarState {
  map: Map<string, string>
  userAgent: string | null
  signedInAt: number | null
  needsWrite: boolean
}

/** Cloudflare cookies are bound to the browser and its TLS fingerprint: a direct request gains nothing from them. */
export function isCloudflareCookie(name: string): boolean {
  return name.startsWith('cf_') || name.startsWith('__cf')
}

/** WT sign-in cookies (identity_*): the session the Replay API needs. */
export function isWtAuthCookie(name: string): boolean {
  return name.startsWith('identity_')
}

let savedLogged = false
let queueTail: Promise<void> = Promise.resolve()

function parseCookiePairs(header: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    const name = part.slice(0, equals).trim()
    const value = part.slice(equals + 1).trim()
    if (isCookiePair(name, value)) map.set(name, value)
  }
  return map
}

function cookieList(map: ReadonlyMap<string, string>): WtCookieValue[] {
  return [...map].map(([name, value]) => ({ name, value }))
}

function seedHash(): string {
  return createHash('sha256').update(config.wtCookie).digest('hex')
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task, task)
  queueTail = result.then(() => undefined, () => undefined)
  return result
}

async function currentJarUnlocked(): Promise<JarState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(JAR_FILE, 'utf8'))
    if (isV2(parsed) && parsed.seedHash === seedHash()) {
      return {
        map: new Map(Object.entries(parsed.cookies)),
        userAgent: validUserAgent(parsed.userAgent),
        signedInAt: validSignedInAt(parsed.signedInAt),
        needsWrite: false,
      }
    }
    if (isLegacy(parsed) && parsed.seed === config.wtCookie) {
      return { map: new Map(Object.entries(parsed.cookies)), userAgent: null, signedInAt: null, needsWrite: true }
    }
    console.log('[wt-cookies] .env has a new WT_COOKIE: starting the session from it')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  // The browser that issued the previous session has nothing to do with the new WT_COOKIE.
  return { map: parseCookiePairs(config.wtCookie), userAgent: null, signedInAt: null, needsWrite: true }
}

function validUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const userAgent = value.trim()
  return userAgent !== '' && userAgent.length <= MAX_USER_AGENT_LENGTH && !/[\0-\x1f\x7f]/.test(userAgent)
    ? userAgent
    : null
}

function validSignedInAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isV2(value: unknown): value is JarFileV2 {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<JarFileV2>
  return candidate.version === 2 && typeof candidate.seedHash === 'string' && isCookieRecord(candidate.cookies)
}

function isLegacy(value: unknown): value is LegacyJarFile {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<LegacyJarFile>
  return typeof candidate.seed === 'string' && isCookieRecord(candidate.cookies)
}

function isCookieRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([name, cookie]) => typeof cookie === 'string' && isCookiePair(name, cookie))
  )
}

function isCookiePair(name: string, value: string): boolean {
  return COOKIE_NAME.test(name) && !/[\0\r\n;]/.test(value)
}

async function persistJarUnlocked(jar: Pick<JarState, 'map' | 'userAgent' | 'signedInAt'>): Promise<void> {
  const payload: JarFileV2 = {
    version: 2,
    seedHash: seedHash(),
    cookies: Object.fromEntries(jar.map),
    ...(jar.userAgent === null ? {} : { userAgent: jar.userAgent }),
    ...(jar.signedInAt === null ? {} : { signedInAt: jar.signedInAt }),
  }
  await writeFileAtomic(JAR_FILE, JSON.stringify(payload, null, 2), {
    fileMode: 0o600,
    directoryMode: 0o700,
    sync: true,
  })
}

/** A token changed by anything but replaceWtSession is a sign-in of unknown time. */
function nextSignedInAt(current: JarState, next: ReadonlyMap<string, string>): number | null {
  return sessionToken(cookieList(next)) === sessionToken(cookieList(current.map)) ? current.signedInAt : null
}

async function withFileLock<T>(task: () => Promise<T>): Promise<T> {
  return withRecoverableFileLock({
    lockFile: LOCK_FILE,
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    onRecovered: (_lockFile, owner) => {
      console.warn(`[wt-cookies] removed a stale lock${owner === null ? '' : ` of process ${owner.pid}`}`)
    },
  }, task)
}

function readJar(): Promise<JarState> {
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      if (current.needsWrite) await persistJarUnlocked(current)
      return current
    }),
  )
}

/** Writes a changed map, keeping the jar's User-Agent. */
async function saveChanged(current: JarState, next: Map<string, string>, changed: boolean): Promise<void> {
  if (!changed) return
  await persistJarUnlocked({ map: next, userAgent: current.userAgent, signedInAt: nextSignedInAt(current, next) })
  if (!savedLogged) {
    savedLogged = true
    console.log('[wt-cookies] Cookies from warthunder.com are saved to data/wt-cookies.json')
  }
}

export async function cookieHeader(): Promise<string> {
  const { map } = await readJar()
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Cookies and User-Agent for a direct request with the session. Cloudflare
 * cookies stay out: the browser got them, and Node's fingerprint differs.
 */
export async function directSessionHeaders(): Promise<{ cookie: string; userAgent: string | null }> {
  const { map, userAgent } = await readJar()
  const cookie = [...map]
    .filter(([name]) => !isCloudflareCookie(name))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return { cookie, userAgent }
}

/** Remembers the User-Agent of the browser that runs the jar's session. */
export function rememberCookieUserAgent(value: string): Promise<void> {
  const userAgent = validUserAgent(value)
  if (userAgent === null) return Promise.resolve()
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      if (current.userAgent === userAgent && !current.needsWrite) return
      await persistJarUnlocked({ map: current.map, userAgent, signedInAt: current.signedInAt })
    }),
  )
}

/** Unix ms of the jar's sign-in; null — unknown (a WT_COOKIE seed, a session taken from the browser). */
export async function wtSessionSignedInAt(): Promise<number | null> {
  return (await readJar()).signedInAt
}

export interface WtCookieValue {
  name: string
  value: string
}

/** The current cookies in the form a browser context takes. */
export async function cookieValues(): Promise<WtCookieValue[]> {
  const header = await cookieHeader()
  return [...parseCookiePairs(header)].map(([name, value]) => ({ name, value }))
}

/**
 * Takes cookies from the browser context that carries the jar's session
 * (wt-browser.ts). The Node jar is the one managed store of the sign-in
 * cookies. A set of another sign-in (the browser kept an older copy while
 * the jar was renewed) leaves the jar's identity_* alone.
 */
export function absorbCookieValues(values: readonly WtCookieValue[]): Promise<void> {
  if (values.length === 0) return Promise.resolve()
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      const ownSession = sessionToken(values) === sessionToken(cookieList(current.map))
      const next = new Map(current.map)
      let changed = current.needsWrite
      for (const cookie of values) {
        if (!isCookiePair(cookie.name, cookie.value)) continue
        if (!ownSession && isWtAuthCookie(cookie.name)) continue
        if (next.get(cookie.name) !== cookie.value) {
          next.set(cookie.name, cookie.value)
          changed = true
        }
      }
      await saveChanged(current, next, changed)
    }),
  )
}

/**
 * Saves the Set-Cookie headers of a direct response. `sentCookie` is the
 * Cookie header the request carried: a response to another sign-in than the
 * jar's (a renewal replaced it while the request was in flight) would
 * otherwise put the old session's identity_sid next to the new token.
 */
export function absorbSetCookies(response: Response, sentCookie: string): Promise<void> {
  const headers = [...response.headers.getSetCookie()]
  if (headers.length === 0) return Promise.resolve()
  const sentToken = sessionToken(cookieList(parseCookiePairs(sentCookie)))
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      const ownSession = sentToken === sessionToken(cookieList(current.map))
      const { next, changed } = applySetCookies(current.map, headers, ownSession)
      await saveChanged(current, next, changed || current.needsWrite)
    }),
  )
}

/** Applies Set-Cookie headers to a jar map; without `ownSession` identity_* stay as they are. */
export function applySetCookies(
  map: ReadonlyMap<string, string>,
  headers: readonly string[],
  ownSession: boolean,
  now = Date.now(),
): { next: Map<string, string>; changed: boolean } {
  const next = new Map(map)
  let changed = false
  for (const header of headers) {
    const [pair = '', ...attrs] = header.split(';')
    const equals = pair.indexOf('=')
    if (equals < 0) continue
    const name = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    if (!isCookiePair(name, value)) continue
    if (!ownSession && isWtAuthCookie(name)) continue
    if (isDeletion(attrs, now)) {
      if (next.delete(name)) changed = true
    } else if (next.get(name) !== value) {
      next.set(name, value)
      changed = true
    }
  }
  return { next, changed }
}

/** The jar's cookies with every identity_* replaced by another sign-in's. */
export function withSession(
  map: ReadonlyMap<string, string>,
  values: readonly WtCookieValue[],
): Map<string, string> {
  const next = new Map([...map].filter(([name]) => !isWtAuthCookie(name)))
  for (const { name, value } of values) {
    if (isWtAuthCookie(name) && isCookiePair(name, value)) next.set(name, value)
  }
  return next
}

/**
 * Puts another sign-in into the jar (a Gaijin renewal, the browser's own
 * session); other cookies stay. `userAgent` — the browser that got it;
 * `signedInAt` — Unix ms of the sign-in, null if unknown.
 */
export function replaceWtSession(
  values: readonly WtCookieValue[],
  userAgent: string | null,
  signedInAt: number | null,
): Promise<void> {
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      await persistJarUnlocked({
        map: withSession(current.map, values),
        userAgent: validUserAgent(userAgent) ?? current.userAgent,
        signedInAt,
      })
    }),
  )
}

function isDeletion(attrs: string[], now: number): boolean {
  for (const raw of attrs) {
    const equals = raw.indexOf('=')
    if (equals < 0) continue
    const key = raw.slice(0, equals).trim().toLowerCase()
    const value = raw.slice(equals + 1).trim()
    if (key === 'max-age' && Number.isFinite(Number(value)) && Number(value) <= 0) return true
    if (key === 'expires') {
      const date = Date.parse(value)
      if (!Number.isNaN(date) && date < now) return true
    }
  }
  return false
}
