import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from 'discord.js'
import { config } from '../../config.js'
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
  [PermissionFlagsBits.ViewChannel, 'просмотр канала'],
  [PermissionFlagsBits.SendMessages, 'отправка сообщений'],
  [PermissionFlagsBits.EmbedLinks, 'встраивание ссылок'],
  [PermissionFlagsBits.ReadMessageHistory, 'чтение истории сообщений'],
] as const

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
    .setDescription('Табло статистики игроков в голосовых каналах')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription('Создать или перенести voice-табло в выбранный канал')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Канал для постоянно обновляемого табло')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Показать текущую настройку табло'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('refresh').setDescription('Перерисовать табло из сохранённых данных'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription('Отключить автоматическое обновление табло'),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (!interaction.inGuild() || interaction.guildId === null) {
      await interaction.editReply('Эта команда доступна только на Discord-сервере.')
      return
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply('Для настройки табло требуется право «Управлять сервером».')
      return
    }

    const subcommand = interaction.options.getSubcommand()
    try {
      if (subcommand === 'setup') {
        const selected = interaction.options.getChannel('channel', true)
        const fetched = await interaction.client.channels.fetch(selected.id)
        const channel = guildTextChannel(fetched)
        if (channel === null || channel.guildId !== interaction.guildId) {
          await interaction.editReply('Выбранный канал недоступен или не является текстовым каналом этого сервера.')
          return
        }
        const permissions = interaction.client.user === null
          ? null
          : channel.permissionsFor(interaction.client.user)
        const missing = REQUIRED_BOT_PERMISSIONS
          .filter(([permission]) => permissions === null || !permissions.has(permission))
          .map(([, label]) => label)
        if (missing.length > 0) {
          await interaction.editReply(`Боту не хватает прав в <#${channel.id}>: ${missing.join(', ')}.`)
          return
        }
        const result = await configurePlayerStatBoard(interaction.client, interaction.guildId, channel.id)
        await interaction.editReply(
          `Табло настроено в <#${channel.id}>: ${result.messageUrl}\n` +
          `Игроков в текущем снимке: ${result.playerCount}.\n` +
          `Голосовые каналы: ${config.voiceChannelIds.length === 0 ? 'все доступные боту' : config.voiceChannelIds.map((id) => `<#${id}>`).join(', ')}.`,
        )
        return
      }

      if (subcommand === 'status') {
        const board = getPlayerStatBoard(interaction.guildId)
        if (board === null || !board.enabled) {
          await interaction.editReply('Табло игроков на этом сервере не настроено или отключено.')
          return
        }
        const url = `https://discord.com/channels/${board.guildId}/${board.channelId}/${board.messageId}`
        await interaction.editReply(
          `Табло включено в <#${board.channelId}>: ${url}\n` +
          `Голосовые каналы: ${config.voiceChannelIds.length === 0 ? 'все доступные боту' : config.voiceChannelIds.map((id) => `<#${id}>`).join(', ')}.`,
        )
        return
      }

      if (subcommand === 'refresh') {
        const result = await refreshPlayerStatBoard(interaction.client, interaction.guildId, true)
        await interaction.editReply(
          `Табло ${result.recreated ? 'восстановлено' : 'обновлено'} из сохранённых данных: ${result.messageUrl}\n` +
          'Для игроков без свежего кэша запрос WT ставится в общую последовательную очередь и не блокирует команду.',
        )
        return
      }

      if (subcommand === 'disable') {
        const disabled = disablePlayerStatBoard(interaction.guildId)
        await interaction.editReply(
          disabled
            ? 'Автоматическое обновление табло отключено. Последнее сообщение оставлено в канале.'
            : 'Табло игроков уже отключено или ещё не было настроено.',
        )
        return
      }

      await interaction.editReply('Неизвестное действие команды.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[player-board] команда ${subcommand} на сервере ${interaction.guildId}: ${message}`)
      await interaction.editReply(`Не удалось выполнить действие с табло: ${message}`)
    }
  },
}
