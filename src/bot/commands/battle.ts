import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ButtonInteraction,
} from 'discord.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { botText, type BotText, type Locale } from '../../i18n/index.js'
import type { Command } from '../types.js'
import { heatmapQualityRow, heatmapScaleForUpload, type HeatmapScale } from '../battle-media-controls.js'
import { channelLocale, userLocale } from '../locale.js'
import {
  canAdmitWinnerUpdate,
  shouldQueueWinnerUpdate,
} from '../battle-post-policy.js'
import {
  getBattlePostSummary,
  getItemByExternalId,
  getLatestItems,
  getSquadronLeaderboardPlace,
  getSquadronResults,
  hasBattle,
  hasBattleChat,
  type SquadronResults,
  type StoredItem,
} from '../../db/index.js'
import {
  battleMaxBr,
  buildBattleHeatmap2x,
  buildBattleMediaKind,
  cachedBattleHeatmap2x,
  cachedBattleMedia,
  cachedBattleMeta,
  type BattleMediaKind,
} from '../../wrpl/battle-media.js'
import { isBattleHeatmapKind } from '../../wrpl/battle-media-kind.js'
import { reconstructBattleSummary } from '../../wrpl/battle-data.js'
import {
  battlePsr,
  notePsrFormulaChecks,
  PSR_RECHECK_AFTER_SEC,
  PSR_RECHECK_STORE_WAIT_SEC,
  type BattlePsr,
} from '../../wrpl/battle-psr.js'
import { fetchRatingsForTags, lookupUnknownClanTags, unknownClanTags } from '../../wrpl/clan-info.js'
import { applyRealNames, fakeNamesFromItem, fetchReplayResults, listedUserIdsFromItem, normalizeSessionId, realNamesFromItem, replayPartUrls, type ReplayResults, type WrplHeader } from '../../wrpl/replay.js'
import { psrLabel, renderBattleImage, stripClanDecorators, summarizeTeams } from '../../wrpl/render-battle.js'
import { fillSquadronTags } from '../../wrpl/squadron-tags.js'
import { ensureVehicleDict } from '../../wrpl/vehicles.js'
import { isWorkerPoolSchedulingError, type WorkerPriority } from '../../workers/pool.js'

/**
 * /battle [id] — the battle's results table as an image, from the replay.
 * Without an id, the latest replay the parser collected. Downloading parts
 * and rendering take a couple of seconds, hence deferReply first.
 *
 * Under the message, buttons as in Boris Stats: the replay link, the battle
 * log, ground/air heatmaps and the match chat. The media is built from the
 * replay's packet stream on the first press (all parts, ~20 MB) and cached
 * in data/battles/, so later presses answer at once.
 */

interface ReplayItemData {
  missionName?: string
  gameMode?: string
  gameVersion?: string
  replayParts?: string[] | null
  url?: string
  partsCount?: number
  /** The site's player lists with userId/name/fakeName (see realNamesFromItem) */
  players?: unknown
}

export const battle: Command = {
  definition: (t) => new SlashCommandBuilder()
    .setName('battle')
    .setDescription(t.commands.battle.description)
    .addStringOption((o) =>
      o.setName('id').setDescription(t.commands.battle.id),
    ),
  async execute(interaction) {
    await interaction.deferReply()
    const locale = channelLocale(interaction)
    const t = botText(locale).battle

    const rawId = interaction.options.getString('id')
    const item = rawId
      ? getItemByExternalId('wt-replays', normalizeSessionId(rawId.trim()))
      : getLatestItems(1, 'wt-replays')[0]
    if (!item) {
      await interaction.editReply(
        rawId ? t.notFound(rawId.slice(0, 64)) : t.noReplays,
      )
      return
    }

    const post = await renderBattlePost(item, locale)
    if (!post) {
      await interaction.editReply(t.noParts)
      return
    }
    await interaction.editReply(post.payload)
    const edit = (p: BattlePostPayload) => interaction.editReply({ ...p, attachments: [] })
    queueBattlePostUpdates(post, edit)
    queueBattlePostRecheck(post, edit, interaction.createdTimestamp + INTERACTION_EDIT_MS)
  },
}

/** An interaction's reply can be edited for 15 min: a minute of margin. */
const INTERACTION_EDIT_MS = 14 * 60_000

