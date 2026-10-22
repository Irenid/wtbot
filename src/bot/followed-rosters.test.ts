import assert from 'node:assert/strict'
import test from 'node:test'

// Read by config.ts at import: this file runs in its own process.
process.env['WT_BATTLES_CHANNEL'] = ''
process.env['WT_SCOUT_CHANNEL'] = ''
process.env['WT_VOICE_CHANNELS'] = ''

const db = await import('../db/index.js')
const { followedSquadrons, refreshFollowedRosters, startFollowedRosters, stopFollowedRosters } = await import('./followed-rosters.js')

test('the followed squadrons are every server\'s battles filter, stats pair and platoon squadron, each once', () => {
  db.initDb(':memory:', { allowCreate: true })
  try {
    db.addGuildChannel({ kind: 'battles', guildId: 'g', channelId: 'all', clan: '' })
    db.addGuildChannel({ kind: 'battles', guildId: 'g', channelId: 'ours', clan: 'wlily' })
    db.addGuildChannel({ kind: 'battles', guildId: 'h', channelId: 'theirs', clan: 'avr' })
    db.setBotState('squadron-stats:g', JSON.stringify({ clan: 'wlily', placeId: 'p', pointsId: 'q' }))
    db.setBotState('platoons:h', JSON.stringify({ settings: { lobbyId: 'l', clan: 'tor1', channelId: null }, messageId: null }))
    db.setBotState('platoons:broken', 'not json')
    assert.deepEqual(followedSquadrons().sort(), ['avr', 'tor1', 'wlily'])
  } finally {
    db.closeDb()
  }
})

test('a pass reads each known squadron, skips unknown ones and goes on after a failure', async () => {
  const read: string[][] = []
  const warn = console.warn
  console.warn = () => undefined
  try {
    await refreshFollowedRosters({
      squadrons: () => ['wlily', 'gone', 'avr', 'tor1'],
      tagsOf: (core) => (core === 'gone' ? [] : [`=${core.toUpperCase()}=`]),
      fetchRatings: async (tags) => {
        read.push(tags)
        if (tags[0] === '=AVR=') throw new Error('down')
      },
    })
  } finally {
    console.warn = warn
  }
  assert.deepEqual(read, [['=WLILY='], ['=AVR='], ['=TOR1=']])
})

test('start runs a pass after its delay and never overlaps one; stop waits for it and ends the timer', async () => {
  let release: () => void = () => undefined
  let calls = 0
  startFollowedRosters({
    squadrons: () => ['wlily'],
    tagsOf: () => ['=WLILY='],
    fetchRatings: () => {
      calls++
      return new Promise<void>((resolve) => { release = resolve })
    },
  }, 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1)
  const stopped = stopFollowedRosters()
  let done = false
  void stopped.then(() => { done = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false, 'stop waits for the running pass')
  release()
  await stopped
  assert.equal(calls, 1)
})
