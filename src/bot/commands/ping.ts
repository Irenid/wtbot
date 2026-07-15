import { SlashCommandBuilder } from 'discord.js'
import type { Command } from '../types.js'

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Проверка, что бот жив'),
  async execute(interaction) {
    const ws = interaction.client.ws.ping
    await interaction.reply(`🏓 Понг! WebSocket: ${ws >= 0 ? `${Math.round(ws)} мс` : 'н/д'}`)
  },
}
