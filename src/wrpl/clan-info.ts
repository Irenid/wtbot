import {
  getClanSeasonContext,
  getClanNameByTag,
  getClanRatingsWithDelta,
  saveClanRatingSnapshots,
  type ClanRating,
} from '../db/index.js'
import { mapConcurrent } from '../concurrency.js'
import { decodeHtmlEntities } from '../html-text.js'
import { readResponseText } from '../http-response.js'
import { deferRequestSlot, retryAfterMs, waitForRequestSlot } from '../parsers/sources/wt-request.js'

/**
 * Личный клановый рейтинг (ПКР) участников — со страницы клана
 * warthunder.com/en/community/claninfo/<имя> (публичная, куки не нужны).
 *
 * Cloudflare эту страницу не проверяет, поэтому она читается обычным fetch,
 * без браузерного транспорта и cookie jar. Но интервал между запросами и пауза
 * после 429 общие для всего warthunder.com: запрос берёт слот общей очереди.
 *
 * Имя клана берётся из словаря clans (его наполняет источник wt-clans
 * по лидерборду), сам рейтинг — из таблицы участников на странице.
 * Каждый успешный запрос кладёт снимок в clan_rating_snapshots, и дельта
 * «сколько получил/потерял» — это разница двух последних снимков ника.
 * Пока снимок один (первый рендер клана), дельты нет — только рейтинг.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
/** Не дёргать страницу клана чаще, чем раз в 2 минуты (спам-рендеры одного боя) */
const COOLDOWN_MS = 2 * 60_000
/** Клан, чья страница не открылась, не запрашивается снова до конца паузы. */
const FAILURE_COOLDOWN_MS = 10 * 60_000
/**
 * 404 подряд у стольких разных кланов значит, что страницы кланов отключены
 * на сайте целиком (так было 2026-09-29), — запросы claninfo встают на паузу,
 * а каждый рендер боя берёт ПКР из сохранённых снимков.
 */
const PAGES_DOWN_THRESHOLD = 3
const PAGES_DOWN_PAUSE_MS = 60 * 60_000
const CLAN_FETCH_CONCURRENCY = 4

/** Очередь запросов к warthunder.com: слот перед запросом и пауза после 429. */
export interface WtRequestQueue {
  wait(): Promise<void>
  defer(delayMs: number): void
}

const sharedRequestQueue: WtRequestQueue = { wait: waitForRequestSlot, defer: deferRequestSlot }

const lastFetch = new Map<string, { at: number; seasonId: string | null }>()
const lastFailure = new Map<string, number>()
const notFoundTags = new Set<string>()
let pagesDownUntil = 0
let requestQueue = sharedRequestQueue

export type { ClanRating }

/** Страница клана ответила не 2xx. */
export class ClanPageHttpError extends Error {
  constructor(
    readonly status: number,
    clanName: string,
  ) {
    super(`HTTP ${status} на странице клана ${clanName}`)
    this.name = 'ClanPageHttpError'
  }
}

/**
 * Сбрасывает кулдауны и паузу запросов claninfo (изоляция тестов); `queue`
 * подменяет общую очередь warthunder.com, чтобы тест не ждал её интервал.
 */
export function resetClanInfoState(queue: WtRequestQueue = sharedRequestQueue): void {
  lastFetch.clear()
  lastFailure.clear()
  notFoundTags.clear()
  pagesDownUntil = 0
  requestQueue = queue
}

/** Участник со страницы claninfo; поля после ПКР — null, если вёрстка их не дала. */
export interface ClanPageMember {
  nick: string
  rating: number
  activity?: number | null
  /** Commander, Deputy, Officer, Sergeant, Private — как на английской странице. */
  role?: string | null
  /** Дата вступления, Unix-секунды (полночь UTC). */
  joinedAt?: number | null
}

const MEMBER_CELL_RE = /<div class="squadrons-members__grid-item[^"]*">\s*([^<]*?)\s*<\/div>/g

/** «26.05.2021» → Unix-секунды полуночи UTC; иное — null. */
export function parseClanEntryDate(value: string): number | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (match === null) return null
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (year < 2012 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return ms / 1_000
}

/**
 * Ячейки строки участника после ПКР: активность, роль, дата вступления. Ищутся
 * до ссылки следующего участника; незнакомое значение — null, а не ошибка:
 * ростер и ПКР от них не зависят.
 */
function memberDetails(tail: string): Pick<ClanPageMember, 'activity' | 'role' | 'joinedAt'> {
  const cells = [...tail.matchAll(MEMBER_CELL_RE)].slice(0, 3).map((cell) => decodeHtmlEntities(cell[1]!).trim())
  const [activity = '', role = '', joined = ''] = cells
  return {
    activity: /^\d{1,9}$/.test(activity) ? Number(activity) : null,
    role: /^[A-Za-z][A-Za-z ]{0,31}$/.test(role) ? role : null,
    joinedAt: parseClanEntryDate(joined),
  }
}

