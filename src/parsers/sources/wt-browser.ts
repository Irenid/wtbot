import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Cookie, type Page, type Request } from 'playwright-core'
import { writeFileAtomic } from '../../atomic-file.js'
import { config } from '../../config.js'
import {
  absorbCookieValues,
  cookieValues,
  isWtAuthCookie,
  rememberCookieUserAgent,
  replaceWtSession,
  type WtCookieValue,
} from './wt-cookies.js'
import {
  freshestCookies,
  isChallengeResponse,
  looksCleared,
  planBrowserSession,
  staleDuplicateCookies,
  type PageSignals,
} from './wt-challenge.js'
import {
  extLoginUrl,
  GAIJIN_ORIGIN,
  gseaFetchUrl,
  gseaSessionFromScript,
  isSignedInSession,
  isSiteLogout,
  pageAccountId,
  sessionToken,
} from './wt-sign-in.js'
import {
  browserExecutableCandidates,
  browserSpawnArgs,
  clearanceProbeDelayMs,
  displayProblem,
  findProfileBrowserPids,
  MAX_FAILED_CLEARANCE_PROBES,
  profileTooBroadToKill,
  removeChromiumSingletonFiles,
} from './wt-browser-platform.js'

/**
 * Браузерный транспорт для warthunder.com.
 *
 * Замеры, на которых построен модуль:
 * - обычный `fetch()` из Node получает 403 `cf-mitigated: challenge` даже со
 *   свежим `cf_clearance`: клиренс привязан к TLS-отпечатку браузера;
 * - Edge, поднятый Playwright-ом (`launchPersistentContext`), имеет
 *   `navigator.webdriver === true` и проверку не проходит вообще;
 * - Edge, запущенный как обычный процесс и подключённый по CDP, даёт
 *   `webdriver === false` и проходит проверку за 8–9 секунд на чистом профиле;
 * - `--headless=new` не проходит проверку ни при spawn, ни при launch, поэтому
 *   «скрытый» режим реализован окном за пределами экрана, а не headless;
 * - после прохождения проверки `fetch()` внутри страницы отдаёт полноценный
 *   ответ за 0.4–0.9 с, поэтому навигация ради получения HTML не нужна.
 */

const WT_ORIGIN = 'https://warthunder.com'
const WARMUP_URL = `${WT_ORIGIN}/en/community/searchplayers?name=`
/** Любая страница нужного origin делает in-page fetch same-origin. */
const POOL_PARK_URL = `${WT_ORIGIN}/robots.txt`
const NAVIGATION_TIMEOUT_MS = 25_000
const CLEARANCE_POLL_MS = 500
const CLEARANCE_COOLDOWN_MS = 60_000
const CDP_WAIT_MS = 20_000
const CLOSE_WAIT_MS = 5_000
const ENDPOINT_FILE = 'wtbot-cdp.json'
/** Попытки одного запроса: две на транспортные сбои плюс одна после проверки. */
const MAX_REQUEST_ATTEMPTS = 3
/** The GSEA answer is a ~1 KiB script. */
const GSEA_ANSWER_MAX_BYTES = 64 * 1024
/**
 * How long the renewal leaves a login.gaijin.net tab of the shared context
 * alone: a visit rotates the Gaijin cookies under a person's form (password,
 * then an emailed code). A tab left open after the sign-in delays it no more.
 */
const SIGN_IN_PAGE_WAIT_MS = 10 * 60_000
/** Requests of the page after the sign-in may still rotate identity_sid. */
const SIGN_IN_SETTLE_MS = 10_000
/** The sign-in visit needs documents and scripts only (blockedOnSignIn). */
const SIGN_IN_SKIPPED_RESOURCES: ReadonlySet<string> = new Set(['image', 'media', 'font'])

interface PoolEntry {
  page: Page
  busy: boolean
}

interface PageWaiter {
  resolve: (entry: PoolEntry) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface BrowserState {
  browser: Browser
  context: BrowserContext
  child: ChildProcess | null
  port: number
  userAgent: string
  pool: PoolEntry[]
}

interface BrowserFetchResult {
  status: number
  url: string
  headers: Record<string, string>
  body: string
  aborted: boolean
}

export interface WtBrowserMetrics {
  /** Запросов, выполненных внутри страницы. */
  requests: number
  /** Ответов с cf-mitigated: challenge. */
  challenged: number
  /** Сорвавшихся in-page запросов (таймаут, потеря вкладки). */
  transportErrors: number
  /** Успешных прохождений проверки. */
  clearances: number
  /** Неудачных прохождений проверки. */
  clearanceFailures: number
  /** Сетевых проб clearance: настоящие запросы к warthunder.com мимо общей очереди. */
  clearanceProbes: number
  lastClearanceMs: number | null
  lastClearanceAt: number | null
  poolSize: number
}

let state: BrowserState | null = null
/**
 * Несёт ли браузер сейчас сессию WT: да, пока Replay API идёт через него.
 * Признак задаёт wt-request по режимам адресов; без него браузер, как раньше,
 * считается владельцем сессии.
 */
let sessionCarrierProbe: () => boolean = () => true
/**
 * Сессия из браузера, которую бот затёр или убрал, потому что она отличалась
 * от jar (например, вход через VNC). Её можно взять, если сессия jar умрёт.
 */
let stashedBrowserSession: WtCookieValue[] | null = null
let sessionPrepareTail: Promise<void> = Promise.resolve()
let renewalTail: Promise<WtSignInRenewal> | null = null
/** sha256 of the login.gaijin.net cookies a visit found signed out; a sign-in through VNC changes them. */
let signedOutGaijinCookies: string | null = null
/** When a login.gaijin.net tab of the shared context was first seen (SIGN_IN_PAGE_WAIT_MS). */
let gaijinPageSeenAt: number | null = null
let lastClearanceAt = 0
let clearanceTail: Promise<void> = Promise.resolve()
let startupTail: Promise<BrowserState> | null = null
let launchFailureLogged = false
let windowRestored = false
const waiters: PageWaiter[] = []
const metrics: WtBrowserMetrics = {
  requests: 0,
  challenged: 0,
  transportErrors: 0,
  clearances: 0,
  clearanceFailures: 0,
  clearanceProbes: 0,
  lastClearanceMs: null,
  lastClearanceAt: null,
  poolSize: 0,
}

export class WtBrowserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WtBrowserError'
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 300)
  return 'unknown error'
}

