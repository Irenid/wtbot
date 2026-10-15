import { createHash } from 'node:crypto'
import {
  DiscordAPIError,
  EmbedBuilder,
  RESTJSONErrorCodes,
  escapeMarkdown,
  type APIEmbed,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js'
import { config } from '../config.js'
import { mapConcurrent } from '../concurrency.js'
import {
  getDbWorkerPath,
  getEnabledPlayerStatBoards,
  getLatestItems,
  getLatestParsePerSource,
  getPlayerStatBoard,
  getVoicePresence,
  getWtPlayerSnapshotAtOrBefore,
  savePlayerStatBoard,
  saveItems,
  updatePlayerStatBoardPublication,
  type ParseRecord,
  type PlayerStatBoard,
  type StoredItem,
  type VoicePresenceRow,
} from '../db/index.js'
import { botText, type BotText, type Locale, type PlayerFetchError } from '../i18n/index.js'
import {
  collectPlayerItem,
  normalizeNickname as normalizedNickname,
  PlayerNotFoundError,
  PlayerSchemaError,
  PlayerSessionError,
} from '../parsers/sources/wt-player.js'
import type { PlayerStatsComparison, PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { runWorkerTask } from '../workers/pool.js'
import { guildLocale } from './locale.js'

const SOURCE = 'wt-players'
const TICK_MS = 60_000
const MESSAGE_VALIDATION_MS = 60 * 60_000
const STALE_AFTER_SEC = 90 * 60
const DAY_SEC = 24 * 60 * 60
const MAX_RENDERED_PLAYERS = 18
const MAX_VOICE_PLAYERS_TO_LOAD = 50
const VOICE_PLAYER_CACHE_TTL_SEC = 30 * 60
const VOICE_PLAYER_RETRY_SEC = 5 * 60
const BOARD_REFRESH_CONCURRENCY = 4

type PlayerMode = 'arcade' | 'realistic' | 'simulation'
type MetricValues = Record<string, string | null>

interface PlayerView {
  nickname: string
  clan: string | null
  level: number | null
  registrationDate: string | null
  statistics: Record<PlayerMode, MetricValues>
  replayCount: number
}

export interface PlayerBoardEntry {
  item: StoredItem
  baselineData: Record<string, unknown> | null
  baselineAt: number | null
  /** Voice channel presence; absent from legacy and render smoke entries. */
  voice?: VoicePresenceRow
  /** The lazy account/replay read model for the current voice. */
  account?: PlayerStatsComparison | null
  accountError?: AccountLookupError | null
  fetchState?: 'ready' | 'loading' | 'error' | 'unavailable'
  fetchError?: PlayerFetchError | null
}

type AccountLookupError = keyof BotText['playerBoard']['lookup']

interface LoadedPlayerBoardEntries {
  entries: PlayerBoardEntry[]
  missingNicknames: string[]
}

interface PlayerBoardMessagePayload {
  embeds: APIEmbed[]
  allowedMentions: { parse: [] }
}

export interface PlayerBoardRender {
  payload: PlayerBoardMessagePayload
  contentHash: string
  playerCount: number
}

export interface PlayerBoardRenderOptions {
  /** `voice` limits the description and the empty state to the current voice. */
  mode?: 'configured' | 'voice'
  /** The board's language; English without it. */
  locale?: Locale
}

export interface PlayerBoardRefreshResult {
  changed: boolean
  recreated: boolean
  messageUrl: string
  playerCount: number
}

let boardTimer: NodeJS.Timeout | null = null
let activeTick: Promise<void> | null = null
let stopping = false
let operationTail: Promise<void> = Promise.resolve()
const lastMessageValidation = new Map<string, number>()
const voiceFetches = new Map<string, {
  inFlight: Promise<void> | null
  nextAttemptAt: number
  error: PlayerFetchError | null
}>()
let boardClient: Client | null = null
let pendingTick = false
let playerStatsCoordinator: PlayerStatsCoordinator | null = null
let accountRefreshWait: Promise<void> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function metricValues(value: unknown): MetricValues {
  if (!isRecord(value)) return {}
  const result: MetricValues = {}
  for (const [key, metric] of Object.entries(value)) {
    if (typeof metric === 'string' || metric === null) result[key] = metric
  }
  return result
}

function playerView(value: unknown, fallbackNickname: string, unknownPlayer: string): PlayerView | null {
  if (!isRecord(value)) return null
  const profile = value['profile']
  const statistics = value['statistics']
  if (!isRecord(profile) || !isRecord(statistics)) return null
  const nickname = nullableString(profile['nickname']) ?? (fallbackNickname.trim() || unknownPlayer)
  const level = typeof profile['level'] === 'number' && Number.isFinite(profile['level']) ? profile['level'] : null
  const replayCount = typeof value['replayCount'] === 'number' && Number.isFinite(value['replayCount'])
    ? Math.max(0, Math.trunc(value['replayCount']))
    : 0
  return {
    nickname,
    clan: nullableString(profile['clan']),
    level,
    registrationDate: nullableString(profile['registrationDate']),
    statistics: {
      arcade: metricValues(statistics['arcade']),
      realistic: metricValues(statistics['realistic']),
      simulation: metricValues(statistics['simulation']),
    },
    replayCount,
  }
}

function integerMetric(value: string | null | undefined): number | null {
  if (value == null) return null
  const normalized = value.replace(/[\s,_]/g, '')
  if (!/^-?\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function formatInteger(value: number | null, t: BotText): string {
  return value === null ? '—' : t.number(value)
}

function formatDelta(current: number | null, previous: number | null, t: BotText): string {
  if (current === null || previous === null) return ''
  const delta = current - previous
  return t.playerBoard.delta(`${delta > 0 ? '+' : ''}${t.number(delta)}`)
}

function totalTargets(metrics: MetricValues): number | null {
  const values = [
    integerMetric(metrics['Air targets destroyed']),
    integerMetric(metrics['Ground targets destroyed']),
    integerMetric(metrics['Naval targets destroyed']),
  ]
  const known = values.filter((value): value is number => value !== null)
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
}

function modeLine(
  label: string,
  icon: string,
  current: MetricValues,
  previous: MetricValues | null,
  t: BotText,
): string {
  const battles = integerMetric(current['Completed missions'])
  const victories = integerMetric(current['Victories'])
  const previousBattles = previous ? integerMetric(previous['Completed missions']) : null
  const previousVictories = previous ? integerMetric(previous['Victories']) : null
  const ratio = nullableString(current['Victories/battles ratio']) ?? '—'
  const deaths = integerMetric(current['Deaths'])
  const targets = totalTargets(current)
  const text = t.playerBoard
  return (
    `${icon} **${label}**: ${text.battles(formatInteger(battles, t))}${formatDelta(battles, previousBattles, t)}` +
    ` · ${text.victories(formatInteger(victories, t))}${formatDelta(victories, previousVictories, t)}` +
    ` · ${escapeMarkdown(ratio)} · ${text.deaths(formatInteger(deaths, t))} · ${text.targets(formatInteger(targets, t))}`
  )
}

/** The account line; a source's own error text stays in the log and the site, never on the board. */
function accountLine(comparison: PlayerStatsComparison, t: BotText): string {
  const account = comparison.account
  const aggregate = account.totals.find((row) =>
    row.gameType === null && row.mode === null && row.category === null,
  ) ?? account.totals[0]
  const replay = comparison.replay.stats
  const parts = [`🌐 ${t.playerBoard.accountStates[account.state]}`]
  if (aggregate?.battles !== null && aggregate?.battles !== undefined) {
    parts.push(t.playerBoard.accountBattles(formatInteger(aggregate.battles, t)))
  }
  if (aggregate?.victories !== null && aggregate?.victories !== undefined) {
    const accountRate = aggregate.battles !== null && aggregate.battles > 0
      ? ` · ${((aggregate.victories / aggregate.battles) * 100).toFixed(1)}%`
      : ''
    parts.push(`${t.playerBoard.accountVictories(formatInteger(aggregate.victories, t))}${accountRate}`)
  }
  if (replay !== null) {
    const replayRate = replay.winRate === null ? '—' : `${(replay.winRate * 100).toFixed(1)}%`
    parts.push(t.playerBoard.replayStats(formatInteger(replay.battles, t), replayRate))
  }
  return parts.join(' · ')
}

function playerField(entry: PlayerBoardEntry, t: BotText): { name: string; value: string; inline: false } {
  const text = t.playerBoard
  const current = playerView(entry.item.data, entry.item.title, text.unknownPlayer)
  const voice = entry.voice
  const voiceLine = voice === undefined
    ? null
    : `🎙️ ${escapeMarkdown(voice.channelName)} (<#${voice.channelId}>)`
  if (current === null) {
    return {
      name: escapeMarkdown(entry.item.title || text.unknownPlayer).slice(0, 256),
      value: [voiceLine, text.unknownFormat]
        .filter((line): line is string => line !== null)
        .join('\n'),
      inline: false,
    }
  }
  const previous = entry.baselineData ? playerView(entry.baselineData, current.nickname, text.unknownPlayer) : null
  const profile = [
    voiceLine,
    current.clan ? text.squadron(escapeMarkdown(current.clan)) : text.noSquadron,
    current.level === null ? null : text.level(current.level),
    current.registrationDate ? text.registered(escapeMarkdown(current.registrationDate)) : null,
    text.replaysFound(t.number(current.replayCount)),
  ].filter((part): part is string => part !== null)
  const lines = [
    profile.join(' · '),
    modeLine(text.modes.arcade, '🕹️', current.statistics['arcade'], previous?.statistics['arcade'] ?? null, t),
    modeLine(text.modes.realistic, '🎯', current.statistics['realistic'], previous?.statistics['realistic'] ?? null, t),
    modeLine(text.modes.simulation, '🛠️', current.statistics['simulation'], previous?.statistics['simulation'] ?? null, t),
  ]
  if (entry.account !== undefined && entry.account !== null) lines.push(accountLine(entry.account, t))
  if (entry.accountError !== undefined && entry.accountError !== null) {
    lines.push(text.statistics(text.lookup[entry.accountError]))
  }
  if (entry.fetchState === 'loading') lines.push(text.profileLoading)
  if (entry.fetchState === 'unavailable') lines.push(text.profileUnavailable)
  if (entry.fetchState === 'error') lines.push(text.profileError[entry.fetchError ?? 'other'])
  if (previous === null) lines.push(text.firstDay)
  return {
    name: escapeMarkdown(current.nickname).slice(0, 256),
    value: lines.join('\n').slice(0, 1024),
    inline: false,
  }
}

function parserState(parse: ParseRecord | null, nowSec: number, t: BotText): { text: string; color: number } {
  const text = t.playerBoard.parser
  if (parse === null) return { text: text.never, color: 0x95a5a6 }
  const relative = `<t:${parse.parsedAt}:R>`
  if (!parse.ok) return { text: text.failed(relative), color: 0xe74c3c }
  // wt-players' summary lists failed nicks after "errors:" ("ошибки:" in history written before 2026-10-15)
  if (/(?:errors|ошибки)\s*:/iu.test(parse.summary ?? '')) return { text: text.partial(relative), color: 0xf1c40f }
  if (nowSec - parse.parsedAt > STALE_AFTER_SEC) return { text: text.stale(relative), color: 0xf1c40f }
  return { text: text.fresh(relative), color: 0x2ecc71 }
}

/** A pure render: used by the publisher and the isolated smoke test. */
export function renderPlayerBoard(
  entries: PlayerBoardEntry[],
  parse: ParseRecord | null,
  nowSec: number,
  configuredCount = entries.length,
  missingNicknames: string[] = [],
  options: PlayerBoardRenderOptions = {},
): PlayerBoardRender {
  const t = botText(options.locale)
  const text = t.playerBoard
  const state = parserState(parse, nowSec, t)
  const shown = entries.slice(0, MAX_RENDERED_PLAYERS)
  const voiceMode = options.mode === 'voice' || entries.some((entry) => entry.voice !== undefined)
  const description = [
    state.text,
    voiceMode ? text.voiceIntro : text.configuredIntro,
    configuredCount > entries.length
      ? voiceMode
        ? text.voiceLoaded(configuredCount, entries.length)
        : text.collected(entries.length, configuredCount)
      : null,
    !voiceMode && missingNicknames.length > 0
      ? text.missing(`${missingNicknames.slice(0, 5).map((nickname) => escapeMarkdown(nickname)).join(', ')}${missingNicknames.length > 5 ? '…' : ''}`)
      : null,
  ].filter((line): line is string => line !== null)
  const candidateFields = shown.map((entry) => playerField(entry, t))
  const baseCharacters = text.title.length + description.join('\n').length + text.footer.length
  const fields: { name: string; value: string; inline: false }[] = []
  let usedCharacters = baseCharacters
  for (const field of candidateFields) {
    const fieldCharacters = field.name.length + field.value.length
    if (usedCharacters + fieldCharacters > 5_800 && fields.length > 0) break
    fields.push(field)
    usedCharacters += fieldCharacters
  }
  const totalPlayers = voiceMode ? configuredCount : entries.length
  const omitted = Math.max(0, totalPlayers - fields.length)
  if (omitted > 0) description.push(text.omitted(fields.length, totalPlayers))
  const embed = new EmbedBuilder()
    .setTitle(text.title)
    .setColor(state.color)
    .setDescription(description.join('\n'))
    .setFooter({ text: text.footer })

  if (fields.length === 0) {
    embed.addFields(voiceMode ? text.emptyVoice : text.emptyConfigured)
  } else {
    embed.addFields(fields)
  }
  const timestamp = parse?.parsedAt ?? Math.max(0, ...entries.map((entry) => entry.item.updatedAt))
  if (timestamp > 0) embed.setTimestamp(new Date(timestamp * 1000))

  const payload: PlayerBoardMessagePayload = {
    embeds: [embed.toJSON()],
    allowedMentions: { parse: [] },
  }
  const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return { payload, contentHash, playerCount: entries.length }
}

function placeholderItem(voice: VoicePresenceRow): StoredItem {
  return {
    id: 0,
    source: SOURCE,
    externalId: `voice:${voice.guildId}:${voice.userId}`,
    title: voice.wtNick,
    data: {
      profile: {
        nickname: voice.wtNick,
        clan: null,
        level: null,
        registrationDate: null,
        avatar: null,
      },
      statistics: { arcade: {}, realistic: {}, simulation: {} },
      replayIdentity: null,
      replayCount: 0,
      replays: [],
    },
    updatedAt: 0,
    analysis: null,
  }
}

function fetchErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'unknown error').slice(0, 300)
}

/** What the board may say about a failed profile request; the message itself goes to the log. */
function fetchErrorKind(error: unknown): PlayerFetchError {
  if (error instanceof PlayerNotFoundError) return 'notFound'
  if (error instanceof PlayerSessionError) return 'session'
  if (error instanceof PlayerSchemaError) return 'schema'
  return 'other'
}

function queueVoicePlayerFetch(nickname: string): void {
  const key = normalizedNickname(nickname)
  if (key === '' || config.wtCookie.trim() === '') return
  const previous = voiceFetches.get(key)
  if (previous?.inFlight !== null && previous?.inFlight !== undefined) return
  const state = previous ?? { inFlight: null, nextAttemptAt: 0, error: null }
  const task = Promise.resolve()
    .then(() => collectPlayerItem(nickname))
    .then((item) => {
      saveItems(SOURCE, [item])
      state.error = null
      state.nextAttemptAt = 0
    })
    .catch((error: unknown) => {
      state.error = fetchErrorKind(error)
      state.nextAttemptAt = Math.floor(Date.now() / 1000) + VOICE_PLAYER_RETRY_SEC
      console.warn(`[player-board] ${nickname}: ${fetchErrorMessage(error)}`)
    })
    .then(() => {
      state.inFlight = null
      requestPlayerBoardRefresh()
    })
  state.inFlight = task
  voiceFetches.set(key, state)
  void task
}

function fetchStateFor(
  nickname: string,
  item: StoredItem,
  nowSec: number,
): { state: NonNullable<PlayerBoardEntry['fetchState']>; error: PlayerFetchError | null } {
  const fresh = item.id !== 0 && item.updatedAt > nowSec - VOICE_PLAYER_CACHE_TTL_SEC
  const previous = voiceFetches.get(normalizedNickname(nickname))
  if (fresh) return { state: 'ready', error: null }
  if (previous?.inFlight !== null && previous?.inFlight !== undefined) {
    return { state: 'loading', error: null }
  }
  if (config.wtCookie.trim() === '') return { state: 'unavailable', error: null }
  if (previous?.error !== null && previous?.error !== undefined && nowSec < previous.nextAttemptAt) {
    return { state: 'error', error: previous.error }
  }
  queueVoicePlayerFetch(nickname)
  return { state: 'loading', error: null }
}

function lookupAccountStats(nickname: string): {
  account: PlayerStatsComparison | null
  error: AccountLookupError | null
} {
  if (playerStatsCoordinator === null) return { account: null, error: null }
  try {
    const result = playerStatsCoordinator.lookup({ player: nickname })
    if (result.status === 'ok') {
      if (result.stats.account.refreshQueued && accountRefreshWait === null) {
        const service = playerStatsCoordinator
        accountRefreshWait = service.waitForIdle()
          .then(() => requestPlayerBoardRefresh())
          .catch((error: unknown) => {
            if (!stopping) {
              console.warn(`[player-board] waiting for account statistics failed: ${fetchErrorMessage(error)}`)
            }
          })
          .finally(() => {
            accountRefreshWait = null
          })
      }
      return { account: result.stats, error: null }
    }
    return { account: null, error: result.status === 'ambiguous' ? 'ambiguous' : 'unknown' }
  } catch (error) {
    console.warn(`[player-board] account statistics of ${nickname}: ${fetchErrorMessage(error)}`)
    return { account: null, error: 'error' }
  }
}

function loadVoiceEntries(nowSec: number, guildId: string, locale: Locale): LoadedPlayerBoardEntries {
  const { intl } = botText(locale)
  const presence = getVoicePresence()
    .filter((entry) => entry.guildId === guildId)
    .sort((left, right) =>
      left.channelName.localeCompare(right.channelName, intl)
      || left.wtNick.localeCompare(right.wtNick, intl)
      || left.userId.localeCompare(right.userId),
    )
  if (presence.length === 0) return { entries: [], missingNicknames: [] }

  const itemLimit = Math.min(5_000, Math.max(100, presence.length * 4))
  const latestByNickname = new Map<string, StoredItem>()
  for (const item of getLatestItems(itemLimit, SOURCE)) {
    const key = normalizedNickname(item.title)
    if (key !== '' && !latestByNickname.has(key)) latestByNickname.set(key, item)
  }

  const cutoff = nowSec - DAY_SEC
  const entries = presence.slice(0, MAX_VOICE_PLAYERS_TO_LOAD).map((voice) => {
    const item = latestByNickname.get(normalizedNickname(voice.wtNick)) ?? placeholderItem(voice)
    const snapshot = item.id === 0
      ? null
      : getWtPlayerSnapshotAtOrBefore(item.externalId, item.title, cutoff)
    const currentData = isRecord(item.data) ? item.data : null
    // Right after the history migration, updated_at proves the current value
    // did not change over the whole interval, so a zero delta is true.
    const unchangedForDay = item.id !== 0 && snapshot === null && currentData !== null && item.updatedAt <= cutoff
    const fetchState = fetchStateFor(voice.wtNick, item, nowSec)
    const account = lookupAccountStats(voice.wtNick)
    return {
      item,
      baselineData: snapshot?.data ?? (unchangedForDay ? currentData : null),
      baselineAt: snapshot?.capturedAt ?? (unchangedForDay ? item.updatedAt : null),
      voice,
      account: account.account,
      accountError: account.error,
      fetchState: fetchState.state,
      fetchError: fetchState.error,
    }
  })
  return { entries, missingNicknames: [] }
}

/** A board's language: its server's (locale.ts); a /language change redraws it through the content hash. */
function boardLocale(client: Client, guildId: string): Locale {
  return guildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale)
}

function buildCurrentRender(
  guildId: string,
  locale: Locale,
  nowSec = Math.floor(Date.now() / 1000),
): PlayerBoardRender {
  const parse = getLatestParsePerSource().find((entry) => entry.source === SOURCE) ?? null
  const loaded = loadVoiceEntries(nowSec, guildId, locale)
  return renderPlayerBoard(
    loaded.entries,
    parse,
    nowSec,
    getVoicePresence().filter((entry) => entry.guildId === guildId).length,
    loaded.missingNicknames,
    { mode: 'voice', locale },
  )
}

function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

async function resolveChannel(client: Client, channelId: string): Promise<GuildTextBasedChannel> {
  const channel = await client.channels.fetch(channelId)
  if (channel === null || channel.isDMBased() || !channel.isTextBased() || !channel.isSendable()) {
    throw new Error(`channel ${channelId} is unavailable or takes no messages`)
  }
  return channel as GuildTextBasedChannel
}

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage
}

