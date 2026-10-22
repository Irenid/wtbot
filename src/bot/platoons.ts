import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  RESTJSONErrorCodes,
  escapeMarkdown,
  type APIEmbed,
  type Client,
  type Guild,
  type GuildMember,
  type NewsChannel,
  type TextChannel,
  type VoiceBasedChannel,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js'
import { createHash } from 'node:crypto'
import { subscribeBattleLifecycle } from '../battle-lifecycle.js'
import { mapConcurrent } from '../concurrency.js'
import {
  deleteBotState,
  getBotState,
  getClanSeasonContext,
  getDbWorkerPath,
  getPlatoonNickPlayers,
  getPlatoonPlayerRows,
  getPlatoonRatings,
  getPlatoonRoster,
  getScoutStages,
  listBotStateKeys,
  setBotState,
} from '../db/index.js'
import { botText, type BotText } from '../i18n/index.js'
import { PLATOON_SIZE, planPlatoons, type Candidate, type PlanResult } from '../platoons/plan.js'
import { ratePlatoonPlayers, type RatedMember, type RateInput, type RateOutput } from '../platoons/rate.js'
import { findSquadrons } from '../scout/report.js'
import { squadronLabel } from '../scout/format.js'
import type { ScoutClass } from '../scout/model.js'
import { fetchRatingsForTags } from '../wrpl/clan-info.js'
import { ensureVehicleDict, type VehicleDict } from '../wrpl/vehicles.js'
import { runWorkerTask } from '../workers/pool.js'
import { guildLocale } from './locale.js'
import { parseWtNick } from './voice-tracker.js'

/**
 * Platoon suggestions (/settings platoons set lobby: squadron: [channel:]):
 * the squadron's players gather in one voice channel, the lobby, and play
 * from the rooms beside it (the voice channels of its category, made by the
 * server's join-to-create hub or by hand). A post, edited in place (sent anew
 * at the channel's bottom once buried, sinksPost; gone once nobody has been in
 * voice for EMPTY_KEEP_MS, emptyVoicePost), suggests
 * who should play where — the most useful for the BR that plays now (the
 * post itself never says so; src/platoons/: identify.ts who they are, strength.ts how
 * useful, plan.ts the advice for every case). The bot moves nobody and
 * creates no room: the field commander decides. Ratings are never shown.
 *
 * A pass runs PASS_DEBOUNCE_MS after a voice change in the lobby or beside
 * it, every TICK_MS (nick changes, the BR stage) and after a stored battle
 * (new strengths); passes of one server never overlap. Strengths are read in
 * worker task `read-platoon-players` and kept RATE_TTL_MS per member. State
 * per server — bot_state `platoons:<guildId>`.
 */

const KEY = 'platoons:'
const TICK_MS = 60_000
const PASS_DEBOUNCE_MS = 3_000
/** A stored battle changes strengths: one pass per server this long after a burst of them. */
const BATTLE_DEBOUNCE_MS = 30_000
const RATE_TTL_MS = 10 * 60_000
/** The squadron's claninfo page (its roster) is reread this often while players are in voice; clan-info.ts throttles it too. */
const ROSTER_REFRESH_MS = 10 * 60_000
/**
 * With nobody in voice the post stays this long (a player stepping out keeps it), then goes, and comes back
 * at the channel's bottom with the next player: a standing «nobody is in voice» was clutter in a shared
 * channel (the owner's «канал замусорен», 2026-10-22, Test pechenka's расписание-и-сборы).
 */
const EMPTY_KEEP_MS = 10 * 60_000
const MEMBER_FETCH_CONCURRENCY = 4
/** Discord's limit on all of an embed's text. */
const EMBED_MAX = 6000

interface Settings {
  lobbyId: string
  /** The squadron's tag core. */
  clan: string
  /** The post's channel; null — the lobby's chat. */
  channelId: string | null
}

interface Stored {
  settings: Settings
  messageId: string | null
}

