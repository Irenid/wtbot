import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import { botText, isLocale, LOCALES } from '../../i18n/index.js'
import { requestGuildCommandSync } from '../command-sync.js'
import { saveGuildLocale, userLocale } from '../locale.js'
import { requestPlayerBoardRefresh } from '../player-board.js'
import type { Command } from '../types.js'

/**
 * /language <language> — the server's language (locale.ts): battle posts,
 * public replies, the player board and the default command descriptions.
 * Kept in bot_state; the server's commands and the boards are redrawn at
 * once, messages already posted stay as they are.
 */
export const language: Command = {
  definition: (t) => new SlashCommandBuilder()
    .setName('language')
    .setDescription(t.commands.language.description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option
      .setName('language')
      .setDescription(t.commands.language.language)
      .setRequired(true)
      // Each by its own name, whatever language the list is read in.
      .addChoices(...LOCALES.map((locale) => ({ name: botText(locale).languageName, value: locale })))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const t = botText(userLocale(interaction)).language
    if (!interaction.inGuild()) {
      await interaction.editReply(t.guildOnly)
      return
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply(t.needManageGuild)
      return
    }
    const choice = interaction.options.getString('language', true)
    // Discord sends only the registered choices: another value is a stale registration.
    if (!isLocale(choice)) throw new Error(`/language got an unknown language "${choice}"`)
    saveGuildLocale(interaction.guildId, choice)
    console.log(`[language] server ${interaction.guildId} now uses ${choice}`)
    requestGuildCommandSync(interaction.guildId)
    requestPlayerBoardRefresh()
    await interaction.editReply(botText(choice).language.changed)
  },
}