export interface BattlePostPayload {
  content: string
  files: AttachmentBuilder[]
  components: ActionRowBuilder<ButtonBuilder>[]
}

export interface BattlePost {
  payload: BattlePostPayload
  sessionIdHex: string
  /** Waits for ingest and redraws with the stored winner and flags; null — the stored summary was drawn already. */
  buildWinnerPayload: (() => Promise<BattlePostPayload | null>) | null
  /** Reads the squadron pages and redraws the PSR column; null — the post has read them already. */
  buildRatingsPayload: (() => Promise<BattlePostPayload | null>) | null
  /**
   * Runs last: looks up squadron tags missing from the clans dictionary (up
   * to a full leaderboard crawl) and redraws the post with their PSR; null —
   * every tag has a name.
   */
  buildLookupPayload: (() => Promise<BattlePostPayload | null>) | null
  /**
   * Rereads the squadron pages once they have counted the battle, waits
   * PSR_RECHECK_STORE_WAIT_SEC for the battles the read may count to be
   * stored, and redraws the PSR column if its numbers change: the page's own
   * PSR replaces the formula's (battle-psr.ts); null — no squadron tags. Due at
   * `recheckAt`; `signal` cuts the wait short at shutdown.
   */
  buildRecheckPayload: ((signal: AbortSignal) => Promise<BattlePostPayload | null>) | null
  /** The battle's end + PSR_RECHECK_AFTER_SEC, unix ms. */
  recheckAt: number
  /** A conservative estimate of the state the update closures retain, bytes. */
  updateBytes: number
}

/**
 * The battle results message for a stored item: the image, the teams text
 * and the media buttons, in `locale`, which its later redraws keep. Shared by
 * /battle and the announcer. null — the item has no replay part links.
 */
