import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from 'discord.js'
import { config } from '../../config.js'
import { botText } from '../../i18n/index.js'
import {
  disablePlayerStatBoard,
  getPlayerStatBoard,
} from '../../db/index.js'
import {
  configurePlayerStatBoard,
  refreshPlayerStatBoard,
} from '../player-board.js'
import type { Command } from '../types.js'

const REQUIRED_BOT_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'view'],
  [PermissionFlagsBits.SendMessages, 'send'],
  [PermissionFlagsBits.EmbedLinks, 'embed'],
  [PermissionFlagsBits.ReadMessageHistory, 'history'],
] as const

const text = botText(config.botLocale).playerBoard
const descriptions = botText(config.botLocale).commands.playerBoard

/** The watched voice channels as mentions, or the catalog's "all" when WT_VOICE_CHANNELS is empty. */
function voiceChannelList(): string {
  return config.voiceChannelIds.length === 0
    ? text.replies.allVoiceChannels
    : config.voiceChannelIds.map((id) => `<#${id}>`).join(', ')
}

function guildTextChannel(value: unknown): GuildTextBasedChannel | null {
  if (
    typeof value !== 'object' || value === null ||
    !('isDMBased' in value) || typeof value.isDMBased !== 'function' ||
    !('isTextBased' in value) || typeof value.isTextBased !== 'function' ||
    !('isSendable' in value) || typeof value.isSendable !== 'function'
  ) return null
  if (value.isDMBased() || !value.isTextBased() || !value.isSendable()) return null
  return value as GuildTextBasedChannel
}

export const playerBoard: Command = {
  data: new SlashCommandBuilder()
    .setName('playerboard')
    .setDescription(descriptions.description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription(descriptions.setup)
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription(descriptions.channel)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription(descriptions.status),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('refresh').setDescription(descriptions.refresh),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription(descriptions.disable),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (!interaction.inGuild() || interaction.guildId === null) {
      await interaction.editReply(text.replies.guildOnly)
      return
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply(text.replies.needManageGuild)
      return
    }

    const subcommand = interaction.options.getSubcommand()
    try {
      if (subcommand === 'setup') {
        const selected = interaction.options.getChannel('channel', true)
        const fetched = await interaction.client.channels.fetch(selected.id)
        const channel = guildTextChannel(fetched)
        if (channel === null || channel.guildId !== interaction.guildId) {
          await interaction.editReply(text.replies.badChannel)
          return
        }
        const permissions = interaction.client.user === null
          ? null
          : channel.permissionsFor(interaction.client.user)
        const missing = REQUIRED_BOT_PERMISSIONS
          .filter(([permission]) => permissions === null || !permissions.has(permission))
          .map(([, key]) => text.replies.permissions[key])
        if (missing.length > 0) {
          await interaction.editReply(text.replies.missingPermissions(`<#${channel.id}>`, missing.join(', ')))
          return
        }
        const result = await configurePlayerStatBoard(interaction.client, interaction.guildId, channel.id)
        await interaction.editReply(
          text.replies.configured(`<#${channel.id}>`, result.messageUrl, result.playerCount, voiceChannelList()),
        )
        return
      }

      if (subcommand === 'status') {
        const board = getPlayerStatBoard(interaction.guildId)
        if (board === null || !board.enabled) {
          await interaction.editReply(text.replies.notConfigured)
          return
        }
        const url = `https://discord.com/channels/${board.guildId}/${board.channelId}/${board.messageId}`
        await interaction.editReply(text.replies.status(`<#${board.channelId}>`, url, voiceChannelList()))
        return
      }

      if (subcommand === 'refresh') {
        const result = await refreshPlayerStatBoard(interaction.client, interaction.guildId, true)
        await interaction.editReply(text.replies.refreshed(result.recreated, result.messageUrl))
        return
      }

      if (subcommand === 'disable') {
        const disabled = disablePlayerStatBoard(interaction.guildId)
        await interaction.editReply(disabled ? text.replies.disabled : text.replies.alreadyDisabled)
        return
      }

      await interaction.editReply(text.replies.unknownAction)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[player-board] command ${subcommand} on server ${interaction.guildId}: ${message}`)
      await interaction.editReply(text.replies.failed)
    }
  },
}
