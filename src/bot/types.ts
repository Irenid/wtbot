import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'
import type { BotText } from '../i18n/index.js'

export interface Command {
  /**
   * The command with its descriptions in `t`'s language; command-sync.ts
   * adds every other catalog's. Names and options are the same in every language.
   */
  definition(t: BotText): SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder
  execute(interaction: ChatInputCommandInteraction): Promise<void>
  /** Suggestions for options declared with setAutocomplete(true); Discord waits 3 s. */
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>
}