interface Rated {
  wtNick: string
  member: RatedMember
  at: number
}

interface Present {
  member: GuildMember
  channelId: string
}

type PostChannel = TextChannel | NewsChannel | VoiceChannel

let client: Client | null = null
let stopping = false
let tickTimer: NodeJS.Timeout | null = null
let battleTimer: NodeJS.Timeout | null = null
let unsubscribeBattles: (() => void) | null = null
const debounce = new Map<string, NodeJS.Timeout>()
const running = new Map<string, Promise<void>>()
const again = new Set<string>()
const rated = new Map<string, Map<string, Rated>>()
const caps = new Map<string, number | null>()
const firstSeen = new Map<string, number>()
const rosterReadAt = new Map<string, number>()
const lastPost = new Map<string, string>()
/** Since when nobody has been in voice, per server (Date.now ms). */
const emptySince = new Map<string, number>()

const nowSec = () => Math.floor(Date.now() / 1000)

function read(guildId: string): Stored | null {
  const raw = getBotState(KEY + guildId)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as { settings?: Partial<Settings>; messageId?: unknown }
    const settings = value.settings
    if (typeof settings?.lobbyId !== 'string' || typeof settings.clan !== 'string') return null
    return {
      settings: { lobbyId: settings.lobbyId, clan: settings.clan, channelId: typeof settings.channelId === 'string' ? settings.channelId : null },
      messageId: typeof value.messageId === 'string' ? value.messageId : null,
    }
  } catch {
    return null
  }
}

function write(guildId: string, stored: Stored): void {
  setBotState(KEY + guildId, JSON.stringify(stored))
}

function forget(guildId: string): void {
  deleteBotState(KEY + guildId)
  rated.delete(guildId)
  caps.delete(guildId)
  lastPost.delete(guildId)
  emptySince.delete(guildId)
}

export function platoonSettings(guildId: string): Settings | null {
  return read(guildId)?.settings ?? null
}

/** Where the post goes: the chosen channel, else the lobby's chat. */
function postChannel(guild: Guild, settings: Settings): PostChannel | null {
  const channel = guild.channels.cache.get(settings.channelId ?? settings.lobbyId)
  return channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement
    || channel?.type === ChannelType.GuildVoice ? channel : null
}

/** /settings platoons set: the lobby, the squadron and the post's channel; a post left in another channel goes. */
export async function setupPlatoons(guild: Guild, settings: Settings): Promise<void> {
  const stored = read(guild.id)
  const samePost = stored !== null && (stored.settings.channelId ?? stored.settings.lobbyId) === (settings.channelId ?? settings.lobbyId)
  if (stored !== null && !samePost) await deletePost(guild, stored)
  write(guild.id, { settings, messageId: samePost ? stored.messageId : null })
  rated.delete(guild.id)
  lastPost.delete(guild.id)
  schedule(guild.id, 0)
}

/** /settings platoons remove: the suggestions stop, the post goes. */
export async function removePlatoons(guild: Guild): Promise<boolean> {
  const stored = read(guild.id)
  if (stored === null) return false
  forget(guild.id)
  await deletePost(guild, stored)
  return true
}

/** The lobby or the post's channel deleted: the suggestions stop. */
export function forgetPlatoonChannel(guild: Guild, channelId: string): void {
  const stored = read(guild.id)
  if (stored === null || (stored.settings.lobbyId !== channelId && stored.settings.channelId !== channelId)) return
  forget(guild.id)
  void deletePost(guild, stored)
  console.log(`[platoons] server ${guild.id}: channel ${channelId} was deleted, the suggestions are off`)
}

export function forgetPlatoonGuild(guildId: string): void {
  forget(guildId)
}

async function deletePost(guild: Guild, stored: Stored): Promise<void> {
  const channel = postChannel(guild, stored.settings)
  if (stored.messageId !== null && channel !== null) await channel.messages.delete(stored.messageId).catch(() => undefined)
}

