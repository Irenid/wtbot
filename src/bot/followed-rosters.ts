import { listBotStateKeys } from '../db/index.js'
import { findSquadrons } from '../scout/report.js'
import { fetchRatingsForTags } from '../wrpl/clan-info.js'
import { guildChannels } from './guild-settings.js'
import { platoonSettings } from './platoons.js'
import { squadronStatsSquadron } from './squadron-stats.js'

/**
 * The claninfo rosters of the squadrons servers follow — a battles channel's squadron, the stats
 * channels' and the platoon suggestions' (/settings) — are read every FOLLOWED_ROSTER_MS. Otherwise a
 * squadron's page is read only after its battles (psr-page-reader.ts) or while its players sit in voice
 * (platoons.ts), and a member who left between sessions stays on its roster until the next battle:
 * rulebot's roster check (Test pechenka, 2026-10-22) tells departures from `/api/clans/:coreTag`.
 * claninfo is cached 15 min on Gaijin's side, so a shorter cadence reads the same page; each squadron
 * costs one request of the shared warthunder.com queue per run.
 */
export const FOLLOWED_ROSTER_MS = 15 * 60_000
/** The first run waits this long after start: startup has heavier work, and a restart reads no page twice. */
const FIRST_RUN_MS = 60_000
/** A squadron reads at most this many decorated tags (platoons.ts and the clan page read 8 too). */
const MAX_TAGS = 8

export interface FollowedRosterDeps {
  /** The tag cores servers follow. */
  squadrons: () => string[]
  /** A core's decorated tags as replays name them; empty — the dictionary does not know it. */
  tagsOf: (core: string) => string[]
  fetchRatings: (tags: string[]) => Promise<unknown>
}

/** The cores every server's /settings name, each once. */
export function followedSquadrons(): string[] {
  const cores = new Set(guildChannels('battles').map((row) => row.clan).filter((clan) => clan !== ''))
  for (const key of listBotStateKeys('squadron-stats:')) {
    const clan = squadronStatsSquadron(key.slice('squadron-stats:'.length))
    if (clan) cores.add(clan)
  }
  for (const key of listBotStateKeys('platoons:')) {
    const clan = platoonSettings(key.slice('platoons:'.length))?.clan
    if (clan) cores.add(clan)
  }
  return [...cores]
}

const defaultDeps: FollowedRosterDeps = {
  squadrons: followedSquadrons,
  // findSquadrons ranks partial matches too: only the squadron of exactly this core.
  tagsOf: (core) => {
    const squadron = findSquadrons(core, 1)[0]
    return squadron?.core === core ? squadron.tags.slice(0, MAX_TAGS) : []
  },
  fetchRatings: (tags) => fetchRatingsForTags(tags),
}

let firstTimer: NodeJS.Timeout | null = null
let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let stopping = false

/** One pass over the followed squadrons, one after another (the shared queue spaces the requests anyway). */
export async function refreshFollowedRosters(deps: FollowedRosterDeps = defaultDeps): Promise<void> {
  for (const core of deps.squadrons()) {
    if (stopping) return
    const tags = deps.tagsOf(core)
    if (tags.length === 0) continue
    try {
      await deps.fetchRatings(tags)
    } catch (error) {
      console.warn(`[rosters] the roster of ${core} was not read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function run(deps: FollowedRosterDeps): void {
  // An overlap guard: a slow queue never stacks passes.
  if (stopping || running) return
  running = refreshFollowedRosters(deps)
    .catch((error: unknown) => console.warn('[rosters] the pass failed:', error))
    .finally(() => { running = null })
}

export function startFollowedRosters(deps: FollowedRosterDeps = defaultDeps, firstRunMs = FIRST_RUN_MS): void {
  if (timer || firstTimer) return
  stopping = false
  firstTimer = setTimeout(() => {
    firstTimer = null
    run(deps)
    timer = setInterval(() => run(deps), FOLLOWED_ROSTER_MS)
  }, firstRunMs)
}

export async function stopFollowedRosters(): Promise<void> {
  stopping = true
  if (firstTimer) clearTimeout(firstTimer)
  if (timer) clearInterval(timer)
  firstTimer = null
  timer = null
  await running
}
