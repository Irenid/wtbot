import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SQLITE_CHECKPOINT_COMMIT_INTERVAL,
  SQLITE_CHECKPOINT_INTERVAL_MS,
  SqliteCheckpointSchedule,
} from './sqlite-checkpoint.js'

test('SQLite checkpoint schedule batches commits', () => {
  const schedule = new SqliteCheckpointSchedule(1_000)
  for (let index = 1; index < SQLITE_CHECKPOINT_COMMIT_INTERVAL; index += 1) {
    assert.equal(schedule.recordCommit(1_000 + index), false)
  }
  assert.equal(schedule.recordCommit(2_000), true)
  schedule.markCheckpoint(2_000)
  assert.deepEqual(schedule.snapshot(), {
    commitsSinceCheckpoint: 0,
    lastCheckpointAtMs: 2_000,
  })
})

test('SQLite checkpoint schedule triggers on elapsed time', () => {
  const schedule = new SqliteCheckpointSchedule(5_000)
  assert.equal(schedule.recordCommit(5_001), false)
  assert.equal(schedule.isDue(5_000 + SQLITE_CHECKPOINT_INTERVAL_MS - 1), false)
  assert.equal(schedule.isDue(5_000 + SQLITE_CHECKPOINT_INTERVAL_MS), true)
})
