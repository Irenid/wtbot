import { isIP } from 'node:net'

/**
 * Политика ссылок на части реплеев. URL приходят из JSON Replay API и из
 * сохранённых items, то есть это недоверенные данные: без проверки сервер
 * пошёл бы по любому адресу (SSRF в локальную сеть) и выделил бы массив на
 * произвольное число частей ещё до byte budget.
 *
 * Хост CDN в коде не зашит: его присылает API. Поэтому по умолчанию действуют
 * структурные проверки (http/https, домен вместо IP, без локальных имён, явных
 * портов и учётных данных). Они совпадают с форматом, который код и раньше
 * требовал от ссылок, поэтому не отсекают настоящий CDN. WT_REPLAY_HOSTS
 * дополнительно ограничивает хосты, но проверяется только при скачивании:
 * ошибка в настройке даёт обычную повторяемую ошибку ingest, а не терминальный
 * статус no_parts.
 */

/** Предел частей одного реплея: часть — около минуты боя, 256 с большим запасом. */
export const MAX_REPLAY_PARTS = 256
export const MAX_REPLAY_REDIRECTS = 3
const MAX_REPLAY_URL_LENGTH = 2_048
/** Имя части: 0000.wrpl, 0001.wrpl, … — так же его разбирает replay-cache. */
const PART_PATH_RE = /\/\d{4}\.wrpl$/i
/** Зарезервированные и внутрисетевые зоны, которых не бывает у публичного CDN. */
const LOCAL_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'test', 'invalid', 'example']

let allowedHosts: string[] = []
let allowInsecure = false

export interface ReplayUrlPolicyOptions {
  /** Допустимые хосты CDN: точное имя или домен-суффикс; пусто — только структурные проверки. */
  allowedHosts?: readonly string[]
  /** Разрешить IP-адреса, локальные имена и явные порты. Только для тестов и локальных benchmark. */
  allowInsecureForTests?: boolean
}

export function configureReplayUrlPolicy(options: ReplayUrlPolicyOptions): void {
  if (options.allowedHosts !== undefined) {
    allowedHosts = options.allowedHosts
      .map((host) => host.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
      .filter((host) => host !== '')
  }
  if (options.allowInsecureForTests !== undefined) allowInsecure = options.allowInsecureForTests
}

function isLocalHostname(hostname: string): boolean {
  if (!hostname.includes('.')) return true
  return LOCAL_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

function parseReplayUrl(raw: string): URL | string {
  if (raw.length > MAX_REPLAY_URL_LENGTH) return 'слишком длинный URL'
  try {
    return new URL(raw)
  } catch {
    return 'некорректный URL'
  }
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '')
}

/**
 * Структурная причина, по которой URL нельзя скачивать, или null.
 * requirePartPath — путь обязан указывать на файл части (для самих ссылок;
 * для перенаправлений нет). WT_REPLAY_HOSTS здесь не учитывается.
 */
export function replayUrlStructureProblem(raw: string, requirePartPath: boolean): string | null {
  const url = parseReplayUrl(raw)
  if (typeof url === 'string') return url
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `протокол ${url.protocol} не разрешён`
  if (url.username !== '' || url.password !== '') return 'учётные данные в URL не разрешены'
  if (!allowInsecure) {
    // Порт по умолчанию URL убирает сам; явный порт у публичного CDN не нужен.
    if (url.port !== '') return `порт ${url.port} не разрешён`
    // URL уже нормализует 2130706433, 0x7f.1 и подобные формы в обычный IPv4.
    const hostname = hostnameOf(url)
    if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return 'IP-адрес вместо доменного имени не разрешён'
    if (isLocalHostname(hostname)) return `локальный хост ${hostname} не разрешён`
  }
  if (requirePartPath && !PART_PATH_RE.test(url.pathname)) return 'путь не указывает на часть .wrpl'
  return null
}

/** Структурные проверки плюс allowlist WT_REPLAY_HOSTS — для фактического скачивания. */
export function replayUrlProblem(raw: string, requirePartPath: boolean): string | null {
  const structural = replayUrlStructureProblem(raw, requirePartPath)
  if (structural !== null || allowedHosts.length === 0) return structural
  const url = parseReplayUrl(raw)
  if (typeof url === 'string') return url
  const hostname = hostnameOf(url)
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    ? null
    : `хост ${hostname} не входит в WT_REPLAY_HOSTS`
}

export function assertReplayPartUrl(raw: string): void {
  const problem = replayUrlProblem(raw, true)
  if (problem !== null) throw new Error(`ссылка на часть WRPL отклонена: ${problem}`)
}

/**
 * Скачивание с ручным следованием перенаправлениям: каждый Location проходит
 * ту же проверку хоста, иначе CDN-редирект увёл бы запрос во внутреннюю сеть.
 */
export async function fetchReplayUrl(
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  let current = url
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current, { signal, redirect: 'manual', ...(headers ? { headers } : {}) })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (location === null) throw new Error(`HTTP ${response.status} без заголовка Location`)
    if (redirects >= MAX_REPLAY_REDIRECTS) throw new Error('слишком много перенаправлений при скачивании части WRPL')
    const next = new URL(location, current).toString()
    const problem = replayUrlProblem(next, false)
    if (problem !== null) throw new Error(`перенаправление части WRPL отклонено: ${problem}`)
    current = next
  }
}
