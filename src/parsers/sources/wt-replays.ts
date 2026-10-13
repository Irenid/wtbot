import { config } from '../../config.js'
import { hasItem, type ParsedItem } from '../../db/index.js'
import { readResponseJson } from '../../http-response.js'
import type { ParserSource } from '../types.js'
import {
  fetchWtResponse,
  retryAfterWtSessionRefresh,
  WtRequestError,
  WT_USER_AGENT,
} from './wt-request.js'

/**
 * War Thunder squadron battle replays (warthunder.com/en/tournament/replay/).
 *
 * POST /en/api/replay returns pages of recent battles (20 a page),
 * GET /en/api/replay/{sessionId} the links to the replay files (.wrpl).
 *
 * The API answers an anonymous visitor HTTP 200 with an empty list, so it
 * needs a signed-in session: WT_COOKIE seeds the jar (wt-cookies.ts). A
 * sign-in lives 14 days however often it is used (identity_sid rotates in
 * responses, the sign-in does not slide); wt-request.ts renews it through
 * Gaijin (wt-sign-in.ts). When that fails the source fails with the advice in
 * collectFreshReplays, on the dashboard and in /stats.
 */

const LIST_URL = 'https://warthunder.com/en/api/replay'

interface WtPlayer {
  userId: string
  name: string
  fakeName: string
}

export interface WtReplay {
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

export interface WtListResponse {
  items: WtReplay[]
  count: number
  total_count: number
}

/** Больше элементов на странице API не отдаёт (limit: 20); запас на случай изменения. */
const MAX_ITEMS_PER_PAGE = 100
const MAX_REPLAY_TEXT_LENGTH = 2_048

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_REPLAY_TEXT_LENGTH
}

/**
 * Минимальная runtime-схема записи Replay API: TypeScript-тип JSON не
 * проверяет. Поля, которые сразу используются (id, время, заголовок, ссылки),
 * должны иметь ожидаемые типы; ссылки и число частей дополнительно проверяет
 * resolveReplayPartUrls при скачивании.
 */
export function isWellFormedReplay(value: unknown): value is WtReplay {
  if (typeof value !== 'object' || value === null) return false
  const replay = value as Record<string, unknown>
  return typeof replay['sessionId'] === 'string'
    && /^\d{1,20}$/.test(replay['sessionId'])
    && typeof replay['startTime'] === 'number'
    && Number.isFinite(replay['startTime'])
    && isShortString(replay['missionName'])
    && isShortString(replay['gameMode'])
    && isShortString(replay['url'])
    && typeof replay['partsCount'] === 'number'
    && (replay['players'] === undefined || (typeof replay['players'] === 'object' && replay['players'] !== null))
}

function assertListResponse(data: WtListResponse, label: string): void {
  if (typeof data !== 'object' || data === null || !Array.isArray(data.items)
    || typeof data.total_count !== 'number' || data.items.length > MAX_ITEMS_PER_PAGE) {
    throw new Error(`${label}: неожиданный формат ответа Replay API`)
  }
}

interface WtDetailResponse {
  replay?: WtReplay
  replay_parts?: string[]
}

function baseHeaders(): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'user-agent': WT_USER_AGENT,
    referer: 'https://warthunder.com/en/tournament/replay/',
  }
}

