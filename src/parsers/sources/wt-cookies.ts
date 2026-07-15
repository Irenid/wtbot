import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { config } from '../../config.js'

/**
 * Мини-«cookie jar» для warthunder.com.
 *
 * Сессия сайта скользящая: на каждый запрос сервер отвечает Set-Cookie
 * с новым сроком `_identity` (+14 дней). Браузер эти обновления подхватывает —
 * потому и не разлогинивается месяцами. Делаем то же самое: стартуем от
 * WT_COOKIE из .env, а актуальные куки храним в data/wt-cookies.json.
 * Пока бот запускается хотя бы раз в 14 дней, сессия продлевается сама.
 *
 * Если в .env вставили новую куку (после смены пароля или долгого простоя),
 * поле `seed` в файле перестанет совпадать с WT_COOKIE — состояние
 * пересоздастся от свежей куки автоматически.
 */

const JAR_FILE = './data/wt-cookies.json'

interface JarFile {
  /** Копия WT_COOKIE, от которой создано состояние, — чтобы заметить новую куку в .env */
  seed: string
  cookies: Record<string, string>
}

let jar: Map<string, string> | null = null
let refreshLogged = false

/** Разбирает строку вида «name=value; name2=value2» (формат WT_COOKIE в .env) */
function parseCookiePairs(header: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) map.set(name, value)
  }
  return map
}

function loadJar(): Map<string, string> {
  if (jar) return jar
  if (existsSync(JAR_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(JAR_FILE, 'utf8')) as JarFile
      if (saved.seed === config.wtCookie && saved.cookies && typeof saved.cookies === 'object') {
        jar = new Map(Object.entries(saved.cookies))
        return jar
      }
      console.log('[wt-cookies] В .env новая WT_COOKIE — начинаю сессию с неё')
    } catch {
      // файл битый — молча пересоздадим от .env
    }
  }
  jar = parseCookiePairs(config.wtCookie)
  saveJar(jar)
  return jar
}

function saveJar(map: Map<string, string>): void {
  mkdirSync('./data', { recursive: true })
  const file: JarFile = { seed: config.wtCookie, cookies: Object.fromEntries(map) }
  writeFileSync(JAR_FILE, JSON.stringify(file, null, 2))
}

/** Заголовок Cookie из актуального состояния сессии */
export function cookieHeader(): string {
  return [...loadJar()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** Подхватывает обновлённые куки из ответа сервера — так сессия продлевается */
export function absorbSetCookies(res: Response): void {
  const headers = res.headers.getSetCookie()
  if (headers.length === 0) return
  const map = loadJar()
  let changed = false
  for (const header of headers) {
    const [pair = '', ...attrs] = header.split(';')
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    if (isDeletion(attrs)) {
      if (map.delete(name)) changed = true
    } else if (map.get(name) !== value) {
      map.set(name, value)
      changed = true
    }
  }
  if (!changed) return
  saveJar(map)
  if (!refreshLogged) {
    refreshLogged = true
    console.log('[wt-cookies] Сервер продлил сессию — куки сохранены в data/wt-cookies.json')
  }
}

/** Max-Age<=0 или expires в прошлом — так сервер приказывает удалить куку */
function isDeletion(attrs: string[]): boolean {
  for (const raw of attrs) {
    const eq = raw.indexOf('=')
    if (eq < 0) continue
    const key = raw.slice(0, eq).trim().toLowerCase()
    const value = raw.slice(eq + 1).trim()
    if (key === 'max-age' && Number.isFinite(Number(value)) && Number(value) <= 0) return true
    if (key === 'expires') {
      const date = Date.parse(value)
      if (!Number.isNaN(date) && date < Date.now()) return true
    }
  }
  return false
}
