import assert from 'node:assert/strict'
import test from 'node:test'
import { ApplicationCommandPermissionType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { botText } from '../i18n/index.js'
import {
  audienceSees,
  boardAudience,
  describeCommandAccess,
  isBotOwner,
  roleSees,
  type AudienceChannel,
  type AudienceGuild,
  type CommandOverride,
  type RoleGrant,
  type RoleOverwrites,
} from './access.js'

const VIEW = PermissionFlagsBits.ViewChannel
const GUILD = '1000'
/** Discord's "every channel" entry: the guild's ID minus 1. */
const ALL_CHANNELS = '999'

const overwrites = (entries: Record<string, { allow?: bigint; deny?: bigint }>): RoleOverwrites =>
  new Map(Object.entries(entries).map(([id, { allow = 0n, deny = 0n }]) => [id, { allow, deny }]))

// A default-deny server like Test pechenka: @everyone sees nothing, roles open channels.
const closed: RoleGrant = { id: GUILD, permissions: PermissionFlagsBits.SendMessages }
const fighter: RoleGrant = { id: 'fighter', permissions: 0n }
const hr: RoleGrant = { id: 'hr', permissions: PermissionFlagsBits.ManageRoles }
const guest: RoleGrant = { id: 'guest', permissions: 0n }
const auditBot: RoleGrant = { id: 'audit', permissions: PermissionFlagsBits.Administrator }
const roles = [fighter, hr, guest, auditBot]
const scouting = overwrites({ [GUILD]: { deny: VIEW }, fighter: { allow: VIEW }, hr: { allow: VIEW } })
const regimentVoice = overwrites({ [GUILD]: { deny: VIEW }, fighter: { allow: VIEW }, hr: { allow: VIEW } })
const staffVoice = overwrites({ [GUILD]: { deny: VIEW }, hr: { allow: VIEW } })

test('a role sees a channel the way Discord counts one member holding it', () => {
  const open: RoleGrant = { id: GUILD, permissions: VIEW }
  assert.equal(roleSees(open, null, new Map()), true)
  assert.equal(roleSees(closed, null, new Map()), false, 'no View Channel on the server')
  const hidden = overwrites({ [GUILD]: { deny: VIEW }, fighter: { allow: VIEW } })
  assert.equal(roleSees(open, null, hidden), false)
  assert.equal(roleSees(open, fighter, hidden), true, "the role's allow beats @everyone's deny")
  assert.equal(roleSees(open, guest, hidden), false)
  assert.equal(roleSees(open, fighter, overwrites({ fighter: { deny: VIEW } })), false, "the role's own deny")
  assert.equal(roleSees(closed, auditBot, staffVoice), true, 'Administrator sees every channel')
})

test('the board audience must see a voice channel for the board to show it', () => {
  assert.equal(audienceSees(closed, roles, scouting, regimentVoice), true)
  assert.equal(audienceSees(closed, roles, scouting, staffVoice), false, 'fighters read the board but not the staff room')
  const staffRoom = overwrites({ [GUILD]: { deny: VIEW }, hr: { allow: VIEW } })
  assert.equal(audienceSees(closed, roles, staffRoom, staffVoice), true, 'a staff board may show the staff room')
  const adminsOnly = overwrites({ [GUILD]: { deny: VIEW } })
  assert.equal(audienceSees(closed, roles, adminsOnly, staffVoice), true, 'only administrators read it')

  // An open server: @everyone reads the board, so only rooms @everyone sees are shown.
  const open: RoleGrant = { id: GUILD, permissions: VIEW }
  const membersVoice = overwrites({ [GUILD]: { deny: VIEW }, fighter: { allow: VIEW } })
  assert.equal(audienceSees(open, roles, new Map(), new Map()), true)
  assert.equal(audienceSees(open, roles, new Map(), membersVoice), false)
})

test('boardAudience reads a guild: role overwrites only, unknown channels hidden', () => {
  const role = (id: string, bitfield: bigint) => [id, { id, permissions: { bitfield } }] as const
  const channel = (id: string, list: readonly [string, OverwriteType, bigint, bigint][]): [string, AudienceChannel] => [id, {
    id,
    permissionOverwrites: {
      cache: new Map(list.map(([target, type, allow, deny]) => [target, { id: target, type, allow: { bitfield: allow }, deny: { bitfield: deny } }])),
    },
  }]
  const guild: AudienceGuild = {
    id: GUILD,
    roles: { cache: new Map([role(GUILD, 0n), role('fighter', 0n), role('hr', 0n)]) },
    channels: {
      cache: new Map([
        channel('board', [[GUILD, OverwriteType.Role, 0n, VIEW], ['fighter', OverwriteType.Role, VIEW, 0n], ['hr', OverwriteType.Role, VIEW, 0n]]),
        channel('squad', [[GUILD, OverwriteType.Role, 0n, VIEW], ['fighter', OverwriteType.Role, VIEW, 0n], ['hr', OverwriteType.Role, VIEW, 0n]]),
        // A member overwrite opens the room to one fighter: the other fighters still cannot see it.
        channel('staff', [[GUILD, OverwriteType.Role, 0n, VIEW], ['hr', OverwriteType.Role, VIEW, 0n], ['user', OverwriteType.Member, VIEW, 0n]]),
        ['thread', { id: 'thread' }],
      ]),
    },
  }
  const sees = boardAudience(guild, 'board')
  assert.equal(sees('squad'), true)
  assert.equal(sees('staff'), false)
  assert.equal(sees('gone'), false, 'a channel missing from the cache')
  assert.equal(boardAudience(guild, 'gone')('squad'), false, 'nothing while the board channel is unknown')
})

const access = botText('en').settings.access
const registered = [
  { id: 'c-settings', name: 'settings', defaultMemberPermissions: PermissionFlagsBits.ManageGuild },
  { id: 'c-language', name: 'language', defaultMemberPermissions: PermissionFlagsBits.ManageGuild },
  { id: 'c-playerboard', name: 'playerboard', defaultMemberPermissions: PermissionFlagsBits.ManageGuild },
  { id: 'c-battle', name: 'battle', defaultMemberPermissions: null },
  { id: 'c-scout', name: 'scout', defaultMemberPermissions: null },
  { id: 'c-stats', name: 'stats', defaultMemberPermissions: null },
  { id: 'c-ping', name: 'ping', defaultMemberPermissions: null },
]
const { Role, User, Channel } = ApplicationCommandPermissionType
const describe = (entries: Record<string, CommandOverride[]>, commands = registered) =>
  describeCommandAccess(GUILD, 'app', commands, new Map(Object.entries(entries)), access)

test('who can use the commands: the defaults the bot registers', () => {
  assert.deepEqual(describe({}), [
    '/language, /playerboard, /settings — members with Manage Server',
    '/battle, /ping, /scout, /stats — everyone',
  ])
  assert.deepEqual(
    describe({}, [
      { id: 'a', name: 'a', defaultMemberPermissions: 0n },
      { id: 'b', name: 'b', defaultMemberPermissions: PermissionFlagsBits.BanMembers },
    ]),
    ['/a — administrators only', '/b — members with the permissions it asks for'],
  )
})

test('who can use the commands: a server\'s Integrations changes', () => {
  // Parliament may change the bot's channels without Manage Server.
  assert.deepEqual(describe({ 'c-settings': [{ id: 'parliament', type: Role, permission: true }] }), [
    '/language, /playerboard — members with Manage Server',
    '/settings — members with Manage Server · also <@&parliament>',
    '/battle, /ping, /scout, /stats — everyone',
  ])
  // @everyone denied: only the allowed role, minus one member, and not in one channel.
  assert.deepEqual(
    describe({
      'c-scout': [
        { id: GUILD, type: Role, permission: false },
        { id: 'fighter', type: Role, permission: true },
        { id: 'troll', type: User, permission: false },
        { id: 'news', type: Channel, permission: false },
      ],
    }),
    [
      '/language, /playerboard, /settings — members with Manage Server',
      '/battle, /ping, /stats — everyone',
      '/scout — only <@&fighter> · not <@troll> · not in <#news>',
    ],
  )
  assert.ok(describe({ 'c-ping': [{ id: GUILD, type: Role, permission: false }] }).includes('/ping — administrators only'))
  // Opened to @everyone, /settings joins the commands everyone can use (listed first: its default was narrower).
  assert.deepEqual(describe({ 'c-settings': [{ id: GUILD, type: Role, permission: true }] })[0], '/battle, /ping, /scout, /settings, /stats — everyone')
})

test('who can use the commands: channels, and the app-wide line first', () => {
  const lines = describe({
    app: [
      { id: ALL_CHANNELS, type: Channel, permission: false },
      { id: 'bots', type: Channel, permission: true },
      { id: 'guest', type: Role, permission: false },
    ],
    'c-battle': [{ id: 'results', type: Channel, permission: true }, { id: 'chat', type: Channel, permission: false }],
    'c-stats': [{ id: ALL_CHANNELS, type: Channel, permission: false }],
  })
  assert.equal(lines[0], 'Every command — not <@&guest> · only in <#bots>')
  assert.ok(lines.includes('/battle — everyone · also in <#results> · not in <#chat>'), lines.join('\n'))
  assert.ok(lines.includes('/stats — everyone · in no channel'), lines.join('\n'))
})

test('the bot\'s owner: a user or any member of the team', () => {
  assert.equal(isBotOwner(null, 'u'), false)
  assert.equal(isBotOwner({ id: 'u' }, 'u'), true)
  assert.equal(isBotOwner({ id: 'u' }, 'x'), false)
  const team = { id: 'team', members: new Map([['dev', {}]]) }
  assert.equal(isBotOwner(team, 'dev'), true)
  assert.equal(isBotOwner(team, 'team'), false, "the team's own ID is no member")
})