function profileDir(): string {
  return resolve(config.wtBrowserProfileDir || './data/wt-browser-profile')
}

async function edgeExecutable(): Promise<string> {
  const candidates = browserExecutableCandidates(process.platform, process.env, config.wtBrowserExecutable)
  const available = await Promise.all(
    candidates.map((candidate) => access(candidate).then(
      () => true,
      () => false,
    )),
  )
  const executable = candidates.find((_, index) => available[index])
  if (executable !== undefined) return executable
  throw new WtBrowserError('no Edge/Chrome/Chromium executable found; set WT_BROWSER_EXECUTABLE')
}

async function cdpIsReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForCdp(port: number, waitMs = CDP_WAIT_MS): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await cdpIsReady(port)) return
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new WtBrowserError(`Edge did not open DevTools port ${port}`)
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => rejectPort(new WtBrowserError('could not pick a free port for CDP')))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })
}

function endpointFile(): string {
  return resolve(profileDir(), ENDPOINT_FILE)
}

/**
 * Порт запомненного Edge. Профиль Edge допускает только один экземпляр, поэтому
 * запись в профиле — надёжный способ снова найти свой браузер и не подключиться
 * к личному Edge пользователя.
 */
async function rememberedPort(): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(endpointFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const port = (parsed as { port?: unknown }).port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

async function rememberPort(port: number): Promise<void> {
  await writeFileAtomic(
    endpointFile(),
    JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }, null, 2),
    { fileMode: 0o600, directoryMode: 0o700 },
  )
}

/**
 * Гасит Edge, оставшийся от прошлого запуска с нашим профилем. Без этого новый
 * spawn с тем же --user-data-dir просто отдаёт управление старому процессу и
 * молча завершается, а CDP-порт так и не открывается.
 */
function killStaleProfileBrowsers(): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return Promise.resolve()
  const dir = profileDir()
  // Слишком общий путь совпал бы с чужим браузером, а личный профиль Edge/Chrome
  // не наш — его процессы нельзя гасить, даже если его указали в WT_BROWSER_PROFILE_DIR.
  const refusal = profileTooBroadToKill(dir)
  if (refusal !== null) {
    console.warn(`[wt-browser] ${refusal}`)
    return Promise.resolve()
  }
  if (process.platform === 'linux') {
    killLinuxProfileBrowsers(dir)
    return Promise.resolve()
  }
  // Путь уходит через переменную окружения: в -like обратный слэш не является
  // экранирующим символом, а квадратные скобки и пробелы в пути ломают шаблон.
  const script = '$dir = $env:WTBOT_EDGE_PROFILE;'
    + ' Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'"'
    + ' | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) }'
    + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  return new Promise((resolvePromise) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, WTBOT_EDGE_PROFILE: dir },
    })
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise()
    }, 10_000)
    timer.unref()
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

/**
 * Linux: гасит процессы с нашим --user-data-dir и снимает SingletonLock
 * профиля. В Docker профиль лежит в volume, и lock-файлы Chromium от прошлого
 * контейнера иначе навсегда помечают профиль занятым.
 */
function killLinuxProfileBrowsers(dir: string): void {
  for (const pid of findProfileBrowserPids(dir)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Процесс уже завершился.
    }
  }
  try {
    removeChromiumSingletonFiles(dir)
  } catch (error) {
    console.warn(`[wt-browser] Не удалось снять SingletonLock профиля (${safeErrorMessage(error)})`)
  }
}

function spawnArgs(port: number): string[] {
  return browserSpawnArgs({
    port,
    profileDir: profileDir(),
    offscreen: config.wtBrowserHeadless,
    noSandbox: config.wtBrowserNoSandbox,
    platform: process.platform,
  })
}

