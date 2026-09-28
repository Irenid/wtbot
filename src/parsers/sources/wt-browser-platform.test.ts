import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  browserExecutableCandidates,
  browserSpawnArgs,
  CHROMIUM_SINGLETON_FILES,
  clearanceProbeDelayMs,
  displayProblem,
  MAX_FAILED_CLEARANCE_PROBES,
  findProfileBrowserPids,
  profileTooBroadToKill,
  removeChromiumSingletonFiles,
} from './wt-browser-platform.js'

test('кандидаты браузера: явный путь первым, Edge на Windows, Chromium на Linux', () => {
  const windows = browserExecutableCandidates('win32', { ProgramFiles: 'C:/PF' }, 'D:/edge/msedge.exe')
  assert.equal(windows[0], 'D:/edge/msedge.exe')
  assert.ok(windows.includes('C:/PF/Microsoft/Edge/Application/msedge.exe'))
  assert.ok(windows.every((candidate) => !candidate.startsWith('/usr/')))

  const linux = browserExecutableCandidates('linux', {}, '')
  assert.ok(linux.includes('/usr/bin/chromium'))
  assert.ok(linux.includes('/usr/bin/microsoft-edge-stable'))
  assert.ok(linux.every((candidate) => !candidate.endsWith('.exe')))
  assert.equal(new Set(linux).size, linux.length)
})

test('флаги браузера: Linux-контейнер получает shm, keyring и sandbox флаги', () => {
  const base = { port: 9222, profileDir: '/app/data/wt-browser-profile', offscreen: true }
  const linux = browserSpawnArgs({ ...base, noSandbox: true, platform: 'linux' })
  assert.ok(linux.includes('--disable-dev-shm-usage'))
  assert.ok(linux.includes('--password-store=basic'))
  assert.ok(linux.includes('--no-sandbox'))
  assert.ok(linux.includes('--user-data-dir=/app/data/wt-browser-profile'))
  assert.ok(linux.includes('--remote-debugging-address=127.0.0.1'))
  assert.ok(linux.some((arg) => arg.startsWith('--window-position=')))
  assert.ok(!linux.some((arg) => arg.startsWith('--headless')))

  const windows = browserSpawnArgs({ ...base, noSandbox: false, offscreen: false, platform: 'win32' })
  assert.ok(!windows.includes('--no-sandbox'))
  assert.ok(!windows.includes('--disable-dev-shm-usage'))
  assert.ok(!windows.some((arg) => arg.startsWith('--window-position=')))
})

test('без X-дисплея на Linux браузер не запускается с понятной причиной', () => {
  assert.match(displayProblem('linux', {}) ?? '', /DISPLAY/)
  assert.equal(displayProblem('linux', { DISPLAY: ':99' }), null)
  assert.equal(displayProblem('linux', { WAYLAND_DISPLAY: 'wayland-0' }), null)
  assert.equal(displayProblem('win32', {}), null)
})

test('личные и слишком общие профили браузера не гасятся', () => {
  assert.equal(profileTooBroadToKill('/app/data/wt-browser-profile'), null)
  assert.equal(profileTooBroadToKill('D:\\GITproject\\wtbot\\data\\wt-browser-profile'), null)
  assert.match(profileTooBroadToKill('/tmp') ?? '', /слишком общий/)
  assert.match(
    profileTooBroadToKill('C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data') ?? '',
    /личный профиль/,
  )
  assert.match(profileTooBroadToKill('/home/me/.config/google-chrome') ?? '', /личный профиль/)
  assert.match(profileTooBroadToKill('/home/me/.config/chromium/Default') ?? '', /личный профиль/)
})

test('процессы профиля ищутся по точному --user-data-dir в /proc', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-proc-'))
  try {
    const profile = '/app/data/wt-browser-profile'
    const proc = (pid: string, args: string[] | null) => {
      mkdirSync(path.join(root, pid), { recursive: true })
      if (args !== null) writeFileSync(path.join(root, pid, 'cmdline'), `${args.join('\0')}\0`)
    }
    proc('101', ['/usr/bin/chromium', `--user-data-dir=${profile}`, '--no-sandbox'])
    proc('102', ['/usr/lib/chromium/chromium', '--type=renderer', `--user-data-dir=${profile}`])
    proc('103', ['/usr/bin/chromium', `--user-data-dir=${profile}-other`])
    proc('104', ['node', 'dist/index.js'])
    proc('105', null) // процесс завершился между readdir и чтением cmdline
    proc('self', ['ignored'])
    assert.deepEqual(findProfileBrowserPids(profile, root).sort(), [101, 102])
    assert.deepEqual(findProfileBrowserPids(profile, path.join(root, 'missing')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('пробы Cloudflare: растущая пауза и конечный предел', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(clearanceProbeDelayMs), [500, 1_000, 2_000, 4_000, 4_000])
  assert.equal(clearanceProbeDelayMs(0), 500)
  // Весь бюджет неудачных проб укладывается в несколько запросов, а не в десятки.
  assert.ok(MAX_FAILED_CLEARANCE_PROBES <= 5)
})

test('Singleton-файлы Chromium удаляются из профиля', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-profile-'))
  try {
    for (const name of CHROMIUM_SINGLETON_FILES) writeFileSync(path.join(root, name), 'old-host-42')
    writeFileSync(path.join(root, 'Cookies'), 'keep')
    removeChromiumSingletonFiles(root)
    for (const name of CHROMIUM_SINGLETON_FILES) assert.equal(existsSync(path.join(root, name)), false)
    assert.equal(existsSync(path.join(root, 'Cookies')), true)
    // Повторный вызов без файлов не падает.
    removeChromiumSingletonFiles(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
