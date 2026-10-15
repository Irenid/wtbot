import { parseForumSeasonPost } from '../../clan-season-forum.js'
import { syncForumClanSeasons } from '../../db/index.js'
import { readResponseText } from '../../http-response.js'
import type { ParserSource } from '../types.js'

/**
 * The squadron battles schedule (seasons and the weekly BR rotation) from
 * the official forum. Topic 2509's first post is rewritten for every season;
 * Discourse serves its source text at /raw/<topic>/<post>. The forum is not
 * behind Cloudflare nor on warthunder.com, so a plain fetch reads it, not the
 * shared fetchWtResponse() queue. It writes clan_seasons/clan_season_stages,
 * not items.
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
    throw new Error(`forum: HTTP ${res.status} on the season schedule post`)
  }
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('text/plain')) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`forum: "${contentType || 'no type'}" instead of the post text`)
  }
  return await readResponseText(res, MAX_RESPONSE_BYTES, 'season schedule post')
}

export const wtClanSeason: ParserSource = {
  name: 'wt-clan-season',
  intervalMs: INTERVAL_MS,
  async run(signal) {
    const schedules = parseForumSeasonPost(await fetchForumSeasonPost(signal))
    signal.throwIfAborted()
    const result = syncForumClanSeasons(schedules)
    // Seasons by their UTC days: the stored name is the forum's Russian text
    const day = (sec: number): string => new Date(sec * 1_000).toISOString().slice(0, 10)
    const names = schedules
      .map((season) => `${day(season.startsAt)}…${day(season.endsAt - 86_400)} (${season.stages.length} stages)`)
      .join('; ')
    const changes = [
      result.inserted.length > 0 ? `new ${result.inserted.length}` : '',
      result.updated.length > 0 ? `updated ${result.updated.length}` : '',
      result.replaced.length > 0 ? `replaced ${result.replaced.length}` : '',
    ].filter(Boolean)
    return { summary: `${names}: ${changes.length > 0 ? changes.join(', ') : 'unchanged'}` }
  },
}
