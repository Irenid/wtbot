import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AsyncByteBudget,
  ByteBudgetOversizeError,
  ByteBudgetTimeoutError,
} from './byte-budget.js'

test('byte budget enforces the hard cap and releases shrink delta', async () => {
  const budget = new AsyncByteBudget(100)
  const first = await budget.acquire(80)
  assert.equal(budget.snapshot().usedBytes, 80)
  first.shrinkTo(30)
  assert.equal(first.bytes, 30)
  assert.equal(budget.snapshot().usedBytes, 30)

  const second = await budget.acquire(70)
  assert.equal(budget.snapshot().usedBytes, 100)
  assert.equal(budget.snapshot().highWaterUsedBytes, 100)
  second.release()
  first.release()
  assert.equal(budget.snapshot().usedBytes, 0)
  assert.equal(budget.snapshot().released, 2)
})

test('byte budget keeps FIFO order instead of bypassing a large waiter', async () => {
  const budget = new AsyncByteBudget(100)
  const held = await budget.acquire(80)
  const largePromise = budget.acquire(90)
  const smallPromise = budget.acquire(20)
  assert.equal(budget.snapshot().queuedCount, 2)
  assert.equal(budget.snapshot().queuedBytes, 110)

  held.release()
  const large = await largePromise
  assert.equal(budget.snapshot().usedBytes, 90)
  assert.equal(budget.snapshot().queuedCount, 1)
  large.release()
  const small = await smallPromise
  assert.equal(budget.snapshot().usedBytes, 20)
  small.release()
})

test('byte budget removes aborted and timed-out waiters', async () => {
  const budget = new AsyncByteBudget(100)
  const held = await budget.acquire(100)
  const controller = new AbortController()
  const aborted = budget.acquire(10, { signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted, (error: Error) => error.name === 'AbortError')

  await assert.rejects(
    budget.acquire(10, { timeoutMs: 5 }),
    ByteBudgetTimeoutError,
  )
  assert.equal(budget.snapshot().queuedCount, 0)
  assert.equal(budget.snapshot().aborted, 1)
  assert.equal(budget.snapshot().timedOut, 1)
  held.release()
})

test('byte budget rejects a single reservation larger than its limit', async () => {
  const budget = new AsyncByteBudget(100)
  await assert.rejects(budget.acquire(101), ByteBudgetOversizeError)
  assert.equal(budget.snapshot().usedBytes, 0)
})
