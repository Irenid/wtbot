import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkerTaskTiming } from '../workers/pool.js'
import type { ReplayPartsTiming } from './replay-events.js'
import { IngestTelemetryAccumulator } from './ingest-telemetry.js'

function replayTiming(
  outcome: ReplayPartsTiming['outcome'] = 'success',
): ReplayPartsTiming {
  return {
    startedAtMs: 1_000,
    completedAtMs: 1_100,
    totalMs: 100,
    outcome,
    requestedParts: 2,
    completedParts: outcome === 'success' ? 2 : 1,
    concurrency: 2,
    peakActive: 2,
    maxTotalBytes: 1_000,
    peakBudgetBytes: 700,
    bytes: 700,
    cacheHits: 1,
    networkParts: 1,
    networkAttempts: 3,
    retries: 1,
    httpErrors: 2,
    slotWaitMs: 15,
    ttfbMs: 45,
    downloadMs: 60,
    retryDelayMs: 20,
    processBudgetWaitMs: 4,
    processBudgetLimitBytes: 1_000,
    processBudgetPeakBytes: 700,
    parts: [
      {
        index: 0,
        label: '0.wrpl',
        startedAtMs: 1_000,
        completedAtMs: 1_020,
        totalMs: 20,
        lockWaitMs: 0,
        cacheHit: true,
        cacheInvalid: false,
        cacheReadMs: 1,
        cacheWriteMs: 0,
        bytes: 200,
        outcome: 'success',
        errorName: null,
        attempts: [],
      },
      {
        index: 1,
        label: '1.wrpl',
        startedAtMs: 1_000,
        completedAtMs: 1_100,
        totalMs: 100,
        lockWaitMs: 0,
        cacheHit: false,
        cacheInvalid: false,
        cacheReadMs: 0,
        cacheWriteMs: 1,
        bytes: 500,
        outcome,
        errorName: outcome === 'success' ? null : 'Error',
        attempts: [
          {
            attempt: 1,
            slotWaitMs: 5,
            ttfbMs: 15,
            downloadMs: 20,
            retryDelayMs: 20,
            status: 429,
            bytes: 0,
          },
          {
            attempt: 2,
            slotWaitMs: 10,
            ttfbMs: 30,
            downloadMs: 40,
            retryDelayMs: 0,
            status: 503,
            bytes: 0,
          },
          {
            attempt: 3,
            slotWaitMs: 0,
            ttfbMs: 8,
            downloadMs: 10,
            retryDelayMs: 0,
            status: 200,
            bytes: 500,
          },
        ],
      },
    ],
  }
}

function workerTiming(): WorkerTaskTiming {
  return {
    kind: 'parse-battle',
    priority: 'background',
    outcome: 'success',
    stage: 'execution',
    reason: 'success',
    coldWorker: false,
    queueMs: 25,
    schedulerWaitMs: 25,
    workerStartupMs: 0,
    inputTransferMs: 2,
    executionMs: 80,
    resultTransferMs: 1,
    totalMs: 108,
    inputTransferBytes: 700,
    outputTransferBytes: 100,
  }
}

test('ingest telemetry tracks the full bounded stage lifecycle', () => {
  let now = 1_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  telemetry.recordSelection([0, 0.5], 4, now)
  const battle = telemetry.beginBattle(0, now)

  now = 1_010
  battle.startDownload(now)
  now = 1_100
  battle.replayReady(replayTiming(), now)
  now = 1_110
  battle.parseSubmitted(700, now)
  now = 1_218
  battle.parseFinished(workerTiming(), now)
  battle.persistQueued(100, now)
  now = 1_230
  battle.persistStarted(now)
  now = 1_250
  battle.persistFinished(now, 20)
  battle.persistTiming(12, 16, 4)
  battle.finish('ok', now)

  const snapshot = telemetry.snapshot(now)
  assert.equal(snapshot.battlesPerMinute, 1)
  assert.equal(snapshot.outcomes.ok, 1)
  assert.equal(snapshot.discoveredToTerminalMs.count, 1)
  assert.equal(snapshot.backlog.saturated, false)
  assert.equal(snapshot.backlog.oldestAgeMs, 1_000)
  assert.equal(snapshot.stages.eligible.waitMs.count, 1)
  assert.equal(snapshot.stages.download.completedBytes, 700)
  assert.equal(snapshot.stages.ready.completedBytes, 700)
  assert.equal(snapshot.stages.parse.waitMs.count, 1)
  assert.equal(snapshot.stages.parse.waitMs.minMs, 25)
  assert.equal(snapshot.stages.parse.activeMs.minMs, 80)
  assert.equal(snapshot.stages.persist.waitMs.minMs, 12)
  assert.equal(snapshot.stages.persist.activeMs.minMs, 20)
  assert.equal(snapshot.sqlite.commits, 1)
  assert.equal(snapshot.sqlite.checkpoints, 1)
  assert.equal(snapshot.sqlite.queueMs.minMs, 12)
  assert.equal(snapshot.sqlite.transactionMs.minMs, 16)
  assert.equal(snapshot.sqlite.checkpointMs.minMs, 4)
  for (const stage of Object.values(snapshot.stages)) {
    assert.equal(stage.currentQueued, 0)
    assert.equal(stage.currentActive, 0)
  }
})