async function spawnEdge(): Promise<{ child: ChildProcess; port: number }> {
  const noDisplay = displayProblem(process.platform, process.env)
  if (noDisplay !== null) throw new WtBrowserError(noDisplay)
  const executable = await edgeExecutable()
  // A profile without live processes: SingletonLock is left from the previous
  // run (or container) and would keep the browser from opening its DevTools port.
  if (process.platform === 'linux' && findProfileBrowserPids(profileDir()).length === 0) {
    removeChromiumSingletonFiles(profileDir())
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = config.wtBrowserCdpPort > 0 ? config.wtBrowserCdpPort : await ephemeralPort()
    const child = spawn(executable, spawnArgs(port), { stdio: 'ignore', windowsHide: true })
    child.unref()
    try {
      // The first attempt waits less: a silent port usually means an Edge
      // holding the profile, and waiting longer is pointless then.
      await waitForCdp(port, attempt === 1 ? 10_000 : CDP_WAIT_MS)
      await rememberPort(port)
      return { child, port }
    } catch (error) {
      if (!child.killed) child.kill()
      if (attempt === 2) throw error
      // The port almost always stays shut for one reason: an Edge left from
      // the previous run holds the profile.
      console.warn('[wt-browser] CDP did not open: killing the Edge that holds the profile and retrying')
      await killStaleProfileBrowsers()
    }
  }
  throw new WtBrowserError('could not start Edge with a DevTools port')
}

async function connectBrowser(): Promise<BrowserState> {
  const remembered = await rememberedPort()
  let child: ChildProcess | null = null
  let port: number
  if (remembered !== null && (await cdpIsReady(remembered))) {
    port = remembered
  } else {
    const spawned = await spawnEdge()
    child = spawned.child
    port = spawned.port
  }

  let browser: Browser | null = null
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    if (context === undefined) {
      throw new WtBrowserError('the browser has no browser context')
    }
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    // A signed-in page would sign itself out (isSiteLogout); a manual sign-out
    // through VNC does nothing either: clear the cookies instead.
    await context.route(isSiteLogout, (route) => route.abort().catch(() => undefined))
    const probe = context.pages()[0] ?? await context.newPage()
    const userAgent = await probe
      .evaluate(() => navigator.userAgent)
      .catch(() => '') as string
    return { browser, context, child, port, userAgent, pool: [] }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    if (child !== null && !child.killed) child.kill()
    await killStaleProfileBrowsers()
    throw error
  }
}

function browserStateIsUsable(current: BrowserState): boolean {
  return current.browser.isConnected()
}

async function ensureBrowser(): Promise<BrowserState> {
  if (state !== null && browserStateIsUsable(state)) return state
  if (startupTail !== null) return startupTail

  startupTail = (async () => {
    if (state !== null && !browserStateIsUsable(state)) {
      const stale = state
      state = null
      rejectPageWaiters(new WtBrowserError('lost the connection to Edge'))
      await Promise.all(stale.pool.map((entry) => entry.page.close().catch(() => undefined)))
      await stale.browser.close().catch(() => undefined)
      if (stale.child !== null && !stale.child.killed) stale.child.kill()
      await killStaleProfileBrowsers()
    }
    const started = await connectBrowser()
    launchFailureLogged = false
    windowRestored = false
    state = started
    try {
      await removeDuplicateCookies(started.context)
      // Before the pool's first navigations: the browser's copy of the jar
      // session must not reach the site while the direct path carries it.
      await prepareBrowserSession(started.context, sessionCarrierProbe())
      await ensurePool(started)
      if (started.userAgent.trim() !== '') {
        await rememberCookieUserAgent(started.userAgent).catch(() => undefined)
      }
      return started
    } catch (error) {
      state = null
      rejectPageWaiters(new WtBrowserError('the browser pool did not start'))
      await Promise.all(started.pool.map((entry) => entry.page.close().catch(() => undefined)))
      await started.browser.close().catch(() => undefined)
      if (started.child !== null && !started.child.killed) started.child.kill()
      await killStaleProfileBrowsers()
      throw error
    }
  })()
  try {
    return await startupTail
  } catch (error) {
    state = null
    if (!launchFailureLogged) {
      launchFailureLogged = true
      console.warn(`[wt-browser] Could not start Edge (${safeErrorMessage(error)})`)
    }
    throw error
  } finally {
    startupTail = null
  }
}

