import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js'
import { deleteBotState, getBotState, getSquadronFigures, setBotState } from '../db/index.js'
import { botText } from '../i18n/index.js'
import { guildLocale } from './locale.js'

/**
 * Two locked voice channels at the top of a server's channel list show a squadron's leaderboard
 * place and rating in their names (/settings stats set). warthunder.com reports them at the
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
}

function readPair(guildId: string): Pair | null {
  const raw = getBotState(KEY + guildId)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Pair>
    return typeof value.clan === 'string' && typeof value.placeId === 'string' && typeof value.pointsId === 'string'
      ? { clan: value.clan, placeId: value.placeId, pointsId: value.pointsId }
      : null
  } catch {
    return null
  }
}

export function squadronStatsSquadron(guildId: string): string | null {
  return readPair(guildId)?.clan ?? null
}

function names(guild: Guild, clan: string): { place: string; points: string } {
  const t = botText(guildLocale(guild.id, guild.preferredLocale)).settings
  const figures = getSquadronFigures(clan)
  return { place: t.statsPlaceName(figures?.place ?? null), points: t.statsPointsName(figures?.rating ?? null) }
}

/** The channels may be viewed, never joined: the bot renames them through Manage Channels. */
const LOCKED = (guild: Guild) => [
  { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
]

async function deleteChannels(guild: Guild, pair: Pair): Promise<void> {
  for (const id of [pair.placeId, pair.pointsId]) {
    await guild.channels.cache.get(id)?.delete('squadron stats removed').catch((error: unknown) => {
      console.warn(`[squadron-stats] server ${guild.id}: could not delete channel ${id}:`, error)
    })
  }
}

/** Creates the pair for squadron `clan` at the top of the list, replacing the server's previous one. */
export async function setupSquadronStats(guild: Guild, clan: string): Promise<void> {
  const previous = readPair(guild.id)
  if (previous) {
    deleteBotState(KEY + guild.id)
    await deleteChannels(guild, previous)
  }
  const text = names(guild, clan)
  const place = await guild.channels.create({
    name: text.place, type: ChannelType.GuildVoice, position: 0, permissionOverwrites: LOCKED(guild),
  })
  const points = await guild.channels.create({
    name: text.points, type: ChannelType.GuildVoice, position: 1, permissionOverwrites: LOCKED(guild),
  }).catch(async (error: unknown) => {
    await place.delete().catch(() => undefined)
    throw error
  })
  setBotState(KEY + guild.id, JSON.stringify({ clan, placeId: place.id, pointsId: points.id } satisfies Pair))
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
  if (!pair || (pair.placeId !== channelId && pair.pointsId !== channelId)) return
  deleteBotState(KEY + guild.id)
  console.log(`[squadron-stats] server ${guild.id}: channel ${channelId} was deleted, the pair is removed`)
  await deleteChannels(guild, pair)
}

export function forgetSquadronStatsGuild(guildId: string): void {
  deleteBotState(KEY + guildId)
}

let timer: NodeJS.Timeout | null = null
let activeTick: Promise<void> = Promise.resolve()
let stopping = false
/** Failures already logged, so a persistent one (a missing permission) does not repeat every minute. */
const warned = new Set<string>()

async function tick(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    if (stopping) return
    const pair = readPair(guild.id)
    if (!pair) continue
    const text = names(guild, pair.clan)
    for (const [id, name] of [[pair.placeId, text.place], [pair.pointsId, text.points]] as const) {
      const channel = guild.channels.cache.get(id)
      if (!channel || channel.name === name) continue
      try {
        await channel.setName(name, 'squadron stats changed')
        warned.delete(id)
      } catch (error) {
        if (!warned.has(id)) console.warn(`[squadron-stats] server ${guild.id}: could not rename channel ${id}:`, error)
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
