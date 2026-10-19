import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getItemByExternalId,
  getPendingAnnounce,
  initDb,
  markAnnounce,
  nextAnnounceBaseline,
  saveItems,
  skipStaleAnnounce,
} from './index.js'

test('announce queue retries a failed battle and processes newest first', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [
      { externalId: '1', title: 'one', data: {} },
      { externalId: '2', title: 'two', data: {} },
    ])

    const first = getPendingAnnounce(0, 3, 2)
    assert.deepEqual(first.map((item) => item.externalId), ['2', '1'])

    const newest = getItemByExternalId('wt-replays', '2')
    assert.ok(newest)
    markAnnounce(newest.id, 'failed', 'network')

    const failed = getPendingAnnounce(0, 3, 2).find((item) => item.externalId === '2')
    assert.equal(failed?.announceStatus, 'failed')
    assert.equal(failed?.announceAttempts, 1)

    markAnnounce(newest.id, 'ok')
    assert.deepEqual(getPendingAnnounce(0, 3, 2).map((item) => item.externalId), ['1'])
    assert.equal(nextAnnounceBaseline(0, 3), 0)
  } finally {
    closeDb()
  }
})

test('stale battles are resolved unposted, failed ones too', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [
      { externalId: 'old', title: 'old', data: { startTime: 1_000 } },
      { externalId: 'old-failed', title: 'old-failed', data: { startTime: 1_100 } },
      { externalId: 'fresh', title: 'fresh', data: { startTime: 9_000 } },
      { externalId: 'no-time', title: 'no-time', data: {} },
    ])
    const id = (externalId: string) => getItemByExternalId('wt-replays', externalId)!.id
    markAnnounce(id('old-failed'), 'failed', 'network')

    assert.equal(skipStaleAnnounce(0, 3, 5_000), 2)
    assert.deepEqual(
      getPendingAnnounce(0, 3, 10).map((item) => item.externalId).sort(),
      ['fresh', 'no-time'],
    )
    // A repeat changes nothing.
    assert.equal(skipStaleAnnounce(0, 3, 5_000), 0)
  } finally {
    closeDb()
  }
})

test('announce queue stops retrying after the configured failure limit', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [{ externalId: '3', title: 'three', data: {} }])
    const item = getItemByExternalId('wt-replays', '3')
    assert.ok(item)

    markAnnounce(item.id, 'failed', 'one')
    markAnnounce(item.id, 'failed', 'two')
    assert.equal(getPendingAnnounce(0, 3, 1).length, 1)
    markAnnounce(item.id, 'failed', 'three')
    assert.equal(getPendingAnnounce(0, 3, 1).length, 0)
    assert.equal(nextAnnounceBaseline(0, 3), item.id)
  } finally {
    closeDb()
  }
})
