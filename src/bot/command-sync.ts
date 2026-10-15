import { createHash } from 'node:crypto'
import {
  DiscordAPIError,
  Events,
  RESTJSONErrorCodes,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js'
import { deleteBotState, getBotState, setBotState } from '../db/index.js'
import { botText, LOCALES, type Locale } from '../i18n/index.js'
import { discordLocales, guildLocale } from './locale.js'
import type { Command } from './types.js'

/**
 * The bot registers its slash commands on every server itself, as guild
 * commands: descriptions in the server's language (locale.ts) plus every
 * catalog's as Discord localizations, which Discord shows to a user whose
 * Discord language that is. A server is rewritten only when its body changes
 * (a code change, /language, the server's Discord language: the hash in
 * bot_state) and when the bot joins it. Global commands would show twice next
 * to the server's, so startup removes any.
 */

export type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody

/** bot_state key prefix: the hash of the body registered on a server. */
const COMMANDS_HASH_KEY = 'commands:'

let syncClient: Client<true> | null = null
let syncCommands: readonly Command[] = []
let stopped = false
/** Servers waiting for a sync, with whether to skip the hash check. */
const queued = new Map<string, boolean>()
/** One write at a time: Discord rate-limits command writes per application. */
let chain: Promise<void> = Promise.resolve()

/** Every command's body for a server whose language is `locale`. */
export function commandBodies(list: readonly Command[], locale: Locale): CommandBody[] {
  return list.map((command) => {
    const body = command.definition(botText(locale)).toJSON()
    for (const other of LOCALES) {
      localizeDescriptions(body, command.definition(botText(other)).toJSON(), discordLocales(other))
    }
    return body
  })
}

interface Described {
  name: string
  description?: string | undefined
  description_localizations?: Partial<Record<string, string | null>> | null | undefined
  options?: Described[] | undefined
}

/** Adds `translated`'s descriptions to `body` as the localizations for `codes`, through every option. */
function localizeDescriptions(body: Described, translated: Described, codes: readonly string[]): void {
  const options = body.options ?? []
  const translatedOptions = translated.options ?? []
  if (body.name !== translated.name || options.length !== translatedOptions.length) {
    throw new Error(`/${body.name}: the languages define different commands`)
  }
  if (body.description !== undefined && translated.description !== undefined) {
    const localizations = { ...body.description_localizations }
    for (const code of codes) localizations[code] = translated.description
    body.description_localizations = localizations
  }
  options.forEach((option, index) => localizeDescriptions(option, translatedOptions[index]!, codes))
}

/** Registers the commands on every server the bot is in, and on the ones it joins or whose language changes. */
export function startCommandSync(client: Client<true>, list: readonly Command[]): void {
  if (syncClient === client) return
  syncClient = client
  syncCommands = list
  stopped = false
  chain = chain
    .then(() => removeGlobalCommands(client))
    .catch((error: unknown) => console.warn(`[commands] could not check the global commands: ${message(error)}`))
  for (const guildId of client.guilds.cache.keys()) requestGuildCommandSync(guildId)
  client.on(Events.GuildCreate, (guild) => requestGuildCommandSync(guild.id, true))
  // A server in an outage has no Discord language yet: it is synced when it returns.
  client.on(Events.GuildAvailable, (guild) => requestGuildCommandSync(guild.id))
  client.on(Events.GuildUpdate, (before, after) => {
    if (before.preferredLocale !== after.preferredLocale) requestGuildCommandSync(after.id)
  })
  client.on(Events.GuildDelete, (guild) => {
    // Rejoining registers anew.
    try {
      deleteBotState(COMMANDS_HASH_KEY + guild.id)
    } catch (error) {
      console.warn(`[commands] server ${guild.id}: ${message(error)}`)
    }
  })
}

/** Queues a server's sync; `force` writes even when the stored hash matches. */
export function requestGuildCommandSync(guildId: string, force = false): void {
  if (stopped || syncClient === null) return
  const waiting = queued.has(guildId)
  queued.set(guildId, force || (queued.get(guildId) ?? false))
  if (waiting) return
  chain = chain
    .then(() => {
      const forced = queued.get(guildId) ?? false
      queued.delete(guildId)
      return stopped ? undefined : syncGuild(guildId, forced)
    })
    .catch((error: unknown) => {
      if (!stopped) console.warn(`[commands] server ${guildId}: ${message(error)}`)
    })
}

/** Lets the current write finish and drops the waiting ones. */
export async function stopCommandSync(): Promise<void> {
  stopped = true
  queued.clear()
  await chain
}

async function syncGuild(guildId: string, force: boolean): Promise<void> {
  const guild = syncClient?.guilds.cache.get(guildId)
  if (!guild?.available) return
  const locale = guildLocale(guild.id, guild.preferredLocale)
  const body = commandBodies(syncCommands, locale)
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const key = COMMANDS_HASH_KEY + guild.id
  if (!force && getBotState(key) === hash) return
  try {
    await guild.commands.set(body)
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingAccess) {
      console.warn(`[commands] server ${guild.id} refused the commands: invite the bot there with the applications.commands scope`)
      return
    }
    throw error
  }
  setBotState(key, hash)
  console.log(`[commands] ${body.length} commands registered on server ${guild.id} (${locale})`)
}

async function removeGlobalCommands(client: Client<true>): Promise<void> {
  const global = await client.application.commands.fetch()
  if (global.size === 0) return
  await client.application.commands.set([])
  console.log(`[commands] removed ${global.size} global commands: every server has its own`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
