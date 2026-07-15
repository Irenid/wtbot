import {
  getClanNameByTag,
  getClanRatingsWithDelta,
  saveClanRatingSnapshots,
  type ClanRating,
} from '../db/index.js'

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

const lastFetch = new Map<string, number>()

export type { ClanRating }

/** Участники клана с ПКР со страницы claninfo */
export async function fetchClanMembers(clanName: string): Promise<{ nick: string; rating: number }[]> {
  const res = await fetch(`https://warthunder.com/en/community/claninfo/${encodeURIComponent(clanName)}`, {
    headers: { accept: 'text/html', 'user-agent': UA },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} на странице клана ${clanName}`)
  const html = await res.text()

  // Строка таблицы: <a href="...userinfo/?nick=NICK">NICK</a></div>
  //                 <div class="squadrons-members__grid-item">ПКР</div>
  const members: { nick: string; rating: number }[] = []
  const rowRe =
    /userinfo\/\?nick=[^"]*"\s*>\s*([^<]+?)\s*<\/a>\s*<\/div>\s*<div class="squadrons-members__grid-item">\s*(\d+)\s*<\/div>/g
  for (const m of html.matchAll(rowRe)) {
    members.push({ nick: decodeHtml(m[1]!), rating: Number(m[2]) })
  }
  if (members.length === 0) throw new Error(`на странице клана ${clanName} не нашлась таблица участников`)
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
  for (const tag of tags) {
    if (!tag) continue
    try {
      const name = getClanNameByTag(tag)
      if (!name) continue // клана нет в словаре — источник wt-clans ещё не прошёлся

      const last = lastFetch.get(tag) ?? 0
      if (opts.force || Date.now() - last > COOLDOWN_MS) {
        const members = await fetchClanMembers(name)
        saveClanRatingSnapshots(tag, members)
        lastFetch.set(tag, Date.now())
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