export function startPlatoons(readyClient: Client): void {
  client = readyClient
  stopping = false
  readyClient.on('voiceStateUpdate', onVoice)
  tickTimer = setInterval(() => {
    for (const guildId of configuredGuilds()) schedule(guildId, 0)
  }, TICK_MS)
  tickTimer.unref()
  unsubscribeBattles = subscribeBattleLifecycle((event) => {
    if (event.kind !== 'committed' || battleTimer !== null) return
    battleTimer = setTimeout(() => {
      battleTimer = null
      // New battles change strengths: each member is read afresh at the next pass.
      rated.clear()
      for (const guildId of configuredGuilds()) schedule(guildId, 0)
    }, BATTLE_DEBOUNCE_MS)
    battleTimer.unref()
  })
  for (const guildId of configuredGuilds()) schedule(guildId, 0)
}

export async function stopPlatoons(): Promise<void> {
  stopping = true
  client?.off('voiceStateUpdate', onVoice)
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  if (battleTimer) clearTimeout(battleTimer)
  battleTimer = null
  unsubscribeBattles?.()
  unsubscribeBattles = null
  for (const timer of debounce.values()) clearTimeout(timer)
  debounce.clear()
  await Promise.allSettled([...running.values()])
}

function configuredGuilds(): string[] {
  return listBotStateKeys(KEY).map((key) => key.slice(KEY.length))
}

function onVoice(before: VoiceState, after: VoiceState): void {
  if (stopping) return
  const settings = read(after.guild.id)?.settings
  if (!settings) return
  const parentId = after.guild.channels.cache.get(settings.lobbyId)?.parentId ?? null
  // A deafen counts too: a deafened player in the lobby is not placed.
  const watched = (channel: VoiceBasedChannel | null) =>
    channel !== null && (channel.id === settings.lobbyId || (parentId !== null && channel.parentId === parentId))
  if (watched(before.channel) || watched(after.channel)) schedule(after.guild.id, PASS_DEBOUNCE_MS)
}

function schedule(guildId: string, delayMs: number): void {
  if (stopping) return
  const pending = debounce.get(guildId)
  if (pending) clearTimeout(pending)
  const timer = setTimeout(() => {
    debounce.delete(guildId)
    run(guildId)
  }, delayMs)
  timer.unref()
  debounce.set(guildId, timer)
}

/** One pass per server at a time; a request meanwhile runs one more after it. */
function run(guildId: string): void {
  if (running.has(guildId)) {
    again.add(guildId)
    return
  }
  const guild = client?.guilds.cache.get(guildId)
  if (!guild) return
  const task = pass(guild)
    .catch((error: unknown) => console.warn(`[platoons] server ${guildId}: the pass failed:`, error))
    .finally(() => {
      running.delete(guildId)
      if (again.delete(guildId)) run(guildId)
    })
  running.set(guildId, task)
}

async function pass(guild: Guild): Promise<void> {
  const stored = read(guild.id)
  if (stored === null) return
  const { settings } = stored
  const lobby = guild.channels.cache.get(settings.lobbyId)
  if (lobby?.type !== ChannelType.GuildVoice) return
  const rooms = roomsBeside(lobby)
  const present = await presentIn(guild, new Set([lobby.id, ...rooms.map((room) => room.id)]))
  const now = nowSec()
  trackFirstSeen(guild.id, present, now)
  // The roster tells members from guests: read while someone is there to place.
  if (present.length > 0) refreshRoster(guild.id, settings.clan)
  const ratings = await rate(guild.id, settings.clan, present)
  const list = present.map(({ member, channelId }): Candidate => {
    const rating = ratings.get(member.id)?.member
    return {
      userId: member.id,
      room: channelId === lobby.id ? null : channelId,
      deaf: member.voice.deaf === true,
      standing: rating?.identity.standing ?? 'unknown',
      strength: rating?.strength ?? 0,
      since: firstSeen.get(`${guild.id}:${member.id}`) ?? now,
    }
  })
  const plan = planPlatoons(rooms.map((room) => room.id), list)
  const nicks = new Map(present.map(({ member }) => [member.id, parseWtNick(member.displayName || member.user.username)]))
  await publish(guild, stored, { lobbyId: lobby.id, rooms: new Map(rooms.map((room) => [room.id, room.name])), plan, list, ratings, nicks })
}

