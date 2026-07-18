import { readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { readResponseBuffer } from '../http-response.js'

/** Асинхронный дисковый cache частей replay и вежливое скачивание с CDN. */

const CACHE_DIR = './data/replays'
const REPLAY_CACHE_DAYS = 7
const FETCH_PAUSE_MS = 150
const FETCH_TIMEOUT_MS = 30_000
const MAX_PART_BYTES = 96 * 1024 * 1024
const WRPL_HEADER_BYTES = 1234

let cleanupStarted = false
let lastFetchAt = 0
let throttleTail: Promise<void> = Promise.resolve()
const sessionTails = new Map<string, Promise<void>>()

function cacheFileFor(url: string): string | null {
  const match = /([0-9a-f]{12,20})\/(\d{4}\.wrpl)(?:\?.*)?$/i.exec(url)
  return match ? path.join(CACHE_DIR, match[1]!.toLowerCase(), match[2]!) : null
}

export function fetchReplayPart(url: string): Promise<Buffer> {
  startCleanup()
  const file = cacheFileFor(url)
  const session = file ? path.basename(path.dirname(file)) : null
  // Buffer передаётся worker'у с detach backing ArrayBuffer, поэтому он не
  // разделяется между callers. Session-lock заставит второй запрос прочитать
  // уже опубликованный cache-файл и получить собственный Buffer.
  return session
    ? withSessionLock(session, () => doFetchReplayPart(url, file))
    : doFetchReplayPart(url, file)
}

async function doFetchReplayPart(url: string, file: string | null): Promise<Buffer> {
  if (file) {
    let cached: Buffer | null = null
    try {
      cached = await readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (cached) {
      try {
        validateReplayPart(cached, `cache ${path.basename(file)}`)
        return cached
      } catch {
        // Битый cache удаляем и один раз восстанавливаем с CDN.
        await rm(file, { force: true }).catch(() => undefined)
      }
    }
  }

  for (let attempt = 0; ; attempt++) {
    await reserveFetchSlot()
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.ok) {
      const data = await readResponseBuffer(response, MAX_PART_BYTES, 'часть WRPL')
      validateReplayPart(data, safeUrlLabel(url))
      if (file) await writeFileAtomic(file, data)
      return data
    }
    if (response.status === 429 && attempt < 5) {
      await response.body?.cancel().catch(() => undefined)
      await sleep(retryDelay(response, attempt))
      continue
    }
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status} при скачивании ${safeUrlLabel(url)}`)
  }
}

function validateReplayPart(data: Buffer, source: string): void {
  if (data.length < WRPL_HEADER_BYTES) throw new Error(`${source}: файл короче заголовка WRPL (${data.length} байт)`)
  if (data.length > MAX_PART_BYTES) throw new Error(`${source}: часть WRPL больше лимита (${data.length} байт)`)
  if (!(data[0] === 0xe5 && data[1] === 0xac && data[2] === 0x00 && data[3] === 0x10)) {
    throw new Error(`${source}: ответ не является WRPL`)
  }
}

function reserveFetchSlot(): Promise<void> {
  const reservation = throttleTail.then(async () => {
    const waitMs = lastFetchAt + FETCH_PAUSE_MS - Date.now()
    if (waitMs > 0) await sleep(waitMs)
    lastFetchAt = Date.now()
  })
  throttleTail = reservation.catch(() => undefined)
  return reservation
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000)
  return 700 * (attempt + 1)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function dropReplayCache(sessionIdHex: string): Promise<void> {
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return
  const directory = path.resolve(CACHE_DIR, sessionIdHex.toLowerCase())
  const root = path.resolve(CACHE_DIR) + path.sep
  if (!directory.startsWith(root)) return
  await withSessionLock(sessionIdHex.toLowerCase(), () =>
    rm(directory, { recursive: true, force: true }).catch(() => undefined),
  )
}

function startCleanup(): void {
  if (cleanupStarted) return
  cleanupStarted = true
  void cleanupExpired().catch((error: unknown) => {
    console.warn(`[replays] не удалось очистить cache: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function cleanupExpired(): Promise<void> {
  let directories
  try {
    directories = await readdir(CACHE_DIR, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const deadline = Date.now() - REPLAY_CACHE_DAYS * 24 * 3600 * 1000
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^[0-9a-f]{12,20}$/i.test(entry.name)) continue
    const directory = path.join(CACHE_DIR, entry.name)
    await withSessionLock(entry.name.toLowerCase(), async () => {
      try {
        if ((await stat(directory)).mtimeMs < deadline) {
          await rm(directory, { recursive: true, force: true })
          console.log(`[replays] cache частей ${entry.name} старше ${REPLAY_CACHE_DAYS} дн. удалён`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
}

/** Последовательно выполняет запись/drop/cleanup одной replay-сессии. */
function withSessionLock<T>(session: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(session) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(task)
  const tail = result.then(() => undefined, () => undefined)
  sessionTails.set(session, tail)
  return result.finally(() => {
    if (sessionTails.get(session) === tail) sessionTails.delete(session)
  })
}

function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host}${url.pathname}`
  } catch {
    return 'WRPL CDN'
  }
}
