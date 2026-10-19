import {
  ChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
} from 'discord.js'
import type { GuildChannelKind } from '../../db/index.js'
import { getPlayerStatBoard } from '../../db/index.js'
import { botText, type BotText } from '../../i18n/index.js'
import { findSquadrons } from '../../scout/report.js'
import { squadronLabel } from '../../scout/format.js'
import { addSetting, guildChannels, removeSetting } from '../guild-settings.js'
import { chosenGuildLocale, guildLocale, userLocale } from '../locale.js'
import type { Command } from '../types.js'
import { squadronChoice } from './scout.js'

/**
 * /settings — what the bot does on this server, for members with Manage
 * Server: the channels of battle posts (every squadron's or one squadron's),
 * of scoreboard screenshots and the voice channels of the player board
 * (guild-settings.ts); `show` lists them with the language and the board.
 * Replies are ephemeral; a channel is accepted only once the bot has what it
 * needs there, so a public install never fails silently.
 */

type PermissionKey = keyof BotText['settings']['permissions']

const PERMISSION_FLAGS: Readonly<Record<PermissionKey, bigint>> = {
  view: PermissionFlagsBits.ViewChannel,
  send: PermissionFlagsBits.SendMessages,
  attach: PermissionFlagsBits.AttachFiles,
  embed: PermissionFlagsBits.EmbedLinks,
  history: PermissionFlagsBits.ReadMessageHistory,
}

/** What each kind needs: battle posts send a PNG; screenshot answers reply with an embed. */
const NEEDS: Readonly<Record<GuildChannelKind, readonly PermissionKey[]>> = {
  battles: ['view', 'send', 'attach'],
  scout: ['view', 'send', 'embed', 'history'],
  voice: ['view'],
}

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const
const VOICE_CHANNELS = [ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const

function missingPermissions(
  interaction: ChatInputCommandInteraction,
  channel: GuildBasedChannel,
  kind: GuildChannelKind,
  t: BotText['settings'],
): string | null {
  const me = interaction.client.user
  const permissions = channel.permissionsFor(me)
  const missing = NEEDS[kind].filter((key) => permissions === null || !permissions.has(PERMISSION_FLAGS[key]))
  return missing.length === 0 ? null : missing.map((key) => t.permissions[key]).join(', ')
}

/** The squadron as the game shows it, from its tag core. */
function squadronName(core: string): string {
  const squadron = findSquadrons(core, 1)[0]
  return squadron?.core === core ? squadronLabel(squadron.displayTag, squadron.name) : core.toUpperCase()
}

export const settings: Command = {
  definition: (t) => {
    const c = t.commands.settings
    return new SlashCommandBuilder()
      .setName('settings')
      .setDescription(c.description)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand((sub) => sub.setName('show').setDescription(c.show))
      .addSubcommandGroup((group) => group
        .setName('battles')
        .setDescription(c.battles)
        .addSubcommand((sub) => sub
          .setName('add')
          .setDescription(c.battlesAdd)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...TEXT_CHANNELS).setRequired(true))
          .addStringOption((option) => option.setName('squadron').setDescription(c.squadron).setMaxLength(64).setAutocomplete(true)))
        .addSubcommand((sub) => sub
          .setName('remove')
          .setDescription(c.battlesRemove)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...TEXT_CHANNELS).setRequired(true))
          .addStringOption((option) => option.setName('squadron').setDescription(c.squadronRemove).setMaxLength(64).setAutocomplete(true))))
      .addSubcommandGroup((group) => group
        .setName('scout')
        .setDescription(c.scout)
        .addSubcommand((sub) => sub
          .setName('add')
          .setDescription(c.scoutAdd)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...TEXT_CHANNELS).setRequired(true)))
        .addSubcommand((sub) => sub
          .setName('remove')
          .setDescription(c.scoutRemove)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...TEXT_CHANNELS).setRequired(true))))
      .addSubcommandGroup((group) => group
        .setName('voice')
        .setDescription(c.voice)
        .addSubcommand((sub) => sub
          .setName('add')
          .setDescription(c.voiceAdd)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...VOICE_CHANNELS).setRequired(true)))
        .addSubcommand((sub) => sub
          .setName('remove')
          .setDescription(c.voiceRemove)
          .addChannelOption((option) => option.setName('channel').setDescription(c.channel).addChannelTypes(...VOICE_CHANNELS).setRequired(true))))
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true)
    if (focused.name !== 'squadron') {
      await interaction.respond([])
      return
    }
    const t = botText(userLocale(interaction)).scout
    await interaction.respond(findSquadrons(focused.value).map((squadron) => squadronChoice(squadron, t)))
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const t = botText(userLocale(interaction)).settings
    if (!interaction.inCachedGuild()) {
      await interaction.editReply(t.guildOnly)
      return
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply(t.needManageGuild)
      return
    }
    const group = interaction.options.getSubcommandGroup()
    const action = interaction.options.getSubcommand()
    if (group === null) {
      await interaction.editReply({ embeds: [showEmbed(interaction, t)] })
      return
    }
    const kind = group as GuildChannelKind
    const picked = interaction.options.getChannel('channel', true)
    const channel = interaction.guild.channels.cache.get(picked.id)
    if (channel === undefined) {
      await interaction.editReply(t.badChannel)
      return
    }
    const mention = `<#${channel.id}>`

    let clan = ''
    let squadron: string | null = null
    const query = interaction.options.getString('squadron')?.trim() ?? ''
    if (kind === 'battles' && query !== '') {
      const found = findSquadrons(query, 1)[0]
      if (!found) {
        await interaction.editReply(t.squadronNotFound(query.slice(0, 64)))
        return
      }
      clan = found.core
      squadron = squadronLabel(found.displayTag, found.name)
    }

    if (action === 'remove') {
      const removed = removeSetting(kind, channel.id, kind === 'battles' && query !== '' ? clan : undefined)
      if (removed === 0) {
        await interaction.editReply(t.notSet(mention))
        return
      }
      console.log(`[settings] server ${interaction.guildId}: ${kind} ${channel.id}${clan ? ` (${clan})` : ''} removed`)
      const reply = kind === 'battles'
        ? t.battlesRemoved(mention)
        : kind === 'scout'
          ? t.scoutRemoved(mention)
          : t.voiceRemoved(mention, guildChannels('voice', interaction.guildId).length > 0)
      await interaction.editReply(reply)
      return
    }

    const missing = missingPermissions(interaction, channel, kind, t)
    if (missing !== null) {
      await interaction.editReply(t.missingPermissions(mention, missing))
      return
    }
    const result = addSetting({ kind, guildId: interaction.guildId, channelId: channel.id, clan })
    if (result === 'limit') {
      await interaction.editReply(t.limit(guildChannels(kind, interaction.guildId).length))
      return
    }
    if (result === 'added') console.log(`[settings] server ${interaction.guildId}: ${kind} ${channel.id}${clan ? ` (${clan})` : ''} added`)
    const added = result === 'added'
    const reply = kind === 'battles'
      ? (added ? t.battlesAdded(mention, squadron) : t.battlesExists(mention, squadron))
      : kind === 'scout'
        ? (added
          ? t.scoutAdded(mention, !interaction.client.options.intents.has(GatewayIntentBits.MessageContent))
          : t.scoutExists(mention))
        : (added ? t.voiceAdded(mention) : t.voiceExists(mention))
    await interaction.editReply(reply)
  },
}

