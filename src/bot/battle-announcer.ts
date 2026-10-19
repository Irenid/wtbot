import {
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type Message,
  type SendableChannels,
} from 'discord.js'
import { subscribeBattleLifecycle } from '../battle-lifecycle.js'
import { config } from '../config.js'
import { mapConcurrent } from '../concurrency.js'
import type { Locale } from '../i18n/index.js'
import {
  getBattleClanTags,
  getBattleIngestState,
  getBattlePostSummary,
  getBotState,
  getMaxItemId,
  getPendingAnnounce,
  markAnnounce,
  nextAnnounceBaseline,
  setBotState,
  skipStaleAnnounce,
  type PendingAnnounceItem,
} from '../db/index.js'
import { INGEST_MAX_ATTEMPTS } from '../wrpl/ingest.js'
import { isWorkerExecutionTimeout, isWorkerPoolSchedulingError } from '../workers/pool.js'
import { ExecTimeoutBudget } from '../workers/exec-timeout-budget.js'
import { battleAnnouncementDecision } from './battle-post-policy.js'
import {
  queueBattlePostRecheck,
  queueBattlePostUpdates,
  renderBattlePost,
  type BattlePost,
  type BattlePostPayload,
} from './commands/battle.js'
import { battleTargets, forgetGuildChannels, guildChannels } from './guild-settings.js'
import { guildLocale } from './locale.js'

/**
 * The battle announcer waits for durable ingest, then posts the finished post
 * with the PNG and the /battle buttons to every channel whose server asked
 * for the battle (/settings battles: every squadron's battles, or one
 * squadron's), rendered once per server language.
 *
 * Every battle has its own state (table announce_state): resolved or not and
 * how many attempts. A failed announcement is retried in later ticks instead
 * of being lost, and a broken one is skipped after the attempt limit without
 * blocking the queue; a retry posts only to the channels the battle has not
 * reached yet (in memory: a restart in between may post twice). A channel the
 * bot cannot post to (deleted, no access or permission) is skipped without an
 * attempt and logged at most hourly; a deleted one leaves the settings. The
 * baseline in bot_state is only a starting mark: the first start sets it to
 * the current maximum (history is not posted), then it moves past resolved
 * battles, and to the maximum while no server has a channel.
 *
 * The squadron filter reads the clan tags of battle_players (indexed), i.e.
 * after the ingest worker parsed the battle; readiness waits for that, and a
 * battle ingest gave up on is skipped. The announcer renders only from the
 * database, without downloading the replay.
 */

const BASELINE_KEY = 'battles:lastAnnouncedId'
const TICK_MS = 20_000
/** Attempts to announce a battle before it is skipped. */
const MAX_ATTEMPTS = 3
/** Consecutive render timeouts after which an announcement counts as a normal failed attempt. */
const RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT = 3
const renderExecTimeouts = new ExecTimeoutBudget(RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT)
/** Channels one battle is sent to at a time; discord.js queues each route under Discord's rate limits. */
const SEND_CONCURRENCY = 4
/** A channel the bot cannot post to is logged at most this often. */
const CHANNEL_WARN_MS = 60 * 60_000
/** What a battle post needs in its channel. */
const POST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
] as const
/** Discord errors that a retry will not fix: the channel is skipped for this battle. */
const DENIED_CODES = new Set<number>([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions])
/** The channel or its server is gone: its settings are dropped. */
const GONE_CODES = new Set<number>([RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.UnknownGuild])

let announceTimer: NodeJS.Timeout | null = null
let activeTick: Promise<void> | null = null
let stopping = false
let unsubscribeLifecycle: (() => void) | null = null
let wakeRequested = false
let announceSweep = 0
/** Channels each battle already reached or skipped; dropped once the battle is resolved or out of attempts. */
const reached = new Map<number, Set<string>>()
const channelWarnedAt = new Map<string, number>()

export interface BattleAnnouncerOptions {
  /** Tests replace the render (worker pool, assets); default renderBattlePost. */
  renderPost?: (item: PendingAnnounceItem, locale: Locale) => Promise<BattlePost | null>
}