/** The voice channels of the lobby's category the bot can see, in Discord's order (position, then age). */
function roomsBeside(lobby: VoiceChannel): VoiceChannel[] {
  return [...(lobby.parent?.children.cache.values() ?? [])]
    .filter((channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice && channel.id !== lobby.id && channel.viewable)
    .sort((a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
}

/**
 * Members in the lobby and the rooms, bots aside. GUILD_CREATE brings voice states without members, so
 * after a restart the missing ones are fetched (one REST call each): a member left out gets no advice.
 */
async function presentIn(guild: Guild, channelIds: ReadonlySet<string>): Promise<Present[]> {
  const states = [...guild.voiceStates.cache.values()].filter((state) => state.channelId !== null && channelIds.has(state.channelId))
  const members = await mapConcurrent(states, MEMBER_FETCH_CONCURRENCY, (state) =>
    state.member ? Promise.resolve(state.member) : guild.members.fetch(state.id).catch(() => null))
  return states.flatMap((state, index) => {
    const member = members[index]
    return member && !member.user.bot ? [{ member, channelId: state.channelId! }] : []
  })
}

function trackFirstSeen(guildId: string, present: readonly Present[], now: number): void {
  const here = new Set(present.map((item) => `${guildId}:${item.member.id}`))
  for (const key of firstSeen.keys()) if (key.startsWith(`${guildId}:`) && !here.has(key)) firstSeen.delete(key)
  for (const key of here) if (!firstSeen.has(key)) firstSeen.set(key, now)
}

function refreshRoster(guildId: string, clan: string): void {
  const last = rosterReadAt.get(guildId) ?? 0
  if (Date.now() - last < ROSTER_REFRESH_MS) return
  rosterReadAt.set(guildId, Date.now())
  const tags = findSquadrons(clan, 1)[0]?.tags ?? []
  if (tags.length > 0) {
    void fetchRatingsForTags(tags.slice(0, 8)).catch((error: unknown) =>
      console.warn(`[platoons] the roster of ${clan} was not refreshed:`, error))
  }
}

/** The members' identities and strengths: cached ones younger than RATE_TTL_MS, the rest read in a worker. */
async function rate(guildId: string, clan: string, present: readonly Present[]): Promise<Map<string, Rated>> {
  const cache = rated.get(guildId) ?? new Map<string, Rated>()
  rated.set(guildId, cache)
  const now = Date.now()
  const wanted = present.map(({ member }) => ({ userId: member.id, wtNick: parseWtNick(member.displayName || member.user.username) }))
  const stale = wanted.filter((item) => {
    const entry = cache.get(item.userId)
    return entry === undefined || entry.wtNick !== item.wtNick || now - entry.at > RATE_TTL_MS
  })
  if (stale.length > 0) {
    const input: RateInput = {
      clanCore: clan,
      members: stale,
      now: Math.floor(now / 1000),
      seasonFrom: getClanSeasonContext().season?.startsAt ?? 0,
    }
    try {
      const output = await readRatings(input)
      caps.set(guildId, output.cap)
      for (const member of output.members) {
        const wtNick = stale.find((item) => item.userId === member.userId)?.wtNick ?? ''
        cache.set(member.userId, { wtNick, member, at: now })
      }
    } catch (error) {
      console.warn(`[platoons] server ${guildId}: strengths not read, the last known are used:`, error)
    }
  }
  const here = new Set(wanted.map((item) => item.userId))
  for (const userId of cache.keys()) if (!here.has(userId)) cache.delete(userId)
  return cache
}

async function readRatings(input: RateInput): Promise<RateOutput> {
  const dbPath = getDbWorkerPath()
  if (dbPath === null) {
    return ratePlatoonPlayers(input, {
      roster: (clanCore) => getPlatoonRoster(clanCore),
      accounts: (keys) => getPlatoonNickPlayers(keys),
      rows: (userIds, fromTs, toTs) => getPlatoonPlayerRows(userIds, fromTs, toTs),
      stages: () => getScoutStages(),
      ratings: (nicks, sinceTs) => getPlatoonRatings(nicks, sinceTs),
    })
  }
  return runWorkerTask({ kind: 'read-platoon-players', input: { dbPath, ...input } }, { priority: 'normal', timeoutMs: 60_000 })
}

export interface Advice {
  lobbyId: string
  /** Room ID → its name, in Discord's order. */
  rooms: ReadonlyMap<string, string>
  plan: PlanResult
  list: readonly Candidate[]
  ratings: ReadonlyMap<string, Pick<Rated, 'member'>>
  /** User ID → the WT nick of their server name: the line's name when the strengths were not read. */
  nicks: ReadonlyMap<string, string>
}

/**
 * Whether a changed post goes anew to the channel's bottom instead of an edit: other messages came after it
 * (a busy channel: a gathering's replies, screenshots) while someone is in voice, so the current suggestions
 * stand where readers look; with nobody in voice, or no last message known, it is edited where it is.
 */
export function sinksPost(lastMessageId: string | null, messageId: string | null, someone: boolean): boolean {
  return someone && messageId !== null && lastMessageId !== null && lastMessageId !== messageId
}

/**
 * The post when nobody has been in voice for `emptyForMs`: drawn empty for EMPTY_KEEP_MS (a player stepping
 * out keeps it), then dropped; with no post, none is sent (a restart or a deploy posts nothing).
 */
export function emptyVoicePost(messageId: string | null, emptyForMs: number): 'draw' | 'drop' | 'skip' {
  return messageId === null ? 'skip' : emptyForMs >= EMPTY_KEEP_MS ? 'drop' : 'draw'
}

/** The empty post goes (emptyVoicePost); a refusal other than a message already gone is tried again after another EMPTY_KEEP_MS. */
async function dropPost(guild: Guild, channel: PostChannel, messageId: string): Promise<void> {
  try {
    await channel.messages.delete(messageId)
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage)) {
      emptySince.set(guild.id, Date.now())
      console.warn(`[platoons] server ${guild.id}: the empty post was not deleted:`, error)
      return
    }
  }
  lastPost.delete(guild.id)
  // /settings may have moved the post meanwhile: only this post's ID is cleared.
  const current = read(guild.id)
  if (current !== null && current.messageId === messageId) write(guild.id, { ...current, messageId: null })
}

/**
 * The post: edited in place, sent anew at the bottom when buried (sinksPost) or gone, left alone when
 * unchanged, dropped once nobody has been in voice for EMPTY_KEEP_MS (emptyVoicePost).
 */
async function publish(guild: Guild, stored: Stored, advice: Advice): Promise<void> {
  const channel = postChannel(guild, stored.settings)
  if (channel === null) return
  if (advice.list.length > 0) emptySince.delete(guild.id)
  else {
    const since = emptySince.get(guild.id) ?? Date.now()
    emptySince.set(guild.id, since)
    const action = emptyVoicePost(stored.messageId, Date.now() - since)
    if (action === 'skip') return
    if (action === 'drop' && stored.messageId !== null) return dropPost(guild, channel, stored.messageId)
  }
  const t = botText(guildLocale(guild.id, guild.preferredLocale))
  const vehicles = await ensureVehicleDict().catch(() => ({} as VehicleDict))
  const squadron = findSquadrons(stored.settings.clan, 1)[0]
  const label = squadron?.core === stored.settings.clan ? squadronLabel(squadron.displayTag, squadron.name) : stored.settings.clan.toUpperCase()
  const payload = { content: '', embeds: [advicePost(t, label, caps.get(guild.id) ?? null, advice, vehicles)], components: [], allowedMentions: { parse: [] } }
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  if (lastPost.get(guild.id) === hash) return
  try {
    const buried = sinksPost(channel.lastMessageId, stored.messageId, advice.list.length > 0)
    if (stored.messageId !== null && !buried) {
      try {
        await channel.messages.edit(stored.messageId, payload)
        lastPost.set(guild.id, hash)
        return
      } catch (error) {
        if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage)) throw error
      }
    }
    const message = await channel.send(payload)
    lastPost.set(guild.id, hash)
    // /settings may have moved the post meanwhile: the ID is kept for the same channel only.
    const current = read(guild.id)
    if (current !== null && (current.settings.channelId ?? current.settings.lobbyId) === channel.id) write(guild.id, { ...current, messageId: message.id })
    // The buried one goes once the new one stands, so the channel is never without the post.
    if (buried && stored.messageId !== null) {
      await channel.messages.delete(stored.messageId).catch((error: unknown) => {
        if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage)) {
          console.warn(`[platoons] server ${guild.id}: the buried post was not deleted:`, error)
        }
      })
    }
  } catch (error) {
    // Without the permissions the same post is not tried again until it changes.
    const denied = error instanceof DiscordAPIError
      && (error.code === RESTJSONErrorCodes.MissingPermissions || error.code === RESTJSONErrorCodes.MissingAccess)
    if (denied) lastPost.set(guild.id, hash)
    console.warn(`[platoons] server ${guild.id}: the post failed:`, error)
  }
}

