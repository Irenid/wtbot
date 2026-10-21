import type { Client } from 'discord.js'
import { config } from '../config.js'
import {
  addGuildChannel,
  getBotState,
  listGuildChannels,
  removeGuildChannel,
  removeGuildChannelsWhere,
  setBotState,
  type GuildChannel,
  type GuildChannelKind,
} from '../db/index.js'
import { plainClanTag } from '../wrpl/render-battle.js'

/**
 * The channels each server gives the bot (table guild_channels), set with
 * /settings (who may: access.ts): battle posts (every squadron's or
 * one squadron's), scoreboard screenshots, the voice channels of the player
 * board. Reads go to SQLite each time (a few rows, the scout check is a
 * primary-key seek): only this process writes them. WT_BATTLES_CHANNEL
 * (+ WT_CLAN_TAG), WT_SCOUT_CHANNEL and WT_VOICE_CHANNELS are imported once
 * per value (importEnvChannels); after that /settings owns the rows.
 */

/** Rows of one kind a server may hold: bounds the posts and reads one server can cause. */
export const MAX_GUILD_CHANNELS: Readonly<Record<GuildChannelKind, number>> = { battles: 10, scout: 5, voice: 25 }

const listeners = new Set<(kind: GuildChannelKind) => void>()

/** Runs `listener` after a change of `kind`'s rows (the voice tracker re-reads its channels). */
export function onGuildChannelsChange(listener: (kind: GuildChannelKind) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(kinds: readonly GuildChannelKind[]): void {
  for (const kind of kinds) {
    for (const listener of listeners) {
      try {
        listener(kind)
      } catch (error) {
        console.error('[settings] a change listener failed:', error)
      }
    }
  }
}

export function guildChannels(kind: GuildChannelKind, guildId?: string): GuildChannel[] {
  return listGuildChannels().filter((row) => row.kind === kind && (guildId === undefined || row.guildId === guildId))
}

export function isScoutChannel(channelId: string): boolean {
  return listGuildChannels().some((row) => row.kind === 'scout' && row.channelId === channelId)
}

/**
 * The voice channels and categories a server's board watches, a category for every voice channel in
 * it (rooms opened later too); empty — every one the bot can view.
 */
export function watchedVoiceChannels(guildId: string): Set<string> {
  return new Set(guildChannels('voice', guildId).map((row) => row.channelId))
}

/** The channels a battle goes to: a feed of every squadron, or of a squadron among `battleTags`. */
export function battleTargets(feeds: readonly GuildChannel[], battleTags: readonly string[]): string[] {
  const cores = new Set(battleTags.map(plainClanTag))
  return [...new Set(feeds.filter((feed) => feed.clan === '' || cores.has(feed.clan)).map((feed) => feed.channelId))]
}

export type AddResult = 'added' | 'exists' | 'limit'

export function addSetting(row: GuildChannel): AddResult {
  const own = guildChannels(row.kind, row.guildId)
  if (own.some((item) => item.channelId === row.channelId && item.clan === row.clan)) return 'exists'
  if (own.length >= MAX_GUILD_CHANNELS[row.kind]) return 'limit'
  if (!addGuildChannel(row)) return 'exists'
  changed([row.kind])
  return 'added'
}

/** Removes a channel's rows of `kind` (only squadron `clan`'s when given); returns how many. */
export function removeSetting(kind: GuildChannelKind, channelId: string, clan?: string): number {
  const removed = removeGuildChannel(kind, channelId, clan)
  if (removed > 0) changed([kind])
  return removed
}

/** Drops a deleted channel's rows, or every row of a server the bot was removed from. */
export function forgetGuildChannels(scope: { channelId: string } | { guildId: string }): number {
  const removed = removeGuildChannelsWhere(scope)
  if (removed > 0) changed(['battles', 'scout', 'voice'])
  return removed
}

/** bot_state key prefix: the env value already imported for a kind. */
const ENV_IMPORT_KEY = 'guild-channels:env:'

/**
 * Imports the env channels of each kind whose value changed since its last
 * import (or was never imported). A channel the bot cannot fetch leaves its
 * kind for the next start. Rows a server removed with /settings stay removed
 * while the variable keeps its value.
 */
export async function importEnvChannels(client: Client): Promise<void> {
  const clan = plainClanTag(config.clanTag)
  const imports: { kind: GuildChannelKind; names: string; ids: readonly string[]; clan: string }[] = [
    {
      kind: 'battles',
      names: 'WT_BATTLES_CHANNEL + WT_CLAN_TAG',
      ids: config.battlesChannelId === '' ? [] : [config.battlesChannelId],
      clan,
    },
    { kind: 'scout', names: 'WT_SCOUT_CHANNEL', ids: config.scoutChannelIds, clan: '' },
    { kind: 'voice', names: 'WT_VOICE_CHANNELS', ids: config.voiceChannelIds, clan: '' },
  ]
  // In order: each fetch of an uncached channel is one REST call, and there are at most a few.
  for (const item of imports) {
    const value = JSON.stringify({ ids: [...item.ids].sort(), clan: item.clan })
    if (item.ids.length === 0 || getBotState(ENV_IMPORT_KEY + item.kind) === value) continue
    const rows: GuildChannel[] = []
    for (const channelId of item.ids) {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel === null || channel.isDMBased()) {
        console.warn(`[settings] ${item.names}: channel ${channelId} is not found on the bot's servers; the import is retried at the next start`)
        rows.length = 0
        break
      }
      rows.push({ kind: item.kind, guildId: channel.guildId, channelId, clan: item.clan })
    }
    if (rows.length === 0) continue
    for (const row of rows) addGuildChannel(row)
    setBotState(ENV_IMPORT_KEY + item.kind, value)
    changed([item.kind])
    console.log(`[settings] imported ${item.names} (${rows.length} channel(s)); /settings changes them from now on`)
  }
}
