import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { OverwriteType, PermissionFlagsBits } from 'discord.js'

// Конфиг импортируется лениво, поэтому smoke не требует WT-cookie и не делает
// сетевых запросов; Discord token config читает только по требованию.
process.env['WT_COOKIE'] = ''
process.env['WT_BROWSER_ENABLED'] = 'false'

const db = await import('../db/index.js')
type ParsedItem = import('../db/index.js').ParsedItem
type VoicePresenceEntry = import('../db/index.js').VoicePresenceEntry

const {
  closeDb,
  initDb,
  getVoicePresence,
  saveItems,
  syncVoicePresence,
} = db
const { renderPlayerBoard } = await import('../bot/player-board.js')
const { configurePlayerStatBoard, refreshPlayerStatBoard } = await import('../bot/player-board.js')
const { startVoiceTracker } = await import('../bot/voice-tracker.js')

class FakeClient extends EventEmitter {
  readonly guilds = {
    cache: new Map<string, {
      id: string
      name: string
      voiceStates: { cache: Map<string, unknown> }
    }>(),
  }

  isReady(): boolean { return true }
}

// The board's readers (src/bot/access.ts): @everyone sees the board's channel and Squad;
// Staff opens only to its role, so the board leaves it out.
const overwrite = (id: string, type: OverwriteType, allow: bigint, deny: bigint) =>
  [id, { id, type, allow: { bitfield: allow }, deny: { bitfield: deny } }] as const
const guild = {
  id: 'guild-voice-smoke',
  name: 'Smoke guild',
  voiceStates: { cache: new Map<string, unknown>() },
  roles: {
    cache: new Map([
      ['guild-voice-smoke', { id: 'guild-voice-smoke', permissions: { bitfield: PermissionFlagsBits.ViewChannel } }],
      ['staff', { id: 'staff', permissions: { bitfield: 0n } }],
    ]),
  },
  channels: {
    cache: new Map([
      ['text-1', { id: 'text-1', permissionOverwrites: { cache: new Map() } }],
      ['voice-1', { id: 'voice-1', permissionOverwrites: { cache: new Map() } }],
      ['voice-2', {
        id: 'voice-2',
        permissionOverwrites: {
          cache: new Map([
            overwrite('guild-voice-smoke', OverwriteType.Role, 0n, PermissionFlagsBits.ViewChannel),
            overwrite('staff', OverwriteType.Role, PermissionFlagsBits.ViewChannel, 0n),
          ]),
        },
      }],
    ]),
  },
}
const member = {
  id: 'user-1',
  displayName: 'SmokePlayer (Tester)',
  user: { username: 'SmokePlayer', bot: false },
}
const channel = { id: 'voice-1', name: 'Squad' }
const state = {
  id: member.id,
  guild,
  channelId: channel.id,
  channel,
  member,
}
guild.voiceStates.cache.set(member.id, state)

const voiceEntry: VoicePresenceEntry = {
  guildId: guild.id,
  guildName: guild.name,
  channelId: channel.id,
  channelName: channel.name,
  userId: member.id,
  displayName: member.displayName,
  wtNick: 'SmokePlayer',
}

const item: ParsedItem = {
  externalId: 'voice-smoke-user',
  title: 'SmokePlayer',
  data: {
    profile: { nickname: 'SmokePlayer', clan: 'TEST', level: 20, registrationDate: null, avatar: null },
    statistics: { arcade: { 'Completed missions': '10', Victories: '6' }, realistic: {}, simulation: {} },
    replayIdentity: null,
    replayCount: 1,
    replays: [],
  },
}

