import { ApplicationCommandPermissionType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import type { BotText } from '../i18n/index.js'

/**
 * Who may do what with the bot on a server.
 *
 * Commands: Discord's per-command permissions are the only gate — the
 * defaults the bot registers (`setDefaultMemberPermissions`: Manage Server
 * for /settings, /language and /playerboard, everyone for the rest) plus a
 * server's changes in Server Settings → Integrations (roles, members,
 * channels; a command-level allow passes a member without the default
 * permission, an app-level one does not). The code adds no role check of its
 * own: it would refuse exactly the roles a server opened a command to; a
 * manager only acts on channels they can view themselves. The bot can read
 * these permissions with its token but not change them (a user's Bearer
 * token only): /settings show lists them (`describeCommandAccess`). Renaming
 * a command drops every server's permissions for it (keyed by command ID).
 *
 * The rest follows Discord's channel access: buttons under a post answer
 * whoever sees it, screenshots are read from whoever can post in the channel,
 * the player board shows a voice channel only if every role that sees the
 * board sees it too (`boardAudience`). /stats shows the parsers to the
 * application's owner only (`isBotOwner`).
 */

const VIEW = PermissionFlagsBits.ViewChannel
const ADMINISTRATOR = PermissionFlagsBits.Administrator

/** A role's server-wide permissions; the @everyone role's ID is the guild's. */
export interface RoleGrant {
  id: string
  permissions: bigint
}

/** A channel's role overwrites by role ID. */
export type RoleOverwrites = ReadonlyMap<string, { allow: bigint; deny: bigint }>

/**
 * Whether a member holding @everyone and `role` (null: @everyone alone) sees
 * a channel, in Discord's order: server permissions (Administrator sees
 * everything), then the @everyone overwrite, then the role's.
 */
export function roleSees(everyone: RoleGrant, role: RoleGrant | null, overwrites: RoleOverwrites): boolean {
  let permissions = everyone.permissions | (role?.permissions ?? 0n)
  if ((permissions & ADMINISTRATOR) !== 0n) return true
  for (const id of role === null ? [everyone.id] : [everyone.id, role.id]) {
    const overwrite = overwrites.get(id)
    if (overwrite !== undefined) permissions = (permissions & ~overwrite.deny) | overwrite.allow
  }
  return (permissions & VIEW) !== 0n
}

/**
 * Whether everyone who sees `audience` also sees `channel`, counted per role
 * as Discord counts a member holding only that role: a second role's deny
 * and member overwrites are not considered.
 */
export function audienceSees(
  everyone: RoleGrant,
  roles: readonly RoleGrant[],
  audience: RoleOverwrites,
  channel: RoleOverwrites,
): boolean {
  return [null, ...roles].every((role) => !roleSees(everyone, role, audience) || roleSees(everyone, role, channel))
}

/** What `boardAudience` reads of a discord.js channel; threads have no overwrites of their own. */
export interface AudienceChannel {
  id: string
  permissionOverwrites?: {
    cache: ReadonlyMap<string, { id: string; type: OverwriteType; allow: { bitfield: bigint }; deny: { bitfield: bigint } }>
  }
}

/** What `boardAudience` reads of a discord.js Guild. */
export interface AudienceGuild {
  id: string
  roles: { cache: ReadonlyMap<string, { id: string; permissions: { bitfield: bigint } }> }
  channels: { cache: ReadonlyMap<string, AudienceChannel> }
}

function overwritesOf(channel: AudienceChannel): RoleOverwrites {
  const overwrites = new Map<string, { allow: bigint; deny: bigint }>()
  for (const overwrite of channel.permissionOverwrites?.cache.values() ?? []) {
    if (overwrite.type === OverwriteType.Role) {
      overwrites.set(overwrite.id, { allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield })
    }
  }
  return overwrites
}

/**
 * The channels a player board in `boardChannelId` may show: those every role
 * that sees the board sees too. The bot's own view never decides it: with
 * Administrator it sees every room. Nothing while the board's channel is
 * unknown. Memoized per channel: build one per render.
 */
export function boardAudience(guild: AudienceGuild, boardChannelId: string): (channelId: string) => boolean {
  const board = guild.channels.cache.get(boardChannelId)
  const everyoneRole = guild.roles.cache.get(guild.id)
  if (board === undefined || everyoneRole === undefined) return () => false
  const everyone: RoleGrant = { id: guild.id, permissions: everyoneRole.permissions.bitfield }
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .map((role): RoleGrant => ({ id: role.id, permissions: role.permissions.bitfield }))
  const audience = overwritesOf(board)
  const seen = new Map<string, boolean>()
  return (channelId) => {
    let sees = seen.get(channelId)
    if (sees === undefined) {
      const channel = guild.channels.cache.get(channelId)
      sees = channel !== undefined && audienceSees(everyone, roles, audience, overwritesOf(channel))
      seen.set(channelId, sees)
    }
    return sees
  }
}

/** A command as Discord has it registered on a server. */
export interface RegisteredCommand {
  id: string
  name: string
  /** null — everyone; 0n — administrators only. */
  defaultMemberPermissions: bigint | null
}

/** One entry of Integrations: a role, member or channel the command is allowed or denied for. */
export interface CommandOverride {
  id: string
  type: ApplicationCommandPermissionType
  permission: boolean
}

type AccessText = BotText['settings']['access']

function defaultAccess(permissions: bigint | null, t: AccessText): string {
  if (permissions === null) return t.everyone
  if (permissions === 0n) return t.adminsOnly
  return permissions === PermissionFlagsBits.ManageGuild ? t.manageGuild : t.needsPermissions
}

/**
 * One level's entries as text, the way Integrations lists them: who (@everyone
 * is its guild's ID) and where (every channel is the guild's ID minus 1).
 * `base` — the command's default audience; null for the app-wide level, which
 * has none.
 */
function describeOverrides(guildId: string, list: readonly CommandOverride[], base: string | null, t: AccessText): string[] {
  const allChannels = (BigInt(guildId) - 1n).toString()
  const isChannel = (entry: CommandOverride) => entry.type === ApplicationCommandPermissionType.Channel
  const mention = (entry: CommandOverride) => entry.type === ApplicationCommandPermissionType.Role ? `<@&${entry.id}>` : `<@${entry.id}>`
  const names = (entries: readonly CommandOverride[], format: (entry: CommandOverride) => string) => entries.map(format).join(', ')
  const everyone = list.find((entry) => !isChannel(entry) && entry.id === guildId)
  const people = list.filter((entry) => !isChannel(entry) && entry.id !== guildId)
  const allowed = people.filter((entry) => entry.permission)
  const denied = people.filter((entry) => !entry.permission)
  const everywhere = list.find((entry) => isChannel(entry) && entry.id === allChannels)
  const channels = list.filter((entry) => isChannel(entry) && entry.id !== allChannels)
  const openIn = channels.filter((entry) => entry.permission)
  const closedIn = channels.filter((entry) => !entry.permission)
  const channel = (entry: CommandOverride) => `<#${entry.id}>`

  const parts: string[] = []
  if (everyone?.permission === false) {
    parts.push(allowed.length > 0 ? t.only(names(allowed, mention)) : t.adminsOnly)
  } else {
    const who = everyone?.permission === true ? t.everyone : base
    if (who !== null) parts.push(who)
    if (allowed.length > 0 && everyone?.permission !== true) parts.push(t.also(names(allowed, mention)))
  }
  if (denied.length > 0) parts.push(t.except(names(denied, mention)))
  if (everywhere?.permission === false) {
    parts.push(openIn.length > 0 ? t.onlyIn(names(openIn, channel)) : t.noChannel)
  } else if (openIn.length > 0) {
    parts.push(t.alsoIn(names(openIn, channel)))
  }
  if (closedIn.length > 0) parts.push(t.notIn(names(closedIn, channel)))
  return parts
}

/**
 * Who can use the bot's commands on a server, one line per group of commands
 * with the same access (restricted ones first), after the app-wide line when
 * the server has one. Shows what is configured, as Integrations does; Discord
 * resolves members holding several of the listed roles.
 */
export function describeCommandAccess(
  guildId: string,
  applicationId: string,
  commands: readonly RegisteredCommand[],
  overrides: ReadonlyMap<string, readonly CommandOverride[]>,
  t: AccessText,
): string[] {
  // `open`: every command of the group defaults to everyone; the others come first.
  const groups = new Map<string, { names: string[]; open: boolean }>()
  for (const command of commands) {
    const text = describeOverrides(guildId, overrides.get(command.id) ?? [], defaultAccess(command.defaultMemberPermissions, t), t)
      .join(' · ')
    const group = groups.get(text) ?? { names: [], open: true }
    group.names.push(`/${command.name}`)
    group.open &&= command.defaultMemberPermissions === null
    groups.set(text, group)
  }
  const lines = [...groups]
    .map(([text, group]) => ({ ...group, names: group.names.sort(), text }))
    .sort((left, right) => Number(left.open) - Number(right.open) || left.names[0]!.localeCompare(right.names[0]!))
    .map((group) => `${group.names.join(', ')} — ${group.text}`)
  const appWide = describeOverrides(guildId, overrides.get(applicationId) ?? [], null, t)
  return appWide.length > 0 ? [`${t.everyCommand} — ${appWide.join(' · ')}`, ...lines] : lines
}

/** Whether `userId` owns the bot's application, alone or in its team (ClientApplication.owner, read at start). */
export function isBotOwner(
  owner: { id: string } | { members: ReadonlyMap<string, unknown> } | null,
  userId: string,
): boolean {
  if (owner === null) return false
  return 'members' in owner ? owner.members.has(userId) : owner.id === userId
}