export async function renderBattlePost(
  item: StoredItem,
  locale: Locale,
  priority: WorkerPriority = 'interactive',
): Promise<BattlePost | null> {
  const data = item.data as ReplayItemData
  const sessionId = item.externalId
  const realNames = realNamesFromItem(data)
  const t = botText(locale)

  // A parsed battle comes from the database without downloading the replay.
  // Otherwise the results-BLK of the last part (parts are needed only here).
  let header: WrplHeader
  let results: ReplayResults
  let parts: string[] = []
  const recon = reconstructBattleSummary(sessionId)
  if (recon) {
    header = recon.header
    results = recon.results // stored nicknames are already the real ones
  } else {
    parts = replayPartUrls(data)
    if (parts.length === 0) return null
    const fetched = await fetchReplayResults(parts, priority)
    header = fetched.header
    results = fetched.results
    // The anonymizer replaces nicknames in the replay: restore the site's ones
    applyRealNames(results, realNames)
    // As ingest will store them
    fillSquadronTags(results.players)
  }
  const dict = await ensureVehicleDict(priority)
  let teams = summarizeTeams(results, dict)
  const missionName = data.missionName ?? item.title
  // Unknown until the first build: results-BLK lists the lineups, not the
  // units that actually spawned.
  let hasAir = true

  // Interactive /battle reads the squadron pages first. A background
  // announcement draws dashes until a separate update reads them.
  const clanTags = teams.flatMap((t) => (t.rawTag ? [t.rawTag] : []))
  // A squadron that began playing after the last full leaderboard crawl has
  // no name for its claninfo page yet: the last update looks it up and redraws.
  const unknownTags = unknownClanTags(clanTags)
  let pagesRead = priority !== 'background'
  if (pagesRead) await fetchRatingsForTags(clanTags)
  // The PSR column (battle-psr.ts), recomputed on every draw: the winner, the
  // stored rows and the page readings change between draws.
  let shownPsr = new Map<string, BattlePsr>()
  const readPsr = (winnerTeam: number | null): Map<string, BattlePsr> =>
    pagesRead
      ? battlePsr({ sessionId, startTime: header.startTime, duration: results.timePlayed, players: results.players, winnerTeam })
      : new Map()

  // The text next to the image: Match ID and cap, then each squadron's tag with its place and the
  // day's record, then each team's squadron, composition and players.
  const buildContent = (): string => {
    const standings = teams.flatMap((team) => {
      const standing = team.rawTag ? squadronStanding(team.rawTag, header.startTime, t) : null
      return team.rawTag && standing !== null ? [` · ${escapeMarkdown(team.rawTag)} ${standing}`] : []
    })
    const text =
      `${t.battle.matchId}: \`${header.sessionId}\`${seasonMaxBrSuffix(battleMaxBr(header.startTime), t)}${standings.join('')}\n` +
      teams
        .map((team, i) => {
          const clan = escapeMarkdown(team.clan ?? t.battle.team(i + 1))
          const players = team.players.map((n) => escapeMarkdown(n)).join(', ')
          return `**${clan}** (${team.composition}): ${players}`
        })
        .join('\n')
    return text.length > 1990 ? text.slice(0, 1990) + '…' : text
  }
  // Built with every payload: the day's record counts this battle once its winner is stored.
  let content = ''

  const buildComponents = (hasChat: boolean): ActionRowBuilder<ButtonBuilder>[] => {
    const overviewButtons = [
      new ButtonBuilder()
        .setLabel(t.battle.buttons.replay)
        .setStyle(ButtonStyle.Link)
        .setURL(`https://warthunder.com/en/tournament/replay/${header.sessionId}`),
      ...(hasChat
        ? [new ButtonBuilder().setCustomId(`battle:chat:${header.sessionId}`).setLabel(t.battle.buttons.chat).setStyle(ButtonStyle.Secondary)]
        : []),
      new ButtonBuilder().setCustomId(`battle:log:${header.sessionId}`).setLabel(t.battle.buttons.log).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`battle:heatmap-ground:${header.sessionId}`)
        .setLabel(t.battle.buttons.heatmapGround)
        .setStyle(ButtonStyle.Secondary),
      ...(hasAir
        ? [
            new ButtonBuilder()
              .setCustomId(`battle:heatmap-air:${header.sessionId}`)
              .setLabel(t.battle.buttons.heatmapAir)
              .setStyle(ButtonStyle.Secondary),
          ]
        : []),
    ]
    const clanButtons = teams.slice(0, 2).flatMap((team, teamIndex) => {
      const clan = stripClanDecorators(team.rawTag ?? team.clan ?? t.battle.team(teamIndex + 1))
      return [
        new ButtonBuilder()
          .setCustomId(`battle:heatmap-team-${teamIndex}:${header.sessionId}`)
          .setLabel(t.battle.buttons.teamGround(clan).slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
        ...(hasAir
          ? [
              new ButtonBuilder()
                .setCustomId(`battle:heatmap-team-air-${teamIndex}:${header.sessionId}`)
                .setLabel(t.battle.buttons.teamAir(clan).slice(0, 80))
                .setStyle(ButtonStyle.Secondary),
            ]
          : []),
      ]
    })
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(...overviewButtons),
      new ActionRowBuilder<ButtonBuilder>().addComponents(...clanButtons),
    ]
  }

  const makePayload = async (
    winnerTeam: number | null,
    hasChat: boolean,
    psr: Map<string, BattlePsr>,
    renderPriority: WorkerPriority = priority,
  ): Promise<BattlePostPayload> => {
    const png = await renderBattleImage(
      { missionName, header, results, dict, psr, winnerTeam, locale },
      renderPriority,
    )
    shownPsr = psr
    content = buildContent()
    return {
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
      components: buildComponents(hasChat),
    }
  }

  // results-BLK has no winner. The read model also keeps cheap has-air/chat
  // flags and never reads events_blob.
  const dbSummary = getBattlePostSummary(sessionId)
  const mediaMeta = await cachedBattleMeta(header.sessionIdHex)
  hasAir = dbSummary?.airUnitCount !== null && dbSummary?.airUnitCount !== undefined
    ? dbSummary.airUnitCount > 0
    : mediaMeta?.hasAir ?? true
  const hasChat = dbSummary
    ? dbSummary.chatCount === null
      ? hasBattleChat(sessionId)
      : dbSummary.chatCount > 0
    : mediaMeta?.hasChat ?? true
  const winner = dbSummary?.teamWon ?? mediaMeta?.teamWon ?? 0
  const initialHasAir = hasAir
  const initialHasChat = hasChat
  let currentWinnerTeam = winner > 0 ? winner : null
  let currentHasChat = hasChat
  const payload = await makePayload(currentWinnerTeam, currentHasChat, readPsr(currentWinnerTeam))
  // A redraw only when the column's numbers change.
  const redrawIfChanged = (psr: Map<string, BattlePsr>): Promise<BattlePostPayload> | null =>
    samePsr(shownPsr, psr) ? null : makePayload(currentWinnerTeam, currentHasChat, psr, 'background')
  const redrawPsr = async (): Promise<BattlePostPayload | null> => {
    await fetchRatingsForTags(clanTags)
    pagesRead = true
    return redrawIfChanged(readPsr(currentWinnerTeam))
  }
  const buildRatingsPayload = priority === 'background' && clanTags.length > 0 ? redrawPsr : null
  const recheckAt = (header.startTime + results.timePlayed + PSR_RECHECK_AFTER_SEC) * 1_000
  const buildRecheckPayload = clanTags.length > 0
    ? async (signal: AbortSignal): Promise<BattlePostPayload | null> => {
        await fetchRatingsForTags(clanTags, { freshAfter: recheckAt })
        pagesRead = true
        // The read may count the players' next battles: the path places it once they are stored.
        await sleep(PSR_RECHECK_STORE_WAIT_SEC * 1_000, undefined, { signal, ref: false })
        const psr = readPsr(currentWinnerTeam)
        notePsrFormulaChecks(psr)
        return redrawIfChanged(psr)
      }
    : null
  const buildLookupPayload = unknownTags.length > 0
    ? async (): Promise<BattlePostPayload | null> => {
        await lookupUnknownClanTags(unknownTags)
        if (unknownClanTags(unknownTags).length === unknownTags.length) return null
        return redrawPsr()
      }
    : null
  const buildWinnerPayload = shouldQueueWinnerUpdate(dbSummary !== null)
    ? async (): Promise<BattlePostPayload | null> => {
        const fresh = await waitForBattlePostSummary(sessionId)
        if (!fresh) return null
        // A post drawn from results-BLK alone: the stored rows add driven
        // vehicles, bot-played slots and resolved teams (player-events.ts).
        const stored = recon ? null : reconstructBattleSummary(sessionId)
        if (stored) {
          results = stored.results
          teams = summarizeTeams(results, dict)
        }
        const freshHasAir = fresh.airUnitCount === null ? initialHasAir : fresh.airUnitCount > 0
        const freshHasChat = fresh.chatCount === null ? hasBattleChat(sessionId) : fresh.chatCount > 0
        if (!stored && fresh.teamWon <= 0 && freshHasAir === initialHasAir && freshHasChat === initialHasChat) {
          return null
        }
        hasAir = freshHasAir
        currentWinnerTeam = fresh.teamWon > 0 ? fresh.teamWon : null
        currentHasChat = freshHasChat
        return makePayload(currentWinnerTeam, currentHasChat, readPsr(currentWinnerTeam), 'background')
      }
    : null
  return {
    payload,
    sessionIdHex: header.sessionIdHex,
    buildWinnerPayload,
    buildRatingsPayload,
    buildLookupPayload,
    buildRecheckPayload,
    recheckAt,
    updateBytes: buildWinnerPayload || buildRatingsPayload || buildLookupPayload || buildRecheckPayload
      ? estimatePostUpdateBytes(results, content)
      : 0,
  }
}

