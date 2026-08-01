import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BATTLE_INGEST_MAX_ATTEMPTS,
  closeDb,
  getIngestStats,
  getPendingBattleItems,
  initDb,
  markBattleIngest,
  saveItems,
} from './index.js'

test('ingest stats count only rows still eligible for selection', () => {
  initDb(':memory:', { allowCreate: true })
  try {
    const sessionIds = [
      'unseen-old',
      'unseen-new',
      'retryable',
      'exhausted',
      'expired',
      'no-parts',
    ] as const
    saveItems('wt-replays', sessionIds.map((sessionId) => ({
      externalId: sessionId,
      title: sessionId,
      data: {},
    })))
    for (let attempt = 0; attempt < BATTLE_INGEST_MAX_ATTEMPTS - 1; attempt += 1) {
      markBattleIngest('retryable', 'error', 'retryable')
    }
    for (let attempt = 0; attempt < BATTLE_INGEST_MAX_ATTEMPTS; attempt += 1) {
      markBattleIngest('exhausted', 'error', 'exhausted')
    }
    markBattleIngest('expired', 'expired', 'expired')
    markBattleIngest('no-parts', 'no_parts', 'no parts')

    const stats = getIngestStats()
    const selected = getPendingBattleItems(BATTLE_INGEST_MAX_ATTEMPTS, 100)
    const oldestFirst = getPendingBattleItems(BATTLE_INGEST_MAX_ATTEMPTS, 100, 'oldest')
    assert.equal(stats.pending, 3)
    assert.equal(stats.failed, 4)
    assert.equal(selected.length, stats.pending)
    assert.deepEqual(
      new Set(selected.map((item) => item.externalId)),
      new Set(['unseen-old', 'unseen-new', 'retryable']),
    )
    assert.deepEqual(
      oldestFirst.map((item) => item.externalId),
      ['unseen-old', 'unseen-new', 'retryable'],
    )
  } finally {
    closeDb()
  }
})
