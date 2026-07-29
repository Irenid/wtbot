import assert from 'node:assert/strict'
import test from 'node:test'
import { runBenchmarkLoad } from './benchmark-load.js'

test('closed-loop benchmark respects count and concurrency', async () => {
  let active = 0
  let observedMax = 0
  const result = await runBenchmarkLoad(
    {
      concurrency: 2,
      maxRuns: 5,
      durationMs: null,
      arrivalRatePerSecond: null,
    },
    async (index) => {
      active++
      observedMax = Math.max(observedMax, active)
      await delay(8)
      active--
      return index * 2
    },
  )

  assert.equal(result.mode, 'closed-loop-count')
  assert.equal(result.offeredRuns, 5)
  assert.equal(result.completedRuns, 5)
  assert.equal(result.maxInFlight, 2)
  assert.equal(observedMax, 2)
  assert.equal(result.runLimitReached, true)
  assert.deepEqual(result.runs.map((run) => run.value), [0, 2, 4, 6, 8])
})

test('closed-loop duration admits work until the deadline and then drains it', async () => {
  const result = await runBenchmarkLoad(
    {
      concurrency: 2,
      maxRuns: null,
      durationMs: 30,
      arrivalRatePerSecond: null,
    },
    async (index) => {
      await delay(6)
      return index
    },
  )

  assert.equal(result.mode, 'closed-loop-duration')
  assert.equal(result.durationReached, true)
  assert.equal(result.safetyLimitReached, false)
  assert.ok(result.completedRuns >= 2)
  assert.ok(result.elapsedMs >= 25)
  assert.ok(result.maxInFlight <= 2)
})

test('open-loop benchmark preserves arrivals while concurrency creates measurable wait', async () => {
  const result = await runBenchmarkLoad(
    {
      concurrency: 1,
      maxRuns: 4,
      durationMs: null,
      arrivalRatePerSecond: 200,
    },
    async (index) => {
      await delay(20)
      return index
    },
  )

  assert.equal(result.mode, 'open-loop')
  assert.equal(result.offeredRuns, 4)
  assert.equal(result.completedRuns, 4)
  assert.equal(result.maxInFlight, 1)
  assert.equal(result.runLimitReached, true)
  assert.deepEqual(
    result.runs.map((run) => run.scheduledOffsetMs),
    [0, 5, 10, 15],
  )
  assert.ok(result.runs[3]!.startDelayMs >= 20)
})

test('open-loop benchmark rejects an unbounded schedule', async () => {
  await assert.rejects(
    runBenchmarkLoad(
      {
        concurrency: 1,
        maxRuns: null,
        durationMs: null,
        arrivalRatePerSecond: 1,
      },
      async () => undefined,
    ),
    /требует --duration/,
  )
})

test('benchmark propagates non-Error failures', async () => {
  await assert.rejects(
    runBenchmarkLoad(
      {
        concurrency: 1,
        maxRuns: 1,
        durationMs: null,
        arrivalRatePerSecond: null,
      },
      async () => {
        throw null
      },
    ),
    (error) => error === null,
  )
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
