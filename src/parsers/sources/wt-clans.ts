import { getClansStats, upsertClans } from '../../db/index.js'
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
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
const MAX_PAGES = 40
const PAUSE_MS = 400
const INTERVAL_MS = 12 * 60 * 60_000

interface LbClan {
  tag?: string
  name?: string
  astat?: Record<string, unknown>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const wtClans: ParserSource = {
  name: 'wt-clans',
  intervalMs: INTERVAL_MS,
  async run() {
    // Парсеры запускаются при каждом старте процесса (tsx watch перезапускает
    // его на любое изменение кода) — свежий словарь не пересобираем
    const existing = getClansStats()
    if (existing.count > 0 && Date.now() / 1000 - existing.newestAt < (INTERVAL_MS / 1000) * 0.9) {
      return { summary: `Словарь свежий (${existing.count} кланов) — обход пропущен` }
    }

    const entries: { tag: string; name: string }[] = []
    let pages = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await sleep(PAUSE_MS)
      const res = await fetch(`${LB_URL}/${page}/sort/dr_era5`, {
        headers: { accept: 'application/json', 'user-agent': UA },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} на странице ${page} лидерборда`)
      const json = (await res.json()) as { status?: string; data?: LbClan[] }
      const clans = json.data ?? []
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