test('replay telemetry separates retry, 429 and 5xx attempts', () => {
  let now = 1_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  const battle = telemetry.beginBattle(0, now)
  battle.startDownload(now)
  now = 1_100
  battle.replayFailed(replayTiming('error'), now)
  battle.finish('error', now)

  const replay = telemetry.snapshot(now).replay
  assert.equal(replay.completed, 1)
  assert.equal(replay.failed, 1)
  assert.equal(replay.bytes, 700)
  assert.equal(replay.networkAttempts, 3)
  assert.equal(replay.retries, 1)
  assert.equal(replay.status.rateLimited429, 1)
  assert.equal(replay.status.server5xx, 1)
  assert.equal(replay.status.success2xx, 1)
  assert.equal(replay.ttfbMs.count, 3)
})

test('failed and cancelled traces release every live gauge', () => {
  let now = 10
  const telemetry = new IngestTelemetryAccumulator(() => now)
  const queued = telemetry.beginBattle(0, now)
  queued.finish('cancelled', now)
  const active = telemetry.beginBattle(0, now)
  active.startDownload(now)
  now = 20
  active.finish('error', now)

  const snapshot = telemetry.snapshot(now)
  assert.equal(snapshot.outcomes.cancelled, 1)
  assert.equal(snapshot.outcomes.error, 1)
  assert.equal(snapshot.stages.eligible.cancelled, 1)
  assert.equal(snapshot.stages.download.cancelled, 1)
  for (const stage of Object.values(snapshot.stages)) {
    assert.equal(stage.currentQueued, 0)
    assert.equal(stage.currentActive, 0)
    assert.equal(stage.currentQueuedBytes, 0)
    assert.equal(stage.currentActiveBytes, 0)
  }
})

test('battles-per-minute uses a fixed 60-slot rolling ring', () => {
  let now = 1_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  for (let index = 0; index < 3; index += 1) {
    const battle = telemetry.beginBattle(0, now)
    battle.finish('ok', now)
  }
  assert.equal(telemetry.snapshot(now).battlesPerMinute, 3)

  now += 59_000
  assert.equal(telemetry.snapshot(now).battlesPerMinute, 3)
  now += 1_000
  assert.equal(telemetry.snapshot(now).battlesPerMinute, 0)
})

test('saturated newest-first selection exposes an oldest-age lower bound', () => {
  const now = 100_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  telemetry.recordSelection([95, 90], 2, now)
  const backlog = telemetry.snapshot(now).backlog
  assert.equal(backlog.saturated, true)
  assert.equal(backlog.oldestAgeMs, null)
  assert.equal(backlog.oldestAgeLowerBoundMs, 10_000)
})

test('snapshot size stays bounded as completed battle count grows', () => {
  let now = 1_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  for (let index = 0; index < 20_000; index += 1) {
    const battle = telemetry.beginBattle(0, now)
    battle.startDownload(now)
    now += 1
    battle.replayFailed(replayTiming('error'), now)
    battle.finish('error', now)
  }
  const serialized = JSON.stringify(telemetry.snapshot(now))
  assert.ok(serialized.length < 10_000)
  assert.equal(telemetry.snapshot(now).outcomes.error, 20_000)
})
