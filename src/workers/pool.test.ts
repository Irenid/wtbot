import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { mock } from 'node:test'
import {
  BACKGROUND_MAX_WAIT_MS,
  CpuWorkerPool,
  MAX_QUEUE,
  MAX_RENDER_JOBS_PER_WORKER,
  MAX_STARTUP_FAILURES,
  WorkerPoolError,
  type PoolWorker,
  type WorkerPriority,
} from './pool.js'
import type { WorkerRequest, WorkerTaskKind } from './protocol.js'

/** A worker that becomes ready and answers only when the test says so. */
class FakeWorker extends EventEmitter implements PoolWorker {
  readonly posted: WorkerRequest[] = []
  terminated = false
  constructor(readonly name: string) {
    super()
  }
  postMessage(request: WorkerRequest): void {
    this.posted.push(request)
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
  ready(): void {
    this.emit('message', { type: 'ready' })
  }
  /** Answers the latest request this worker got. */
  answer(value: unknown = 'done'): void {
    const request = this.posted.at(-1)
    assert.ok(request, `${this.name} has no request to answer`)
    this.emit('message', {
      type: 'result',
      response: { id: request.id, ok: true, value, timing: { receivedAtMs: 0, completedAtMs: 0, outputTransferBytes: 0 } },
    })
  }
  kinds(): string[] {
    return this.posted.map((request) => request.task.kind)
  }
}

interface Harness {
  pool: CpuWorkerPool
  workers: FakeWorker[]
  /** Submits a task of `kind`; its label is recorded in `finished` when it resolves. */
  run(kind: WorkerTaskKind, priority: WorkerPriority, options?: { timeoutMs?: number; transferBytes?: number; signal?: AbortSignal }): Promise<unknown>
  finished: string[]
}

function harness(size: number, backgroundReserveSlots = 0, extra: { maxQueuedTransferBytes?: number; failStarts?: number } = {}): Harness {
  const workers: FakeWorker[] = []
  let failures = extra.failStarts ?? 0
  const pool = new CpuWorkerPool({
    size,
    backgroundReserveSlots,
    maxQueuedTransferBytes: extra.maxQueuedTransferBytes,
    now: () => Date.now(),
    createWorker: (name) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('spawn failed')
      }
      const worker = new FakeWorker(name)
      workers.push(worker)
      return worker
    },
  })
  const finished: string[] = []
  return {
    pool,
    workers,
    finished,
    run(kind, priority, options = {}) {
      const transferList = options.transferBytes === undefined ? [] : [new ArrayBuffer(options.transferBytes)]
      const promise = pool.run({ kind, input: {} } as never, {
        priority,
        transferList,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      promise.then(() => finished.push(`${priority}:${kind}`), () => undefined)
      return promise
    },
  }
}

/** Lets settled promises and `finally` callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function withTimers(body: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: performance.timeOrigin + performance.now() })
  try {
    await body()
  } finally {
    mock.timers.reset()
  }
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof WorkerPoolError ? error.code : (error as Error).name
  }
  return 'resolved'
}

test('one worker takes interactive, then normal, then background work', () => withTimers(async () => {
  const { pool, workers, run, finished } = harness(1)
  void run('warm-sqlite', 'normal')
  workers[0]!.ready()
  void run('db-maintenance', 'background')
  void run('read-site-dashboard-stats', 'normal')
  void run('read-player-insights', 'interactive')
  for (let i = 0; i < 4; i += 1) {
    workers[0]!.answer()
    await flush()
  }
  assert.deepEqual(finished, [
    'normal:warm-sqlite',
    'interactive:read-player-insights',
    'normal:read-site-dashboard-stats',
    'background:db-maintenance',
  ])
  await pool.close(0)
}))

test('background work that waited BACKGROUND_MAX_WAIT_MS goes before newer interactive work on one worker', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  void run('warm-sqlite', 'normal')
  workers[0]!.ready()
  void run('db-maintenance', 'background')
  mock.timers.tick(BACKGROUND_MAX_WAIT_MS)
  void run('read-player-insights', 'interactive')
  workers[0]!.answer()
  await flush()
  assert.deepEqual(workers[0]!.kinds(), ['warm-sqlite', 'db-maintenance'])
  await pool.close(0)
}))

test('background work never takes the slots reserved for interactive work', () => withTimers(async () => {
  const { pool, workers, run } = harness(3, 1)
  void run('warm-sqlite', 'normal')
  for (const worker of workers) worker.ready()
  // Three workers, one reserved: beside the normal job two background jobs run, the third waits.
  for (let i = 0; i < 3; i += 1) void run('db-maintenance', 'background')
  const running = (kind: string) => workers.filter((worker) => worker.kinds().at(-1) === kind && !worker.terminated)
  assert.equal(running('db-maintenance').length, 2)
  const normal = running('warm-sqlite')[0]!
  normal.answer()
  await flush()
  assert.equal(normal.posted.length, 1, 'the freed worker stays free for interactive work')
  assert.equal(pool.snapshot().current.queued, 1)
  void run('read-player-insights', 'interactive')
  assert.equal(normal.kinds().at(-1), 'read-player-insights', 'interactive work starts at once')
  await pool.close(0)
}))

test('with two workers a waiting background job gets the next free one before queued normal work', () => withTimers(async () => {
  const { pool, workers, run } = harness(2, 1)
  void run('read-player-insights', 'interactive')
  for (const worker of workers) worker.ready()
  void run('read-player-insights', 'interactive')
  void run('read-site-dashboard-stats', 'normal')
  void run('db-maintenance', 'background')
  workers[0]!.answer()
  await flush()
  assert.equal(workers[0]!.kinds().at(-1), 'db-maintenance')
  await pool.close(0)
}))

test('a full queue, too many queued bytes and a task over the byte cap are refused', () => withTimers(async () => {
  const { pool, run } = harness(1, 0, { maxQueuedTransferBytes: 1_000 })
  // The fake worker never becomes ready: everything stays queued.
  assert.equal(await rejectionCode(run('warm-sqlite', 'normal', { transferBytes: 1_001 })), 'TASK_TOO_LARGE')
  const held = run('warm-sqlite', 'normal', { transferBytes: 600 })
  assert.equal(await rejectionCode(run('warm-sqlite', 'normal', { transferBytes: 600 })), 'QUEUE_MEMORY')
  const queued = [held]
  while (queued.length < MAX_QUEUE) queued.push(run('warm-sqlite', 'normal'))
  assert.equal(await rejectionCode(run('warm-sqlite', 'normal')), 'QUEUE_FULL')
  assert.equal(pool.snapshot().cumulative.rejected, 3)
  await pool.close(0)
  for (const promise of queued) assert.equal(await rejectionCode(promise), 'Error')
}))

test('the timeout covers the queue: a job that never got a worker fails with QUEUE_TIMEOUT', () => withTimers(async () => {
  const { pool, run } = harness(1)
  const job = run('warm-sqlite', 'interactive', { timeoutMs: 1_000 })
  mock.timers.tick(999)
  await flush()
  mock.timers.tick(1)
  assert.equal(await rejectionCode(job), 'QUEUE_TIMEOUT')
  await pool.close(0)
}))

test('a job past its timeout fails with EXEC_TIMEOUT and its worker is replaced', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  const job = run('warm-sqlite', 'normal', { timeoutMs: 500 })
  workers[0]!.ready()
  assert.equal(workers[0]!.posted.length, 1)
  mock.timers.tick(500)
  assert.equal(await rejectionCode(job), 'EXEC_TIMEOUT')
  assert.equal(workers[0]!.terminated, true)
  await flush()
  void run('warm-sqlite', 'normal')
  assert.equal(workers.length, 2, 'the next job starts a new worker')
  assert.equal(pool.snapshot().recycleReasons['EXEC_TIMEOUT'], 1)
  await pool.close(0)
}))

test('a render worker is recycled after MAX_RENDER_JOBS_PER_WORKER jobs', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  void run('render-media-kind', 'interactive')
  workers[0]!.ready()
  for (let i = 1; i <= MAX_RENDER_JOBS_PER_WORKER; i += 1) {
    if (i > 1) void run('render-media-kind', 'interactive')
    workers[0]!.answer()
    await flush()
    assert.equal(workers[0]!.terminated, i === MAX_RENDER_JOBS_PER_WORKER, `after ${i} renders`)
  }
  assert.equal(pool.snapshot().recycleReasons['RENDER_RECYCLE'], 1)
  await pool.close(0)
}))

test('a promoted background job runs before queued normal work', () => withTimers(async () => {
  const workers: FakeWorker[] = []
  const pool = new CpuWorkerPool({ size: 1, backgroundReserveSlots: 0, createWorker: (name) => { const worker = new FakeWorker(name); workers.push(worker); return worker } })
  const settle = (promise: Promise<unknown>) => promise.catch(() => undefined)
  void settle(pool.run({ kind: 'warm-sqlite', input: {} } as never, { priority: 'normal' }))
  workers[0]!.ready()
  void settle(pool.run({ kind: 'read-site-dashboard-stats', input: {} } as never, { priority: 'normal' }))
  let control: { promote(priority: WorkerPriority): void } | undefined
  void settle(pool.run({ kind: 'db-maintenance', input: {} } as never, { priority: 'background', onControl: (value) => { control = value } }))
  control!.promote('interactive')
  workers[0]!.answer()
  await flush()
  assert.deepEqual(workers[0]!.kinds(), ['warm-sqlite', 'db-maintenance'])
  // A demotion is ignored.
  control!.promote('background')
  assert.equal(pool.snapshot().workloads.find((workload) => workload.kind === 'db-maintenance')?.priority, 'interactive')
  await pool.close(0)
}))

test('a worker that exits mid-job fails the job, and queued work gets a new worker', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  const job = run('warm-sqlite', 'normal')
  workers[0]!.ready()
  const next = run('read-site-dashboard-stats', 'normal')
  workers[0]!.emit('exit', 1)
  assert.equal(await rejectionCode(job), 'Error')
  await flush()
  mock.timers.tick(0)
  assert.equal(workers.length, 2)
  workers[1]!.ready()
  assert.deepEqual(workers[1]!.kinds(), ['read-site-dashboard-stats'])
  workers[1]!.answer('second')
  assert.equal(await next, 'second')
  assert.equal(pool.snapshot().recycleReasons['WORKER_EXIT'], 1)
  await pool.close(0)
}))

test('a worker that cannot start is retried with backoff, then queued work fails with STARTUP_FAILED', () => withTimers(async () => {
  const { pool, run, workers } = harness(1, 0, { failStarts: MAX_STARTUP_FAILURES })
  const job = run('warm-sqlite', 'normal')
  mock.timers.tick(100)
  await flush()
  mock.timers.tick(200)
  assert.equal(await rejectionCode(job), 'STARTUP_FAILED')
  assert.equal(workers.length, 0)
  // The next submission starts afresh and succeeds.
  const later = run('warm-sqlite', 'normal')
  workers[0]!.ready()
  workers[0]!.answer('ok')
  assert.equal(await later, 'ok')
  await pool.close(0)
}))

test('an aborted job leaves the queue; one aborted while running retires its worker', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  const running = new AbortController()
  const job = run('warm-sqlite', 'normal', { signal: running.signal })
  workers[0]!.ready()
  const queuedAbort = new AbortController()
  const queued = run('db-maintenance', 'background', { signal: queuedAbort.signal })
  queuedAbort.abort()
  assert.equal(await rejectionCode(queued), 'AbortError')
  assert.equal(workers[0]!.terminated, false)
  running.abort()
  assert.equal(await rejectionCode(job), 'AbortError')
  assert.equal(workers[0]!.terminated, true)
  await pool.close(0)
}))

test('close refuses queued work, lets a running job finish within the grace and stops the workers', () => withTimers(async () => {
  const { pool, workers, run } = harness(1)
  const running = run('warm-sqlite', 'normal')
  workers[0]!.ready()
  const queued = run('db-maintenance', 'background')
  const closing = pool.close(1_000)
  assert.equal(await rejectionCode(queued), 'Error')
  workers[0]!.answer('finished in time')
  assert.equal(await running, 'finished in time')
  await closing
  assert.equal(workers[0]!.terminated, true)
  assert.equal(await rejectionCode(run('warm-sqlite', 'normal')), 'POOL_CLOSED')
}))
