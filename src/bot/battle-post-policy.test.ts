import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_WINNER_UPDATE_BYTES,
  MAX_WINNER_UPDATES,
  battleAnnouncementDecision,
  canAdmitWinnerUpdate,
  shouldQueueWinnerUpdate,
} from './battle-post-policy.js'

test('battle announcement waits for durable winner data before rendering', () => {
  assert.equal(battleAnnouncementDecision(false, null, 3), 'wait')
  assert.equal(battleAnnouncementDecision(false, { status: 'error', attempts: 2 }, 3), 'wait')
  assert.equal(battleAnnouncementDecision(true, null, 3), 'send')
})

test('battle announcement skips terminal ingest failures', () => {
  assert.equal(battleAnnouncementDecision(false, { status: 'ok', attempts: 1 }, 3), 'skip')
  assert.equal(battleAnnouncementDecision(false, { status: 'expired', attempts: 1 }, 3), 'skip')
  assert.equal(battleAnnouncementDecision(false, { status: 'no_parts', attempts: 1 }, 3), 'skip')
  assert.equal(battleAnnouncementDecision(false, { status: 'error', attempts: 3 }, 3), 'skip')
})

test('winner update is queued only while both durable summaries are absent', () => {
  assert.equal(shouldQueueWinnerUpdate(false, false), true)
  assert.equal(shouldQueueWinnerUpdate(true, false), false)
  assert.equal(shouldQueueWinnerUpdate(false, true), false)
  assert.equal(shouldQueueWinnerUpdate(true, true), false)
})

test('winner update admission is bounded by count and estimated retained bytes', () => {
  assert.equal(canAdmitWinnerUpdate(0, 0, 1), true)
  assert.equal(canAdmitWinnerUpdate(MAX_WINNER_UPDATES, 0, 1), false)
  assert.equal(canAdmitWinnerUpdate(0, MAX_WINNER_UPDATE_BYTES, 1), false)
  assert.equal(canAdmitWinnerUpdate(0, 0, MAX_WINNER_UPDATE_BYTES + 1), false)
  assert.equal(
    canAdmitWinnerUpdate(1, MAX_WINNER_UPDATE_BYTES - 4, 4),
    true,
  )
})
