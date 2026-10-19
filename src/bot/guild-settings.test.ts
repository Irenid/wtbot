import assert from 'node:assert/strict'
import test from 'node:test'
import type { Client } from 'discord.js'

// Read by config.ts at import: this file runs in its own process.
process.env['WT_BATTLES_CHANNEL'] = 'battles-1'
process.env['WT_CLAN_TAG'] = '=WLILY='
process.env['WT_SCOUT_CHANNEL'] = 'scout-1,scout-gone'
process.env['WT_VOICE_CHANNELS'] = ''

const db = await import('../db/index.js')
const settings = await import('./guild-settings.js')

test('a battle goes to the every-squadron channels and its squadrons\' channels, once each', () => {
  const feed = (channelId: string, clan: string) => ({ kind: 'battles' as const, guildId: 'g', channelId, clan })
  const feeds = [feed('all', ''), feed('ours', 'wlily'), feed('ours', 'avr'), feed('theirs', 'avr')]
  assert.deepEqual(settings.battleTargets(feeds, ['=WLILY=', '[AVR]']), ['all', 'ours', 'theirs'])
  assert.deepEqual(settings.battleTargets(feeds, ['╝WLILY╝']), ['all', 'ours'])
  assert.deepEqual(settings.battleTargets(feeds, []), ['all'])
})

test('a server holds each setting once and at most its limit; removal and cleanup notify', () => {
  db.initDb(':memory:', { allowCreate: true })
  try {
    const changes: string[] = []
    const unsubscribe = settings.onGuildChannelsChange((kind) => changes.push(kind))
    const row = { kind: 'voice' as const, guildId: 'g', channelId: 'v0', clan: '' }
    assert.equal(settings.addSetting(row), 'added')
    assert.equal(settings.addSetting(row), 'exists')
    for (let i = 1; i < settings.MAX_GUILD_CHANNELS.voice; i++) settings.addSetting({ ...row, channelId: `v${i}` })
    assert.equal(settings.addSetting({ ...row, channelId: 'one-more' }), 'limit')
    // Another server has its own limit.
    assert.equal(settings.addSetting({ ...row, guildId: 'h', channelId: 'h0' }), 'added')
    assert.equal(settings.watchedVoiceChannels('g').size, settings.MAX_GUILD_CHANNELS.voice)

    assert.equal(settings.removeSetting('voice', 'v0'), 1)
    assert.equal(settings.removeSetting('voice', 'v0'), 0)
    assert.equal(settings.forgetGuildChannels({ guildId: 'g' }), settings.MAX_GUILD_CHANNELS.voice - 1)
    assert.deepEqual([...settings.watchedVoiceChannels('h')], ['h0'])
    unsubscribe()
    assert.ok(changes.length >= 3 && changes.every((kind) => ['voice', 'battles', 'scout'].includes(kind)))
  } finally {
    db.closeDb()
  }
})

test('env channels are imported once per value; a channel the bot cannot fetch waits for the next start', async () => {
  db.initDb(':memory:', { allowCreate: true })
  try {
    const fetchable = new Set(['battles-1', 'scout-1'])
    const client = {
      channels: {
        fetch: async (id: string) => fetchable.has(id) ? { isDMBased: () => false, guildId: 'g' } : null,
      },
    } as unknown as Client
    await settings.importEnvChannels(client)
    assert.deepEqual(db.listGuildChannels(), [{ kind: 'battles', guildId: 'g', channelId: 'battles-1', clan: 'wlily' }])

    // A server's own removal sticks while the variable keeps its value.
    settings.removeSetting('battles', 'battles-1')
    fetchable.add('scout-gone')
    await settings.importEnvChannels(client)
    assert.deepEqual(db.listGuildChannels().map((row) => `${row.kind}:${row.channelId}`), ['scout:scout-1', 'scout:scout-gone'])
    assert.equal(settings.isScoutChannel('scout-gone'), true)
    assert.equal(settings.isScoutChannel('battles-1'), false)
  } finally {
    db.closeDb()
  }
})
