import {
  ChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js'
import type { GuildChannelKind } from '../../db/index.js'
import { getPlayerStatBoard } from '../../db/index.js'
import { botText, type BotText } from '../../i18n/index.js'
import { findSquadrons } from '../../scout/report.js'
import { squadronLabel } from '../../scout/format.js'
import { boardAudience, describeCommandAccess } from '../access.js'
import { addSetting, guildChannels, removeSetting } from '../guild-settings.js'
import { chosenGuildLocale, guildLocale, userLocale } from '../locale.js'
import { removeSquadronStats, setupSquadronStats, squadronStatsSquadron } from '../squadron-stats.js'
import type { Command } from '../types.js'
import { squadronChoice } from './scout.js'

/**
 * /settings — what the bot does on this server, for whoever the server lets
 * use the command (Manage Server by default; access.ts): the channels of
 * battle posts (every squadron's or one squadron's), of scoreboard
 * screenshots and the voice channels or categories of the player board (guild-settings.ts);
 * `show` lists them with the language, the board and who can use each
 * command. Replies are ephemeral; a channel is accepted only once the bot has
 * what it needs there, so a public install never fails silently, and only
 * from a member who can view it.
 */

type PermissionKey = keyof BotText['settings']['permissions']

const PERMISSION_FLAGS: Readonly<Record<PermissionKey, bigint>> = {
  view: PermissionFlagsBits.ViewChannel,
  send: PermissionFlagsBits.SendMessages,
  attach: PermissionFlagsBits.AttachFiles,
  embed: PermissionFlagsBits.EmbedLinks,
  history: PermissionFlagsBits.ReadMessageHistory,
  manage: PermissionFlagsBits.ManageChannels,
  connect: PermissionFlagsBits.Connect,
}

/** What each kind needs: battle posts send a PNG; screenshot answers reply with an embed. */
const NEEDS: Readonly<Record<GuildChannelKind, readonly PermissionKey[]>> = {
  battles: ['view', 'send', 'attach'],
  scout: ['view', 'send', 'embed', 'history'],
  voice: ['view'],
}

/**
 * The place and rating channels (squadron-stats.ts): in a category they copy its overwrites, so the bot
 * needs to see and manage channels there; at the top of the list they carry their own (everyone sees,
 * nobody connects), and Discord lets a bot allow or deny only permissions it holds on the server.
 */
const STATS_NEEDS = {
  category: ['view', 'manage'],
  server: ['view', 'manage', 'connect'],
} as const satisfies Record<string, readonly PermissionKey[]>

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const
/** A category stands for every voice channel in it, so the board follows rooms a join-to-create bot opens there. */
const VOICE_CHANNELS = [ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory] as const

function missingPermissions(
  interaction: ChatInputCommandInteraction,
  channel: GuildBasedChannel,
  kind: GuildChannelKind,
  t: BotText['settings'],
): string | null {
  const me = interaction.client.user
  // A category is checked in its voice channels, one granting each permission enough: its own
  // overwrites open nothing in them (only a synced channel copies them).
  const targets = channel.type === ChannelType.GuildCategory
    ? [...channel.children.cache.values()].filter((child) => child.isVoiceBased())
    : [channel]
  const missing = NEEDS[kind].filter((key) =>
    !targets.some((target) => target.permissionsFor(me)?.has(PERMISSION_FLAGS[key]) === true))
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
      .addSubcommandGroup((group) => group
        .setName('stats')
        .setDescription(c.stats)
        .addSubcommand((sub) => sub
          .setName('set')
          .setDescription(c.statsSet)
          .addStringOption((option) => option.setName('squadron').setDescription(c.squadron).setMaxLength(64).setAutocomplete(true).setRequired(true))
          .addChannelOption((option) => option.setName('category').setDescription(c.statsCategory).addChannelTypes(ChannelType.GuildCategory)))
        .addSubcommand((sub) => sub.setName('remove').setDescription(c.statsRemove)))
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
    const group = interaction.options.getSubcommandGroup()
    const action = interaction.options.getSubcommand()
    if (group === null) {
      await interaction.editReply({ embeds: [await showEmbed(interaction, t)] })
      return
    }
    if (group === 'stats') {
      await executeStats(interaction, action, t)
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
    // A role the server opened /settings to must not point the bot at a channel it cannot see:
    // posts into a staff room, or a hidden room's members on the board.
    if (channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel) !== true) {
      await interaction.editReply(t.cannotView(mention))
      return
    }

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
        : (added
          ? t.voiceAdded(mention, hiddenOnBoard(interaction.guild, channel.id), channel.type === ChannelType.GuildCategory)
          : t.voiceExists(mention))
    await interaction.editReply(reply)
  },
}