let renderPost: NonNullable<BattleAnnouncerOptions['renderPost']> = (item, locale) => renderBattlePost(item, locale, 'background')

export function startBattleAnnouncer(client: Client, options: BattleAnnouncerOptions = {}): void {
  if (announceTimer) return
  renderPost = options.renderPost ?? ((item, locale) => renderBattlePost(item, locale, 'background'))
  stopping = false
  wakeRequested = false
  announceSweep = 0
  reached.clear()
  if (getBotState(BASELINE_KEY) === null) {
    setBotState(BASELINE_KEY, String(getMaxItemId('wt-replays')))
  }
  console.log(
    `[bot] battle announcements on: ${guildChannels('battles').length} channel setting(s) ` +
      `(/settings battles), checked every ${TICK_MS / 1000} s`,
  )

  const tick = async (): Promise<void> => {
    if (stopping) return
    const feeds = guildChannels('battles')
    if (feeds.length === 0) {
      // Nobody to post to: a channel added later starts from now, not from a backlog.
      setBotState(BASELINE_KEY, String(getMaxItemId('wt-replays')))
      reached.clear()
      return
    }
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
    // Posted in battle order, so each channel reads its battles in order.
    for (const item of fresh.sort((a, b) => startTimeOf(a) - startTimeOf(b))) {
      if (stopping) break
      const summary = getBattlePostSummary(item.externalId)
      const readiness = battleAnnouncementDecision(
        (summary?.teamWon ?? 0) > 0,
        getBattleIngestState(item.externalId),
        INGEST_MAX_ATTEMPTS,
      )
      if (readiness === 'wait') continue
      const done = reached.get(item.id)
      const targets = readiness === 'skip'
        ? []
        : battleTargets(feeds, getBattleClanTags(item.externalId)).filter((id) => !done?.has(id))
      if (targets.length === 0) {
        // Unparsed, no server asked for it, or every channel reached.
        resolve(item)
        continue
      }
      try {
        const outcome = await announce(client, item, targets)
        if (stopping) break
        if (outcome.kind === 'no-links') {
          // No replay links: counts as an attempt, skipped after the limit.
          fail(item, 'no replay links')
          console.warn(`[bot] announcement ${item.externalId}: the item has no replay links`)
          continue
        }
        renderExecTimeouts.clear(item.externalId)
        if (outcome.retry === null) resolve(item)
        else fail(item, outcome.retry)
        if (outcome.sent > 0) console.log(`[bot] announced battle ${item.externalId} (${item.title.trim()}) in ${outcome.sent} channel(s)`)
      } catch (err) {
        if (stopping) break
        // A render that keeps missing its timeout would otherwise repeat every
        // tick forever, holding a worker for the whole timeout.
        if (isWorkerExecutionTimeout(err) && renderExecTimeouts.register(item.externalId)) {
          fail(item, `${err.message} (${RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT} times in a row)`)
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
        fail(item, (err as Error).message)
        console.error(`[bot] announcement ${item.externalId}: ${(err as Error).message}`)
      }
    }

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

function resolve(item: PendingAnnounceItem): void {
  markAnnounce(item.id, 'ok')
  reached.delete(item.id)
}

function fail(item: PendingAnnounceItem, error: string): void {
  markAnnounce(item.id, 'failed', error)
  if (item.announceAttempts + 1 >= MAX_ATTEMPTS) reached.delete(item.id)
}

function markReached(item: PendingAnnounceItem, channelId: string): void {
  let channels = reached.get(item.id)
  if (!channels) {
    channels = new Set()
    reached.set(item.id, channels)
  }
  channels.add(channelId)
}

type AnnounceOutcome =
  | { kind: 'no-links' }
  /** retry: the first error worth another attempt; null — every channel reached or skipped. */
  | { kind: 'done'; sent: number; retry: string | null }

/**
 * Posts the battle to `channelIds`, rendering once per server language. A
 * render error is thrown (the caller spends the attempt); a channel's own
 * failure only skips that channel, or asks for a retry when it may pass.
 */
async function announce(client: Client, item: PendingAnnounceItem, channelIds: readonly string[]): Promise<AnnounceOutcome> {
  let retry: string | null = null
  const byLocale = new Map<Locale, SendableChannels[]>()
  // In order: almost always cached, else one REST call each, and a battle has a few targets.
  for (const channelId of channelIds) {
    let channel: SendableChannels
    try {
      const fetched = await client.channels.fetch(channelId)
      if (!fetched?.isSendable()) throw new ChannelUnusable('not a text channel')
      const missing = missingPermissions(client, fetched)
      if (missing) throw new ChannelUnusable(`missing permissions: ${missing}`)
      channel = fetched
    } catch (error) {
      const verdict = channelFailure(item, channelId, error)
      if (verdict !== null) retry ??= verdict
      continue
    }
    const locale = channelServerLocale(channel)
    const list = byLocale.get(locale) ?? []
    list.push(channel)
    byLocale.set(locale, list)
  }
  let sent = 0
  for (const [locale, channels] of byLocale) {
    if (stopping) break
    const post = await renderPost(item, locale)
    if (!post) return { kind: 'no-links' }
    if (stopping) break
    const messages = (await mapConcurrent(channels, SEND_CONCURRENCY, async (channel): Promise<Message | null> => {
      try {
        const message = await channel.send(post.payload)
        markReached(item, channel.id)
        return message
      } catch (error) {
        const verdict = channelFailure(item, channel.id, error)
        if (verdict !== null) retry ??= verdict
        return null
      }
    })).filter((message): message is Message => message !== null)
    sent += messages.length
    if (messages.length === 0) continue
    // Each update redraws every copy; a copy deleted by hand only fails its own edit.
    const edit = (payload: BattlePostPayload) =>
      Promise.allSettled(messages.map((message) => message.edit({ ...payload, attachments: [] })))
    queueBattlePostUpdates(post, edit)
    queueBattlePostRecheck(post, edit)
  }
  return { kind: 'done', sent, retry }
}

class ChannelUnusable extends Error {}

/** The permissions a post lacks in a server channel, by name; null — none. */
function missingPermissions(client: Client, channel: SendableChannels): string | null {
  if (!('permissionsFor' in channel) || client.user === null) return null
  const permissions = channel.permissionsFor(client.user)
  if (permissions === null) return 'all'
  const missing = POST_PERMISSIONS.filter((flag) => !permissions.has(flag))
  if (missing.length === 0) return null
  const names = new Map(Object.entries(PermissionFlagsBits).map(([name, flag]) => [flag, name]))
  return missing.map((flag) => names.get(flag) ?? String(flag)).join(', ')
}

/**
 * Handles a channel's failure: null — skipped for good (no retry), else the
 * error to retry with. Checking permissions first keeps the bot clear of
 * Discord's invalid-request limit (10,000 per 10 min ban the IP).
 */
function channelFailure(item: PendingAnnounceItem, channelId: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null
  if (code !== null && GONE_CODES.has(code)) {
    markReached(item, channelId)
    const removed = forgetGuildChannels({ channelId })
    console.warn(`[bot] announcement channel ${channelId} is gone: ${removed} setting(s) removed`)
    return null
  }
  if (error instanceof ChannelUnusable || (code !== null && DENIED_CODES.has(code))) {
    markReached(item, channelId)
    const now = Date.now()
    if (now - (channelWarnedAt.get(channelId) ?? 0) >= CHANNEL_WARN_MS) {
      channelWarnedAt.set(channelId, now)
      console.warn(`[bot] cannot post battles to channel ${channelId} (${message}); skipped until fixed, logged hourly`)
    }
    return null
  }
  return `channel ${channelId}: ${message}`
}

/** The language of the announcement channel's server (locale.ts). */
function channelServerLocale(channel: SendableChannels): Locale {
  return 'guild' in channel ? guildLocale(channel.guild.id, channel.guild.preferredLocale) : guildLocale(null)
}

const startTimeOf = (item: PendingAnnounceItem): number => {
  const t = (item.data as { startTime?: unknown } | null)?.startTime
  return typeof t === 'number' ? t : item.updatedAt
}