function showEmbed(interaction: ChatInputCommandInteraction<'cached'>, t: BotText['settings']): EmbedBuilder {
  const s = t.show
  const guild = interaction.guild
  const line = (kind: GuildChannelKind, channelId: string, suffix = ''): string => {
    const channel = guild.channels.cache.get(channelId)
    const missing = channel === undefined ? null : missingPermissions(interaction, channel, kind, t)
    return `<#${channelId}>${suffix}${missing === null ? '' : ` ${s.missing(missing)}`}`
  }
  // One line per channel: a channel holding several squadrons lists them together.
  const battles = new Map<string, string[]>()
  for (const feed of guildChannels('battles', guild.id)) {
    const names = battles.get(feed.channelId) ?? []
    names.push(feed.clan === '' ? s.everySquadron : squadronName(feed.clan))
    battles.set(feed.channelId, names)
  }
  const scout = guildChannels('scout', guild.id)
  const voice = guildChannels('voice', guild.id)
  const board = getPlayerStatBoard(guild.id)
  const language = botText(guildLocale(guild.id, guild.preferredLocale)).languageName
  const value = (text: string): string => text.slice(0, 1024)
  return new EmbedBuilder()
    .setTitle(s.title)
    .setColor(0x5865f2)
    .addFields(
      { name: s.language, value: s.languageValue(language, chosenGuildLocale(guild.id) !== null) },
      {
        name: s.battles,
        value: value(battles.size === 0
          ? s.noBattles
          : [...battles].map(([channelId, names]) => line('battles', channelId, ` — ${names.join(', ')}`)).join('\n')),
      },
      { name: s.scout, value: value(scout.length === 0 ? s.noScout : scout.map((row) => line('scout', row.channelId)).join('\n')) },
      { name: s.voice, value: value(voice.length === 0 ? s.allVoice : voice.map((row) => line('voice', row.channelId)).join('\n')) },
      { name: s.playerBoard, value: board === null || !board.enabled ? s.noBoard : `<#${board.channelId}>` },
    )
}
