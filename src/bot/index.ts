import { Client, DiscordAPIError, Events, GatewayIntentBits, MessageFlags, RESTJSONErrorCodes, type Interaction } from 'discord.js'
import { config } from '../config.js'
import { recordCommandUse } from '../db/index.js'
import { commands } from './commands/index.js'
import { handleBattleButton, stopBattlePostUpdates } from './commands/battle.js'
import { startBattleAnnouncer, stopBattleAnnouncer } from './battle-announcer.js'
import { stopPlayerBoardPublisher } from './player-board.js'

let acceptingInteractions = true
const activeInteractions = new Set<Promise<void>>()

/**
 * 10062 Unknown interaction — токен нажатия/команды протух. У Discord всего
 * 3 секунды на подтверждение (defer/reply). CPU-разбор и рендер вынесены в
 * workers, но токен всё ещё может протухнуть при сетевой/Discord-задержке или
 * во время остановки процесса. Отвечать уже некому — спокойно выходим.
 */
function isExpiredInteraction(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownInteraction
}

export async function startBot(): Promise<Client> {
  acceptingInteractions = true
  const client = new Client({
    // Guilds — slash-команды, GuildVoiceStates — кто сидит в голосовых
    // каналах (не privileged, в Developer Portal включать ничего не надо).
    // Если понадобится читать сообщения — добавь GuildMessages +
    // MessageContent и включи Message Content Intent в Developer Portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  })

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] Готов! Вошёл как ${readyClient.user.tag}`)
    // Автоанонс новых боёв в канал WT_BATTLES_CHANNEL (если задан)
    if (config.battleBackgroundEnabled) {
      startBattleAnnouncer(readyClient)
    } else {
      console.log('[announce] Автоанонс боёв отключён')
    }
  })
  client.on(Events.Error, (error) => {
    console.error('[bot] Gateway client error:', error)
  })
  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[bot] Ошибка shard ${shardId}:`, error)
  })
  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    console.warn(`[bot] Shard ${shardId} отключён: код ${closeEvent.code}`)
  })

  const handleInteraction = async (interaction: Interaction): Promise<void> => {
    // Кнопки под сообщением /battle (battle log, хитмапы, чат)
    if (interaction.isButton() && interaction.customId.startsWith('battle:')) {
      try {
        await handleBattleButton(interaction)
      } catch (err) {
        if (isExpiredInteraction(err)) {
          console.warn(`[bot] нажатие ${interaction.customId} устарело — бот был занят, нужно нажать ещё раз`)
          return
        }
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
    if (interaction.isAutocomplete()) {
      try {
        await commands.get(interaction.commandName)?.autocomplete?.(interaction)
      } catch (err) {
        // An expired autocomplete only loses the suggestions; Discord shows none.
        if (!isExpiredInteraction(err)) console.error(`[bot] Autocomplete error in /${interaction.commandName}:`, err)
      }
      return
    }
    if (!interaction.isChatInputCommand()) return

    const command = commands.get(interaction.commandName)
    if (!command) return

    try {
      // Учитываем вызов в статистике, но ошибка SQLite не должна оставить
      // interaction без ответа и без записи в логе.
      recordCommandUse(interaction.commandName, interaction.guildId, interaction.user.id)
      await command.execute(interaction)
    } catch (err) {
      if (isExpiredInteraction(err)) {
        console.warn(`[bot] вызов /${interaction.commandName} устарел — бот был занят, повтори команду`)
        return
      }
      console.error(`[bot] Ошибка в /${interaction.commandName}:`, err)
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply('Произошла ошибка при выполнении команды.')
          .catch(() => {})
      } else {
        await interaction
          .reply({ content: 'Произошла ошибка при выполнении команды.', flags: MessageFlags.Ephemeral })
          .catch(() => {})
      }
    }
  }

  client.on(Events.InteractionCreate, (interaction) => {
    if (!acceptingInteractions) return
    const task = handleInteraction(interaction)
    activeInteractions.add(task)
    task.then(
      () => activeInteractions.delete(task),
      (error) => {
        activeInteractions.delete(task)
        console.error('[bot] необработанная ошибка обработчика interaction:', error)
      },
    )
  })

  await client.login(config.token)
  return client
}

/**
 * Останавливает фоновые Discord producers и ждёт handlers с верхней границей.
 * После дедлайна shutdown уничтожит Discord client и CPU pool; атомарные кэши
 * допускают обрыв незавершённой сетевой сборки без публикации битого поколения.
 */
export async function stopBotWork(graceMs = 10_000): Promise<void> {
  acceptingInteractions = false
  // Вызовы сразу выставляют stopping-флаги, поэтому запускаем их до ожидания.
  const drain = Promise.allSettled([
    stopBattleAnnouncer(),
    stopPlayerBoardPublisher(),
    stopBattlePostUpdates(),
    Promise.allSettled([...activeInteractions]),
  ])
  if (graceMs <= 0) {
    await drain
    return
  }
  let timer: NodeJS.Timeout | undefined
  const drained = await Promise.race([
    drain.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (!drained) {
    console.warn(`[bot] Discord-задачи не завершились за ${graceMs} мс — прерываю их вместе с client/CPU pool`)
  }
}