async function parkPage(page: Page, carrier = sessionCarrierProbe()): Promise<void> {
  if (page.url().startsWith(WT_ORIGIN)) return
  await page.goto(POOL_PARK_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  if (!page.url().startsWith(WT_ORIGIN)) {
    await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  }
  // Навигация тоже может ротировать identity_sid, пока сессию несёт браузер.
  await saveSessionIfCarrier(page.context(), carrier)
}

async function ensurePool(current: BrowserState): Promise<void> {
  current.pool = current.pool.filter((entry) => !entry.page.isClosed())
  // Вкладки, оставшиеся в профиле от прошлого запуска, переиспользуем: иначе
  // при каждом старте в браузере копится по новой вкладке. Забираем только
  // свои — пустые или уже на warthunder.com, чтобы не увести чужую вкладку.
  for (const page of current.context.pages()) {
    if (current.pool.length >= config.wtBrowserPoolSize) break
    if (page.isClosed()) continue
    const url = page.url()
    if (!url.startsWith(WT_ORIGIN) && url !== 'about:blank' && url !== '') continue
    if (current.pool.some((entry) => entry.page === page)) continue
    current.pool.push({ page, busy: false })
  }
  const missing = Math.max(0, config.wtBrowserPoolSize - current.pool.length)
  const created = await Promise.all(
    Array.from({ length: missing }, () => current.context.newPage()),
  )
  current.pool.push(...created.map((page) => ({ page, busy: false })))
  const extras = current.pool.splice(config.wtBrowserPoolSize)
  await Promise.all(extras.map((entry) => entry.page.close().catch(() => undefined)))
  // Навигации идут последовательно: это внешний warthunder.com, где
  // одновременный burst повышает риск Cloudflare challenge.
  for (const entry of current.pool) {
    if (!entry.busy) await parkPage(entry.page)
  }
  metrics.poolSize = current.pool.length
  // На свежем профиле первая вкладка — служебная страница edge://, где
  // evaluate запрещён, поэтому UA снимаем уже с припаркованной вкладки сайта.
  const first = current.pool[0]
  if (current.userAgent.trim() === '' && first !== undefined) {
    current.userAgent = await first.page
      .evaluate(() => navigator.userAgent)
      .catch(() => '') as string
  }
}

function rejectPageWaiters(error: Error): void {
  for (const waiter of waiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
}

function releasePage(entry: PoolEntry): void {
  entry.busy = false
  if (entry.page.isClosed() || state === null || !state.pool.includes(entry)) {
    rejectPageWaiters(new WtBrowserError('the browser pool lost a working tab'))
    return
  }
  const waiter = waiters.shift()
  if (waiter !== undefined) {
    clearTimeout(waiter.timer)
    entry.busy = true
    waiter.resolve(entry)
    return
  }
}

async function acquirePage(): Promise<PoolEntry> {
  const current = await ensureBrowser()
  const free = current.pool.find((entry) => !entry.busy && !entry.page.isClosed())
  if (free !== undefined) {
    free.busy = true
    return free
  }
  const broken = current.pool.filter((entry) => entry.page.isClosed())
  if (broken.length > 0) {
    await ensurePool(current)
    const replaced = current.pool.find((entry) => !entry.busy && !entry.page.isClosed())
    if (replaced !== undefined) {
      replaced.busy = true
      return replaced
    }
  }
  return new Promise<PoolEntry>((resolveEntry, rejectEntry) => {
    const waiter: PageWaiter = {
      resolve: resolveEntry,
      reject: rejectEntry,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        rejectEntry(new WtBrowserError(`waited over ${config.wtBrowserTimeoutMs} ms for a free Edge tab`))
      }, config.wtBrowserTimeoutMs),
    }
    waiter.timer.unref()
    waiters.push(waiter)
  })
}

/**
 * Выдаёт эксклюзивную вкладку общего Edge/CDP-пула для другого публичного
 * browser-only источника. Callback не должен сохранять Page после завершения:
 * вкладка возвращается на warthunder.com перед передачей следующему клиенту.
 */
export async function withEdgeBrowserPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const entry = await acquirePage()
  try {
    return await work(entry.page)
  } finally {
    if (!entry.page.isClosed()) await parkPage(entry.page)
    releasePage(entry)
  }
}

const WT_COOKIE_DOMAIN = /^\.?warthunder\.com$/

/**
 * Регистрирует признак «сессию WT сейчас несёт браузер». Его задаёт
 * wt-request: браузеру сессия нужна, только пока Replay API идёт через него.
 */
export function setWtBrowserSessionProbe(probe: () => boolean): void {
  sessionCarrierProbe = probe
}

/**
 * Раньше seed при каждом старте добавлял host-only копии рядом с доменными:
 * браузер отправлял обе, сервер читал устаревшую и уводил на повторный вход.
 */
async function removeDuplicateCookies(context: BrowserContext): Promise<void> {
  const existing = await context.cookies(WT_ORIGIN).catch(() => [])
  for (const stale of staleDuplicateCookies(existing)) {
    await context
      .clearCookies({ name: stale.name, domain: stale.domain, path: stale.path })
      .catch(() => undefined)
  }
}

async function browserAuthCookies(context: BrowserContext): Promise<WtCookieValue[]> {
  const cookies = await context.cookies(WT_ORIGIN).catch(() => [])
  return freshestCookies(cookies.filter((cookie) => isWtAuthCookie(cookie.name)))
}

async function jarAuthCookies(): Promise<WtCookieValue[]> {
  return (await cookieValues()).filter(({ name }) => isWtAuthCookie(name))
}

/**
 * Prepares the browser's sign-in cookies for a request. The jar owns the WT
 * session: the server rotates identity_sid in responses, and two copies of
 * one session in the jar and the browser would diverge.
 * - carrier (the Replay API goes through the browser): the browser gets the
 *   jar's session, and its responses are saved back (saveSessionIfCarrier);
 * - otherwise the browser browses anonymously: public pages need no session.
 * The browser's own sign-in (VNC) is not lost: it is kept and taken by
 * adoptBrowserSession if the jar's session dies.
 */
async function prepareBrowserSession(context: BrowserContext, carrier: boolean): Promise<void> {
  const run = sessionPrepareTail.then(async () => {
    const browserAuth = await browserAuthCookies(context)
    const jarAuth = await jarAuthCookies()
    const plan = planBrowserSession(carrier, browserAuth, jarAuth)
    if (plan.stash) stashedBrowserSession = browserAuth
    if (plan.clear) {
      await context.clearCookies({ name: /^identity_/, domain: WT_COOKIE_DOMAIN }).catch(() => undefined)
    }
    if (!plan.push) return
    await context
      .addCookies(jarAuth.map(({ name, value }) => ({
        name,
        value,
        domain: '.warthunder.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax' as const,
      })))
      .catch(() => undefined)
  })
  sessionPrepareTail = run.catch(() => undefined)
  await run
}

/**
 * Copies the browser's cookies into the jar while the browser carries the
 * session, so the jar sees identity_sid rotate; the jar ignores identity_*
 * of another sign-in (absorbCookieValues). Requests without the session leave
 * the jar alone. cf_clearance is kept on purpose: the jar mirrors the session.
 */
