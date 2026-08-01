import assert from 'node:assert/strict'
import test from 'node:test'
import type { Client } from 'discord.js'

test('автоанонс не отправляет текст до завершения ingest', async () => {
  process.env['TOKEN'] ??= 'test-token'
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
      throw new Error('предварительный анонс не должен отправляться')
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
      title: 'Новый неразобранный бой',
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
