import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js'
import { config } from '../config.js'
import { recordCommandUse } from '../db/index.js'
import { commands } from './commands/index.js'
import { handleBattleButton } from './commands/battle.js'

export async function startBot(): Promise<Client> {
  const client = new Client({
    // Guilds — slash-команды, GuildVoiceStates — кто сидит в голосовых
    // каналах (не privileged, в Developer Portal включать ничего не надо).
    // Если понадобится читать сообщения — добавь GuildMessages +
    // MessageContent и включи Message Content Intent в Developer Portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  })

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] Готов! Вошёл как ${readyClient.user.tag}`)
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    // Кнопки под сообщением /battle (battle log, хитмапы, чат)
    if (interaction.isButton() && interaction.customId.startsWith('battle:')) {
      try {
        await handleBattleButton(interaction)
      } catch (err) {
        console.error('[bot] Ошибка кнопки', interaction.customId, err)
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('Произошла ошибка при сборке материалов боя.').catch(() => {})
        } else {
          await interaction
            .reply({ content: 'Произошла ошибка при сборке материалов боя.', flags: MessageFlags.Ephemeral })
            .catch(() => {})
        }
      }
      return
    }
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
