import assert from 'node:assert/strict'
import test from 'node:test'
import { workerResourcePlan } from './runtime-options.js'

test('auto resource plan jointly budgets workers and retained replay bytes', () => {
  const plan = workerResourcePlan({
    env: {},
    availableCpus: 12,
    totalMemoryMb: 16_334,
    freeMemoryMb: 4_127,
  })

  assert.equal(plan.reservedMemoryMb, 2_450)
  assert.equal(plan.estimatedWorkerMemoryMb, 320)
  assert.equal(plan.memoryLimitedThreads, 4)
  assert.equal(plan.workerThreads, 4)
  assert.equal(plan.backgroundWorkerThreads, 3)
  assert.equal(plan.ingestConcurrency, 3)
  assert.equal(plan.replayProcessByteBudgetMb, 397)
  assert.ok(
    plan.workerThreads * plan.estimatedWorkerMemoryMb + plan.replayProcessByteBudgetMb <=
      plan.freeMemoryMb - plan.reservedMemoryMb,
  )
})

test('explicit worker estimate preserves conservative auto sizing', () => {
  const plan = workerResourcePlan({
    env: { WT_WORKER_ESTIMATED_MB: '640' },
    availableCpus: 12,
    totalMemoryMb: 16_334,
    freeMemoryMb: 4_127,
  })

  assert.equal(plan.workerThreads, 2)
  assert.equal(plan.backgroundWorkerThreads, 1)
  assert.equal(plan.replayProcessByteBudgetMb, 397)
})

test('explicit worker and replay settings remain authoritative', () => {
  const plan = workerResourcePlan({
    env: {
      WT_WORKER_THREADS: '8',
      WT_REPLAY_PROCESS_BUDGET_MB: '1024',
    },
    availableCpus: 12,
    totalMemoryMb: 16_334,
    freeMemoryMb: 4_127,
  })

  assert.equal(plan.workerThreads, 8)
  assert.equal(plan.replayProcessByteBudgetMb, 1_024)
})
