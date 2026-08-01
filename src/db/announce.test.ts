import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getItemByExternalId,
  getPendingAnnounce,
  initDb,
  markAnnounce,
  markAnnouncePending,
  nextAnnounceBaseline,
  saveItems,
} from './index.js'

test('announce queue keeps preliminary message pending and processes newest first', () => {
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
    markAnnouncePending(newest.id, 'message-2')

    const pending = getPendingAnnounce(0, 3, 2).find((item) => item.externalId === '2')
    assert.equal(pending?.announceStatus, 'pending')
    assert.equal(pending?.announceMessageId, 'message-2')
    assert.equal(pending?.announceAttempts, 0)

    markAnnounce(newest.id, 'ok')
    assert.deepEqual(getPendingAnnounce(0, 3, 2).map((item) => item.externalId), ['1'])
    assert.equal(nextAnnounceBaseline(0, 3), 0)
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
