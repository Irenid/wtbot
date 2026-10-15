import { SlashCommandBuilder } from 'discord.js'
import { config } from '../../config.js'
import { botText } from '../../i18n/index.js'
import type { Command } from '../types.js'

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription(botText(config.botLocale).commands.ping.description),
  async execute(interaction) {
    const ws = interaction.client.ws.ping
    await interaction.reply(botText(config.botLocale).ping(ws >= 0 ? Math.round(ws) : null))
  },
}