/** The cap the battle played (battleMaxBr) after its Match ID; nothing outside the known stages. */
export function seasonMaxBrSuffix(maxBr: number | null, t: BotText): string {
  return maxBr === null ? '' : ` · ${t.battle.maxBr(maxBr.toFixed(1))}`
}

/**
 * How far the leaderboard read may lie from the battle's start for its place to show: the full
 * crawl's cadence (FULL_CRAWL_INTERVAL_SEC in wt-clans.ts), so a squadron below the top 100 keeps
 * its place, while /battle on an older battle shows none: today's place says nothing about it.
 */
const PLACE_MAX_SHIFT_SEC = 12 * 60 * 60
const DAY_SEC = 86_400

/**
 * A squadron's standing in the post's first line, after its tag: its leaderboard place and its battles won and lost on the
 * battle's UTC day up to this one (both squadron-battle windows, 01–07 and 14–22 UTC, lie within
 * one UTC day). Two indexed reads on the main thread, 1–2 ms on the 2026-10-14 copy.
 */
export function squadronStanding(tag: string, startTime: number, t: BotText): string | null {
  const leaderboard = getSquadronLeaderboardPlace(tag)
  const place = leaderboard !== null && Math.abs(leaderboard.readAt - startTime) <= PLACE_MAX_SHIFT_SEC
    ? leaderboard.place
    : null
  return standingText(place, getSquadronResults(tag, startTime - (startTime % DAY_SEC), startTime), t)
}