async function saveSessionIfCarrier(context: BrowserContext, carrier: boolean): Promise<void> {
  if (!carrier) return
  const cookies = await context.cookies(WT_ORIGIN).catch(() => [])
  if (cookies.length === 0) return
  await absorbCookieValues(freshestCookies(cookies))
}

/**
 * Puts another sign-in into the jar. The browser's copy of the replaced one
 * goes, and is never kept for adoption: it is the session that just died or
 * was replaced. Runs in the prepareBrowserSession chain, so a request between
 * the two steps cannot stash that copy.
 */
async function installSession(
  context: BrowserContext,
  auth: readonly WtCookieValue[],
  userAgent: string,
  signedInAt: number | null,
): Promise<void> {
  const run = sessionPrepareTail.then(async () => {
    const retired = sessionToken(await jarAuthCookies())
    await replaceWtSession(auth, userAgent, signedInAt)
    if (retired === null || retired === sessionToken(auth)) return
    if (stashedBrowserSession !== null && sessionToken(stashedBrowserSession) === retired) {
      stashedBrowserSession = null
    }
    if (sessionToken(await browserAuthCookies(context)) === retired) {
      await context.clearCookies({ name: /^identity_/, domain: WT_COOKIE_DOMAIN }).catch(() => undefined)
    }
  })
  sessionPrepareTail = run.catch(() => undefined)
  await run
}

/**
 * Takes into the jar the browser's own sign-in (a VNC sign-in at
 * warthunder.com): the current one or the one prepareBrowserSession kept.
 * Called when the server refused the jar's session; an anonymous set or a
 * copy of the jar's own sign-in is no candidate.
 */
export async function adoptBrowserSession(): Promise<boolean> {
  if (!config.wtBrowserEnabled) return false
  let current: BrowserState
  try {
    current = await ensureBrowser()
  } catch {
    return false
  }
  const jarToken = sessionToken(await jarAuthCookies())
  const candidates = [await browserAuthCookies(current.context), stashedBrowserSession ?? []]
  const adopted = candidates.find((auth) => isSignedInSession(auth) && sessionToken(auth) !== jarToken)
  stashedBrowserSession = null
  if (adopted === undefined) return false
  // When that sign-in happened is unknown: the next scheduled check renews it.
  await installSession(current.context, adopted, current.userAgent, null)
  return true
}

export type WtSignInRenewal = 'renewed' | 'signed-out' | 'signing-in' | 'failed'

/**
 * Signs warthunder.com in again through the Gaijin sign-in that the bot's
 * browser keeps (one manual sign-in at login.gaijin.net through VNC), the way
 * the site's gsea.js does (wt-sign-in.ts): the Gaijin session's refresh token,
 * then /extLogin. It runs in an isolated context with copies of the browser's
 * login.gaijin.net cookies: warthunder.com cookies of the shared context (the
 * jar's copy, a VNC session) take no part, and the new session goes only to
 * the jar. `prepareVisit` reserves a request slot (the visit ends on
 * warthunder.com) and returns the page's queryContext. "signed-out" costs no
 * request while the Gaijin cookies are those a visit already found signed out.
 */
export function renewWtSessionThroughGaijin(
  reason: string,
  prepareVisit: () => Promise<string>,
): Promise<WtSignInRenewal> {
  if (!config.wtBrowserEnabled) return Promise.resolve('failed')
  if (renewalTail !== null) return renewalTail
  const run = renewOnce(reason, prepareVisit).finally(() => {
    renewalTail = null
  })
  renewalTail = run
  return run
}

