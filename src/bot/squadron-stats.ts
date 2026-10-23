import {
  ChannelType, DiscordAPIError, OverwriteType, PermissionFlagsBits, RESTJSONErrorCodes, type CategoryChannel, type Client, type Guild,
} from 'discord.js'
import { deleteBotState, getBotState, getClanSeasonContext, getSquadronFigures, setBotState } from '../db/index.js'
import { botText } from '../i18n/index.js'
import { guildLocale } from './locale.js'

/**
 * Four voice channels nobody joins show the max BR that plays now and a squadron's leaderboard place, player count and
 * average PSR in their names
 * (/settings stats set): at the top of the channel list with overwrites of their own (`CLOSED`), which
 * needs View Channel, Manage Channels and Connect on the server: Discord lets a bot allow or deny only
 * permissions it holds; or in a category the server picks, created bare so they copy its overwrites
 * (the server decides who sees them; the bot needs View Channel, Manage Channels and Connect there:
 * Discord answers Missing Access to any change of a voice channel its bot cannot connect to, so a
 * channel the bot cannot connect to keeps its first name for good). warthunder.com reports them at the
 * `wt-clans` crawls (every 20 min), so a minute-long tick compares the names with the database and
 * renames a channel only when its text differs: Discord allows two renames per channel in 10
 * minutes, far above a crawl's cadence. A language change renames them within a minute too.
 * State per server — bot_state `squadron-stats:<guildId>`; a deleted channel takes the pair with it.
 */

const KEY = 'squadron-stats:'
const TICK_MS = 60_000

interface Pair {
  /** The squadron's tag core. */
  clan: string
  placeId: string
  pointsId: string
  /** Added later: a pair made before it has none until /settings stats set runs again. */
  ratingId?: string | undefined
  /** Added later like `ratingId`; the first channel of the list. */
  brId?: string | undefined
}

function readPair(guildId: string): Pair | null {
  const raw = getBotState(KEY + guildId)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Pair>
    return typeof value.clan === 'string' && typeof value.placeId === 'string' && typeof value.pointsId === 'string'
      ? { clan: value.clan, placeId: value.placeId, pointsId: value.pointsId, ratingId: typeof value.ratingId === 'string' ? value.ratingId : undefined, brId: typeof value.brId === 'string' ? value.brId : undefined }
      : null
  } catch {
    return null
  }
}

export function squadronStatsSquadron(guildId: string): string | null {
  return readPair(guildId)?.clan ?? null
}

function names(guild: Guild, clan: string): { br: string; place: string; points: string; rating: string } {
  const t = botText(guildLocale(guild.id, guild.preferredLocale)).settings
  const figures = getSquadronFigures(clan)
  // The cap that plays now (stageAt: switches at 14:00 UTC of a stage's first day); null between stages and after the season.
  const maxBr = getClanSeasonContext().currentStage?.maxBr
  return { br: t.statsBrName(maxBr === undefined ? null : maxBr.toFixed(1)), place: t.statsPlaceName(figures?.place ?? null), points: t.statsMembersName(figures?.members ?? null), rating: t.statsRatingName(figures?.averageRating ?? null) }
}

/**
 * What a channel at the top of the list denies everyone (Test pechenka's owner, 2026-10-21: nobody
 * joins, nothing else either): a voice channel's every permission but View Channel (the names are the
 * point), Manage Channels (an @everyone deny binds the bot too, and it renames them) and Manage
 * Permissions (Discord sets that in a channel for administrators only). Discord lets a bot deny only
 * permissions it holds on the server, so the bot denies those it holds; /settings requires Connect.
 */
const CLOSED = [
  PermissionFlagsBits.CreateInstantInvite, PermissionFlagsBits.AddReactions, PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.Stream, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendTTSMessages,
  PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers, PermissionFlagsBits.UseVAD, PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.UseApplicationCommands, PermissionFlagsBits.ManageEvents, PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.UseEmbeddedActivities, PermissionFlagsBits.UseSoundboard, PermissionFlagsBits.CreateEvents,
  PermissionFlagsBits.UseExternalSounds, PermissionFlagsBits.SendVoiceMessages, PermissionFlagsBits.SetVoiceChannelStatus,
  PermissionFlagsBits.SendPolls, PermissionFlagsBits.UseExternalApps, PermissionFlagsBits.PinMessages,
  PermissionFlagsBits.BypassSlowmode,
].reduce((all, bit) => all | bit, 0n)

/**
 * Everyone views the channel; everything else the bot holds on the server is denied — except, for the bot
 * itself, View Channel and Connect: the @everyone deny binds the bot too, and without Connect Discord
 * refuses its renames (Test pechenka 2026-10-21: the pair made with @everyone's overwrite alone answered
 * Missing Access to the renames of a /language change).
 */
export function lockedOverwrites(guildId: string, botId: string, botPermissions: bigint)
  : { id: string; type: OverwriteType; allow: bigint; deny: bigint }[] {
  return [
    { id: guildId, type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel, deny: CLOSED & botPermissions },
    { id: botId, type: OverwriteType.Member, allow: (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect) & botPermissions, deny: 0n },
  ]
}

async function deleteChannels(guild: Guild, pair: Pair): Promise<void> {
  for (const id of [pair.placeId, pair.pointsId, ...(pair.ratingId ? [pair.ratingId] : []), ...(pair.brId ? [pair.brId] : [])]) {
    await guild.channels.cache.get(id)?.delete('squadron stats removed').catch((error: unknown) => {
      console.warn(`[squadron-stats] server ${guild.id}: could not delete channel ${id}:`, error)
    })
  }
}

