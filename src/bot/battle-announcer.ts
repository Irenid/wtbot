import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Message, type SendableChannels } from 'discord.js'
import { subscribeBattleLifecycle } from '../battle-lifecycle.js'
import { config } from '../config.js'
import {
  getBattleClanTags,
  getBattleIngestState,
  getBattlePostSummary,
  getBotState,
  getMaxItemId,
  getPendingAnnounce,
  getUnfinishedAnnounceMessages,
  markAnnounce,
  nextAnnounceBaseline,
  setBotState,
  skipStaleAnnounce,
  type PendingAnnounceItem,
} from '../db/index.js'
import { INGEST_MAX_ATTEMPTS } from '../wrpl/ingest.js'
import { plainClanTag } from '../wrpl/render-battle.js'
import { isWorkerExecutionTimeout, isWorkerPoolSchedulingError } from '../workers/pool.js'
import { ExecTimeoutBudget } from '../workers/exec-timeout-budget.js'
import { battleAnnouncementDecision } from './battle-post-policy.js'
import {
  queueBattlePostRecheck,
  queueBattlePostUpdates,
  renderBattlePost,
  type BattlePostPayload,
} from './commands/battle.js'

/**
 * The battle announcer waits for durable ingest, then posts the finished post
 * with the PNG and the /battle buttons. It sends no preliminary messages since
 * 2026-08-01 (e530b1c); unfinished legacy ones are completed once at start.
 *
 * Every battle has its own state (table announce_state): sent or not and how
 * many attempts. A failed announcement is retried in later ticks instead of
 * being lost, and a broken one is skipped after the attempt limit without
 * blocking the queue. The baseline in bot_state is only a starting mark: the
 * first start sets it to the current maximum (history is not posted), then it
 * moves past resolved battles.
 *
 * Clan filter: with WT_CLAN_TAG set, only battles of that clan are announced.
 * The clan tag exists only inside the replay, so it comes from battle_players
 * (an indexed query on idx_bp_clan), i.e. after the ingest worker parsed the
 * battle. Until then the announcement waits for the next tick; if ingest gave
 * up on the battle (parts gone from the CDN and so on), it is skipped instead
 * of waiting forever. The announcer renders only its own battles, from the
 * database, without downloading the replay.
 */

const BASELINE_KEY = 'battles:lastAnnouncedId'
const TICK_MS = 20_000
/** Attempts to announce a battle before it is skipped. */
const MAX_ATTEMPTS = 3
/** Consecutive render timeouts after which an announcement counts as a normal failed attempt. */
const RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT = 3
const renderExecTimeouts = new ExecTimeoutBudget(RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT)
/** Clan for the filter (the tag core without decorations); empty — every battle is announced. */
const TARGET_CLAN = plainClanTag(config.clanTag)
let announceTimer: NodeJS.Timeout | null = null
let activeTick: Promise<void> | null = null
let stopping = false
let unsubscribeLifecycle: (() => void) | null = null
let wakeRequested = false
let announceSweep = 0
/** Legacy preliminary messages behind the baseline; a tick with a channel takes them, unresolved ones return. */
let unfinishedMessages: PendingAnnounceItem[] = []

