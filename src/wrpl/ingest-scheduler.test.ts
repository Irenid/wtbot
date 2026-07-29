import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldContinueIngestImmediately } from './ingest-scheduler.js'

test('ingest scheduler drains immediately only after a full batch made progress', () => {
  assert.equal(shouldContinueIngestImmediately(7, 14, ['ok'], false), false)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['ok', 'expired'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['error'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['deferred', 'cancelled'], false), false)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['deferred', 'ok'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['ok'], true), false)
})
