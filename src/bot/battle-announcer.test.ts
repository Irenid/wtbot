import assert from 'node:assert/strict'
import test from 'node:test'
import type { Client } from 'discord.js'

test('the announcer sends no text before ingest finishes', async () => {
  process.env['WT_BATTLES_CHANNEL'] = 'test-channel'
  const [
    { emitBattleLifecycle },
    { startBattleAnnouncer, stopBattleAnnouncer },
    { closeDb, initDb, saveItems, setBotState },
  ] = await Promise.all([
    import('../battle-lifecycle.js'),
    import('./battle-announcer.js'),
    import('../db/index.js'),
  ])

  initDb(':memory:', { allowCreate: true })
  setBotState('battles:lastAnnouncedId', '0')
  let sends = 0
  const channel = {
    isSendable: () => true,
    send: async () => {
      sends += 1
      throw new Error('no preliminary announcement may be sent')
    },
  }
  const client = {
    channels: {
      fetch: async () => channel,
    },
  } as unknown as Client

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

test('legacy preliminary messages behind the baseline are finished, a waiting one later', async () => {
  process.env['WT_BATTLES_CHANNEL'] = 'test-channel'
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

  db.initDb(':memory:', { allowCreate: true })
  db.saveItems('wt-replays', [
    { externalId: 'legacy-expired', title: 'Legacy', data: { startTime: 1 } },
    { externalId: 'legacy-deleted', title: 'Legacy, message deleted', data: { startTime: 2 } },
    { externalId: 'legacy-waiting', title: 'Legacy, ingest not done', data: { startTime: 3 } },
  ])
  const id = (externalId: string): number => db.getItemByExternalId('wt-replays', externalId)!.id
  db.markAnnouncePending(id('legacy-expired'), 'message-1')
  db.markAnnouncePending(id('legacy-deleted'), 'message-2')
  db.markAnnouncePending(id('legacy-waiting'), 'message-3')
  db.markBattleIngest('legacy-expired', 'expired')
  db.markBattleIngest('legacy-deleted', 'expired')
  const baseline = id('legacy-waiting')
  db.setBotState('battles:lastAnnouncedId', String(baseline))
  assert.equal(db.getPendingAnnounce(baseline, 3, 10).length, 0, 'the tick query never sees them')

  const edits: [string, unknown][] = []
  const channel = {
    isSendable: () => true,
    send: async () => {
      throw new Error('a legacy message is finished in place, never posted anew')
    },
    messages: {
      fetch: async (messageId: string) => {
        if (messageId === 'message-2') {
          throw new DiscordAPIError(
            { code: RESTJSONErrorCodes.UnknownMessage, message: 'Unknown Message' },
            RESTJSONErrorCodes.UnknownMessage,
            404,
            'GET',
            '/channels/test-channel/messages/message-2',
            {},
          )
        }
        return { edit: async (payload: { content?: string }) => edits.push([messageId, payload.content]) }
      },
    },
  }
  const client = { channels: { fetch: async () => channel } } as unknown as Client

  const unfinished = (): string[] => db.getUnfinishedAnnounceMessages(baseline, 3).map((item) => item.externalId)
  const settle = async (expected: string[]): Promise<void> => {
    for (let i = 0; i < 100 && unfinished().join() !== expected.join(); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(unfinished(), expected)
  }

  try {
    startBattleAnnouncer(client)
    await settle(['legacy-waiting'])
    assert.deepEqual(edits, [['message-1', 'The replay could not be parsed.\nMatch ID: `legacy-expired`']])

    // The waiting one stays queued in memory and is finished by a later tick.
    db.markBattleIngest('legacy-waiting', 'expired')
    emitBattleLifecycle({ kind: 'committed', sessionId: 'legacy-waiting' })
    await settle([])
    assert.deepEqual(edits.map(([messageId]) => messageId), ['message-1', 'message-3'])
  } finally {
    await stopBattleAnnouncer()
    db.closeDb()
  }
})