/** The standing: the place, then the day's record once a battle of it has a winner; null — neither. */
export function standingText(place: number | null, results: SquadronResults, t: BotText): string | null {
  const parts: string[] = []
  if (place !== null) parts.push(t.battle.place(place))
  if (results.wins + results.losses > 0) parts.push(t.battle.dayRecord(results.wins, results.losses))
  return parts.length > 0 ? parts.join(' ') : null
}

/** Applies the post's PSR, then the stored winner and flags, then the squadron lookup, in order. */
export function queueBattlePostUpdates(post: BattlePost, apply: (p: BattlePostPayload) => Promise<unknown>): void {
  const builders = [post.buildRatingsPayload, post.buildWinnerPayload, post.buildLookupPayload].filter(
    (build): build is () => Promise<BattlePostPayload | null> => build !== null,
  )
  const sessionIdHex = post.sessionIdHex
  const estimatedBytes = Math.max(0, Math.floor(post.updateBytes))
  if (builders.length === 0 || postUpdatesStopping || postUpdates.has(post)) return
  if (!canAdmitWinnerUpdate(postUpdates.size, postUpdatesBytes, estimatedBytes)) {
    console.warn(
      `[bot] updates of the post of ${sessionIdHex} skipped: ` +
        `${postUpdates.size} waiting, ${(postUpdatesBytes / 1024 / 1024).toFixed(1)} MiB`,
    )
    return
  }
  postUpdatesBytes += estimatedBytes
  const task = (async () => {
    try {
      // In order: a later payload must keep the PSR, winner and flags drawn before it.
      for (const build of builders) {
        const payload = await build()
        if (payload && !postUpdatesStopping) await apply(payload)
      }
    } catch (err) {
      if (!postUpdatesStopping) {
        console.warn(`[bot] update of the post of ${sessionIdHex}: ${(err as Error).message}`)
      }
    }
  })().finally(() => {
    const current = postUpdates.get(post)
    if (current?.task !== task) return
    postUpdates.delete(post)
    postUpdatesBytes = Math.max(0, postUpdatesBytes - current.estimatedBytes)
  })
  postUpdates.set(post, { task, estimatedBytes })
  void task
}

interface BattlePostUpdateEntry {
  task: Promise<void>
  estimatedBytes: number
}

const WINNER_UPDATE_WAIT_MS = 14 * 60_000
const WINNER_UPDATE_POLL_MS = 1_000
/**
 * Update tasks by post, not by battle: a /battle reply and the announcement of
 * the same battle each redraw their own message.
 */
const postUpdates = new Map<BattlePost, BattlePostUpdateEntry>()
let postUpdatesBytes = 0
let postUpdatesStopping = false
/** Aborts the rechecks' wait for stored battles at shutdown. */
const postUpdatesAbort = new AbortController()

export async function stopBattlePostUpdates(): Promise<void> {
  postUpdatesStopping = true
  postUpdatesAbort.abort()
  for (const { timer } of postRechecks.values()) clearTimeout(timer)
  postRechecks.clear()
  postRechecksBytes = 0
  await Promise.allSettled([...postUpdates.values()].map((entry) => entry.task))
  await Promise.allSettled([...recheckTasks])
}

/**
 * Posts waiting for their PSR recheck. ~1,250 posts a day wait 16 min each,
 * then 3 more in recheckTasks: ~20 at a time, a few times that at the evening
 * peak. The bytes cover both.
 */
const postRechecks = new Map<BattlePost, { timer: NodeJS.Timeout; bytes: number }>()
let postRechecksBytes = 0
const recheckTasks = new Set<Promise<void>>()
const MAX_POST_RECHECKS = 256
const MAX_POST_RECHECK_BYTES = 32 * 1024 * 1024