/** /settings stats set|remove: the locked channels with a squadron's place and rating (squadron-stats.ts). */
async function executeStats(
  interaction: ChatInputCommandInteraction<'cached'>,
  action: string,
  t: BotText['settings'],
): Promise<void> {
  try {
    if (action === 'remove') {
      await interaction.editReply((await removeSquadronStats(interaction.guild)) ? t.statsRemoved : t.statsNotSet)
      return
    }
    const picked = interaction.options.getChannel('category')
    const chosen = picked === null ? undefined : interaction.guild.channels.cache.get(picked.id)
    const category = chosen?.type === ChannelType.GuildCategory ? chosen : null
    if (picked !== null && category === null) {
      await interaction.editReply(t.badChannel)
      return
    }
    const mention = category === null ? null : `<#${category.id}>`
    // As for the other settings: a member points the bot only at what they can see themselves.
    if (category !== null && category.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel) !== true) {
      await interaction.editReply(t.cannotView(`<#${category.id}>`))
      return
    }
    const permissions = category === null ? interaction.guild.members.me?.permissions : category.permissionsFor(interaction.client.user)
    const missing = (category === null ? STATS_NEEDS.server : STATS_NEEDS.category)
      .filter((key) => permissions?.has(PERMISSION_FLAGS[key]) !== true)
      .map((key) => t.permissions[key]).join(', ')
    if (missing !== '') {
      await interaction.editReply(mention === null ? t.statsNeedsPermissions(missing) : t.missingPermissions(mention, missing))
      return
    }
    const query = interaction.options.getString('squadron', true).trim()
    const found = findSquadrons(query, 1)[0]
    if (!found) {
      await interaction.editReply(t.squadronNotFound(query.slice(0, 64)))
      return
    }
    await setupSquadronStats(interaction.guild, found.core, category)
    console.log(`[settings] server ${interaction.guildId}: stats channels for ${found.core} created${category ? ` in ${category.id}` : ''}`)
    await interaction.editReply(t.statsSet(squadronLabel(found.displayTag, found.name), mention))
  } catch (error) {
    console.warn(`[settings] server ${interaction.guildId}: stats ${action} failed:`, error)
    await interaction.editReply(botText(userLocale(interaction)).failure.command)
  }
}

/** Whether the server's player board leaves the voice channel out: some who see the board cannot see it (access.ts). */
function hiddenOnBoard(guild: Guild, channelId: string): boolean {
  const board = getPlayerStatBoard(guild.id)
  return board !== null && board.enabled && !boardAudience(guild, board.channelId)(channelId)
}

/** The lines that fit `room` characters whole, then "…": a cut mention would show as raw text. */
function fitLines(lines: readonly string[], room: number): string[] {
  const kept: string[] = []
  let length = 0
  for (const [index, line] of lines.entries()) {
    // The last line needs no room for "…" after it.
    const reserve = index === lines.length - 1 ? 0 : 2
    if (length + line.length + reserve > room) return [...kept, '…']
    kept.push(line)
    length += line.length + 1
  }
  return kept
}

/** Who can use the bot's commands here, as Discord has them: the registered defaults and the server's Integrations changes. */
async function commandAccess(interaction: ChatInputCommandInteraction<'cached'>, t: BotText['settings']['access']): Promise<string> {
  const guild = interaction.guild
  try {
    // Two reads at once; a server's /settings show is rare.
    const [registered, overrides] = await Promise.all([guild.commands.fetch(), guild.commands.permissions.fetch({})])
    const commands = [...registered.values()].map((command) => ({
      id: command.id,
      name: command.name,
      defaultMemberPermissions: command.defaultMemberPermissions?.bitfield ?? null,
    }))
    const lines = describeCommandAccess(guild.id, interaction.applicationId, commands, overrides, t)
    // The note says where to change it: always kept, within the field's 1,024 characters.
    const note = t.note(interaction.client.user.username)
    return [...fitLines(lines, 1024 - note.length - 1), note].join('\n')
  } catch (error) {
    console.warn(`[settings] server ${guild.id}: could not read who can use the commands:`, error)
    return t.unread
  }
}

async function showEmbed(interaction: ChatInputCommandInteraction<'cached'>, t: BotText['settings']): Promise<EmbedBuilder> {
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
  const statsClan = squadronStatsSquadron(guild.id)
  const boardSees = board !== null && board.enabled ? boardAudience(guild, board.channelId) : () => true
  const language = botText(guildLocale(guild.id, guild.preferredLocale)).languageName
  const value = (text: string): string => text.slice(0, 1024)
  const access = await commandAccess(interaction, t.access)
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
      {
        name: s.voice,
        value: value(voice.length === 0
          ? s.allVoice
          : voice.map((row) => line('voice', row.channelId,
            (guild.channels.cache.get(row.channelId)?.type === ChannelType.GuildCategory ? ` ${s.wholeCategory}` : '') +
            (boardSees(row.channelId) ? '' : ` ${s.hiddenOnBoard}`))).join('\n')),
      },
      { name: s.playerBoard, value: board === null || !board.enabled ? s.noBoard : `<#${board.channelId}>` },
      {
        name: s.stats,
        value: value(statsClan === null ? s.noStats : squadronName(statsClan)),
      },
      { name: s.access, value: access },
    )
    .setFooter({ text: s.footer })
}
