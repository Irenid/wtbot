import { parseForumSeasonPost } from '../../clan-season-forum.js'
import { syncForumClanSeasons } from '../../db/index.js'
import { readResponseText } from '../../http-response.js'
import type { ParserSource } from '../types.js'

/**
 * Расписание полковых боёв (сезоны и ротация БР по неделям) с официального
 * форума. Первый пост темы 2509 переписывается к каждому сезону, Discourse
 * отдаёт его исходный текст по /raw/<topic>/<post>. Форум не за Cloudflare и
 * не на warthunder.com, поэтому идёт обычным fetch, а не через общую очередь
 * fetchWtResponse(). Пишем не в items, а в clan_seasons/clan_season_stages.
 */

export const FORUM_SEASON_URL = 'https://forum.warthunder.ru/raw/2509/1'
const INTERVAL_MS = 6 * 60 * 60_000
const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 256 * 1024

export async function fetchForumSeasonPost(signal: AbortSignal): Promise<string> {
  const res = await fetch(FORUM_SEASON_URL, {
    headers: { accept: 'text/plain', 'user-agent': 'wtbot (+https://github.com/Irenid/wtbot)' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    redirect: 'error',
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`форум: HTTP ${res.status} на посте с расписанием сезона`)
  }
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('text/plain')) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`форум: вместо текста поста пришло «${contentType || 'без типа'}»`)
  }
  return await readResponseText(res, MAX_RESPONSE_BYTES, 'пост с расписанием сезона')
}

export const wtClanSeason: ParserSource = {
  name: 'wt-clan-season',
  intervalMs: INTERVAL_MS,
  async run(signal) {
    const schedules = parseForumSeasonPost(await fetchForumSeasonPost(signal))
    signal.throwIfAborted()
    const result = syncForumClanSeasons(schedules)
    const names = schedules.map((season) => `${season.name} (${season.stages.length} этапов)`).join('; ')
    const changes = [
      result.inserted.length > 0 ? `новых ${result.inserted.length}` : '',
      result.updated.length > 0 ? `обновлено ${result.updated.length}` : '',
      result.replaced.length > 0 ? `заменено прежних ${result.replaced.length}` : '',
    ].filter(Boolean)
    return { summary: `${names}: ${changes.length > 0 ? changes.join(', ') : 'без изменений'}` }
  },
}
