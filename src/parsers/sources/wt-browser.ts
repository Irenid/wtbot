import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { writeFileAtomic } from '../../atomic-file.js'
import { config } from '../../config.js'
import { absorbCookieValues, cookieValues } from './wt-cookies.js'
import {
  isChallengeResponse,
  looksCleared,
  preferHostCookies,
  type PageSignals,
} from './wt-challenge.js'

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
const OFFSCREEN_POSITION = '-32000,-32000'
const ENDPOINT_FILE = 'wtbot-cdp.json'
/** Попытки одного запроса: две на транспортные сбои плюс одна после проверки. */
const MAX_REQUEST_ATTEMPTS = 3

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
  lastClearanceMs: number | null
  lastClearanceAt: number | null
  poolSize: number
}

let state: BrowserState | null = null
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
  return 'неизвестная ошибка'
}

function profileDir(): string {
  return resolve(config.wtBrowserProfileDir || './data/wt-browser-profile')
}

async function edgeExecutable(): Promise<string> {
  const candidates = [
    config.wtBrowserExecutable,
    process.env['ProgramFiles(x86)'] === undefined
      ? ''
      : `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`,
    process.env['ProgramFiles'] === undefined
      ? ''
      : `${process.env['ProgramFiles']}/Microsoft/Edge/Application/msedge.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter((candidate): candidate is string => candidate.trim() !== '')
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Пробуем следующий стандартный путь.
    }
  }
  throw new WtBrowserError('исполняемый файл Microsoft Edge не найден; задайте WT_BROWSER_EXECUTABLE')
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
  throw new WtBrowserError(`Edge не открыл DevTools-порт ${port}`)
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => rejectPort(new WtBrowserError('не удалось выбрать свободный порт для CDP')))
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
  if (process.platform !== 'win32') return Promise.resolve()
  const dir = profileDir()
  // Слишком общий путь совпал бы с личным Edge пользователя, поэтому по
  // корню диска или короткому каталогу не убиваем ничего.
  if (dir.length < 12 || !/[\\/].+[\\/]/.test(dir)) {
    console.warn(`[wt-browser] Профиль ${dir} слишком общий — не снимаю чужие процессы Edge`)
    return Promise.resolve()
  }
  // Личный профиль Edge не наш, и его браузер нельзя гасить ни при каких
  // обстоятельствах, даже если его указали в WT_BROWSER_PROFILE_DIR.
  if (/[\\/]AppData[\\/]Local[\\/]Microsoft[\\/]Edge[\\/]/i.test(`${dir}/`)) {
    console.warn('[wt-browser] WT_BROWSER_PROFILE_DIR указывает на личный профиль Edge — не трогаю его процессы')
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

function spawnArgs(port: number): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    `--user-data-dir=${profileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    // Cloudflare отклоняет настоящий headless, поэтому окно остаётся обычным и
    // просто уезжает за пределы экрана.
    ...(config.wtBrowserHeadless
      ? [`--window-position=${OFFSCREEN_POSITION}`, '--window-size=1365,900']
      : []),
  ]
}

async function spawnEdge(): Promise<{ child: ChildProcess; port: number }> {
  const executable = await edgeExecutable()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = config.wtBrowserCdpPort > 0 ? config.wtBrowserCdpPort : await ephemeralPort()
    const child = spawn(executable, spawnArgs(port), { stdio: 'ignore', windowsHide: true })
    child.unref()
    try {
      // Первая попытка ждёт меньше: типичная причина молчания порта — Edge,
      // удерживающий профиль, и тогда лишнее ожидание бессмысленно.
      await waitForCdp(port, attempt === 1 ? 10_000 : CDP_WAIT_MS)
      await rememberPort(port)
      return { child, port }
    } catch (error) {
      if (!child.killed) child.kill()
      if (attempt === 2) throw error
      // Порт не открылся почти всегда по одной причине: профиль удерживает
      // Edge, оставшийся от прошлого запуска.
      console.warn('[wt-browser] CDP не открылся — снимаю Edge, удерживающий профиль, и пробую ещё раз')
      await killStaleProfileBrowsers()
    }
  }
  throw new WtBrowserError('не удалось запустить Edge с DevTools-портом')
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
      throw new WtBrowserError('в Edge нет доступного browser context')
    }
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
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
      rejectPageWaiters(new WtBrowserError('Соединение с Edge потеряно'))
      for (const entry of stale.pool) await entry.page.close().catch(() => undefined)
      await stale.browser.close().catch(() => undefined)
      if (stale.child !== null && !stale.child.killed) stale.child.kill()
      await killStaleProfileBrowsers()
    }
    const started = await connectBrowser()
    launchFailureLogged = false
    windowRestored = false
    state = started
    try {
      await seedBrowserCookies(started.context)
      await ensurePool(started)
      return started
    } catch (error) {
      state = null
      rejectPageWaiters(new WtBrowserError('Browser pool не запустился'))
      for (const entry of started.pool) await entry.page.close().catch(() => undefined)
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
      console.warn(`[wt-browser] Не удалось поднять Edge (${safeErrorMessage(error)})`)
    }
    throw error
  } finally {
    startupTail = null
  }
}