/** Участники клана с ПКР, активностью, ролью и датой вступления со страницы claninfo */
export async function fetchClanMembers(clanName: string): Promise<ClanPageMember[]> {
  await requestQueue.wait()
  const res = await fetch(`https://warthunder.com/en/community/claninfo/${encodeURIComponent(clanName)}`, {
    headers: { accept: 'text/html', 'user-agent': UA },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    // 429 откладывает всю очередь warthunder.com, а не только страницы кланов.
    if (res.status === 429) requestQueue.defer(retryAfterMs(res))
    await res.body?.cancel().catch(() => undefined)
    throw new ClanPageHttpError(res.status, clanName)
  }
  const html = await readResponseText(res, 4 * 1024 * 1024, `страница клана ${clanName}`)

  // Между ссылкой участника и ячейкой ПКР у офицеров могут быть обёртки
  // noindex/robots-nocontent, которых нет у обычных участников.
  const members: ClanPageMember[] = []
  const rowRe =
    /userinfo\/\?nick=[^"]*"\s*>\s*([^<]+?)\s*<\/a>(?:(?!userinfo\/\?nick=)[\s\S]){0,1024}?<div class="squadrons-members__grid-item">\s*(\d+)\s*<\/div>/g
  for (const m of html.matchAll(rowRe)) {
    const tailStart = m.index + m[0].length
    const next = html.indexOf('userinfo/?nick=', tailStart)
    const tail = html.slice(tailStart, next < 0 ? tailStart + 2_048 : Math.min(next, tailStart + 2_048))
    members.push({ nick: decodeHtmlEntities(m[1]!), rating: Number(m[2]), ...memberDetails(tail) })
  }
  if (members.length === 0) throw new Error(`на странице клана ${clanName} не нашлась таблица участников`)
  // Список используется как ПОЛНЫЙ ростер (clan_roster): неполный парс молча
  // «выгонял» бы живых участников. Число якорей участников должно сойтись;
  // выброс сохраняет прежнюю деградацию (fallback на сохранённые рейтинги).
  const memberTable = html.slice(html.indexOf('squadrons-members'))
  const anchorCount = (memberTable.match(/userinfo\/\?nick=/g) ?? []).length
  if (anchorCount > 0 && members.length !== anchorCount) {
    throw new Error(
      `страница клана ${clanName}: распознано ${members.length} из ${anchorCount} участников — парс не полный`,
    )
  }
  return members
}

/**
 * Пауза для клана после сбоя; 404 у нескольких разных кланов подряд ставит
 * на паузу все страницы кланов — предупреждение пишется один раз на паузу.
 */
function noteClanPageFailure(tag: string, err: unknown): void {
  const now = Date.now()
  lastFailure.set(tag, now)
  if (!(err instanceof ClanPageHttpError) || err.status !== 404) return
  notFoundTags.add(tag)
  if (notFoundTags.size < PAGES_DOWN_THRESHOLD || now < pagesDownUntil) return
  pagesDownUntil = now + PAGES_DOWN_PAUSE_MS
  notFoundTags.clear()
  console.warn(
    `[clan-info] страницы кланов отдают 404 (${PAGES_DOWN_THRESHOLD} клана подряд) — ` +
      `ПКР берётся из сохранённых снимков, повтор через ${PAGES_DOWN_PAUSE_MS / 60_000} мин`,
  )
}

/** Сохранённые ПКР по тегам без сетевого обновления. */
function getStoredRatingsForTags(tags: string[]): Map<string, ClanRating> {
  const result = new Map<string, ClanRating>()
  for (const tag of tags) {
    if (!tag) continue
    for (const [nick, rating] of getClanRatingsWithDelta(tag)) {
      result.set(nick, rating)
    }
  }
  return result
}

/**
 * ПКР и дельты для игроков боя по тегам обеих команд.
 * Возвращает карту «ник → {rating, delta}»; недоступные кланы молча
 * пропускаются (нет в словаре, сайт не ответил) — картинка выйдет без ПКР.
 * `force` игнорирует кулдаун (кнопка принудительного обновления),
 * `cachedOnly` возвращает только сохранённые снимки без обращения к сети.
 */
export async function fetchRatingsForTags(
  tags: string[],
  opts: { force?: boolean; cachedOnly?: boolean } = {},
): Promise<Map<string, ClanRating>> {
  if (opts.cachedOnly) return getStoredRatingsForTags(tags)

  const result = getStoredRatingsForTags(tags)
  const seasonId = getClanSeasonContext().season?.id ?? null
  const uniqueTags = [...new Set(tags.filter((tag) => tag !== ''))]
  const refreshed = await mapConcurrent(
    uniqueTags,
    CLAN_FETCH_CONCURRENCY,
    async (tag): Promise<Map<string, ClanRating> | null> => {
      try {
        const name = getClanNameByTag(tag)
        if (!name) return null // клана нет в словаре — источник wt-clans ещё не прошёлся

        const now = Date.now()
        const last = lastFetch.get(tag)
        const due = opts.force || last?.seasonId !== seasonId || now - (last?.at ?? 0) > COOLDOWN_MS
        const allowed = opts.force
          || (now >= pagesDownUntil && now - (lastFailure.get(tag) ?? 0) > FAILURE_COOLDOWN_MS)
        if (due && allowed) {
          try {
            const members = await fetchClanMembers(name)
            saveClanRatingSnapshots(tag, members)
            lastFetch.set(tag, { at: Date.now(), seasonId })
            lastFailure.delete(tag)
            notFoundTags.clear()
          } catch (err) {
            noteClanPageFailure(tag, err)
            throw err
          }
        }
        return getClanRatingsWithDelta(tag)
      } catch (err) {
        console.warn(`[clan-info] ПКР клана ${tag} не получен: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
  )
  for (const ratings of refreshed) {
    if (!ratings) continue
    for (const [nick, rating] of ratings) result.set(nick, rating)
  }
  return result
}
