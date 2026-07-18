import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Дисковый кэш частей реплея (.wrpl) и вежливое скачивание с CDN.
 *
 * Части неизменяемые, но живут на CDN ~2 недели, а сборки и пересборки
 * просят одни и те же файлы (кнопки, автоанонс, CLI); CDN отвечает 429
 * на частые запросы. Все скачивания идут через fetchReplayPart:
 * попадание — чтение data/replays/<sid>/NNNN.wrpl, промах — сеть с
 * ретраями на 429 и глобальной паузой между запросами, результат
 * пишется в кэш. Сессии старше REPLAY_CACHE_DAYS удаляются лениво при
 * первом обращении за процесс: кэш ускорительный, после чистки часть
 * можно скачать снова, пока она жива на CDN.
 */

const CACHE_DIR = './data/replays'
const REPLAY_CACHE_DAYS = 7
const FETCH_PAUSE_MS = 150

let cleanedUp = false
let lastFetchAt = 0

/** Путь кэша по URL части (…/<sessionIdHex>/0000.wrpl) или null */
function cacheFileFor(url: string): string | null {
  const m = /([0-9a-f]{12,20})\/(\d{4}\.wrpl)(?:\?.*)?$/i.exec(url)
  return m ? path.join(CACHE_DIR, m[1]!.toLowerCase(), m[2]!) : null
}

/** Часть реплея: с диска или с CDN (тогда кладётся в кэш) */
export async function fetchReplayPart(url: string): Promise<Buffer> {
  cleanupOnce()
  const file = cacheFileFor(url)
  if (file && existsSync(file)) return readFileSync(file)

  // вежливость к CDN: пауза между сетевыми запросами, общая на процесс
  const wait = lastFetchAt + FETCH_PAUSE_MS - Date.now()
  if (wait > 0) await sleep(wait)

  let attempt = 0
  for (;;) {
    lastFetchAt = Date.now()
    const res = await fetch(url)
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (file) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, buf)
      }
      return buf
    }
    if (res.status === 429 && attempt < 5) {
      attempt++
      await sleep(700 * attempt)
      continue
    }
    throw new Error(`HTTP ${res.status} при скачивании ${url}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Удаляет кэш частей одной сессии (после ingest — данные уже в БД) */
export function dropReplayCache(sessionIdHex: string): void {
  const dir = path.join(CACHE_DIR, sessionIdHex.toLowerCase())
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    // не смогли удалить — не критично, TTL-чистка снесёт позже
  }
}

/** Раз за процесс сносит сессии старше REPLAY_CACHE_DAYS */
function cleanupOnce(): void {
  if (cleanedUp) return
  cleanedUp = true
  if (!existsSync(CACHE_DIR)) return
  const deadline = Date.now() - REPLAY_CACHE_DAYS * 24 * 3600 * 1000
  for (const dir of readdirSync(CACHE_DIR)) {
    const p = path.join(CACHE_DIR, dir)
    try {
      if (statSync(p).mtimeMs < deadline) {
        rmSync(p, { recursive: true, force: true })
        console.log(`[replays] кэш частей ${dir} старше ${REPLAY_CACHE_DAYS} дн. удалён`)
      }
    } catch {
      // гонка удаления или битые права — сборке не мешаем
    }
  }
}