async function fetchOwnedMessage(
  client: Client,
  channel: GuildTextBasedChannel,
  messageId: string,
): Promise<Message | null> {
  let message: Message
  try {
    message = await channel.messages.fetch(messageId)
  } catch (error) {
    if (isUnknownMessage(error)) return null
    throw error
  }
  return message.author.id === client.user?.id ? message : null
}

async function retirePreviousBoardMessage(
  client: Client,
  previous: PlayerStatBoard | null,
  newChannelId: string,
): Promise<void> {
  if (previous === null || previous.channelId === newChannelId) return
  try {
    const oldChannel = await resolveChannel(client, previous.channelId)
    const oldMessage = await fetchOwnedMessage(client, oldChannel, previous.messageId)
    if (oldMessage !== null) {
      await oldMessage.edit({
        content: botText(boardLocale(client, previous.guildId)).playerBoard.moved(`<#${newChannelId}>`),
        embeds: [],
        allowedMentions: { parse: [] },
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[player-board] could not mark the old board of ${previous.guildId} as moved: ${message}`)
  }
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation)
  operationTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function refreshBoardInternal(
  client: Client,
  board: PlayerStatBoard,
  force: boolean,
): Promise<PlayerBoardRefreshResult> {
  const render = buildCurrentRender(board.guildId, boardLocale(client, board.guildId))
  const now = Date.now()
  const shouldValidate = now - (lastMessageValidation.get(board.guildId) ?? 0) >= MESSAGE_VALIDATION_MS
  if (!force && board.lastContentHash === render.contentHash && !shouldValidate) {
    return {
      changed: false,
      recreated: false,
      messageUrl: messageUrl(board.guildId, board.channelId, board.messageId),
      playerCount: render.playerCount,
    }
  }

  const channel = await resolveChannel(client, board.channelId)
  const existing = await fetchOwnedMessage(client, channel, board.messageId)
  let message = existing
  let recreated = false
  let changed = false
  if (message === null) {
    message = await channel.send(render.payload)
    recreated = true
    changed = true
  } else if (force || board.lastContentHash !== render.contentHash) {
    await message.edit(render.payload)
    changed = true
  }
  lastMessageValidation.set(board.guildId, now)
  if (changed) {
    const dbPath = getDbWorkerPath()
    if (dbPath === null) {
      updatePlayerStatBoardPublication(board.guildId, message.id, render.contentHash)
    } else {
      await runWorkerTask(
        {
          kind: 'update-player-stat-board-publication',
          input: {
            dbPath,
            guildId: board.guildId,
            messageId: message.id,
            contentHash: render.contentHash,
          },
        },
        { priority: 'normal', timeoutMs: 30_000 },
      )
    }
  }
  return {
    changed,
    recreated,
    messageUrl: message.url,
    playerCount: render.playerCount,
  }
}

export function refreshPlayerStatBoard(
  client: Client,
  guildId: string,
  force = false,
): Promise<PlayerBoardRefreshResult> {
  return serialize(async () => {
    const board = getPlayerStatBoard(guildId)
    if (board === null || !board.enabled) throw new Error('the player board is not set up on this server')
    return refreshBoardInternal(client, board, force)
  })
}

export function configurePlayerStatBoard(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<PlayerBoardRefreshResult> {
  return serialize(async () => {
    const render = buildCurrentRender(guildId, boardLocale(client, guildId))
    const channel = await resolveChannel(client, channelId)
    const previous = getPlayerStatBoard(guildId)
    const existing = previous?.channelId === channelId
      ? await fetchOwnedMessage(client, channel, previous.messageId)
      : null
    const message = existing ?? await channel.send(render.payload)
    if (existing !== null) await existing.edit(render.payload)
    savePlayerStatBoard(guildId, channelId, message.id, render.contentHash)
    await retirePreviousBoardMessage(client, previous, channelId)
    lastMessageValidation.set(guildId, Date.now())
    return {
      changed: true,
      recreated: existing === null,
      messageUrl: message.url,
      playerCount: render.playerCount,
    }
  })
}

async function tick(client: Client): Promise<void> {
  const boards = getEnabledPlayerStatBoards()
  await mapConcurrent(boards, BOARD_REFRESH_CONCURRENCY, async (board) => {
    if (stopping) return
    try {
      const result = await refreshBoardInternal(client, board, false)
      if (result.changed) {
        console.log(
          `[player-board] ${result.recreated ? 'restored' : 'updated'} the board of server ${board.guildId}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[player-board] server ${board.guildId}: ${message}`)
    }
  })
}

function scheduleBoardTick(client: Client): void {
  if (stopping) return
  if (activeTick !== null) {
    pendingTick = true
    return
  }
  activeTick = serialize(() => tick(client))
    .catch((error: unknown) => {
      if (!stopping) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[player-board] background tick failed: ${message}`)
      }
    })
    .finally(() => {
      activeTick = null
      if (pendingTick && !stopping) {
        pendingTick = false
        scheduleBoardTick(client)
      }
    })
}

/** Queues a redraw at once: voice_presence or a server's language changed. */
export function requestPlayerBoardRefresh(): void {
  if (boardClient !== null) scheduleBoardTick(boardClient)
}

export interface PlayerBoardPublisherOptions {
  playerStats?: PlayerStatsCoordinator | null
}

export function startPlayerBoardPublisher(
  client: Client,
  options: PlayerBoardPublisherOptions = {},
): void {
  boardClient = client
  playerStatsCoordinator = options.playerStats ?? null
  if (boardTimer !== null) return
  stopping = false
  scheduleBoardTick(client)
  boardTimer = setInterval(() => scheduleBoardTick(client), TICK_MS)
  boardTimer.unref()
  console.log('[player-board] board auto-update started')
}

export async function stopPlayerBoardPublisher(): Promise<void> {
  stopping = true
  if (boardTimer !== null) clearInterval(boardTimer)
  boardTimer = null
  await Promise.allSettled([activeTick, operationTail])
  activeTick = null
  pendingTick = false
  boardClient = null
  playerStatsCoordinator = null
  accountRefreshWait = null
  voiceFetches.clear()
  lastMessageValidation.clear()
}