/**
 * Runs the post's PSR recheck (BattlePost.buildRecheckPayload) when it is
 * due, after the post's other updates. Not queued when it is already due (the
 * post's first read of the pages came after the battle was counted) or would
 * redraw after `deadline` (unix ms), when `apply` no longer works; dropped when
 * the post's other updates delay it past the deadline. A restart drops the
 * waiting ones.
 */
export function queueBattlePostRecheck(
  post: BattlePost,
  apply: (p: BattlePostPayload) => Promise<unknown>,
  deadline = Infinity,
): void {
  const build = post.buildRecheckPayload
  const sessionIdHex = post.sessionIdHex
  const delayMs = post.recheckAt - Date.now()
  const redrawAt = post.recheckAt + PSR_RECHECK_STORE_WAIT_SEC * 1_000
  if (!build || postUpdatesStopping || delayMs <= 0 || redrawAt > deadline || postRechecks.has(post)) return
  const bytes = Math.max(0, Math.floor(post.updateBytes))
  const waiting = postRechecks.size + recheckTasks.size
  if (waiting >= MAX_POST_RECHECKS || postRechecksBytes + bytes > MAX_POST_RECHECK_BYTES) {
    console.warn(
      `[bot] PSR recheck of ${sessionIdHex} skipped: ${waiting} waiting, ` +
        `${(postRechecksBytes / 1024 / 1024).toFixed(1)} MiB`,
    )
    return
  }
  postRechecksBytes += bytes
  const timer = setTimeout(() => {
    postRechecks.delete(post)
    const task: Promise<void> = (async () => {
      // The last draw must keep the winner and flags the post's other updates drew.
      await postUpdates.get(post)?.task
      // Those updates (a squadron lookup) can hold it past the deadline.
      if (postUpdatesStopping || Date.now() + PSR_RECHECK_STORE_WAIT_SEC * 1_000 > deadline) return
      const payload = await build(postUpdatesAbort.signal)
      if (payload && !postUpdatesStopping && Date.now() <= deadline) await apply(payload)
    })()
      .catch((err: unknown) => {
        if (!postUpdatesStopping) {
          console.warn(`[bot] PSR recheck of ${sessionIdHex}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      .finally(() => {
        recheckTasks.delete(task)
        postRechecksBytes = Math.max(0, postRechecksBytes - bytes)
      })
    recheckTasks.add(task)
  }, delayMs)
  timer.unref()
  postRechecks.set(post, { timer, bytes })
}

async function waitForBattlePostSummary(sessionId: string) {
  const deadline = Date.now() + WINNER_UPDATE_WAIT_MS
  while (!postUpdatesStopping) {
    const summary = getBattlePostSummary(sessionId)
    if (summary) return summary
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return null
    await sleepWinnerUpdate(Math.min(WINNER_UPDATE_POLL_MS, remainingMs))
  }
  return null
}

function sleepWinnerUpdate(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function estimatePostUpdateBytes(results: ReplayResults, content: string): number {
  return 64 * 1024
    + Buffer.byteLength(content, 'utf8')
    + Buffer.byteLength(JSON.stringify(results), 'utf8')
}

/** Whether two PSR columns draw the same numbers. */
function samePsr(left: ReadonlyMap<string, BattlePsr>, right: ReadonlyMap<string, BattlePsr>): boolean {
  if (left.size !== right.size) return false
  for (const [userId, entry] of left) {
    const other = right.get(userId)
    if (!other) return false
    const shown = psrLabel(entry)
    const fresh = psrLabel(other)
    if (shown.psr !== fresh.psr || shown.change !== fresh.change) return false
  }
  return true
}

/**
 * Presses of battle:<kind>:<sessionId>[:<scale>]; only the ephemeral heatmap
 * toggle carries a scale. The replies and their images are in the presser's
 * language (locale.ts), each cached per language.
 */
export async function handleBattleButton(interaction: ButtonInteraction): Promise<void> {
  const locale = userLocale(interaction)
  const t = botText(locale).battle
  const [, rawKind, sessionId, rawScale] = interaction.customId.split(':')
  const kind = rawKind as BattleMediaKind
  if (!Object.hasOwn(t.media, kind) || !sessionId) return
  if (rawScale !== undefined && rawScale !== '1' && rawScale !== '2') return
  if (rawScale !== undefined && !isBattleHeatmapKind(kind)) return
  const scale: HeatmapScale = rawScale === '2' ? 2 : 1
  const isQualityToggle = rawScale !== undefined

  // Replies are seen only by the presser: otherwise the buttons clutter the channel.
  // Acknowledge before any cache, worker or network work: Discord gives 3 s.
  // An expired token (10062) is handled centrally in bot/index.ts.
  if (isQualityToggle) await interaction.deferUpdate()
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const sessionIdHex = BigInt(sessionId).toString(16).padStart(16, '0')
  const item = getItemByExternalId('wt-replays', sessionId)
  const data = item?.data as ReplayItemData | undefined
  const parts = data ? replayPartUrls(data) : []
  const meta = {
    missionName: data?.missionName ?? item?.title ?? '',
    gameMode: data?.gameMode,
    gameVersion: data?.gameVersion,
    ...(data ? { listedUserIds: listedUserIdsFromItem(data) } : {}),
    fakeNames: fakeNamesFromItem(data ?? {}),
  }
  let media: Buffer | null = null

  try {
    if (scale === 2 && isBattleHeatmapKind(kind)) {
      media = await cachedBattleHeatmap2x(sessionIdHex, kind, locale)
      if (!media) {
        // A battle ingest has not stored yet is drawn from its replay parts.
        if (!hasBattle(sessionId) && (!item || parts.length === 0)) {
          await interaction.editReply(t.noReplayForHd)
          return
        }
        media = await buildBattleHeatmap2x(
          sessionId,
          parts,
          kind,
          meta,
          locale,
          realNamesFromItem(data ?? {}),
          'interactive',
        )
      }
    } else {
      media = await cachedBattleMedia(sessionIdHex, kind, locale)
      if (!media) {
        // A stored battle builds from the database (no replay needed); otherwise the replay parts are.
        if (!hasBattle(sessionId) && (!item || parts.length === 0)) {
          await interaction.editReply(t.noReplayForMedia)
          return
        }
        media = await buildBattleMediaKind(
          sessionId,
          parts,
          meta,
          kind,
          locale,
          realNamesFromItem(data ?? {}),
          'interactive',
        )
      }
    }
  } catch (err) {
    console.error(`[bot] building ${kind} at ${scale}× for ${sessionId}:`, err)
    await interaction.editReply(
      isWorkerPoolSchedulingError(err) ? t.buildBusy(t.media[kind], scale) : t.buildFailed(t.media[kind], scale),
    )
    return
  }

  if (!media) return

  if (kind === 'chat') {
    let text = media.toString('utf8')
    if (text.length > 1900) text = text.slice(0, 1900) + '\n…'
    await interaction.editReply({ content: `**${t.chatTitle}**\n\`\`\`\n${text}\n\`\`\`\n${t.matchId}: \`${sessionId}\`` })
    return
  }

  let responseScale = scale
  let qualityNotice: string | undefined
  if (
    isBattleHeatmapKind(kind) &&
    heatmapScaleForUpload(scale, media.byteLength, interaction.attachmentSizeLimit) === 1 &&
    scale === 2
  ) {
    const hdByteLength = media.byteLength
    const standard = await cachedBattleMedia(sessionIdHex, kind, locale)
    if (!standard) {
      await interaction.editReply(t.hdOverLimitNoCache)
      return
    }
    media = standard
    responseScale = 1
    qualityNotice = t.hdOverLimit((hdByteLength / 1024 / 1024).toFixed(1))
  }

  await interaction.editReply({
    ...(qualityNotice ? { content: qualityNotice } : {}),
    ...(isQualityToggle ? { attachments: [] } : {}),
    files: [new AttachmentBuilder(media, { name: `battle-${sessionIdHex}-${kind}${responseScale === 2 ? '@2x' : ''}.png` })],
    components:
      isBattleHeatmapKind(kind) && !qualityNotice
        ? [heatmapQualityRow(kind, sessionId, responseScale, botText(locale))]
        : [],
  })
}