/**
 * Creates the pair for squadron `clan` in `category`, or at the top of the list without one, replacing
 * the server's previous pair.
 */
export async function setupSquadronStats(guild: Guild, clan: string, category: CategoryChannel | null): Promise<void> {
  const previous = readPair(guild.id)
  if (previous) {
    deleteBotState(KEY + guild.id)
    await deleteChannels(guild, previous)
  }
  const text = names(guild, clan)
  const locked = lockedOverwrites(guild.id, guild.client.user.id, guild.members.me?.permissions.bitfield ?? 0n)
  const create = (name: string, position: number) => category === null
    ? guild.channels.create({ name, type: ChannelType.GuildVoice, position, permissionOverwrites: locked })
    : category.children.create({ name, type: ChannelType.GuildVoice, position })
  const created: { delete(): Promise<unknown> }[] = []
  const next = async (name: string, position: number) => {
    try {
      const channel = await create(name, position)
      created.push(channel)
      return channel
    } catch (error) {
      for (const channel of created) await channel.delete().catch(() => undefined)
      throw error
    }
  }
  const br = await next(text.br, 0)
  const place = await next(text.place, 1)
  const points = await next(text.points, 2)
  const rating = await next(text.rating, 3)
  setBotState(KEY + guild.id, JSON.stringify({ clan, placeId: place.id, pointsId: points.id, ratingId: rating.id, brId: br.id } satisfies Pair))
}

/** Deletes the pair; false — the server had none. */
export async function removeSquadronStats(guild: Guild): Promise<boolean> {
  const pair = readPair(guild.id)
  if (!pair) return false
  deleteBotState(KEY + guild.id)
  await deleteChannels(guild, pair)
  return true
}

/** A server's channel was deleted by hand: the pair is gone, so its other channel goes too. */
export async function forgetSquadronStatsChannel(guild: Guild, channelId: string): Promise<void> {
  const pair = readPair(guild.id)
  if (!pair || (pair.placeId !== channelId && pair.pointsId !== channelId && pair.ratingId !== channelId && pair.brId !== channelId)) return
  deleteBotState(KEY + guild.id)
  console.log(`[squadron-stats] server ${guild.id}: channel ${channelId} was deleted, the pair is removed`)
  await deleteChannels(guild, pair)
}

export function forgetSquadronStatsGuild(guildId: string): void {
  deleteBotState(KEY + guildId)
}

/** Failures already logged, so a persistent one (a missing permission) does not repeat every minute. */
const warned = new Set<string>()

/**
 * A pair made before a later channel (rating, max BR) gets it from the tick, so nobody has to run
 * /settings stats set again: same category and overwrites as the player-count channel; the max BR one
 * takes the place channel's slot, the top of the list, the rating one goes right below the player count.
 */
async function addChannel(guild: Guild, pair: Pair, field: 'ratingId' | 'brId', name: string): Promise<void> {
  const anchor = guild.channels.cache.get(field === 'brId' ? pair.placeId : pair.pointsId)
  if (!anchor || anchor.type !== ChannelType.GuildVoice) return
  try {
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildVoice, parent: anchor.parentId, position: field === 'brId' ? anchor.position : anchor.position + 1,
      permissionOverwrites: anchor.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
    })
    pair[field] = channel.id
    setBotState(KEY + guild.id, JSON.stringify(pair satisfies Pair))
  } catch (error) {
    if (!warned.has(pair.pointsId + field)) console.warn(`[squadron-stats] server ${guild.id}: could not add the ${field} channel:`, error)
    warned.add(pair.pointsId + field)
  }
}

let timer: NodeJS.Timeout | null = null
let activeTick: Promise<void> = Promise.resolve()
let stopping = false

async function tick(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    if (stopping) return
    const pair = readPair(guild.id)
    if (!pair) continue
    const text = names(guild, pair.clan)
    if (!pair.ratingId) await addChannel(guild, pair, 'ratingId', text.rating)
    if (!pair.brId) await addChannel(guild, pair, 'brId', text.br)
    const targets: (readonly [string, string])[] = [[pair.placeId, text.place], [pair.pointsId, text.points]]
    if (pair.ratingId) targets.push([pair.ratingId, text.rating])
    if (pair.brId) targets.push([pair.brId, text.br])
    for (const [id, name] of targets) {
      const channel = guild.channels.cache.get(id)
      if (!channel || channel.name === name) continue
      try {
        await channel.setName(name, 'squadron stats changed')
        warned.delete(id)
      } catch (error) {
        // A pair made before the bot kept Connect for itself cannot be renamed, nor changed by the bot at all.
        const hint = error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingAccess
          ? ' (the bot cannot connect to it: delete both channels and run /settings stats set again)' : ''
        if (!warned.has(id)) console.warn(`[squadron-stats] server ${guild.id}: could not rename channel ${id}${hint}:`, error)
        warned.add(id)
      }
    }
  }
}

export function startSquadronStats(client: Client): void {
  if (timer) return
  stopping = false
  let running = false
  const run = (): void => {
    // One tick at a time: a rename waiting on Discord's rate limit must not pile up behind the timer.
    if (running) return
    running = true
    activeTick = tick(client)
      .catch((error: unknown) => console.error('[squadron-stats] tick failed:', error))
      .finally(() => { running = false })
  }
  timer = setInterval(run, TICK_MS)
  timer.unref()
  run()
}

export async function stopSquadronStats(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
  await activeTick
}
