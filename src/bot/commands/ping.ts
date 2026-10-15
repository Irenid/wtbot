import { SlashCommandBuilder } from 'discord.js'
import { botText } from '../../i18n/index.js'
import { channelLocale } from '../locale.js'
import type { Command } from '../types.js'

export const ping: Command = {
  definition: (t) => new SlashCommandBuilder().setName('ping').setDescription(t.commands.ping.description),
  async execute(interaction) {
    const ws = interaction.client.ws.ping
    await interaction.reply(botText(channelLocale(interaction)).ping(ws >= 0 ? Math.round(ws) : null))
  },
}
