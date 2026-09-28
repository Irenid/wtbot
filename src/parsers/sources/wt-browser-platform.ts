import { readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * Платформенная часть браузерного транспорта warthunder.com: где искать
 * Chromium-браузер, с какими флагами его запускать и как найти процессы,
 * удерживающие наш профиль. Модуль не зависит от Playwright и сети, поэтому
 * одинаково проверяется тестами на Windows и Linux.
 *
 * Боевой запуск — Docker на Linux: там нет Edge из Windows, нет рабочего стола
 * и нет D-Bus/keyring, а профиль браузера лежит в volume и переживает
 * перезапуск контейнера вместе со служебными lock-файлами Chromium.
 */

/** Окно за пределами экрана: настоящий headless Cloudflare не пропускает. */
export const OFFSCREEN_POSITION = '-32000,-32000'

type Env = Readonly<Record<string, string | undefined>>

/** Кандидаты исполняемого файла: явный WT_BROWSER_EXECUTABLE, затем Edge, затем Chrome/Chromium. */
export function browserExecutableCandidates(
  platform: NodeJS.Platform,
  env: Env,
  configured: string,
): string[] {
  const candidates: string[] = [configured]
  if (platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env['ProgramFiles'], 'C:/Program Files (x86)', 'C:/Program Files']) {
      if (base !== undefined && base.trim() !== '') candidates.push(`${base}/Microsoft/Edge/Application/msedge.exe`)
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
      '/opt/microsoft/msedge/msedge',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    )
  }
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter((candidate) => candidate !== ''))]
}

export interface BrowserSpawnOptions {
  port: number
  profileDir: string
  /** Окно за пределами экрана (WT_BROWSER_HEADLESS). */
  offscreen: boolean
  /** --no-sandbox: нужен в Docker, где seccomp запрещает namespace-песочницу Chromium. */
  noSandbox: boolean
  platform: NodeJS.Platform
}

export function browserSpawnArgs(options: BrowserSpawnOptions): string[] {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.port}`,
    `--remote-allow-origins=http://127.0.0.1:${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ]
  if (options.platform === 'linux') {
    // В Docker /dev/shm по умолчанию 64 МиБ: без флага вкладки падают на тяжёлых страницах.
    args.push('--disable-dev-shm-usage')
    // В контейнере нет D-Bus и keyring: без флага браузер ждёт их и долго стартует.
    args.push('--password-store=basic')
  }
  if (options.noSandbox) args.push('--no-sandbox')
  // Cloudflare отклоняет настоящий headless, поэтому окно остаётся обычным и
  // просто уезжает за пределы экрана (в Docker — за пределы виртуального Xvfb).
  if (options.offscreen) args.push(`--window-position=${OFFSCREEN_POSITION}`, '--window-size=1365,900')
  return args
}

/** Причина, по которой обычное окно браузера не откроется, или null. */
export function displayProblem(platform: NodeJS.Platform, env: Env): string | null {
  if (platform !== 'linux') return null
  if ((env['DISPLAY'] ?? '').trim() !== '' || (env['WAYLAND_DISPLAY'] ?? '').trim() !== '') return null
  return 'нет графического дисплея (DISPLAY): Cloudflare не пропускает headless-браузер. '
    + 'Запустите бота в Docker-образе wtbot (там есть Xvfb) или через xvfb-run'
}

/**
 * Профиль, чьи процессы нельзя гасить: слишком общий путь совпал бы с чужими
 * браузерами, а личный профиль Edge/Chrome пользователя не наш ни при каких условиях.
 */
export function profileTooBroadToKill(profileDir: string): string | null {
  const dir = `${profileDir.replace(/\\/g, '/')}/`
  if (profileDir.length < 12 || !/\/.+\//.test(dir)) {
    return `Профиль ${profileDir} слишком общий — не снимаю чужие процессы браузера`
  }
  if (
    /\/AppData\/Local\/Microsoft\/Edge\//i.test(dir) ||
    /\/AppData\/Local\/Google\/Chrome\//i.test(dir) ||
    /\/\.config\/(?:microsoft-edge[^/]*|google-chrome[^/]*|chromium)\//.test(dir)
  ) {
    return 'WT_BROWSER_PROFILE_DIR указывает на личный профиль браузера — не трогаю его процессы'
  }
  return null
}

/**
 * PID процессов Linux, запущенных с нашим --user-data-dir (браузер и его
 * вспомогательные процессы). Читает /proc без shell; procRoot подменяется в тестах.
 */
export function findProfileBrowserPids(profileDir: string, procRoot = '/proc'): number[] {
  const marker = `--user-data-dir=${profileDir}`
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }
  const pids: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    let cmdline: string
    try {
      cmdline = readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8')
    } catch {
      // Процесс успел завершиться или недоступен — пропускаем.
      continue
    }
    if (cmdline.split('\0').some((arg) => arg === marker)) pids.push(pid)
  }
  return pids
}

/**
 * Сколько сетевых проб подряд может не пройти, пока DOM страницы выглядит
 * «чистым». Каждая проба — настоящий запрос к warthunder.com мимо общей очереди
 * с интервалом 1,5 с, поэтому бесконечный опрос бил бы по авторизованной сессии.
 */
export const MAX_FAILED_CLEARANCE_PROBES = 4

/** Пауза после n-й неудачной пробы: 0,5 → 1 → 2 → 4 с. */
export function clearanceProbeDelayMs(failedProbes: number): number {
  if (!Number.isSafeInteger(failedProbes) || failedProbes < 1) return 500
  return Math.min(4_000, 500 * 2 ** (failedProbes - 1))
}

/** Служебные файлы Chromium, которыми он помечает профиль как занятый. */
export const CHROMIUM_SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const

/**
 * Удаляет SingletonLock/Socket/Cookie профиля. Chromium записывает в них
 * «hostname-pid» и после перезапуска контейнера (другой hostname или тот же
 * PID у чужого процесса) считает профиль занятым — DevTools-порт тогда не
 * открывается никогда. Вызывать только когда процессов профиля нет:
 * одновременный запуск второго бота исключает process lock wtbot.
 */
export function removeChromiumSingletonFiles(profileDir: string): void {
  for (const name of CHROMIUM_SINGLETON_FILES) {
    rmSync(path.join(profileDir, name), { force: true })
  }
}
