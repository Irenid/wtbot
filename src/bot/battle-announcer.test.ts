import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Client } from 'discord.js'
import type { BattlePlayerInput } from '../db/index.js'
import type { BattlePost } from './commands/battle.js'

test('the announcer sends no text before ingest finishes', async () => {
  const [
    { emitBattleLifecycle },
    { startBattleAnnouncer, stopBattleAnnouncer },
    { addGuildChannel, closeDb, initDb, saveItems, setBotState },
  ] = await Promise.all([
    import('../battle-lifecycle.js'),
    import('./battle-announcer.js'),
    import('../db/index.js'),
  ])

  initDb(':memory:', { allowCreate: true })
  setBotState('battles:lastAnnouncedId', '0')
  addGuildChannel({ kind: 'battles', guildId: 'guild', channelId: 'test-channel', clan: '' })
  let sends = 0
  const channel = {
    id: 'test-channel',
    isSendable: () => true,
    send: async () => {
      sends += 1
      throw new Error('no preliminary announcement may be sent')
    },
  }
  const client = { user: null, channels: { fetch: async () => channel } } as unknown as Client

  try {
    startBattleAnnouncer(client)
    saveItems('wt-replays', [{
      externalId: 'new-unparsed-battle',
      title: 'New unparsed battle',
      data: {},
    }])
    emitBattleLifecycle({
      kind: 'discovered',
      sessionIds: ['new-unparsed-battle'],
      bulk: false,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    assert.equal(sends, 0)
  } finally {
    await stopBattleAnnouncer()
    closeDb()
  }
})

function player(userId: string, clanTag: string): BattlePlayerInput {
  return {
    userId, nick: `p${userId}`, clanTag, team: 1, kills: 0, groundKills: 0, navalKills: 0, aiKills: 0,
    aiGroundKills: 0, assists: 0, deaths: 0, captureZone: 0, damageZone: 0, score: 0, awardDamage: 0,
    teamKills: 0, squadId: 4096, vehicle: null, vehicles: [], disconnected: false, slot: null, title: null,
    autoSquad: null,
  }
}

test('a battle reaches every channel that asked for it once; a gone channel leaves the settings', async () => {
  const [
    { DiscordAPIError, RESTJSONErrorCodes },
    { emitBattleLifecycle },
    { startBattleAnnouncer, stopBattleAnnouncer },
    db,
  ] = await Promise.all([
    import('discord.js'),
    import('../battle-lifecycle.js'),
    import('./battle-announcer.js'),
    import('../db/index.js'),
  ])
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-announcer-'))
  db.initDb(path.join(root, 'announce.db'), { allowCreate: true })
  db.setBotState('battles:lastAnnouncedId', '0')
  for (const [channelId, clan] of [['all', ''], ['ours', 'wlily'], ['gone', 'wlily'], ['flaky', '']] as const) {
    db.addGuildChannel({ kind: 'battles', guildId: `guild-${channelId}`, channelId, clan })
  }
  const sent: string[] = []
  let flakyFailures = 1
  const channel = (id: string) => ({
    id,
    isSendable: () => true,
    send: async (payload: { content: string }) => {
      if (id === 'flaky' && flakyFailures-- > 0) throw new Error('socket hang up')
      sent.push(`${id}:${payload.content}`)
      return { edit: async () => {} }
    },
  })
  const client = {
    user: null,
    channels: {
      fetch: async (id: string) => {
        if (id !== 'gone') return channel(id)
        throw new DiscordAPIError(
          { code: RESTJSONErrorCodes.UnknownChannel, message: 'Unknown Channel' },
          RESTJSONErrorCodes.UnknownChannel, 404, 'GET', `/channels/${id}`, {},
        )
      },
    },
  } as unknown as Client
  const renderPost = async (item: { externalId: string }): Promise<BattlePost> => ({
    payload: { content: item.externalId, files: [], components: [] },
    sessionIdHex: item.externalId,
    buildWinnerPayload: null,
    buildRatingsPayload: null,
    buildLookupPayload: null,
    buildRecheckPayload: null,
    recheckAt: 0,
    updateBytes: 0,
  }) as unknown as BattlePost

  const startTime = Math.floor(Date.now() / 1000)
  for (const [sessionId, tag] of [['1', '=WLILY='], ['2', '[AVR]']] as const) {
    db.saveItems('wt-replays', [{ externalId: sessionId, title: sessionId, data: { startTime: startTime + Number(sessionId) } }])
    db.saveBattle({
      sessionId, sessionHex: sessionId.padStart(16, '0'), missionName: 'test', level: 'test', gameMode: null,
      battleType: null, environment: null, status: null, startTime, durationSec: 2, endTimeMs: 3, teamWon: 1,
      gameVersion: null, missionSettings: null, players: [player('1', tag), player('2', tag)], kills: [], chat: [],
      eventsBlob: Buffer.from('test'),
    })
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200 && db.getPendingAnnounce(0, 3, 10).length > 0; i++) {
      emitBattleLifecycle({ kind: 'committed', sessionId: '1' })
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }

  try {
    startBattleAnnouncer(client, { renderPost })
    await settle()
    assert.deepEqual(db.getPendingAnnounce(0, 3, 10), [])
    // In battle order; the flaky channel's retry posts only there.
    assert.deepEqual(sent.sort(), ['all:1', 'all:2', 'flaky:1', 'flaky:2', 'ours:1'])
    assert.deepEqual(
      db.listGuildChannels().map((row) => row.channelId).sort(),
      ['all', 'flaky', 'ours'],
    )
  } finally {
    await stopBattleAnnouncer()
    db.closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('without any battle channel the baseline follows the newest battle', async () => {
  const [{ startBattleAnnouncer, stopBattleAnnouncer }, db] = await Promise.all([
    import('./battle-announcer.js'),
    import('../db/index.js'),
  ])
  db.initDb(':memory:', { allowCreate: true })
  db.setBotState('battles:lastAnnouncedId', '0')
  db.saveItems('wt-replays', [{ externalId: 'a', title: 'a', data: {} }, { externalId: 'b', title: 'b', data: {} }])
  const client = { user: null, channels: { fetch: async () => null } } as unknown as Client
  try {
    startBattleAnnouncer(client)
    for (let i = 0; i < 100 && db.getBotState('battles:lastAnnouncedId') === '0'; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(db.getBotState('battles:lastAnnouncedId'), String(db.getMaxItemId('wt-replays')))
  } finally {
    await stopBattleAnnouncer()
    db.closeDb()
  }
})
