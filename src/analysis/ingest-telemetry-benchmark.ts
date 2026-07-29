import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, hostname } from 'node:os'
import path from 'node:path'
import type { WorkerTaskTiming } from '../workers/pool.js'
import {
  IngestTelemetryAccumulator,
  type IngestTelemetrySnapshot,
} from '../wrpl/ingest-telemetry.js'
import type { ReplayPartsTiming } from '../wrpl/replay-events.js'

const args = process.argv.slice(2)

async function main(): Promise<void> {
  const iterations = integerOption('--iterations=', 100_000, 1_000, 10_000_000)
  const rounds = integerOption('--rounds=', 7, 3, 25)
  const jsonOption = args.find((arg) => arg.startsWith('--json='))
  const jsonPath = jsonOption ? path.resolve(jsonOption.slice('--json='.length)) : null
  if (jsonOption && !jsonPath) throw new Error('Укажи файл после --json=')

  runRound(Math.min(10_000, iterations))
  const measurements = Array.from({ length: rounds }, () => runRound(iterations))
  const perBattleMs = measurements.map((measurement) => measurement.elapsedMs / iterations)
  const sorted = perBattleMs.slice().sort((a, b) => a - b)
  const p50Ms = percentile(sorted, 0.5)
  const p95Ms = percentile(sorted, 0.95)
  const conservativePipelineMs = 100
  const projectedOverheadPercentAt100Ms = p95Ms / conservativePipelineMs * 100
  const last = measurements.at(-1)!
  const result = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    environment: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
    },
    configuration: {
      iterationsPerRound: iterations,
      rounds,
      conservativePipelineMs,
    },
    result: {
      elapsedMs: measurements.map((measurement) => measurement.elapsedMs),
      perBattleMs: {
        min: sorted[0]!,
        p50: p50Ms,
        p95: p95Ms,
        max: sorted.at(-1)!,
      },
      throughputLifecyclesPerSecond: 1_000 / p50Ms,
      projectedOverheadPercentAt100Ms,
      snapshotBytes: Buffer.byteLength(JSON.stringify(last.snapshot)),
      finalOutcomes: last.snapshot.outcomes,
    },
  }

  assert.ok(
    projectedOverheadPercentAt100Ms <= 2,
    `Telemetry p95 ${p95Ms.toFixed(4)} мс/бой превышает gate 2% от ${conservativePipelineMs} мс`,
  )

  console.log(
    `[ingest:telemetry:bench] ${iterations.toLocaleString('en-US')} × ${rounds} · ` +
      `p50 ${p50Ms.toFixed(4)} мс/бой · p95 ${p95Ms.toFixed(4)} мс/бой · ` +
      `${projectedOverheadPercentAt100Ms.toFixed(4)}% от ${conservativePipelineMs} мс · ` +
      `snapshot ${result.result.snapshotBytes} байт`,
  )

  if (jsonPath) {
    await mkdir(path.dirname(jsonPath), { recursive: true })
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(`[ingest:telemetry:bench] JSON сохранён: ${jsonPath}`)
  }
}

function runRound(count: number): {
  elapsedMs: number
  snapshot: IngestTelemetrySnapshot
} {
  let now = 1_700_000_000_000
  const telemetry = new IngestTelemetryAccumulator(() => now)
  const started = performance.now()
  for (let index = 0; index < count; index += 1) {
    const battle = telemetry.beginBattle(now - 50, now)
    battle.startDownload(now)
    now += 5
    battle.replayReady(REPLAY_TIMING, now)
    now += 1
    battle.parseSubmitted(REPLAY_TIMING.bytes, now)
    now += 10
    battle.parseFinished(WORKER_TIMING, now)
    battle.persistQueued(24_317, now)
    now += 1
    battle.persistStarted(now)
    now += 2
    battle.persistFinished(now, 2)
    battle.persistTiming(1, 2, index % 32 === 31 ? 1 : 0)
    battle.finish('ok', now)
  }
  const elapsedMs = performance.now() - started
  return { elapsedMs, snapshot: telemetry.snapshot(now) }
}

function integerOption(prefix: string, fallback: number, min: number, max: number): number {
  const option = args.find((arg) => arg.startsWith(prefix))
  if (!option) return fallback
  const value = Number(option.slice(prefix.length))
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} должен быть целым числом ${min}..${max}`)
  }
  return value
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!
}

const REPLAY_TIMING: ReplayPartsTiming = {
  startedAtMs: 0,
  completedAtMs: 5,
  totalMs: 5,
  outcome: 'success',
  requestedParts: 2,
  completedParts: 2,
  concurrency: 2,
  peakActive: 2,
  maxTotalBytes: 4_000_000,
  peakBudgetBytes: 2_716_645,
  bytes: 2_716_645,
  cacheHits: 1,
  networkParts: 1,
  networkAttempts: 1,
  retries: 0,
  httpErrors: 0,
  slotWaitMs: 0,
  ttfbMs: 10,
  downloadMs: 20,
  retryDelayMs: 0,
  processBudgetWaitMs: 0,
  processBudgetLimitBytes: 1024 * 1024 * 1024,
  processBudgetPeakBytes: 2_716_645,
  parts: [
    {
      index: 0,
      label: '0000.wrpl',
      startedAtMs: 0,
      completedAtMs: 1,
      totalMs: 1,
      lockWaitMs: 0,
      cacheHit: true,
      cacheInvalid: false,
      cacheReadMs: 1,
      cacheWriteMs: 0,
      bytes: 44_043,
      outcome: 'success',
      errorName: null,
      attempts: [],
    },
    {
      index: 1,
      label: '0001.wrpl',
      startedAtMs: 0,
      completedAtMs: 5,
      totalMs: 5,
      lockWaitMs: 0,
      cacheHit: false,
      cacheInvalid: false,
      cacheReadMs: 0,
      cacheWriteMs: 1,
      bytes: 2_672_602,
      outcome: 'success',
      errorName: null,
      attempts: [
        {
          attempt: 1,
          slotWaitMs: 0,
          ttfbMs: 10,
          downloadMs: 20,
          retryDelayMs: 0,
          status: 200,
          bytes: 2_672_602,
        },
      ],
    },
  ],
}

const WORKER_TIMING: WorkerTaskTiming = {
  kind: 'parse-battle',
  priority: 'background',
  outcome: 'success',
  stage: 'execution',
  reason: 'success',
  coldWorker: false,
  inputTransferBytes: REPLAY_TIMING.bytes,
  outputTransferBytes: 24_317,
  queueMs: 1,
  schedulerWaitMs: 1,
  workerStartupMs: 0,
  inputTransferMs: 0.5,
  executionMs: 9,
  resultTransferMs: 0.2,
  totalMs: 10.7,
}

await main()