async function requireJsonContentType(response: Response, label: string): Promise<void> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('json')) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label}: сервер вернул не JSON (Content-Type: ${contentType || 'отсутствует'})`)
  }
}

async function fetchPage(page: number): Promise<WtListResponse> {
  const res = await fetchWtResponse(LIST_URL, {
    method: 'POST',
    headers: { ...baseHeaders(), 'content-type': 'application/json' },
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
  }, `список replay, страница ${page}`)
  await requireJsonContentType(res, `список replay, страница ${page}`)
  return readResponseJson<WtListResponse>(res, 4 * 1024 * 1024, `список replay, страница ${page}`)
}

/** Ссылки на файлы .wrpl реплея; при ошибке — null, реплей сохранится без них */
async function fetchParts(sessionId: string): Promise<string[] | null> {
  let res: Response
  try {
    res = await fetchWtResponse(`${LIST_URL}/${sessionId}`, {
      headers: baseHeaders(),
      signal: AbortSignal.timeout(20_000),
    }, `детали replay ${sessionId}`)
  } catch (error) {
    if (error instanceof WtRequestError && [401, 403, 429].includes(error.status)) throw error
    return null
  }
  try {
    await requireJsonContentType(res, `детали replay ${sessionId}`)
    const detail = await readResponseJson<WtDetailResponse>(res, 2 * 1024 * 1024, 'детали replay')
    return detail.replay_parts ?? null
  } catch {
    return null
  }
}

export interface ReplayCollectionDeps {
  hasCookie(): boolean
  fetchPage(page: number): Promise<WtListResponse>
  fetchParts(sessionId: string): Promise<string[] | null>
  isKnownReplay(sessionId: string): boolean
  retryFirstPage(
    request: () => Promise<WtListResponse>,
    isInvalid: (response: WtListResponse) => boolean,
    label: string,
  ): Promise<WtListResponse>
}

const DEFAULT_COLLECTION_DEPS: ReplayCollectionDeps = {
  hasCookie: () => config.wtCookie !== '',
  fetchPage,
  fetchParts,
  isKnownReplay: (sessionId) => hasItem('wt-replays', sessionId),
  retryFirstPage: retryAfterWtSessionRefresh,
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
  /** Отмена обхода при остановке планировщика; проверяется между запросами. */
  signal?: AbortSignal | undefined
}

export interface CollectResult {
  items: ParsedItem[]
  totalOnSite: number
  pagesRead: number
  /** Записи API, отброшенные runtime-схемой. */
  rejected: number
  /** true — упёрлись в maxPages, не встретив границы (известный бой/дата) */
  hitCap: boolean
}

/**
 * Catch-up pages per cycle (20 replays a page): while pages are entirely new
 * the walk goes on to the first stored battle. Requests run one after another
 * through the shared queue, so a long catch-up adds no parallel load.
 */
export const PLANNED_REPLAYS_MAX_PAGES = 50

/**
 * Pages through the battle list and collects battles the database lacks.
 * While a page is entirely new it goes on (catching up after downtime); the
 * limits are maxPages, the first known battle (incremental mode) and sinceTs.
 */
export async function collectFreshReplays(
  opts: CollectOpts,
  deps: ReplayCollectionDeps = DEFAULT_COLLECTION_DEPS,
): Promise<CollectResult> {
  if (opts.maxPages !== undefined && (!Number.isInteger(opts.maxPages) || opts.maxPages < 1)) {
    throw new RangeError('maxPages must be a positive integer')
  }
  if (opts.sinceTs !== undefined && (!Number.isSafeInteger(opts.sinceTs) || opts.sinceTs < 0)) {
    throw new RangeError('sinceTs must be a non-negative Unix time')
  }
  if (!deps.hasCookie()) {
    throw new Error('WT_COOKIE is not set in .env: copy the identity_* cookies from a browser (see .env.example)')
  }

  const fresh: WtReplay[] = []
  let totalOnSite = 0
  let pagesRead = 0
  let rejected = 0
  let hitCap = true // cleared when the walk stops at a normal boundary, not at the cap
  // Pages depend on each other: each may stop the walk (known, cutoff, cap),
  // and the transport sends requests through the shared queue anyway.
  for (let page = 1; opts.maxPages === undefined || page <= opts.maxPages; page++) {
    opts.signal?.throwIfAborted()
    const data = page === 1
      ? await deps.retryFirstPage(
          () => deps.fetchPage(page),
          (response) => response.total_count === 0 && response.items.length === 0,
          'Replay API returned an empty list',
        )
      : await deps.fetchPage(page)
    assertListResponse(data, `replay list, page ${page}`)
    totalOnSite = data.total_count
    pagesRead = page
    if (page === 1 && data.total_count === 0 && data.items.length === 0) {
      throw new Error(
        'API returned an empty list: the WT session expired and renewing it failed; sign in once at '
        + 'https://login.gaijin.net in the bot\'s browser (VNC, README) or update WT_COOKIE in .env',
      )
    }

    let reachedCutoff = false
    let unseenOnPage = 0
    const wellFormed = data.items.filter(isWellFormedReplay)
    rejected += data.items.length - wellFormed.length
    for (const replay of wellFormed) {
      if (opts.sinceTs !== undefined && replay.startTime < opts.sinceTs) {
        reachedCutoff = true
        continue
      }
      if (!deps.isKnownReplay(replay.sessionId)) {
        fresh.push(replay)
        unseenOnPage++
      }
    }

    if (reachedCutoff) { hitCap = false; break } // reached the date boundary
    if (data.items.length < 20) { hitCap = false; break } // the list's last page
    // a known battle: everything after it is collected already (incremental)
    if (opts.stopAtKnown && unseenOnPage < wellFormed.length) { hitCap = false; break }
  }

  const items: ParsedItem[] = []
  // Details go through the shared rate-limited transport too: a fan-out would
  // only pile up waiting promises without more throughput.
  for (const replay of fresh) {
    let parts: string[] | null = null
    if (opts.fetchDetails !== false) {
      opts.signal?.throwIfAborted()
      parts = await deps.fetchParts(replay.sessionId)
    }
    items.push({
      externalId: replay.sessionId,
      title: `[${replay.gameMode}] ${replay.missionName.trim()}`,
      // parts === null: replayPartUrls builds the links from url + partsCount
      data: { ...replay, replayParts: parts },
    })
  }

  return { items, totalOnSite, pagesRead, hitCap, rejected }
}

export const wtReplays: ParserSource = {
  name: 'wt-replays',
  // Частый опрос дешёвый: парсинг инкрементальный, без новых реплеев
  // это один запрос первой страницы списка
  intervalMs: 20_000,
  async run(signal) {
    // Догон: листаем до первого уже сохранённого боя. Планировщик не допускает
    // параллельных запусков этого source, а запросы ограничены паузой 1,5 с.
    const { items, totalOnSite, pagesRead, hitCap, rejected } = await collectFreshReplays({
      maxPages: PLANNED_REPLAYS_MAX_PAGES,
      stopAtKnown: true,
      signal,
      // Точные URL частей восстанавливаются из url + partsCount. Отдельный
      // запрос на каждый новый бой замедляет догон и быстро приводит к 429.
      fetchDetails: false,
    })

    let summary = `Новых реплеев: ${items.length} (всего на сайте: ${totalOnSite})`
    if (pagesRead > 1) summary += ` · прочитано страниц: ${pagesRead}`
    if (hitCap) summary += ` · достигнут предел ${PLANNED_REPLAYS_MAX_PAGES} страниц`
    if (rejected > 0) summary += ` · отброшено некорректных записей API: ${rejected}`
    return { summary, items }
  },
}
