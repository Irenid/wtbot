import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AsyncByteBudget } from './byte-budget.js'
import {
  fetchReplayPartsRetained,
  isReplayByteBudgetSchedulingError,
  type ReplayPartsTiming,
} from './replay-events.js'
import { configureReplayUrlPolicy } from './replay-url-policy.js'

// Локальный HTTP-сервер теста: http и 127.0.0.1 разрешены только явной инъекцией.
configureReplayUrlPolicy({ allowInsecureForTests: true })

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
    const budget = new AsyncByteBudget(fixture.byteLength * 4)
    const timings: ReplayPartsTiming[] = []
    const retained = await fetchReplayPartsRetained(
      [`${base}/0000.wrpl`, `${base}/0001.wrpl`],
      undefined,
      {
        cacheDirectory: null,
        concurrency: 2,
        processByteBudget: budget,
        exactProcessReservation: true,
        onTiming: (value) => { timings.push(value) },
      },
    )
    const timing = timings[0]
    assert.ok(timing)
    assert.equal(retained.parts.length, 2)
    assert.equal(budget.snapshot().usedBytes, fixture.byteLength * 2)
    assert.equal(budget.snapshot().highWaterUsedBytes, fixture.byteLength * 2)
    assert.equal(timing.processBudgetLimitBytes, fixture.byteLength * 4)
    assert.equal(timing.processBudgetPeakBytes, budget.snapshot().highWaterUsedBytes)
    retained.release()
    assert.equal(budget.snapshot().usedBytes, 0)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('exact reservation uses cached file size and retains it until release', async () => {
  const fixture = replayPartFixture()
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'wtbot-replay-budget-'))
  const session = '0123456789ab'
  const sessionDirectory = path.join(cacheDirectory, session)
  await mkdir(sessionDirectory)
  await writeFile(path.join(sessionDirectory, '0000.wrpl'), fixture)
  const budget = new AsyncByteBudget(fixture.byteLength)
  const timings: ReplayPartsTiming[] = []
  try {
    const retained = await fetchReplayPartsRetained(
      [`http://cache.invalid/${session}/0000.wrpl`],
      undefined,
      {
        cacheDirectory,
        processByteBudget: budget,
        exactProcessReservation: true,
        onTiming: (value) => { timings.push(value) },
      },
    )
    assert.equal(retained.parts[0]?.byteLength, fixture.byteLength)
    assert.equal(timings[0]?.cacheHits, 1)
    assert.equal(budget.snapshot().usedBytes, fixture.byteLength)
    assert.equal(budget.snapshot().highWaterUsedBytes, fixture.byteLength)
    retained.release()
    assert.equal(budget.snapshot().usedBytes, 0)
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true })
  }
})

test('process budget timeout releases partial state and is retry-neutral', async () => {
  const fixture = replayPartFixture()
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-length': fixture.byteLength })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const budget = new AsyncByteBudget(128 * MIB)
  const held = await budget.acquire(128 * MIB)
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await assert.rejects(
      fetchReplayPartsRetained(
        [`http://127.0.0.1:${address.port}/0000.wrpl`],
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
    assert.ok(budget.snapshot().waitMs.total >= 4)
    assert.equal(budget.snapshot().usedBytes, 128 * MIB)
    assert.equal(requests, 0, 'rollback mode must acquire worst-case budget before network I/O')
  } finally {
    held.release()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
  assert.equal(budget.snapshot().usedBytes, 0)
})

test('exact reservation waits after trusted headers and releases failed admission', async () => {
  const fixture = replayPartFixture()
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-length': fixture.byteLength })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const budget = new AsyncByteBudget(fixture.byteLength * 2)
  const held = await budget.acquire(budget.limitBytes)
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await assert.rejects(
      fetchReplayPartsRetained(
        [`http://127.0.0.1:${address.port}/0000.wrpl`],
        undefined,
        {
          cacheDirectory: null,
          processByteBudget: budget,
          processBudgetTimeoutMs: 5,
          exactProcessReservation: true,
        },
      ),
      (error) => isReplayByteBudgetSchedulingError(error),
    )
    assert.equal(requests, 1)
    assert.equal(budget.snapshot().queuedCount, 0)
    assert.equal(budget.snapshot().timedOut, 1)
    assert.equal(budget.snapshot().usedBytes, budget.limitBytes)
  } finally {
    held.release()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
  assert.equal(budget.snapshot().usedBytes, 0)
})

test('429 Retry-After pauses the shared replay fetch limiter', async () => {
  const fixture = replayPartFixture()
  const requestTimes: number[] = []
  let rateLimited = true
  const server = createServer((_request, response) => {
    requestTimes.push(Date.now())
    if (rateLimited) {
      rateLimited = false
      response.writeHead(429, { 'retry-after': '0.3' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-length': fixture.byteLength })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const retained = await fetchReplayPartsRetained(
      [
        `http://127.0.0.1:${address.port}/0000.wrpl`,
        `http://127.0.0.1:${address.port}/0001.wrpl`,
      ],
      undefined,
      {
        cacheDirectory: null,
        concurrency: 2,
        processByteBudget: new AsyncByteBudget(fixture.byteLength * 4),
        exactProcessReservation: true,
      },
    )
    retained.release()
    assert.ok(requestTimes.length >= 3)
    assert.ok(requestTimes[1]! - requestTimes[0]! >= 250)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

function replayPartFixture(): Buffer {
  const part = Buffer.alloc(1_234)
  part[0] = 0xe5
  part[1] = 0xac
  part[2] = 0x00
  part[3] = 0x10
  return part
}
