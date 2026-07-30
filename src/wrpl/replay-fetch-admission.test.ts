import assert from 'node:assert/strict'
import test from 'node:test'
import { ReplayFetchAdmission } from './replay-fetch-admission.js'

test('replay fetch admission increases multiplicatively on 429', () => {
  const admission = new ReplayFetchAdmission(150, 2_000, true)
  admission.recordRateLimit()
  assert.equal(admission.intervalMs(), 200)
  admission.recordRateLimit()
  assert.equal(admission.intervalMs(), 250)
  assert.equal(admission.snapshot().rateLimitEvents, 2)
})

test('replay fetch admission recovers slowly after stable successes', () => {
  const admission = new ReplayFetchAdmission(150, 2_000, true)
  admission.recordRateLimit()
  admission.recordRateLimit()
  for (let index = 0; index < 31; index += 1) admission.recordSuccess()
  assert.equal(admission.intervalMs(), 250)
  admission.recordSuccess()
  assert.equal(admission.intervalMs(), 225)
  for (let index = 0; index < 320; index += 1) admission.recordSuccess()
  assert.ok(admission.intervalMs() >= 150)
})

test('disabled replay fetch admission preserves baseline interval', () => {
  const admission = new ReplayFetchAdmission(150, 2_000)
  admission.recordRateLimit()
  assert.equal(admission.intervalMs(), 150)
  assert.equal(admission.snapshot().rateLimitEvents, 1)

  admission.setEnabled(true)
  admission.recordRateLimit()
  assert.equal(admission.intervalMs(), 200)

  admission.setEnabled(false)
  assert.equal(admission.intervalMs(), 150)
  assert.equal(admission.snapshot().enabled, false)
})