async function parkPage(page: Page): Promise<void> {
  if (page.url().startsWith(WT_ORIGIN)) return
  await page.goto(POOL_PARK_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  if (!page.url().startsWith(WT_ORIGIN)) {
    await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  }
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
  while (current.pool.length < config.wtBrowserPoolSize) {
    current.pool.push({ page: await current.context.newPage(), busy: false })
  }
  for (const extra of current.pool.splice(config.wtBrowserPoolSize)) {
    await extra.page.close().catch(() => undefined)
  }
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
    rejectPageWaiters(new WtBrowserError('Browser pool потерял рабочую вкладку'))
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
        rejectEntry(new WtBrowserError(`Ожидание свободной вкладки Edge превысило ${config.wtBrowserTimeoutMs} мс`))
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

async function seedBrowserCookies(context: BrowserContext): Promise<void> {
  const values = await cookieValues()
  if (values.length === 0) return
  // cf_* не переносим: клиренс из Node-jar привязан к другому отпечатку и в
  // браузере бесполезен, а свой браузер выдаёт себе сам.
  const authValues = values.filter(({ name }) => !name.startsWith('cf_') && !name.startsWith('__cf'))
  if (authValues.length === 0) return
  await context
    .addCookies(authValues.map(({ name, value }) => ({ name, value, url: WT_ORIGIN })))
    .catch(() => undefined)
}

/**
 * Переносит cookies браузера в общий jar. cf_clearance сохраняется намеренно:
 * так jar отражает реальное состояние сессии и виден в диагностике.
 */
async function saveBrowserCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies(WT_ORIGIN).catch(() => [])
  if (cookies.length === 0) return
  await absorbCookieValues(preferHostCookies(cookies))
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

async function runClearance(reason: string, force: boolean): Promise<boolean> {
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
    await entry.page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    const deadline = started + config.wtBrowserTimeoutMs
    let lastSignals: PageSignals | null = null
    while (Date.now() < deadline) {
      lastSignals = await pageSignals(entry.page)
      if (looksCleared(lastSignals)) {
        // DOM выглядит чистым, но истина — только ответ сервера.
        const probe = await inPageFetch(entry.page, WARMUP_URL, { method: 'GET' }, 512 * 1024)
          .catch(() => null)
        if (probe !== null && !isChallenge(probe) && probe.status < 400) {
          await saveBrowserCookies(current.context)
          lastClearanceAt = Date.now()
          metrics.clearances += 1
          metrics.lastClearanceMs = lastClearanceAt - started
          metrics.lastClearanceAt = Math.floor(lastClearanceAt / 1_000)
          console.log(`[wt-browser] Проверка Cloudflare пройдена за ${metrics.lastClearanceMs} мс (${reason})`)
          return true
        }
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
export function refreshWtClearance(reason: string, force = false): Promise<boolean> {
  if (!config.wtBrowserEnabled) return Promise.resolve(false)
  const result = clearanceTail.then(
    () => runClearance(reason, force),
    () => runClearance(reason, force),
  )
  clearanceTail = result.then(() => undefined, () => undefined)
  return result
}

function toResponse(result: BrowserFetchResult, maxBytes: number, label: string): Response {
  if (result.aborted) {
    throw new WtBrowserError(`${label}: ответ браузера превышает лимит ${maxBytes} байт`)
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
 * Выполняет запрос внутри страницы браузера, где Cloudflare выдала clearance.
 * Тело возвращается как текст, поэтому путь пригоден только для HTML и JSON;
 * бинарные файлы (.wrpl) качаются с CDN обычным fetch без Cloudflare.
 */
export async function fetchWtResponseInBrowser(
  url: string | URL,
  init: RequestInit,
  maxBytes = 8 * 1024 * 1024,
  label = 'запрос WT',
): Promise<Response> {
  const target = String(url)
  let challengeRetried = false
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const entry = await acquirePage()
    let result: BrowserFetchResult | null = null
    let failure: unknown = null
    try {
      await parkPage(entry.page)
      result = await inPageFetch(entry.page, target, init, maxBytes)
      metrics.requests += 1
    } catch (error) {
      failure = error
      metrics.transportErrors += 1
      // Вкладка могла остаться на полпути (зависший fetch, навигация), поэтому
      // возвращаем её в известное состояние, прежде чем отдавать в пул.
      await entry.page.goto(POOL_PARK_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    } finally {
      releasePage(entry)
    }

    if (failure !== null) {
      // Одиночный зависший in-page запрос не должен убивать весь вызов:
      // следующая попытка уйдёт на другую вкладку пула.
      if (attempt === MAX_REQUEST_ATTEMPTS) {
        throw new WtBrowserError(
          `${label}: запрос в браузере не выполнен (${safeErrorMessage(failure)})`,
          { cause: failure },
        )
      }
      console.warn(`[wt-browser] ${label}: попытка ${attempt} не удалась (${safeErrorMessage(failure)}) — повторяю`)
      continue
    }

    if (result === null) continue
    if (!isChallenge(result)) {
      const current = state
      if (current !== null) await saveBrowserCookies(current.context)
      return toResponse(result, maxBytes, label)
    }

    metrics.challenged += 1
    if (challengeRetried) return toResponse(result, maxBytes, label)
    challengeRetried = true
    const cleared = await refreshWtClearance(label, true)
    if (!cleared) return toResponse(result, maxBytes, label)
  }
  throw new WtBrowserError(`${label}: запрос в браузере не выполнен за ${MAX_REQUEST_ATTEMPTS} попытки`)
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

/** Закрывает браузер при штатном завершении процесса. */
export async function closeWtBrowser(): Promise<void> {
  await Promise.race([
    clearanceTail.catch(() => undefined),
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, CLOSE_WAIT_MS)
      timer.unref()
    }),
  ])
  const current = state
  state = null
  startupTail = null
  lastClearanceAt = 0
  rejectPageWaiters(new WtBrowserError('Browser pool остановлен'))
  if (current === null) return

  for (const entry of current.pool) {
    await entry.page.close().catch(() => undefined)
  }
  await current.browser.close().catch(() => undefined)
  if (current.child !== null && !current.child.killed) current.child.kill()
  // connectOverCDP закрывает соединение, но не сам Edge, а kill() по pid
  // родителя не снимает дерево процессов браузера.
  await killStaleProfileBrowsers()
}
