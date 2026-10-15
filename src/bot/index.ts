import { ApplicationFlagsBitField, Client, DiscordAPIError, Events, GatewayIntentBits, MessageFlags, REST, RESTJSONErrorCodes, Routes, type Interaction } from 'discord.js'
import { config } from '../config.js'
import { botText } from '../i18n/index.js'
import { recordCommandUse } from '../db/index.js'
import { startCommandSync, stopCommandSync } from './command-sync.js'
import { commands } from './commands/index.js'
import { handleBattleButton, stopBattlePostUpdates } from './commands/battle.js'
import { startBattleAnnouncer, stopBattleAnnouncer } from './battle-announcer.js'
import { stopPlayerBoardPublisher } from './player-board.js'
import type { ScoutStatSharkSource } from '../scout/report.js'
import { handleScoutImageMessage, scoutImagesIdle } from './scout-images.js'
import { channelLocale, userLocale } from './locale.js'

let acceptingInteractions = true
const activeInteractions = new Set<Promise<void>>()

/**
 * 10062 Unknown interaction: the press's or command's token expired. Discord
 * gives 3 seconds to acknowledge (defer/reply); parsing and rendering run in
 * workers, but a network or Discord delay, or shutdown, can still outlast it.
 * Nobody is left to answer, so the handler just returns.
 */
function isExpiredInteraction(err: unknown): boolean {
  return err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownInteraction
}

/**
 * Whether the application may receive message content (Developer Portal →
 * Bot → Message Content Intent). Asking for the intent without it makes the
 * gateway refuse the login (4014), so it is checked first.
 */
async function messageContentAllowed(): Promise<boolean> {
  try {
    const application = await new REST().setToken(config.token).get(Routes.currentApplication()) as { flags?: number }
    const flags = new ApplicationFlagsBitField(application.flags ?? 0)
    return flags.has('GatewayMessageContent') || flags.has('GatewayMessageContentLimited')
  } catch (error) {
    console.warn('[bot] Could not read the application flags; message content stays off:', error)
    return false
  }
}

export interface BotOptions {
  /** StatShark refreshes /scout pictures queue for the enemies they read; null — StatShark off. */
  scoutStatShark?: ScoutStatSharkSource | null
}

export async function startBot(options: BotOptions = {}): Promise<Client> {
  acceptingInteractions = true
  // Guilds — slash commands, GuildVoiceStates — who sits in voice channels
  // (neither is privileged). GuildMessages (+ MessageContent when the portal
  // allows it) — scoreboard screenshots in WT_SCOUT_CHANNEL.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  if (config.scoutChannelIds.length > 0) {
    intents.push(GatewayIntentBits.GuildMessages)
    if (await messageContentAllowed()) {
      intents.push(GatewayIntentBits.MessageContent)
    } else {
      console.warn('[bot] Message Content Intent is off in the Developer Portal: /scout screenshots are read only when the message mentions the bot')
    }
  }
  const client = new Client({ intents })

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] Ready, logged in as ${readyClient.user.tag}`)
    startCommandSync(readyClient, [...commands.values()])
    // Announces new battles in WT_BATTLES_CHANNEL (when set)
    if (config.battleBackgroundEnabled) {
      startBattleAnnouncer(readyClient)
    } else {
      console.log('[announce] Battle announcements are off')
    }
  })
  if (config.scoutChannelIds.length > 0) {
    client.on(Events.MessageCreate, (message) => {
      if (!acceptingInteractions) return
      handleScoutImageMessage(message, options.scoutStatShark ?? null)
    })
  }
  client.on(Events.Error, (error) => {
    console.error('[bot] Gateway client error:', error)
  })
  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[bot] Shard ${shardId} error:`, error)
  })
  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    console.warn(`[bot] Shard ${shardId} disconnected: code ${closeEvent.code}`)
  })

  const handleInteraction = async (interaction: Interaction): Promise<void> => {
    // The buttons under a /battle message (battle log, heatmaps, chat); their replies are ephemeral.
    if (interaction.isButton() && interaction.customId.startsWith('battle:')) {
      const failure = botText(userLocale(interaction)).failure
      try {
        await handleBattleButton(interaction)
      } catch (err) {
        if (isExpiredInteraction(err)) {
          console.warn(`[bot] the press of ${interaction.customId} expired: the bot was busy, it must be pressed again`)
          return
        }
        console.error('[bot] Button error', interaction.customId, err)
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(failure.battleMedia).catch(() => {})
        } else {
          await interaction
            .reply({ content: failure.battleMedia, flags: MessageFlags.Ephemeral })
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
      // Counted in the statistics; an SQLite error must not leave the
      // interaction unanswered and unlogged.
      recordCommandUse(interaction.commandName, interaction.guildId, interaction.user.id)
      await command.execute(interaction)
    } catch (err) {
      if (isExpiredInteraction(err)) {
        console.warn(`[bot] /${interaction.commandName} expired: the bot was busy, the command must be repeated`)
        return
      }
      console.error(`[bot] Error in /${interaction.commandName}:`, err)
      // Replaces a public reply in the channel's language; a new reply is ephemeral.
      const answered = interaction.deferred || interaction.replied
      const failure = botText(answered && !interaction.ephemeral ? channelLocale(interaction) : userLocale(interaction)).failure
      if (answered) {
        await interaction
          .editReply(failure.command)
          .catch(() => {})
      } else {
        await interaction
          .reply({ content: failure.command, flags: MessageFlags.Ephemeral })
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
        console.error('[bot] Unhandled interaction handler error:', error)
      },
    )
  })

  await client.login(config.token)
  return client
}

/**
 * Stops the background Discord producers and waits for the handlers, at most
 * `graceMs`. After that shutdown destroys the Discord client and the CPU pool;
 * atomic caches survive an interrupted build without publishing a broken set.
 */
export async function stopBotWork(graceMs = 10_000): Promise<void> {
  acceptingInteractions = false
  // Each call sets its stopping flag at once, so all start before the wait.
  const drain = Promise.allSettled([
    stopBattleAnnouncer(),
    stopPlayerBoardPublisher(),
    stopBattlePostUpdates(),
    stopCommandSync(),
    scoutImagesIdle(),
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
    console.warn(`[bot] Discord work did not finish in ${graceMs} ms: it ends with the client and the CPU pool`)
  }
}
