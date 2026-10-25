import {
  ChannelType, DiscordAPIError, OverwriteType, PermissionFlagsBits, RESTJSONErrorCodes, type CategoryChannel, type Client, type Guild,
} from 'discord.js'
import { deleteBotState, getBotState, getClanSeasonContext, getSquadronFigures, setBotState } from '../db/index.js'
import { botText } from '../i18n/index.js'
import { guildLocale } from './locale.js'

/**
 * Three voice channels nobody joins show a squadron's leaderboard place and player count and the max BR that plays now
 * in their names, «emoji・text» like the server's other channels (/settings stats set): at the top of the channel list with overwrites of their own (`CLOSED`), which
 * needs View Channel, Manage Channels and Connect on the server: Discord lets a bot allow or deny only
 * permissions it holds; or in a category the server picks, created bare so they copy its overwrites
 * (the server decides who sees them; the bot needs View Channel, Manage Channels and Connect there:
 * Discord answers Missing Access to any change of a voice channel its bot cannot connect to, so a
 * channel the bot cannot connect to keeps its first name for good). warthunder.com reports them at the
 * `wt-clans` crawls (top 100 every 20 min, the rest at the 12 h full crawl), so a minute-long tick
 * compares the figures with the database and renames a channel only when its text differs from what the
 * bot last wrote there (a manual rename stays until the figure changes), never to «–» for a place or
 * count it lost (a full crawl that missed the squadron) and at most once per RENAME_GAP_SEC: Discord
 * allows two renames per channel in 10 minutes and makes a third wait, which would stall the tick.
 * State per server — bot_state `squadron-stats:<guildId>`; a deleted channel takes the group with it.
 * The average PSR channel (2026-10-22…10-25) is deleted by the tick (his request 2026-10-25).
 */

const KEY = 'squadron-stats:'
const TICK_MS = 60_000
/** Half of Discord's 2 renames per channel per 10 min: a rename never waits on its rate limit. */
const RENAME_GAP_SEC = 300

interface Pair {
  /** The squadron's tag core. */
  clan: string
  placeId: string
  pointsId: string
  /** The average PSR channel of a group made 2026-10-22…10-25: the tick deletes it. */
  ratingId?: string | undefined
  /** Added later: the tick adds it to a group without one; the last channel of the group. */
  brId?: string | undefined
  /** By channel id: the name the bot last wrote and when (unix seconds). */
  written?: Record<string, { name: string; at: number }> | undefined
}

function readPair(guildId: string): Pair | null {
  const raw = getBotState(KEY + guildId)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Pair>
    const written = typeof value.written === 'object' && value.written !== null ? value.written : undefined
    return typeof value.clan === 'string' && typeof value.placeId === 'string' && typeof value.pointsId === 'string'
      ? { clan: value.clan, placeId: value.placeId, pointsId: value.pointsId, ratingId: typeof value.ratingId === 'string' ? value.ratingId : undefined,
          brId: typeof value.brId === 'string' ? value.brId : undefined, written }
      : null
  } catch {
    return null
  }
}

export function squadronStatsSquadron(guildId: string): string | null {
  return readPair(guildId)?.clan ?? null
}

/** The channels' names; `known` — false for a place or count the database has lost, which keeps the channel's name. */
function names(guild: Guild, clan: string): { br: string; place: string; points: string; known: { place: boolean; points: boolean } } {
  const t = botText(guildLocale(guild.id, guild.preferredLocale)).settings
  const figures = getSquadronFigures(clan)
  // The cap that plays now (stageAt: switches at 14:00 UTC of a stage's first day); null between stages and after the season.
  const maxBr = getClanSeasonContext().currentStage?.maxBr
  const place = figures?.place ?? null
  const members = figures?.members ?? null
  return { br: t.statsBrName(maxBr === undefined ? null : maxBr.toFixed(1)), place: t.statsPlaceName(place), points: t.statsMembersName(members),
    known: { place: place !== null, points: members !== null } }
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
  const place = await next(text.place, 0)
  const points = await next(text.points, 1)
  const br = await next(text.br, 2)
  const at = Math.floor(Date.now() / 1000)
  const written = { [place.id]: { name: text.place, at }, [points.id]: { name: text.points, at }, [br.id]: { name: text.br, at } }
  setBotState(KEY + guild.id, JSON.stringify({ clan, placeId: place.id, pointsId: points.id, brId: br.id, written } satisfies Pair))
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
 * A group made before the max BR channel gets it from the tick, so nobody has to run /settings stats set
 * again: same category and overwrites as the player-count channel, right below it.
 */
async function addChannel(guild: Guild, pair: Pair, field: 'brId', name: string): Promise<void> {
  const anchor = guild.channels.cache.get(pair.pointsId)
  if (!anchor || anchor.type !== ChannelType.GuildVoice) return
  try {
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildVoice, parent: anchor.parentId, position: anchor.position + 1,
      permissionOverwrites: anchor.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
    })
    pair[field] = channel.id
    setBotState(KEY + guild.id, JSON.stringify(pair satisfies Pair))
  } catch (error) {
    if (!warned.has(pair.pointsId + field)) console.warn(`[squadron-stats] server ${guild.id}: could not add the ${field} channel:`, error)
    warned.add(pair.pointsId + field)
  }
}

/**
 * Whether a channel named `current` gets `name`: only when it differs from what the bot last wrote (`last`;
 * without one, from the channel's name) and RENAME_GAP_SEC after the bot's last rename.
 */
export function renameDue(last: { name: string; at: number } | undefined, current: string, name: string, now: number): boolean {
  if (!last) return current !== name
  return last.name !== name && now - last.at >= RENAME_GAP_SEC
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
    if (pair.ratingId) {
      // Forgotten first: its ChannelDelete would otherwise take the whole group (forgetSquadronStatsChannel).
      const id = pair.ratingId
      pair.ratingId = undefined
      setBotState(KEY + guild.id, JSON.stringify(pair satisfies Pair))
      await guild.channels.cache.get(id)?.delete('average PSR channel removed').catch((error: unknown) => {
        console.warn(`[squadron-stats] server ${guild.id}: could not delete channel ${id}; delete it by hand:`, error)
      })
    }
    if (!pair.brId) await addChannel(guild, pair, 'brId', text.br)
    const targets: (readonly [string, string])[] = []
    if (text.known.place) targets.push([pair.placeId, text.place])
    if (text.known.points) targets.push([pair.pointsId, text.points])
    if (pair.brId) targets.push([pair.brId, text.br])
    const now = Math.floor(Date.now() / 1000)
    for (const [id, name] of targets) {
      const channel = guild.channels.cache.get(id)
      if (!channel || !renameDue(pair.written?.[id], channel.name, name, now)) continue
      try {
        await channel.setName(name, 'squadron stats changed')
        pair.written = { ...pair.written, [id]: { name, at: now } }
        setBotState(KEY + guild.id, JSON.stringify(pair satisfies Pair))
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
