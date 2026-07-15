import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { config } from '../config.js'
import { recordCommandUse } from '../db/index.js'
import { commands } from './commands/index.js'

export async function startBot(): Promise<Client> {
  const client = new Client({
    // Guilds достаточно для slash-команд. Если понадобится читать сообщения —
    // добавь GuildMessages + MessageContent и включи Message Content Intent
    // в Developer Portal (Bot → Privileged Gateway Intents).
    intents: [GatewayIntentBits.Guilds],
  })

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] Готов! Вошёл как ${readyClient.user.tag}`)
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    const command = commands.get(interaction.commandName)
    if (!command) return

    // Учитываем вызов в статистике (даже если команда потом упадёт)
    recordCommandUse(interaction.commandName, interaction.guildId, interaction.user.id)

    try {
      await command.execute(interaction)
    } catch (err) {
      console.error(`[bot] Ошибка в /${interaction.commandName}:`, err)
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: 'Произошла ошибка при выполнении команды.', flags: MessageFlags.Ephemeral })
          .catch(() => {})
      } else {
        await interaction
          .reply({ content: 'Произошла ошибка при выполнении команды.', flags: MessageFlags.Ephemeral })
          .catch(() => {})
      }
    }
  })

  await client.login(config.token)
  return client
}
