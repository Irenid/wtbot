import assert from 'node:assert/strict'
import test from 'node:test'
import { IngestAdmissionController } from './ingest-admission.js'

const cleanPressure = {
  retries: 0,
  rateLimited429: 0,
  server5xx: 0,
  processBudgetWaitMs: 0,
  processBudgetQueuedCount: 0,
  processBudgetUsedBytes: 0,
  processBudgetLimitBytes: 384 * 1024 * 1024,
}

test('adaptive admission halves on new network pressure and respects cooldown', () => {
  const controller = new IngestAdmissionController(8, true, 0)
  controller.observeReplay({ ...cleanPressure, rateLimited429: 1 }, 1)
  assert.equal(controller.concurrency(), 4)
  assert.equal(controller.snapshot().reason, 'network-pressure')

  controller.observeReplay({ ...cleanPressure, rateLimited429: 2 }, 10_000)
  assert.equal(controller.concurrency(), 4)

  controller.observeReplay({ ...cleanPressure, rateLimited429: 3 }, 30_001)
  assert.equal(controller.concurrency(), 2)
  assert.equal(controller.snapshot().minConcurrency, 2)
})

test('adaptive admission restores one slot only after stable cooldown', () => {
  const controller = new IngestAdmissionController(8, true, 0)
  controller.observeReplay({ ...cleanPressure, processBudgetWaitMs: 6_000 }, 1)
  assert.equal(controller.concurrency(), 4)

  controller.observeReplay({ ...cleanPressure, processBudgetWaitMs: 12_000 }, 30_001)
  assert.equal(controller.concurrency(), 2)
  for (let sample = 1; sample <= 8; sample += 1) {
    controller.observeReplay(cleanPressure, 120_000 + sample * 15_000)
  }
  assert.equal(controller.concurrency(), 3)
  assert.equal(controller.snapshot().increases, 1)
})

test('pressure at minimum concurrency restarts the recovery interval', () => {
  const controller = new IngestAdmissionController(8, true, 0)
  controller.observeReplay({ ...cleanPressure, rateLimited429: 1 }, 1)
  controller.observeReplay({ ...cleanPressure, rateLimited429: 2 }, 30_001)
  controller.observeReplay({ ...cleanPressure, rateLimited429: 3 }, 60_002)
  assert.equal(controller.concurrency(), 2)

  for (let sample = 1; sample <= 8; sample += 1) {
    controller.observeReplay(cleanPressure, 60_002 + sample * 5_000)
  }
  assert.equal(controller.concurrency(), 2)
  controller.observeReplay(cleanPressure, 180_003)
  assert.equal(controller.concurrency(), 3)
  assert.equal(controller.snapshot().lastPressureAtMs, 60_002)
})

test('pressure reason remains observable through the decrease cooldown', () => {
  const controller = new IngestAdmissionController(8, true, 0)
  controller.observePersist(1_000, 1)
  controller.observeReplay(cleanPressure, 2)
  assert.equal(controller.snapshot().reason, 'persist-pressure')

  controller.observeReplay(cleanPressure, 30_002)
  assert.equal(controller.snapshot().reason, 'stable')
})

test('adaptive admission normalizes invalid configured concurrency', () => {
  const controller = new IngestAdmissionController(0, true, 0)
  assert.equal(controller.concurrency(), 1)
  assert.equal(controller.snapshot().minConcurrency, 1)
  assert.equal(controller.snapshot().maxConcurrency, 1)
})

test('disabled admission preserves configured concurrency', () => {
  const controller = new IngestAdmissionController(8, false, 0)
  controller.observeReplay({ ...cleanPressure, rateLimited429: 100 }, 1)
  controller.observePersist(10_000, 2)
  assert.equal(controller.concurrency(), 8)
  assert.equal(controller.snapshot().reason, 'disabled')
})