try {
  initDb(':memory:')
  saveItems('wt-players', [item])

  const rendered = renderPlayerBoard([{
    item: {
      id: 1,
      source: 'wt-players',
      externalId: item.externalId,
      title: item.title,
      data: item.data,
      updatedAt: Math.floor(Date.now() / 1000),
      analysis: null,
    },
    baselineData: null,
    baselineAt: null,
    voice: { ...voiceEntry, wtNickBase: 'SmokePlayer', joinedAt: Math.floor(Date.now() / 1000) },
    fetchState: 'ready',
    fetchError: null,
  }], null, Math.floor(Date.now() / 1000), 1, [], { mode: 'voice' })
  const renderedJson = JSON.stringify(rendered.payload)
  assert.match(renderedJson, /Squad/)
  assert.match(renderedJson, /watched voice channels/)

  const messages = new Map<string, {
    id: string
    url: string
    author: { id: string }
    payload: unknown
    edit: (payload: unknown) => Promise<unknown>
  }>()
  let nextMessageId = 1
  const textChannel = {
    isDMBased: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    messages: {
      fetch: async (id: string) => {
        const message = messages.get(id)
        if (message === undefined) throw new Error('unknown message')
        return message
      },
    },
    send: async (payload: unknown) => {
      const id = String(nextMessageId++)
      const message = {
        id,
        url: `https://discord.test/guild/${id}`,
        author: { id: 'bot' },
        payload,
        edit: async (next: unknown) => {
          message.payload = next
          return message
        },
      }
      messages.set(id, message)
      return message
    },
  }
  const discordLikeClient = {
    user: { id: 'bot' },
    channels: { fetch: async () => textChannel },
    // The board's language comes from its server (src/bot/locale.ts).
    guilds: { cache: new Map([[guild.id, guild]]) },
  }
  const staffEntry: VoicePresenceEntry = { ...voiceEntry, channelId: 'voice-2', channelName: 'Staff', userId: 'user-2', displayName: 'Officer', wtNick: 'Officer' }
  syncVoicePresence([voiceEntry, staffEntry])
  const configured = await configurePlayerStatBoard(discordLikeClient as never, guild.id, 'text-1')
  assert.equal(configured.playerCount, 1, 'the board leaves out a room some of its readers cannot see')
  assert.doesNotMatch(JSON.stringify([...messages.values()].map((message) => message.payload)), /Staff|Officer/)
  syncVoicePresence([])

  const client = new FakeClient()
  client.guilds.cache.set(guild.id, guild)
  let changes = 0
  // The server watches this one channel (/settings voice).
  db.addGuildChannel({ kind: 'voice', guildId: guild.id, channelId: channel.id, clan: '' })
  const tracker = startVoiceTracker(client as never, {
    onPresenceChange: () => { changes += 1 },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(getVoicePresence().length, 1)
  assert.ok(changes >= 1)

  const leftState = { ...state, channelId: null, channel: null, member }
  guild.voiceStates.cache.delete(member.id)
  client.emit('voiceStateUpdate', state, leftState)
  assert.equal(getVoicePresence().length, 0)
  assert.ok(changes >= 2)

  // A watched channel the bot cannot view stays off the board.
  const hiddenState = { ...state, channel: { ...channel, viewable: false } }
  client.emit('voiceStateUpdate', leftState, hiddenState)
  assert.equal(getVoicePresence().length, 0, 'a channel hidden from the bot is not tracked')
  guild.voiceStates.cache.set(member.id, hiddenState)
  client.emit('channelUpdate', channel, hiddenState.channel)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(getVoicePresence().length, 0, 'the snapshot skips it too')
  guild.voiceStates.cache.delete(member.id)
  const refreshed = await refreshPlayerStatBoard(discordLikeClient as never, guild.id, true)
  assert.equal(refreshed.playerCount, 0)

  // A watched category takes every voice channel in it: a room a join-to-create bot opens there later
  // counts, a room of another category does not.
  db.addGuildChannel({ kind: 'voice', guildId: guild.id, channelId: 'category-1', clan: '' })
  const roomState = { ...state, channelId: 'room-1', channel: { id: 'room-1', name: 'Platoon 1', parentId: 'category-1' } }
  client.emit('voiceStateUpdate', leftState, roomState)
  assert.equal(getVoicePresence()[0]?.channelId, 'room-1', 'a room of a watched category is tracked')
  const otherRoomState = { ...state, channelId: 'room-2', channel: { id: 'room-2', name: 'Squad 1', parentId: 'category-2' } }
  client.emit('voiceStateUpdate', roomState, otherRoomState)
  assert.equal(getVoicePresence().length, 0, 'a room of another category is not')
  await tracker.stop()

  console.log('player-board voice smoke: OK')
} catch (error) {
  console.error('player-board voice smoke: FAIL', error)
  process.exitCode = 1
} finally {
  closeDb()
}