async function renewOnce(reason: string, prepareVisit: () => Promise<string>): Promise<WtSignInRenewal> {
  let current: BrowserState
  try {
    current = await ensureBrowser()
  } catch {
    return 'failed'
  }
  if (current.context.pages().some((page) => safeUrl(page.url())?.origin === GAIJIN_ORIGIN)) {
    if (gaijinPageSeenAt === null) {
      gaijinPageSeenAt = Date.now()
      console.log(`[wt-browser] A login.gaijin.net tab is open in the bot's browser: the renewal waits up to ${SIGN_IN_PAGE_WAIT_MS / 60_000} min for the sign-in to finish`)
    }
    if (Date.now() - gaijinPageSeenAt < SIGN_IN_PAGE_WAIT_MS) return 'signing-in'
  } else {
    gaijinPageSeenAt = null
  }
  const gaijin = await current.context.cookies(GAIJIN_ORIGIN).catch(() => null)
  if (gaijin === null) return 'failed'
  // Nobody has opened login.gaijin.net in this browser yet.
  if (gaijin.length === 0) return 'signed-out'
  const fingerprint = cookieFingerprint(gaijin)
  if (fingerprint === signedOutGaijinCookies) return 'signed-out'

  let isolated: BrowserContext | null = null
  try {
    const target = await prepareVisit()
    // The deadline starts with the visit: the request slot may wait out a 429.
    const started = Date.now()
    isolated = await current.browser.newContext()
    isolated.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    await isolated.route('**/*', async (route) => {
      await (blockedOnSignIn(route.request()) ? route.abort() : route.continue()).catch(() => undefined)
    })
    await isolated.addCookies(gaijin)
    // gsea.js's own request, first-party here: on the site the bot's Chromium hides the Gaijin session from it.
    const answer = await isolated.request.get(gseaFetchUrl(target, randomUUID()), {
      headers: { referer: `${WT_ORIGIN}/` },
      timeout: NAVIGATION_TIMEOUT_MS,
      maxRedirects: 0,
    })
    const body = answer.ok() ? await answer.body() : null
    const session = body === null || body.length > GSEA_ANSWER_MAX_BYTES ? null : gseaSessionFromScript(body.toString('utf8'))

    let outcome: WtSignInRenewal = session?.signedIn === false ? 'signed-out' : 'failed'
    let note = session === null ? `; GSEA answered HTTP ${answer.status()} without a session` : ''
    const page = await isolated.newPage()
    if (session?.signedIn === true) {
      await page.goto(extLoginUrl(session.refreshToken), { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    }
    const deadline = started + config.wtBrowserTimeoutMs
    while (session?.signedIn === true && Date.now() < deadline) {
      const address = safeUrl(page.url())
      if (
        address?.origin === WT_ORIGIN
        && !address.pathname.toLowerCase().includes('extlogin')
        && isSignedInSession(await browserAuthCookies(isolated))
      ) {
        // The page served after the sign-in tells whether the server took it.
        await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined)
        if (pageAccountId(await page.content().catch(() => '')) !== '') {
          outcome = 'renewed'
          break
        }
        note = '; the site page is anonymous'
      }
      await page.waitForTimeout(CLEARANCE_POLL_MS).catch(() => undefined)
    }
    if (outcome === 'renewed') {
      await page.waitForLoadState('networkidle', { timeout: SIGN_IN_SETTLE_MS }).catch(() => undefined)
    }
    const lastPage = pageAddress(page.url())
    await page.goto('about:blank').catch(() => undefined)

    if (outcome === 'renewed') {
      const auth = await browserAuthCookies(isolated)
      if (isSignedInSession(auth)) {
        await installSession(current.context, auth, current.userAgent, Date.now())
      } else {
        outcome = 'failed'
        note = '; the sign-in cookies vanished'
      }
    }
    // Gaijin rotates its cookies on every visit: the shared copies may stop working.
    const mirrored = await mirrorGaijinCookies(current.context, isolated, fingerprint)
    signedOutGaijinCookies = outcome === 'signed-out' && mirrored
      ? cookieFingerprint(await current.context.cookies(GAIJIN_ORIGIN).catch(() => []))
      : null

    const elapsed = Date.now() - started
    if (outcome === 'renewed') {
      console.log(`[wt-browser] Signed in to warthunder.com again through Gaijin in ${elapsed} ms (${reason})`)
    } else if (outcome === 'signed-out') {
      console.warn(`[wt-browser] Gaijin reports no session: the browser keeps no Gaijin sign-in (${reason})`)
    } else {
      console.warn(`[wt-browser] The Gaijin sign-in did not finish in ${elapsed} ms (${reason}); last page: ${lastPage}${note}`)
    }
    return outcome
  } catch (error) {
    console.warn(`[wt-browser] The Gaijin sign-in failed (${safeErrorMessage(error)})`)
    return 'failed'
  } finally {
    await isolated?.close().catch(() => undefined)
  }
}

/** Fingerprint of a cookie set: only the hash stays in memory. */
function cookieFingerprint(cookies: readonly Cookie[]): string {
  const lines = cookies.map((cookie) => [cookie.domain, cookie.path, cookie.name, cookie.value].join('\t')).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/**
 * Copies the visit's login.gaijin.net cookies back to the shared context,
 * deletions included. A change there during the visit (a sign-in through VNC)
 * wins. false — nothing copied.
 */
async function mirrorGaijinCookies(
  shared: BrowserContext,
  isolated: BrowserContext,
  before: string,
): Promise<boolean> {
  try {
    const now = await shared.cookies(GAIJIN_ORIGIN)
    const after = await isolated.cookies(GAIJIN_ORIGIN)
    if (cookieFingerprint(now) !== before || after.length === 0) return false
    for (const old of now) {
      if (after.some((cookie) => cookie.name === old.name && cookie.domain === old.domain && cookie.path === old.path)) {
        continue
      }
      await shared.clearCookies({ name: old.name, domain: old.domain, path: old.path })
    }
    await shared.addCookies(after)
    return true
  } catch (error) {
    console.warn(`[wt-browser] Could not copy the Gaijin cookies back (${safeErrorMessage(error)})`)
    return false
  }
}

/**
 * The visit loads no Gaijin script on a warthunder.com page: the site's
 * Gaijin client would find no Gaijin session there and sign the new one out
 * (wt-sign-in.ts); the sign-out request itself never leaves either.
 */
function blockedOnSignIn(request: Request): boolean {
  const type = request.resourceType()
  if (SIGN_IN_SKIPPED_RESOURCES.has(type)) return true
  const url = safeUrl(request.url())
  if (url === null) return false
  if (isSiteLogout(url)) return true
  return type === 'script' && url.hostname.endsWith('.gaijin.net') && frameOrigin(request) === WT_ORIGIN
}

function frameOrigin(request: Request): string | null {
  try {
    return safeUrl(request.frame().url())?.origin ?? null
  } catch {
    // A service worker's request has no frame.
    return null
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Origin and path only: the query of a sign-in address carries tokens. */
function pageAddress(value: string): string {
  const url = safeUrl(value)
  return url === null || url.origin === 'null' ? value.split(/[?#]/)[0] || 'none' : `${url.origin}${url.pathname}`
}

function browserHeaders(init: RequestInit): Record<string, string> {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  // Эти заголовки браузер выставляет сам или запрещает задавать из fetch().
  for (const name of [
    'accept-encoding',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'referer',
    'user-agent',
  ]) {
    delete headers[name]
  }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('sec-')) delete headers[name]
  }
  return headers
}

async function pageSignals(page: Page): Promise<PageSignals> {
  // Код выполняется в странице, где нет типов DOM из tsconfig проекта.
  return await page.evaluate(() => {
    const view = globalThis as unknown as {
      location: { href: string }
      document: {
        title: string
        body: { innerText: string } | null
        querySelector(selector: string): unknown
      }
    }
    const body = view.document.body
    return {
      url: view.location.href,
      title: view.document.title,
      bodyLength: body === null ? 0 : body.innerText.length,
      // Маркеры именно страницы проверки; скрипт challenge-platform Cloudflare
      // подмешивает и в обычные страницы, поэтому по нему судить нельзя.
      challengeMarkup: view.document.querySelector(
        '#challenge-form, #challenge-running, #cf-please-wait, #challenge-error-title',
      ) !== null,
    }
  }).catch(() => ({ url: page.url(), title: '', bodyLength: 0, challengeMarkup: true }))
}

async function inPageFetch(
  page: Page,
  url: string,
  init: RequestInit,
  maxBytes: number,
): Promise<BrowserFetchResult> {
  const requestBody = typeof init.body === 'string' ? init.body : null
  return await page.evaluate(async ({ targetUrl, method, headers, body, limit }) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const requestInit: RequestInit = {
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
      }
      if (body !== null) requestInit.body = body
      const response = await fetch(targetUrl, requestInit)
      const contentLength = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(contentLength) && contentLength > limit) {
        return {
          status: response.status,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          body: '',
          aborted: true,
        }
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      let aborted = false
      if (reader !== undefined) {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          const chunk = next.value
          total += chunk.byteLength
          if (total > limit) {
            await reader.cancel()
            aborted = true
            break
          }
          chunks.push(chunk)
        }
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: aborted ? '' : new TextDecoder().decode(bytes),
        aborted,
      }
    } finally {
      clearTimeout(timeout)
    }
  }, {
    targetUrl: url,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: browserHeaders(init),
    body: requestBody,
    limit: maxBytes,
  }) as BrowserFetchResult
}

function isChallenge(result: BrowserFetchResult): boolean {
  return isChallengeResponse(result)
}

/** Возвращает окно на экран, чтобы проверку можно было пройти руками. */
async function restoreWindow(current: BrowserState, page: Page): Promise<void> {
  if (!config.wtBrowserHeadless || windowRestored) return
  windowRestored = true
  try {
    const session = await current.context.newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget') as { windowId: number }
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 80, top: 80, width: 1365, height: 900, windowState: 'normal' },
    })
    await session.detach().catch(() => undefined)
    console.warn('[wt-browser] Окно Edge возвращено на экран — пройдите проверку Cloudflare вручную')
  } catch (error) {
    console.warn(`[wt-browser] Не удалось показать окно Edge (${safeErrorMessage(error)})`)
  }
}

