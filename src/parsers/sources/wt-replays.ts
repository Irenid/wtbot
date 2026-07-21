import { config } from '../../config.js'
import { hasItem, type ParsedItem } from '../../db/index.js'
import { readResponseJson } from '../../http-response.js'
import type { ParserSource } from '../types.js'
import { absorbSetCookies, cookieHeader } from './wt-cookies.js'

/**
 * Реплеи клановых боёв War Thunder (warthunder.com/en/tournament/replay/).
 *
 * POST /en/api/replay отдаёт страницы последних боёв (20 на страницу),
 * GET /en/api/replay/{sessionId} — ссылки на файлы реплея (.wrpl).
 *
 * Анонимам API отвечает 200, но с пустым списком, поэтому нужна кука
 * залогиненной сессии — WT_COOKIE в .env. Сессия скользящая: каждый ответ
 * сервера несёт Set-Cookie с новым сроком (+14 дней), их подхватывает
 * wt-cookies.ts — так что куку достаточно вставить один раз, дальше она
 * продлевается сама, пока бот запускается хотя бы раз в 14 дней.
 * Если сессия всё же истечёт (долгий простой, смена пароля), источник
 * упадёт с понятной ошибкой — её видно на дашборде и в /stats,
 * после обновления WT_COOKIE в .env всё продолжится само.
 */

const LIST_URL = 'https://warthunder.com/en/api/replay'
// Cloudflare сверяет user-agent с сессией браузера, из которого взята кука
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
/**
 * Предел страниц догона за один цикл (20 реплеев на странице). Пока
 * страницы целиком новые — бот продолжает листать до первого уже сохранённого
 * боя. Запросы последовательны и ограничены паузой, поэтому долгий догон не
 * создаёт параллельную нагрузку на API.
 */
/** Минимальный интервал между любыми запросами replay API. */
const REQUEST_INTERVAL_MS = 1_500
const RATE_LIMIT_RETRIES = 2
const DEFAULT_RATE_LIMIT_DELAY_MS = 30_000

interface WtPlayer {
  userId: string
  name: string
  fakeName: string
}

interface WtReplay {
  sessionId: string
  missionName: string
  startTime: number
  endTime: number
  url: string
  gameVersion: string
  gameType: string
  gameMode: string
  statisticGroup: string
  partsCount: number
  players: Record<string, WtPlayer[]>
}

interface WtListResponse {
  items: WtReplay[]
  count: number
  total_count: number
}

interface WtDetailResponse {
  replay?: WtReplay
  replay_parts?: string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let nextRequestAt = 0

async function waitForRequestSlot(): Promise<void> {
  const waitMs = nextRequestAt - Date.now()
  if (waitMs > 0) await sleep(waitMs)
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS
}

function retryAfterMs(res: Response): number {
  const value = res.headers.get('retry-after')
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  return DEFAULT_RATE_LIMIT_DELAY_MS
}

async function baseHeaders(): Promise<Record<string, string>> {
  return {
    accept: 'application/json, text/plain, */*',
    'user-agent': UA,
    referer: 'https://warthunder.com/en/tournament/replay/',
    cookie: await cookieHeader(),
  }
}

async function fetchPage(page: number): Promise<WtListResponse> {
  for (let attempt = 0; ; attempt++) {
    await waitForRequestSlot()
    const headers = await baseHeaders()
    const res = await fetch(LIST_URL, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    // Тело повторяет запрос сайта; при пустых timeRangeFrom/To
    // поля дат игнорируются и API отдаёт просто последние бои
      body: JSON.stringify({
      gameMode: ['arcade', 'realistic', 'simulation'],
      gameType: 'clanBattle',
      techType: 'all',
      findMissionValue: '',
      findUserValue: '',
      findUserType: 'USERNAME',
      isUserOwnReplays: false,
      rankRange: '',
      timeRangeFrom: '',
      timeRangeTo: '',
      timeRangeFromDay: 8,
      timeRangeFromMonth: 2,
      timeRangeFromTime: '10:00',
      timeRangeToDay: 10,
      timeRangeToMonth: 5,
      timeRangeToTime: '14:00',
      limit: 20,
      page,
      }),
    })
    await absorbSetCookies(res)
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const delayMs = retryAfterMs(res)
      await res.body?.cancel().catch(() => undefined)
      nextRequestAt = Math.max(nextRequestAt, Date.now() + delayMs)
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`HTTP ${res.status} на странице ${page}`)
    }
    return readResponseJson<WtListResponse>(res, 4 * 1024 * 1024, `список replay, страница ${page}`)
  }
}

