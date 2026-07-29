import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { AsyncByteBudget } from './byte-budget.js'
import { REPLAY_PART_MAX_BYTES } from './replay-cache.js'
import {
  fetchReplayPartsRetained,
  isReplayByteBudgetSchedulingError,
  type ReplayPartsTiming,
} from './replay-events.js'

const MIB = 1024 * 1024

test('retained replay parts hold actual bytes until parse-side release', async () => {
  const fixture = replayPartFixture()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': fixture.byteLength })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const budget = new AsyncByteBudget(REPLAY_PART_MAX_BYTES * 2)
    const timings: ReplayPartsTiming[] = []
    const retained = await fetchReplayPartsRetained(
      [`${base}/0000.wrpl`, `${base}/0001.wrpl`],
      undefined,
      {
        cacheDirectory: null,
        concurrency: 2,
        processByteBudget: budget,
        onTiming: (value) => { timings.push(value) },
      },
    )
    const timing = timings[0]
    assert.ok(timing)
    assert.equal(retained.parts.length, 2)
    assert.equal(budget.snapshot().usedBytes, fixture.byteLength * 2)
    assert.equal(budget.snapshot().highWaterUsedBytes, REPLAY_PART_MAX_BYTES * 2)
    assert.equal(timing.processBudgetLimitBytes, REPLAY_PART_MAX_BYTES * 2)
    assert.equal(timing.processBudgetPeakBytes, REPLAY_PART_MAX_BYTES * 2)
    retained.release()
    assert.equal(budget.snapshot().usedBytes, 0)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('process budget timeout releases partial state and is retry-neutral', async () => {
  const budget = new AsyncByteBudget(128 * MIB)
  const held = await budget.acquire(128 * MIB)
  try {
    await assert.rejects(
      fetchReplayPartsRetained(
        ['http://127.0.0.1:1/never-started.wrpl'],
        undefined,
        {
          cacheDirectory: null,
          processByteBudget: budget,
          processBudgetTimeoutMs: 5,
        },
      ),
      (error) => isReplayByteBudgetSchedulingError(error),
    )
    assert.equal(budget.snapshot().queuedCount, 0)
    assert.equal(budget.snapshot().timedOut, 1)
    assert.equal(budget.snapshot().usedBytes, 128 * MIB)
  } finally {
    held.release()
  }
  assert.equal(budget.snapshot().usedBytes, 0)
})

function replayPartFixture(): Buffer {
  const part = Buffer.alloc(1_234)
  part[0] = 0xe5
  part[1] = 0xac
  part[2] = 0x00
  part[3] = 0x10
  return part
}