async function runClearance(reason: string, force: boolean, carrier: boolean): Promise<boolean> {
  if (!config.wtBrowserEnabled) return false
  if (!force && Date.now() - lastClearanceAt < CLEARANCE_COOLDOWN_MS) return true

  let current: BrowserState
  try {
    current = await ensureBrowser()
  } catch {
    return false
  }

  const entry = await acquirePage()
  const started = Date.now()
  try {
    await prepareBrowserSession(current.context, carrier)
    await entry.page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    const deadline = started + config.wtBrowserTimeoutMs
    let lastSignals: PageSignals | null = null
    let failedProbes = 0
    while (Date.now() < deadline) {
      lastSignals = await pageSignals(entry.page)
      if (looksCleared(lastSignals)) {
        // DOM выглядит чистым, но истина — только ответ сервера.
        const probe = await inPageFetch(entry.page, WARMUP_URL, { method: 'GET' }, 512 * 1024)
          .catch(() => null)
        metrics.clearanceProbes += 1
        if (probe !== null && !isChallenge(probe) && probe.status < 400) {
          await saveSessionIfCarrier(current.context, carrier)
          lastClearanceAt = Date.now()
          metrics.clearances += 1
          metrics.lastClearanceMs = lastClearanceAt - started
          metrics.lastClearanceAt = Math.floor(lastClearanceAt / 1_000)
          console.log(`[wt-browser] Проверка Cloudflare пройдена за ${metrics.lastClearanceMs} мс (${reason})`)
          return true
        }
        // DOM «чистый», а сервер отказывает: растущая пауза и предел проб,
        // чтобы не слать десятки запросов с авторизованной сессии за попытку.
        failedProbes += 1
        if (failedProbes >= MAX_FAILED_CLEARANCE_PROBES) break
        await entry.page.waitForTimeout(clearanceProbeDelayMs(failedProbes)).catch(() => undefined)
        continue
      }
      await entry.page.waitForTimeout(CLEARANCE_POLL_MS).catch(() => undefined)
    }
    metrics.clearanceFailures += 1
    await restoreWindow(current, entry.page)
    console.warn(
      `[wt-browser] Проверка Cloudflare не пройдена за ${Date.now() - started} мс (${reason}); последняя страница: ${lastSignals?.title || 'без заголовка'}`,
    )
    return false
  } catch (error) {
    metrics.clearanceFailures += 1
    console.warn(`[wt-browser] Ошибка прохождения проверки Cloudflare (${safeErrorMessage(error)})`)
    return false
  } finally {
    releasePage(entry)
  }
}