const CLASS_ORDER: readonly ScoutClass[] = ['T', 'L', 'AA', 'F', 'H']

/** The suggestions' embed: a field per room with someone in it, the new platoons, the waiting and the unplaced. */
export function advicePost(t: BotText, squadron: string, cap: number | null, advice: Advice, vehicles: VehicleDict): APIEmbed {
  const p = t.platoons
  const { plan, list, ratings } = advice
  const nick = (userId: string) => {
    const identity = ratings.get(userId)?.member.identity
    return escapeMarkdown(identity?.rosterNick ?? identity?.wtNick ?? advice.nicks.get(userId) ?? '?')
  }
  const classOf = (userId: string): ScoutClass | null => {
    const vehicle = ratings.get(userId)?.member.vehicle
    const cls = vehicle ? vehicles[vehicle]?.cls : undefined
    return cls === undefined || cls === '?' ? null : cls
  }
  const line = (userId: string, extra: readonly string[] = []) => {
    const member = ratings.get(userId)?.member
    const parts: string[] = []
    const vehicle = member?.vehicle ? vehicles[member.vehicle] : undefined
    const cls = classOf(userId)
    if (vehicle) parts.push(`${vehicle.name}${cls ? ` · ${p.classes[cls]}` : ''}`)
    else if (member?.identity.standing === 'member' && member.capBattles === 0) parts.push(p.tags.noBattles)
    if (member?.identity.guessed && member.identity.rosterNick) parts.push(p.tags.guessed(escapeMarkdown(member.identity.rosterNick)))
    if (member?.identity.standing === 'unknown') parts.push(p.tags.unknown)
    parts.push(...extra)
    return `**${nick(userId)}**${parts.length ? ` — ${parts.join(', ')}` : ''}`
  }
  // By role, then nick: the order of a lineup never ranks its players.
  const byRole = (a: string, b: string) => {
    const ca = classOf(a)
    const cb = classOf(b)
    return (ca === null ? 9 : CLASS_ORDER.indexOf(ca)) - (cb === null ? 9 : CLASS_ORDER.indexOf(cb)) || nick(a).localeCompare(nick(b), t.intl)
  }
  const channel = (id: string | null) => `<#${id ?? advice.lobbyId}>`
  const from = (id: string | null) => (id === null ? [] : [p.tags.from(channel(id))])
  // Where a room's player is suggested to go: another room or a new platoon.
  const goes = new Map<string, string>()
  for (const room of plan.rooms) {
    for (const call of room.calls) goes.set(call.userId, channel(room.roomId))
    if (room.swap) goes.set(room.swap.userId, channel(room.roomId))
  }
  for (const platoon of plan.platoons) for (const call of platoon) goes.set(call.userId, p.tags.newPlatoon)

  const fields: { name: string; value: string }[] = []
  for (const room of plan.rooms) {
    const here = list.filter((item) => item.room === room.roomId)
    if (here.length === 0) continue
    const players = here.filter((item) => item.standing !== 'guest')
    const leaving = players.filter((item) => !room.lineup.includes(item.userId)).map((item) => item.userId).sort(byRole)
    const lines = [
      ...[...room.lineup].sort(byRole).map((userId) => line(userId)),
      ...room.calls.map((call) => `➕ ${line(call.userId, [p.tags.from(channel(call.from))])}`),
      ...(room.swap ? [`🔁 ${p.swap(`**${nick(room.swap.userId)}**`, `**${nick(room.swap.out)}**`)}${from(room.swap.from).map((tag) => `, ${tag}`).join('')}`] : []),
      ...leaving.map((userId) => line(userId, [goes.has(userId) ? p.tags.to(goes.get(userId)!) : p.tags.reserve])),
      ...here.filter((item) => item.standing === 'guest').map((item) => line(item.userId, [p.tags.guest])),
    ]
    const short = PLATOON_SIZE - players.length
    fields.push({ name: p.room(escapeMarkdown(advice.rooms.get(room.roomId) ?? '?'), players.length) + (short > 0 ? p.short(short) : ''), value: lines.join('\n') })
  }
  plan.platoons.forEach((platoon, index) => {
    const origin = new Map(platoon.map((call) => [call.userId, call.from]))
    fields.push({
      name: p.newPlatoon(plan.platoons.length > 1 ? index + 1 : null),
      value: platoon.map((call) => call.userId).sort(byRole).map((userId) => line(userId, from(origin.get(userId) ?? null))).join('\n'),
    })
  })
  if (plan.waiting.length > 0) {
    fields.push({ name: p.forming(plan.waiting.length), value: plan.waiting.map((call) => line(call.userId, from(call.from))).join('\n') })
  }
  const notPlaced = list.filter((item) => item.room === null && (item.deaf || item.standing === 'guest'))
  if (notPlaced.length > 0) {
    fields.push({ name: p.notPlaced, value: notPlaced.map((item) => line(item.userId, [item.standing === 'guest' ? p.tags.guest : p.tags.deaf])).join('\n') })
  }

  const title = p.title(squadron, cap)
  const description = (list.length === 0 ? `${p.intro}\n\n${p.empty}` : p.intro).slice(0, 4096)
  const embed = new EmbedBuilder().setTitle(title).setColor(0x2e86c1).setDescription(description)
  let budget = EMBED_MAX - title.length - description.length
  for (const field of fields.slice(0, 25)) {
    const name = field.name.slice(0, 256)
    const value = fitField(field.value)
    if (name.length + value.length > budget) break
    budget -= name.length + value.length
    embed.addFields({ name, value })
  }
  return embed.toJSON()
}

/** Whole lines within an embed field's 1,024 characters. */
function fitField(value: string): string {
  if (value.length <= 1024) return value
  const kept: string[] = []
  for (const line of value.split('\n')) {
    if ([...kept, line, '…'].join('\n').length > 1024) break
    kept.push(line)
  }
  return [...kept, '…'].join('\n')
}
