import { getClansStats, upsertClans } from '../../db/index.js'
import { readResponseText } from '../../http-response.js'
import { fetchWtResponse } from './wt-request.js'
import type { ParserSource } from '../types.js'

/**
 * Словарь кланов с лидерборда warthunder.com: полный тег с украшениями
 * («╁0NYX╂») → имя клана («0NYX») для страницы claninfo.
 *
 * Зачем: в реплее лежит только тег, а личный клановый рейтинг (ПКР)
 * участников виден на странице клана, которая открывается по имени.
 * Поиска по тегу у сайта нет, зато лидерборд отдаёт и тег, и имя.
 *
 * Идём по страницам (20 кланов на каждой), пока у кланов ненулевой
 * рейтинг клановых боёв текущего сезона (dr_era5) — активные кланы,
 * чьи бои и попадают в реплеи, все в этой части списка.
 * Пишем не в items, а в свою таблицу clans (см. db/index.ts).
 */

const LB_URL = 'https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page'
const MAX_PAGES = 40
const INTERVAL_MS = 12 * 60 * 60_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

interface LbClan {
  tag?: string
  name?: string
  astat?: Record<string, unknown>
}

interface LbPage {
  status: string
  data: LbClan[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLeaderboardPage(raw: string, page: number): LbPage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`лидерборд, страница ${page}: некорректный JSON`)
  }
  if (!isRecord(value) || typeof value['status'] !== 'string' || !Array.isArray(value['data'])) {
    throw new Error(`лидерборд, страница ${page}: неожиданная схема ответа`)
  }

  const data: LbClan[] = []
  for (const [index, rawClan] of value['data'].entries()) {
    if (!isRecord(rawClan)) {
      throw new Error(`лидерборд, страница ${page}: элемент ${index} не является объектом`)
    }
    const tag = rawClan['tag']
    const name = rawClan['name']
    const astat = rawClan['astat']
    if (tag !== undefined && typeof tag !== 'string') {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный tag`)
    }
    if (name !== undefined && typeof name !== 'string') {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный name`)
    }
    if (astat !== undefined && !isRecord(astat)) {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный astat`)
    }
    const clan: LbClan = {}
    if (tag !== undefined) clan.tag = tag
    if (name !== undefined) clan.name = name
    if (astat !== undefined) clan.astat = astat
    data.push(clan)
  }
  return { status: value['status'], data }
}

export const wtClans: ParserSource = {
  name: 'wt-clans',
  intervalMs: INTERVAL_MS,
  async run(signal) {
    // Парсеры запускаются при каждом старте процесса (tsx watch перезапускает
    // его на любое изменение кода) — свежий словарь не пересобираем
    const existing = getClansStats()
    if (existing.count > 0 && Date.now() / 1000 - existing.newestAt < (INTERVAL_MS / 1000) * 0.9) {
      return { summary: `Словарь свежий (${existing.count} кланов) — обход пропущен` }
    }

    const entries: { tag: string; name: string }[] = []
    let pages = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      signal.throwIfAborted()
      const res = await fetchWtResponse(
        `${LB_URL}/${page}/sort/dr_era5`,
        { headers: { accept: 'application/json' } },
        `лидерборд, страница ${page}`,
        MAX_RESPONSE_BYTES,
      )
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`HTTP ${res.status} на странице ${page} лидерборда`)
      }
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType !== '' && !contentType.includes('json')) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`лидерборд, страница ${page}: сервер вернул не JSON`)
      }
      const json = parseLeaderboardPage(
        await readResponseText(res, MAX_RESPONSE_BYTES, `лидерборд, страница ${page}`),
        page,
      )
      const clans = json.data
      if (json.status !== 'ok' || clans.length === 0) break
      pages = page

      let sawActive = false
      for (const clan of clans) {
        if (!clan.tag || !clan.name) continue
        const rating = Number(clan.astat?.['dr_era5_hist'] ?? 0)
        if (rating > 0) sawActive = true
        entries.push({ tag: clan.tag, name: clan.name })
      }
      // страница целиком из кланов с нулевым рейтингом — дальше только неактивные
      if (!sawActive) break
    }

    upsertClans(entries)
    return { summary: `Кланов в словаре: ${entries.length} (страниц лидерборда: ${pages})` }
  },
}