/**
 * Единственная последовательная попытка получить clearance.
 * Несколько источников, получивших challenge одновременно, не запустят несколько проверок.
 */
export function refreshWtClearance(
  reason: string,
  force = false,
  carrier = sessionCarrierProbe(),
): Promise<boolean> {
  if (!config.wtBrowserEnabled) return Promise.resolve(false)
  const result = clearanceTail.then(
    () => runClearance(reason, force, carrier),
    () => runClearance(reason, force, carrier),
  )
  clearanceTail = result.then(() => undefined, () => undefined)
  return result
}

function toResponse(result: BrowserFetchResult, maxBytes: number, label: string): Response {
  if (result.aborted) {
    throw new WtBrowserError(`${label}: the browser's response is over the ${maxBytes}-byte limit`)
  }
  const emptyBodyStatus = result.status === 204 || result.status === 205 || result.status === 304
  const response = new Response(emptyBodyStatus ? null : result.body, {
    status: result.status,
    headers: result.headers,
  })
  Object.defineProperty(response, 'url', { value: result.url })
  return response
}

/**
 * Runs a request inside a browser page that holds Cloudflare clearance. The
 * body comes back as text, so the path suits only HTML and JSON; binary files
 * (.wrpl) come from the CDN through a plain fetch without Cloudflare.
 * `session` — the address needs the WT session: the browser takes it from the jar.
 */
export async function fetchWtResponseInBrowser(
  url: string | URL,
  init: RequestInit,
  maxBytes = 8 * 1024 * 1024,
  label = 'WT request',
  options: { session?: boolean } = {},
): Promise<Response> {
  const target = String(url)
  const carrier = options.session === true || sessionCarrierProbe()
  let challengeRetried = false
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const entry = await acquirePage()
    let result: BrowserFetchResult | null = null
    let failure: unknown = null
    try {
      await prepareBrowserSession(entry.page.context(), carrier)
      await parkPage(entry.page, carrier)
      result = await inPageFetch(entry.page, target, init, maxBytes)
      metrics.requests += 1
    } catch (error) {
      failure = error
      metrics.transportErrors += 1
      // The tab may be stuck halfway (a hung fetch, a navigation): return it to
      // a known state before it goes back to the pool.
      await entry.page.goto(POOL_PARK_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      await saveSessionIfCarrier(entry.page.context(), carrier)
    } finally {
      releasePage(entry)
    }

    if (failure !== null) {
      // One hung in-page request must not fail the whole call: the next
      // attempt goes to another pool tab.
      if (attempt === MAX_REQUEST_ATTEMPTS) {
        throw new WtBrowserError(
          `${label}: the browser request failed (${safeErrorMessage(failure)})`,
          { cause: failure },
        )
      }
      console.warn(`[wt-browser] ${label}: attempt ${attempt} failed (${safeErrorMessage(failure)}), retrying`)
      continue
    }

    if (result === null) continue
    if (!isChallenge(result)) {
      await saveSessionIfCarrier(entry.page.context(), carrier)
      return toResponse(result, maxBytes, label)
    }

    metrics.challenged += 1
    if (challengeRetried) return toResponse(result, maxBytes, label)
    challengeRetried = true
    const cleared = await refreshWtClearance(label, true, carrier)
    if (!cleared) return toResponse(result, maxBytes, label)
  }
  throw new WtBrowserError(`${label}: the browser request failed after ${MAX_REQUEST_ATTEMPTS} attempts`)
}

/** Прогревает браузер и clearance заранее, чтобы первый запрос не ждал проверку. */
export async function warmupWtBrowser(): Promise<boolean> {
  if (!config.wtBrowserEnabled) return false
  try {
    await ensureBrowser()
  } catch {
    return false
  }
  return refreshWtClearance('прогрев', false)
}

export function wtBrowserMetrics(): WtBrowserMetrics {
  return { ...metrics }
}

/** User-Agent реального браузера; Node-запросы должны подписываться им же. */
export function wtBrowserUserAgent(): string | null {
  return state?.userAgent.trim() || null
}

/** Closes the browser on a normal shutdown, after a running check or sign-in (at most CLOSE_WAIT_MS). */
export async function closeWtBrowser(): Promise<void> {
  await Promise.race([
    Promise.all([clearanceTail.catch(() => undefined), renewalTail?.catch(() => undefined)]),
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, CLOSE_WAIT_MS)
      timer.unref()
    }),
  ])
  const current = state
  state = null
  startupTail = null
  lastClearanceAt = 0
  rejectPageWaiters(new WtBrowserError('the browser pool stopped'))
  if (current === null) return

  await Promise.all(current.pool.map((entry) => entry.page.close().catch(() => undefined)))
  await current.browser.close().catch(() => undefined)
  if (current.child !== null && !current.child.killed) current.child.kill()
  // connectOverCDP closes the connection, not the browser, and kill() of the
  // parent pid leaves the browser's process tree.
  await killStaleProfileBrowsers()
}
