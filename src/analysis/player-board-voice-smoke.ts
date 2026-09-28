import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

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

const guild = {
  id: 'guild-voice-smoke',
  name: 'Smoke guild',
  voiceStates: { cache: new Map<string, unknown>() },
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
  assert.match(renderedJson, /отслеживаемых голосовых каналах/)

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
  }
  syncVoicePresence([voiceEntry])
  const configured = await configurePlayerStatBoard(discordLikeClient as never, guild.id, 'text-1')
  assert.equal(configured.playerCount, 1)
  syncVoicePresence([])

  const client = new FakeClient()
  client.guilds.cache.set(guild.id, guild)
  let changes = 0
  const tracker = startVoiceTracker(client as never, [channel.id], {
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
  const refreshed = await refreshPlayerStatBoard(discordLikeClient as never, guild.id, true)
  assert.equal(refreshed.playerCount, 0)
  await tracker.stop()

  console.log('player-board voice smoke: OK')
} catch (error) {
  console.error('player-board voice smoke: FAIL', error)
  process.exitCode = 1
} finally {
  closeDb()
}
