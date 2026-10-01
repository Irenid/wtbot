import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../../atomic-file.js'
import { config } from '../../config.js'
import { withRecoverableFileLock } from '../../recoverable-file-lock.js'

/** Асинхронный cookie jar со скользящей сессией и атомарной записью. */

const JAR_FILE = './data/wt-cookies.json'
const LOCK_FILE = `${JAR_FILE}.lock`
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 60_000
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_USER_AGENT_LENGTH = 512

interface JarFileV2 {
  version: 2
  /** Хэш seed позволяет заметить новую WT_COOKIE, не дублируя секрет на диске. */
  seedHash: string
  cookies: Record<string, string>
  /**
   * User-Agent браузера, который выдал сессию: прямой запрос с её cookies
   * представляется тем же браузером. Поле необязательное — прежние версии бота
   * его не читают.
   */
  userAgent?: string
}

interface LegacyJarFile {
  seed: string
  cookies: Record<string, string>
}

interface JarState {
  map: Map<string, string>
  userAgent: string | null
  needsWrite: boolean
}

/** Cookies Cloudflare привязаны к браузеру и его TLS-отпечатку: прямому запросу они не помогают. */
export function isCloudflareCookie(name: string): boolean {
  return name.startsWith('cf_') || name.startsWith('__cf')
}

/** Cookies авторизации WT (identity_*): сессия, которая нужна Replay API. */
export function isWtAuthCookie(name: string): boolean {
  return name.startsWith('identity_')
}

let refreshLogged = false
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

function seedHash(): string {
  return createHash('sha256').update(config.wtCookie).digest('hex')
}

/** Хэш текущей WT_COOKIE: браузерный профиль по нему понимает, что seed сменился. */
export function wtCookieSeedHash(): string {
  return seedHash()
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
        needsWrite: false,
      }
    }
    if (isLegacy(parsed) && parsed.seed === config.wtCookie) {
      return { map: new Map(Object.entries(parsed.cookies)), userAgent: null, needsWrite: true }
    }
    console.log('[wt-cookies] В .env новая WT_COOKIE — начинаю сессию с неё')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  // Браузер, выдавший прежнюю сессию, к новой WT_COOKIE отношения не имеет.
  return { map: parseCookiePairs(config.wtCookie), userAgent: null, needsWrite: true }
}

function validUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const userAgent = value.trim()
  return userAgent !== '' && userAgent.length <= MAX_USER_AGENT_LENGTH && !/[\0-\x1f\x7f]/.test(userAgent)
    ? userAgent
    : null
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

async function persistJarUnlocked(jar: Pick<JarState, 'map' | 'userAgent'>): Promise<void> {
  const payload: JarFileV2 = {
    version: 2,
    seedHash: seedHash(),
    cookies: Object.fromEntries(jar.map),
    ...(jar.userAgent === null ? {} : { userAgent: jar.userAgent }),
  }
  await writeFileAtomic(JAR_FILE, JSON.stringify(payload, null, 2), {
    fileMode: 0o600,
    directoryMode: 0o700,
    sync: true,
  })
}

async function withFileLock<T>(task: () => Promise<T>): Promise<T> {
  return withRecoverableFileLock({
    lockFile: LOCK_FILE,
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    onRecovered: (_lockFile, owner) => {
      console.warn(`[wt-cookies] удалён stale lock${owner === null ? '' : ` процесса ${owner.pid}`}`)
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

export async function cookieHeader(): Promise<string> {
  const { map } = await readJar()
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Cookies и User-Agent для прямого запроса с сессией. Cookies Cloudflare не
 * отправляются: они выданы браузеру и с отпечатком Node не совпадут.
 */
export async function directSessionHeaders(): Promise<{ cookie: string; userAgent: string | null }> {
  const { map, userAgent } = await readJar()
  const cookie = [...map]
    .filter(([name]) => !isCloudflareCookie(name))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return { cookie, userAgent }
}

/** Запоминает User-Agent браузера, который ведёт сессию jar. */
export function rememberCookieUserAgent(value: string): Promise<void> {
  const userAgent = validUserAgent(value)
  if (userAgent === null) return Promise.resolve()
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      if (current.userAgent === userAgent && !current.needsWrite) return
      await persistJarUnlocked({ map: current.map, userAgent })
    }),
  )
}

export interface WtCookieValue {
  name: string
  value: string
}

/** Возвращает текущие cookies в форме, которую понимает браузерный контекст. */
export async function cookieValues(): Promise<WtCookieValue[]> {
  const header = await cookieHeader()
  return [...parseCookiePairs(header)].map(([name, value]) => ({ name, value }))
}

/**
 * Обновляет общий jar cookies значениями из браузерного контекста.
 * Node-хранилище остаётся единственным управляемым jar для auth-cookie; Edge
 * использует нативный профиль для browser fingerprint, а clearance не копируется
 * между Node и браузером.
 */
export function absorbCookieValues(values: readonly WtCookieValue[]): Promise<void> {
  if (values.length === 0) return Promise.resolve()
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      const next = new Map(current.map)
      let changed = current.needsWrite
      for (const cookie of values) {
        if (!isCookiePair(cookie.name, cookie.value)) continue
        if (next.get(cookie.name) !== cookie.value) {
          next.set(cookie.name, cookie.value)
          changed = true
        }
      }
      if (changed) await persistJarUnlocked({ map: next, userAgent: current.userAgent })
      if (changed && !refreshLogged) {
        refreshLogged = true
        console.log('[wt-cookies] Cookies обновлены и сохранены в data/wt-cookies.json')
      }
    }),
  )
}

export function absorbSetCookies(response: Response): Promise<void> {
  const headers = [...response.headers.getSetCookie()]
  if (headers.length === 0) return Promise.resolve()
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      const next = new Map(current.map)
      let changed = current.needsWrite
      for (const header of headers) {
        const [pair = '', ...attrs] = header.split(';')
        const equals = pair.indexOf('=')
        if (equals < 0) continue
        const name = pair.slice(0, equals).trim()
        const value = pair.slice(equals + 1).trim()
        if (!isCookiePair(name, value)) continue
        if (isDeletion(attrs)) {
          if (next.delete(name)) changed = true
        } else if (next.get(name) !== value) {
          next.set(name, value)
          changed = true
        }
      }
      if (changed) await persistJarUnlocked({ map: next, userAgent: current.userAgent })
      if (changed && !refreshLogged) {
        refreshLogged = true
        console.log('[wt-cookies] Сервер продлил сессию — cookies сохранены в data/wt-cookies.json')
      }
    }),
  )
}

function isDeletion(attrs: string[]): boolean {
  for (const raw of attrs) {
    const equals = raw.indexOf('=')
    if (equals < 0) continue
    const key = raw.slice(0, equals).trim().toLowerCase()
    const value = raw.slice(equals + 1).trim()
    if (key === 'max-age' && Number.isFinite(Number(value)) && Number(value) <= 0) return true
    if (key === 'expires') {
      const date = Date.parse(value)
      if (!Number.isNaN(date) && date < Date.now()) return true
    }
  }
  return false
}
