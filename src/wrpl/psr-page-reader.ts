import { subscribeBattleLifecycle } from '../battle-lifecycle.js'
import { getBattleClanTags, getBattleEndSec } from '../db/index.js'
import { fetchRatingsForTags } from './clan-info.js'

/**
 * Reads the squadron pages of every stored battle's teams, whether or not a server publishes it.
 * The PSR column (battle-psr.ts) needs a reading near the battle, and the post used to be what
 * read the pages: with a battles channel filtered to one squadron the others had none, and a
 * later /battle or a re-queued post lacked PSR for players without an earlier reading (21 Oct
 * 2026, TOR1 against WGES). Per squadron fetchRatingsForTags reads at most every 2 min through the
 * shared warthunder.com queue: ~190 squadrons and at most ~1,900 reads a day (2026-10-20..22).
 */

/** Only a battle that just ended: a reading is no use for a backfilled old one. */
const MAX_BATTLE_AGE_SEC = 30 * 60
/** Squadrons waiting for a read; more are dropped (a busy hour re-adds them with the next battle). */
const MAX_QUEUED_TAGS = 64
/** Squadrons per fetchRatingsForTags call: its own concurrency cap (CLAN_FETCH_CONCURRENCY). */
const BATCH = 4

export interface PsrPageReaderDeps {
  tagsOf: (sessionId: string) => string[]
  endOf: (sessionId: string) => number | null
  fetchRatings: (tags: string[]) => Promise<unknown>
  nowSec: () => number
}

const defaultDeps: PsrPageReaderDeps = {
  tagsOf: getBattleClanTags,
  endOf: getBattleEndSec,
  fetchRatings: (tags) => fetchRatingsForTags(tags),
  nowSec: () => Math.floor(Date.now() / 1_000),
}

const pending = new Set<string>()
let unsubscribe: (() => void) | null = null
let running: Promise<void> | null = null
let stopping = false

export function startPsrPageReader(deps: PsrPageReaderDeps = defaultDeps): void {
  if (unsubscribe) return
  stopping = false
  unsubscribe = subscribeBattleLifecycle((event) => {
    if (event.kind !== 'committed' || stopping) return
    const endAt = deps.endOf(event.sessionId)
    if (endAt === null || deps.nowSec() - endAt > MAX_BATTLE_AGE_SEC) return
    for (const tag of deps.tagsOf(event.sessionId)) {
      if (pending.size >= MAX_QUEUED_TAGS) break
      pending.add(tag)
    }
    // A rejection is handled inside; the guard keeps one reader loop at a time.
    if (!running) running = drain(deps).finally(() => { running = null })
  })
}

async function drain(deps: PsrPageReaderDeps): Promise<void> {
  while (!stopping && pending.size > 0) {
    const batch = [...pending].slice(0, BATCH)
    for (const tag of batch) pending.delete(tag)
    try {
      await deps.fetchRatings(batch)
    } catch (error) {
      console.warn(`[psr-pages] read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function stopPsrPageReader(): Promise<void> {
  stopping = true
  unsubscribe?.()
  unsubscribe = null
  pending.clear()
  await running
}
