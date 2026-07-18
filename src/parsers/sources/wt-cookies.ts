import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../../atomic-file.js'
import { config } from '../../config.js'

/** Асинхронный cookie jar со скользящей сессией и атомарной записью. */

const JAR_FILE = './data/wt-cookies.json'
const LOCK_FILE = `${JAR_FILE}.lock`
const LOCK_TIMEOUT_MS = 5_000
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

interface JarFileV2 {
  version: 2
  /** Хэш seed позволяет заметить новую WT_COOKIE, не дублируя секрет на диске. */
  seedHash: string
  cookies: Record<string, string>
}

interface LegacyJarFile {
  seed: string
  cookies: Record<string, string>
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

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task, task)
  queueTail = result.then(() => undefined, () => undefined)
  return result
}

async function currentJarUnlocked(): Promise<{ map: Map<string, string>; needsWrite: boolean }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(JAR_FILE, 'utf8'))
    if (isV2(parsed) && parsed.seedHash === seedHash()) {
      return { map: new Map(Object.entries(parsed.cookies)), needsWrite: false }
    }
    if (isLegacy(parsed) && parsed.seed === config.wtCookie) {
      return { map: new Map(Object.entries(parsed.cookies)), needsWrite: true }
    }
    console.log('[wt-cookies] В .env новая WT_COOKIE — начинаю сессию с неё')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  return { map: parseCookiePairs(config.wtCookie), needsWrite: true }
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

async function persistJarUnlocked(map: Map<string, string>): Promise<void> {
  const payload: JarFileV2 = { version: 2, seedHash: seedHash(), cookies: Object.fromEntries(map) }
  await writeFileAtomic(JAR_FILE, JSON.stringify(payload, null, 2), {
    fileMode: 0o600,
    directoryMode: 0o700,
    sync: true,
  })
}

async function withFileLock<T>(task: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let ownerToken = ''
  for (;;) {
    try {
      handle = await open(LOCK_FILE, 'wx', 0o600)
      ownerToken = randomUUID()
      try {
        await handle.writeFile(JSON.stringify({ ownerToken, pid: process.pid, createdAt: Date.now() }), 'utf8')
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        handle = null
        // Файл только что эксклюзивно создали мы; до его удаления другой
        // владелец появиться не может.
        await rm(LOCK_FILE, { force: true }).catch(() => undefined)
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(
          'таймаут блокировки cookie jar; если wtbot аварийно завершился, проверь и удали data/wt-cookies.json.lock',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)))
    }
  }
  try {
    return await task()
  } finally {
    await handle?.close().catch(() => undefined)
    await releaseOwnedLock(ownerToken).catch((error: unknown) => {
      console.warn(`[wt-cookies] не удалось освободить lock: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

async function releaseOwnedLock(ownerToken: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(LOCK_FILE, 'utf8')) as { ownerToken?: unknown }
    if (parsed.ownerToken === ownerToken) await rm(LOCK_FILE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

export function cookieHeader(): Promise<string> {
  return serialized(() =>
    withFileLock(async () => {
      const current = await currentJarUnlocked()
      if (current.needsWrite) await persistJarUnlocked(current.map)
      return [...current.map].map(([name, value]) => `${name}=${value}`).join('; ')
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
      if (changed) await persistJarUnlocked(next)
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
