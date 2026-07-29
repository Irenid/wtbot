import {
  getClanSeasonContext,
  getClanNameByTag,
  getClanRatingsWithDelta,
  saveClanRatingSnapshots,
  type ClanRating,
} from '../db/index.js'
import { readResponseText } from '../http-response.js'

/**
 * Личный клановый рейтинг (ПКР) участников — со страницы клана
 * warthunder.com/en/community/claninfo/<имя> (публичная, куки не нужны).
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

const lastFetch = new Map<string, { at: number; seasonId: string | null }>()

export type { ClanRating }

/** Участники клана с ПКР со страницы claninfo */
export async function fetchClanMembers(clanName: string): Promise<{ nick: string; rating: number }[]> {
  const res = await fetch(`https://warthunder.com/en/community/claninfo/${encodeURIComponent(clanName)}`, {
    headers: { accept: 'text/html', 'user-agent': UA },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${res.status} на странице клана ${clanName}`)
  }
  const html = await readResponseText(res, 4 * 1024 * 1024, `страница клана ${clanName}`)

  // Между ссылкой участника и ячейкой ПКР у офицеров могут быть обёртки
  // noindex/robots-nocontent, которых нет у обычных участников.
  const members: { nick: string; rating: number }[] = []
  const rowRe =
    /userinfo\/\?nick=[^"]*"\s*>\s*([^<]+?)\s*<\/a>(?:(?!userinfo\/\?nick=)[\s\S]){0,1024}?<div class="squadrons-members__grid-item">\s*(\d+)\s*<\/div>/g
  for (const m of html.matchAll(rowRe)) {
    members.push({ nick: decodeHtml(m[1]!), rating: Number(m[2]) })
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
 * ПКР и дельты для игроков боя по тегам обеих команд.
 * Возвращает карту «ник → {rating, delta}»; недоступные кланы молча
 * пропускаются (нет в словаре, сайт не ответил) — картинка выйдет без ПКР.
 * `force` игнорирует кулдаун (кнопка принудительного обновления).
 */
export async function fetchRatingsForTags(
  tags: string[],
  opts: { force?: boolean } = {},
): Promise<Map<string, ClanRating>> {
  const result = new Map<string, ClanRating>()
  const seasonId = getClanSeasonContext().season?.id ?? null
  for (const tag of tags) {
    if (!tag) continue
    try {
      const name = getClanNameByTag(tag)
      if (!name) continue // клана нет в словаре — источник wt-clans ещё не прошёлся

      const last = lastFetch.get(tag)
      if (opts.force || last?.seasonId !== seasonId || Date.now() - (last?.at ?? 0) > COOLDOWN_MS) {
        const members = await fetchClanMembers(name)
        saveClanRatingSnapshots(tag, members)
        lastFetch.set(tag, { at: Date.now(), seasonId })
      }
      for (const [nick, rating] of getClanRatingsWithDelta(tag)) {
        result.set(nick, rating)
      }
    } catch (err) {
      console.warn(`[clan-info] ПКР клана ${tag} не получен: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}

/** &amp; &#39; и прочие сущности в никах со страницы */
function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