export function startBattleAnnouncer(client: Client): void {
  if (announceTimer) return
  if (!config.battlesChannelId) {
    console.log('[bot] WT_BATTLES_CHANNEL is empty: battle announcements are off')
    return
  }
  stopping = false
  wakeRequested = false
  announceSweep = 0
  if (getBotState(BASELINE_KEY) === null) {
    setBotState(BASELINE_KEY, String(getMaxItemId('wt-replays')))
  }
  unfinishedMessages = getUnfinishedAnnounceMessages(Number(getBotState(BASELINE_KEY) ?? '0'), MAX_ATTEMPTS)
  console.log(`[bot] battle announcements on (channel ${config.battlesChannelId}, every ${TICK_MS / 1000} s)`)
  console.log(
    TARGET_CLAN
      ? `[bot] announcing only battles of clan "${config.clanTag}"`
      : '[bot] announcing every clan battle (WT_CLAN_TAG is empty)',
  )
  if (unfinishedMessages.length > 0) {
    console.log(`[bot] unfinished preliminary announcements to complete: ${unfinishedMessages.length}`)
  }

  const tick = async (): Promise<void> => {
    if (stopping) return
    const baseline = Number(getBotState(BASELINE_KEY) ?? '0')
    if (config.announceMaxAgeHours > 0) {
      const cutoffSec = Math.floor(Date.now() / 1_000) - config.announceMaxAgeHours * 3_600
      const skipped = skipStaleAnnounce(baseline, MAX_ATTEMPTS, cutoffSec)
      if (skipped > 0) {
        console.log(`[bot] announcements: skipped battles older than ${config.announceMaxAgeHours} h: ${skipped}`)
      }
    }
    announceSweep += 1
    const order = announceSweep % 8 === 0 ? 'oldest' : 'newest'
    const fresh = getPendingAnnounce(baseline, MAX_ATTEMPTS, 5, order)
    if (fresh.length === 0 && unfinishedMessages.length === 0) return

    const channel = await client.channels.fetch(config.battlesChannelId)
    if (stopping) return
    if (!channel?.isSendable()) {
      console.warn('[bot] the announcement channel is unavailable or not a text channel: check WT_BATTLES_CHANNEL')
      return
    }

    // Posted in battle order; legacy messages lie behind the baseline, so the
    // two lists never overlap.
    const legacy = unfinishedMessages.splice(0)
    const ordered = [...legacy, ...fresh].sort((a, b) => startTimeOf(a) - startTimeOf(b))
    for (const item of ordered) {
      if (stopping) break
      const summary = getBattlePostSummary(item.externalId)
      const readiness = battleAnnouncementDecision(
        (summary?.teamWon ?? 0) > 0,
        getBattleIngestState(item.externalId),
        INGEST_MAX_ATTEMPTS,
      )
      if (readiness === 'wait') continue
      if (readiness === 'skip') {
        await finishPendingWithError(channel, item, 'The replay could not be parsed.')
        markAnnounce(item.id, 'ok')
        continue
      }
      if (TARGET_CLAN && clanDecision(item) === 'skip') {
        // Not our clan: resolved without a post.
        await deletePendingMessage(channel, item)
        markAnnounce(item.id, 'ok')
        continue
      }
      try {
        const post = await renderBattlePost(item, 'background')
        if (stopping) break
        if (!post) {
          // No replay links: counts as an attempt, skipped after the limit.
          markAnnounce(item.id, 'failed', 'no replay links')
          console.warn(`[bot] announcement ${item.externalId}: the item has no replay links`)
          continue
        }
        let message: Message
        if (item.announceMessageId) {
          const pending = await pendingMessage(channel, item)
          if (!pending) {
            // Deleted by hand: a late post in its place would be noise.
            markAnnounce(item.id, 'ok', 'the preliminary message was deleted')
            continue
          }
          message = pending
          await message.edit(post.payload)
        } else {
          message = await channel.send(post.payload)
        }
        markAnnounce(item.id, 'ok')
        renderExecTimeouts.clear(item.externalId)
        const edit = (payload: BattlePostPayload) => message.edit({ ...payload, attachments: [] })
        queueBattlePostUpdates(post, edit)
        queueBattlePostRecheck(post, edit)
        console.log(`[bot] announced battle ${item.externalId} (${item.title.trim()})`)
      } catch (err) {
        if (stopping) break
        // A render that keeps missing its timeout would otherwise repeat every
        // tick forever, holding a worker for the whole timeout.
        if (isWorkerExecutionTimeout(err) && renderExecTimeouts.register(item.externalId)) {
          markAnnounce(item.id, 'failed', `${err.message} (${RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT} times in a row)`)
          console.error(
            `[bot] announcement ${item.externalId}: the render exceeded its timeout ` +
              `${RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT} times in a row`,
          )
          continue
        }
        if (isWorkerPoolSchedulingError(err)) {
          console.warn(`[bot] announcement ${item.externalId}: the CPU scheduler is busy (${err.message}); no attempt spent`)
          continue
        }
        // The baseline does not move past the battle: the next tick retries
        // until it succeeds or runs out of attempts, so nothing is lost silently.
        markAnnounce(item.id, 'failed', (err as Error).message)
        console.error(`[bot] announcement ${item.externalId}: ${(err as Error).message}`)
      }
    }

    // A legacy message left unresolved (waiting for ingest, a busy scheduler,
    // attempts left) is retried next tick; the query costs ~1 ms per 36k rows.
    if (legacy.length > 0) unfinishedMessages = getUnfinishedAnnounceMessages(baseline, MAX_ATTEMPTS)
    // Move the baseline past resolved battles so the scan window does not grow.
    if (!stopping) setBotState(BASELINE_KEY, String(nextAnnounceBaseline(baseline, MAX_ATTEMPTS)))
  }

  const scheduleTick = (): void => {
    if (stopping) return
    if (activeTick) {
      wakeRequested = true
      return
    }
    activeTick = tick()
      .catch((error: unknown) => {
        if (!stopping) console.error(`[bot] announcement tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        activeTick = null
        if (wakeRequested && !stopping) {
          wakeRequested = false
          setImmediate(scheduleTick)
        }
      })
  }
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = subscribeBattleLifecycle(scheduleTick)
  scheduleTick()
  announceTimer = setInterval(scheduleTick, TICK_MS)
  announceTimer.unref()
}

export async function stopBattleAnnouncer(): Promise<void> {
  stopping = true
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = null
  if (announceTimer) clearInterval(announceTimer)
  announceTimer = null
  await activeTick
}

/** The preliminary message of a legacy row; null when it was deleted. */
async function pendingMessage(
  channel: SendableChannels,
  item: PendingAnnounceItem,
): Promise<Message | null> {
  if (!item.announceMessageId) throw new Error('the preliminary announcement has no message_id')
  try {
    return await channel.messages.fetch(item.announceMessageId)
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null
    throw error
  }
}

async function finishPendingWithError(
  channel: SendableChannels,
  item: PendingAnnounceItem,
  message: string,
): Promise<void> {
  if (!item.announceMessageId) return
  try {
    const pending = await pendingMessage(channel, item)
    await pending?.edit({ content: `${message}\nMatch ID: \`${item.externalId}\``, components: [] })
  } catch (error) {
    console.warn(
      `[bot] could not update the preliminary announcement ${item.externalId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function deletePendingMessage(
  channel: SendableChannels,
  item: PendingAnnounceItem,
): Promise<void> {
  if (!item.announceMessageId) return
  try {
    const pending = await pendingMessage(channel, item)
    await pending?.delete()
  } catch (error) {
    console.warn(
      `[bot] could not delete the preliminary announcement ${item.externalId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const startTimeOf = (item: PendingAnnounceItem): number => {
  const t = (item.data as { startTime?: unknown } | null)?.startTime
  return typeof t === 'number' ? t : item.updatedAt
}

/**
 * Clan filter decision for one battle:
 *  send — our clan played, post it;
 *  skip — the battle is parsed and our clan is not in it.
 */
function clanDecision(item: PendingAnnounceItem): 'send' | 'skip' {
  const tags = getBattleClanTags(item.externalId)
  if (tags.some((t) => plainClanTag(t) === TARGET_CLAN)) return 'send'
  return 'skip'
}
