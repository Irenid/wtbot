import { Locale as DiscordLocale } from 'discord.js'
import { config } from '../config.js'
import { getBotState, setBotState } from '../db/index.js'
import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from '../i18n/index.js'

/**
 * Which language the bot writes where. What the whole channel sees (posts,
 * public replies, the player board, the default command descriptions) is in
 * the server's language: its /language choice, else WT_BOT_LOCALE, else the
 * server's own Discord language, else English. What only one user sees
 * (ephemeral replies, autocomplete) is in that user's Discord language when a
 * catalog has it, else the server's.
 */

/** bot_state key prefix of a server's /language choice. */
const GUILD_LOCALE_KEY = 'guild-locale:'

/** The catalog serving a Discord locale ("en-US", "ru"): the exact one, else its language's; null — none. */
export function catalogLocale(discordLocale: string | null | undefined): Locale | null {
  if (!discordLocale) return null
  const tag = discordLocale.toLowerCase()
  const language = tag.split('-')[0]
  return LOCALES.find((locale) => locale === tag) ?? LOCALES.find((locale) => locale === language) ?? null
}

/** The Discord locales a catalog serves; Discord localizes commands only for its own list. */
export function discordLocales(locale: Locale): DiscordLocale[] {
  return Object.values(DiscordLocale).filter((code) => catalogLocale(code) === locale)
}

/** A server's /language choice; null — none, or a language the bot no longer has. */
export function chosenGuildLocale(guildId: string): Locale | null {
  const value = getBotState(GUILD_LOCALE_KEY + guildId)
  return value !== null && isLocale(value) ? value : null
}

export function saveGuildLocale(guildId: string, locale: Locale): void {
  setBotState(GUILD_LOCALE_KEY + guildId, locale)
}

/** A server's language; `discordLocale` is the server's own Discord language (Guild.preferredLocale). */
export function guildLocale(guildId: string | null, discordLocale?: string | null): Locale {
  return (guildId === null ? null : chosenGuildLocale(guildId))
    ?? config.defaultLocale
    ?? catalogLocale(discordLocale)
    ?? DEFAULT_LOCALE
}

/** What an interaction carries about languages. */
export interface InteractionLocales {
  guildId: string | null
  /** The server's Discord language; null outside a server. */
  guildLocale: string | null
  /** The user's Discord language. */
  locale: string
}

/** The language of a reply the whole channel sees. */
export function channelLocale(interaction: Pick<InteractionLocales, 'guildId' | 'guildLocale'>): Locale {
  return guildLocale(interaction.guildId, interaction.guildLocale)
}

/** The language of a reply only the interaction's user sees. */
export function userLocale(interaction: InteractionLocales): Locale {
  return catalogLocale(interaction.locale) ?? channelLocale(interaction)
}