/** Ссылки на файлы .wrpl реплея; при ошибке — null, реплей сохранится без них */
async function fetchParts(sessionId: string): Promise<string[] | null> {
  await waitForRequestSlot()
  const headers = await baseHeaders()
  let res: Response
  try {
    res = await fetch(`${LIST_URL}/${sessionId}`, { headers, signal: AbortSignal.timeout(20_000) })
  } catch {
    return null
  }
  await absorbSetCookies(res)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  try {
    const detail = await readResponseJson<WtDetailResponse>(res, 2 * 1024 * 1024, 'детали replay')
    return detail.replay_parts ?? null
  } catch {
    return null
  }
}

export interface CollectOpts {
  /** Предел страниц; без значения листаем до нормальной границы. */
  maxPages?: number | undefined
  /**
   * true — оборвать обход, как только на странице встретился уже известный
   * бой (инкрементальный режим: догоняем от новых к последнему виденному).
   * false — идти дальше, ограничиваясь maxPages/sinceTs (бэкфилл).
   */
  stopAtKnown: boolean
  /** Не собирать бои, начавшиеся раньше этого unix-времени (бэкфилл по дате) */
  sinceTs?: number | undefined
  /**
   * Дозапрашивать точные ссылки на .wrpl отдельным запросом на каждый бой.
   * По умолчанию да (инкрементально — заодно подтверждает готовность свежего
   * боя). Для бэкфилла тысяч боёв — false: ссылки строятся из url+partsCount
   * (проверено — совпадают), лишние N запросов не нужны.
   */
  fetchDetails?: boolean | undefined
}

export interface CollectResult {
  items: ParsedItem[]
  totalOnSite: number
  pagesRead: number
  /** true — упёрлись в maxPages, не встретив границы (известный бой/дата) */
  hitCap: boolean
}

/**
 * Листает список боёв и собирает те, которых ещё нет в БД. Пока страница
 * целиком новая — листает дальше (догон после простоя), пределы — maxPages,
 * первый известный бой (в инкрементальном режиме) и дата sinceTs.
 */
export async function collectFreshReplays(opts: CollectOpts): Promise<CollectResult> {
  if (!config.wtCookie) {
    throw new Error('WT_COOKIE не задан в .env — скопируй куки identity_* из браузера (см. README)')
  }

  const fresh: WtReplay[] = []
  let totalOnSite = 0
  let pagesRead = 0
  let hitCap = true // сбросится, если выйдем по нормальной границе, а не по пределу
  for (let page = 1; opts.maxPages === undefined || page <= opts.maxPages; page++) {
    const data = await fetchPage(page)
    totalOnSite = data.total_count
    pagesRead = page
    if (page === 1 && data.total_count === 0) {
      throw new Error('API вернул пустой список — похоже, сессия истекла: обнови WT_COOKIE в .env')
    }

    let reachedCutoff = false
    let unseenOnPage = 0
    for (const replay of data.items) {
      if (opts.sinceTs !== undefined && replay.startTime < opts.sinceTs) {
        reachedCutoff = true
        continue
      }
      if (!hasItem('wt-replays', replay.sessionId)) {
        fresh.push(replay)
        unseenOnPage++
      }
    }

    if (reachedCutoff) { hitCap = false; break } // дошли до даты-границы
    if (data.items.length < 20) { hitCap = false; break } // последняя страница списка
    // встретили известный бой — дальше только уже собранное (инкрементально)
    if (opts.stopAtKnown && unseenOnPage < data.items.length) { hitCap = false; break }
  }

  const items: ParsedItem[] = []
  for (const replay of fresh) {
    let parts: string[] | null = null
    if (opts.fetchDetails !== false) {
      parts = await fetchParts(replay.sessionId)
    }
    items.push({
      externalId: replay.sessionId,
      title: `[${replay.gameMode}] ${replay.missionName.trim()}`,
      // parts === null → ссылки построит replayPartUrls из url+partsCount
      data: { ...replay, replayParts: parts },
    })
  }

  return { items, totalOnSite, pagesRead, hitCap }
}

export const wtReplays: ParserSource = {
  name: 'wt-replays',
  // Частый опрос дешёвый: парсинг инкрементальный, без новых реплеев
  // это один запрос первой страницы списка
  intervalMs: 20_000,
  async run() {
    // Догон: листаем до первого уже сохранённого боя. Планировщик не допускает
    // параллельных запусков этого source, а запросы ограничены паузой 1,5 с.
    const { items, totalOnSite, pagesRead } = await collectFreshReplays({
      stopAtKnown: true,
      // Точные URL частей восстанавливаются из url + partsCount. Отдельный
      // запрос на каждый новый бой замедляет догон и быстро приводит к 429.
      fetchDetails: false,
    })

    let summary = `Новых реплеев: ${items.length} (всего на сайте: ${totalOnSite})`
    if (pagesRead > 1) summary += ` · прочитано страниц: ${pagesRead}`
    return { summary, items }
  },
}
