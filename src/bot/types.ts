import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder
  execute(interaction: ChatInputCommandInteraction): Promise<void>
  /** Suggestions for options declared with setAutocomplete(true); Discord waits 3 s. */
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>
}
