import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { cpus, hostname } from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const args = process.argv.slice(2)
const API_PATHS = [
  '/health',
  '/api/stats',
  '/api/items?limit=3',
  '/api/voice',
] as const

type ApiPath = typeof API_PATHS[number]

interface ApiSample {
  elapsedMs: number
  status: number | null
  bytes: number
  error: string | null
  ingestStats: IngestStatsSample | null
}

interface IngestStatsSample {
  ingested: number
  pending: number
  failed: number
  players: number
  kills: number
}

interface NumericSummary {
  count: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

let requestAppShutdown: ((signal: string, exitCode?: number) => void) | null = null
let shutdownRequestedAtMs: number | null = null

async function main(): Promise<void> {
  applySoakEnvironment()
  const durationMs = numberOption('--duration-minutes=', 5, 0.1, 240) * 60_000
  const intervalMs = numberOption('--interval-seconds=', 30, 5, 300) * 1_000
  const outputOption = args.find((arg) => arg.startsWith('--output-prefix='))
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z')
  const outputPrefix = path.resolve(
    outputOption?.slice('--output-prefix='.length)
      || `data/benchmarks/performance-g1-live-${timestamp}`,
  )
  const rawPath = `${outputPrefix}.raw.jsonl`
  const summaryPath = `${outputPrefix}.summary.json`
  const shutdownPath = `${outputPrefix}.shutdown.json`
  await mkdir(path.dirname(outputPrefix), { recursive: true })
  await writeFile(rawPath, '', 'utf8')

  const { config } = await import('../config.js')
  validateProfile(config)
  console.log(
    `[performance:soak] Профиль ${config.workerThreads} workers / ` +
      `reserve ${config.workerResources.backgroundReserveSlots} / ` +
      `ingest ${config.workerResources.ingestConcurrency} / ` +
      `replay ${config.workerResources.replayProcessByteBudgetMb} МиБ / ` +
      `adaptive ${config.ingestAdaptiveAdmissionEnabled ? 'on' : 'off'} / ` +
      `exact ${config.replayExactReservationEnabled ? 'on' : 'off'}`,
  )
  console.log(`[performance:soak] Raw telemetry: ${rawPath}`)

  const { requestShutdown: requestCoreShutdown } = await import('../index.js')
  requestAppShutdown = requestCoreShutdown
  const [{ getIngestTelemetrySnapshot }, { workerPoolSnapshot }] = await Promise.all([
    import('../wrpl/ingest.js'),
    import('../workers/pool.js'),
  ])
  process.once('exit', (exitCode) => {
    try {
      const completedAtMs = Date.now()
      writeFileSync(shutdownPath, `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date(completedAtMs).toISOString(),
        exitCode,
        shutdownElapsedMs: shutdownRequestedAtMs === null
          ? null
          : completedAtMs - shutdownRequestedAtMs,
        memory: process.memoryUsage(),
        workerPool: workerPoolSnapshot(),
        ingest: getIngestTelemetrySnapshot(),
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.error(
        `[performance:soak] Не удалось сохранить shutdown telemetry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  })

  const eventLoop = monitorEventLoopDelay({ resolution: 10 })
  eventLoop.enable()
  const startedAtMs = Date.now()
  const samples: SoakSample[] = []
  let index = 0
  try {
    for (;;) {
      await waitUntil(startedAtMs + index * intervalMs)
      const elapsedMs = Date.now() - startedAtMs
      const api = await sampleApis(config.webHost, config.port, config.webToken)
      const ingestStats = api['/api/stats'].ingestStats
      if (!ingestStats) throw new Error('/api/stats не вернул ingest snapshot')
      const sample: SoakSample = {
        schemaVersion: 1,
        index,
        timestamp: new Date().toISOString(),
        elapsedMs,
        memory: process.memoryUsage(),
        eventLoop: {
          minMs: finiteNanoseconds(eventLoop.min),
          p50Ms: finiteNanoseconds(eventLoop.percentile(50)),
          p95Ms: finiteNanoseconds(eventLoop.percentile(95)),
          p99Ms: finiteNanoseconds(eventLoop.percentile(99)),
          maxMs: finiteNanoseconds(eventLoop.max),
          meanMs: finiteNanoseconds(eventLoop.mean),
        },
        workerPool: workerPoolSnapshot(),
        ingest: getIngestTelemetrySnapshot(),
        ingestStats,
        api,
      }
      samples.push(sample)
      await appendFile(rawPath, `${JSON.stringify(sample)}\n`, 'utf8')
      eventLoop.reset()
      console.log(
        `[performance:soak] ${formatDuration(elapsedMs)} · RSS ${formatMiB(sample.memory.rss)} · ` +
          `backlog ${sample.ingestStats.pending} · ${sample.ingest.battlesPerMinute} боёв/мин · ` +
          `worker ${sample.workerPool.current.running}/${sample.workerPool.configuredWorkers} · ` +
          `429 ${sample.ingest.replay.status.rateLimited429}`,
      )
      if (elapsedMs >= durationMs && index > 0) break
      index += 1
    }
  } finally {
    eventLoop.disable()
  }

  const summary = buildSummary(samples, {
    startedAtMs,
    durationMs,
    intervalMs,
    rawPath,
    shutdownPath,
    config: {
      workers: config.workerThreads,
      backgroundReserve: config.workerResources.backgroundReserveSlots,
      backgroundSlots: config.workerResources.backgroundWorkerThreads,
      ingestConcurrency: config.workerResources.ingestConcurrency,
      replayProcessBudgetMb: config.workerResources.replayProcessByteBudgetMb,
      adaptiveAdmission: config.ingestAdaptiveAdmissionEnabled,
      exactReplayReservation: config.replayExactReservationEnabled,
    },
  })
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`[performance:soak] Summary: ${summaryPath}`)
  console.log(`[performance:soak] Shutdown telemetry: ${shutdownPath}`)
  console.log('[performance:soak] Запускаю graceful shutdown')
  shutdownRequestedAtMs = Date.now()
  requestAppShutdown('performance-soak')
}

function applySoakEnvironment(): void {
  process.env['WT_WORKER_THREADS'] = '5'
  process.env['WT_WORKER_BACKGROUND_RESERVE'] = '1'
  process.env['WT_INGEST_CONCURRENCY'] = '8'
  process.env['WT_REPLAY_PROCESS_BUDGET_MB'] = '384'
  process.env['WT_INGEST_ADAPTIVE_ENABLED'] = args.includes('--adaptive') ? 'true' : 'false'
  process.env['WT_REPLAY_EXACT_RESERVATION_ENABLED'] =
    args.includes('--exact-reservation') ? 'true' : 'false'
  process.env['WT_BATTLES_CHANNEL'] = ''
  process.env['WEB_HOST'] = '127.0.0.1'
}

interface SoakSample {
  schemaVersion: 1
  index: number
  timestamp: string
  elapsedMs: number
  memory: NodeJS.MemoryUsage
  eventLoop: {
    minMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
    meanMs: number
  }
  workerPool: ReturnType<typeof import('../workers/pool.js')['workerPoolSnapshot']>
  ingest: ReturnType<typeof import('../wrpl/ingest.js')['getIngestTelemetrySnapshot']>
  ingestStats: IngestStatsSample
  api: Record<ApiPath, ApiSample>
}

function validateProfile(config: typeof import('../config.js')['config']): void {
  const errors: string[] = []
  if (config.workerThreads !== 5) errors.push('WT_WORKER_THREADS=5')
  if (config.workerResources.backgroundReserveSlots !== 1) {
    errors.push('WT_WORKER_BACKGROUND_RESERVE=1')
  }
  if (config.workerResources.ingestConcurrency !== 8) errors.push('WT_INGEST_CONCURRENCY=8')
  if (config.workerResources.replayProcessByteBudgetMb !== 384) {
    errors.push('WT_REPLAY_PROCESS_BUDGET_MB=384')
  }
  if (config.battlesChannelId !== '') errors.push('WT_BATTLES_CHANNEL должен быть пустым')
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.webHost.toLowerCase())) {
    errors.push('WEB_HOST должен быть loopback')
  }
  if (errors.length > 0) {
    throw new Error(`Неверный профиль soak: ${errors.join('; ')}`)
  }
}

async function sampleApis(
  host: string,
  port: number,
  token: string,
): Promise<Record<ApiPath, ApiSample>> {
  const entries = await Promise.all(API_PATHS.map(async (apiPath) => {
    const started = performance.now()
    try {
      const init: RequestInit = {
        signal: AbortSignal.timeout(10_000),
      }
      if (token) init.headers = { authorization: `Bearer ${token}` }
      const response = await fetch(`http://${host}:${port}${apiPath}`, init)
      const body = await response.text()
      return [apiPath, {
        elapsedMs: performance.now() - started,
        status: response.status,
        bytes: Buffer.byteLength(body),
        error: null,
        ingestStats: apiPath === '/api/stats' ? parseIngestStats(body) : null,
      }] as const
    } catch (error) {
      return [apiPath, {
        elapsedMs: performance.now() - started,
        status: null,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
        ingestStats: null,
      }] as const
    }
  }))
  return Object.fromEntries(entries) as Record<ApiPath, ApiSample>
}

function parseIngestStats(body: string): IngestStatsSample | null {
  try {
    const value = JSON.parse(body) as { ingest?: Partial<IngestStatsSample> }
    const ingest = value.ingest
    if (
      !ingest
      || !Number.isFinite(ingest.ingested)
      || !Number.isFinite(ingest.pending)
      || !Number.isFinite(ingest.failed)
      || !Number.isFinite(ingest.players)
      || !Number.isFinite(ingest.kills)
    ) {
      return null
    }
    return {
      ingested: ingest.ingested!,
      pending: ingest.pending!,
      failed: ingest.failed!,
      players: ingest.players!,
      kills: ingest.kills!,
    }
  } catch {
    return null
  }
}

function buildSummary(
  samples: SoakSample[],
  context: {
    startedAtMs: number
    durationMs: number
    intervalMs: number
    rawPath: string
    shutdownPath: string
    config: {
      workers: number
      backgroundReserve: number
      backgroundSlots: number
      ingestConcurrency: number
      replayProcessBudgetMb: number
      adaptiveAdmission: boolean
      exactReplayReservation: boolean
    }
  },
) {
  if (samples.length < 2) throw new Error('Soak не собрал достаточное число samples')
  const first = samples[0]!
  const last = samples.at(-1)!
  const warmSamples = samples.slice(Math.floor(samples.length / 3))
  const warmWindowMs = warmSamples.at(-1)!.elapsedMs - warmSamples[0]!.elapsedMs
  const rssSlopeBytesPerHour = linearSlope(
    warmSamples.map((sample) => sample.elapsedMs / 3_600_000),
    warmSamples.map((sample) => sample.memory.rss),
  )
  const warmRss = warmSamples.map((sample) => sample.memory.rss)
  const warmRssRangeBytes = Math.max(...warmRss) - Math.min(...warmRss)
  const plateauEvidenceSufficient = warmSamples.length >= 4 && warmWindowMs >= 120_000
  const rssPlateau = plateauEvidenceSufficient
    ? Math.abs(rssSlopeBytesPerHour) <= 64 * 1024 * 1024
      && warmRssRangeBytes <= Math.max(...warmRss) * 0.15
    : null
  const elapsedMinutes = Math.max(0.001, last.elapsedMs / 60_000)
  const outcomeDelta = Object.fromEntries(
    (Object.keys(last.ingest.outcomes) as Array<keyof typeof last.ingest.outcomes>)
      .map((outcome) => [
        outcome,
        Math.max(0, last.ingest.outcomes[outcome] - first.ingest.outcomes[outcome]),
      ]),
  ) as typeof last.ingest.outcomes
  const terminalCount = Object.values(outcomeDelta).reduce((sum, value) => sum + value, 0)
  const parseOccupancy = mean(samples.map((sample) =>
    sample.ingest.stages.parse.currentActive / context.config.backgroundSlots))
  const downloadOccupancy = mean(samples.map((sample) =>
    sample.ingest.stages.download.currentActive / context.config.ingestConcurrency))
  const persistOccupancy = mean(samples.map((sample) =>
    sample.ingest.stages.persist.currentActive))

  return {
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
      requestedDurationMs: context.durationMs,
      sampleIntervalMs: context.intervalMs,
      ...context.config,
    },
    artifacts: {
      rawTelemetry: context.rawPath,
      shutdownTelemetry: context.shutdownPath,
    },
    sampling: {
      startedAt: new Date(context.startedAtMs).toISOString(),
      completedAt: last.timestamp,
      sampleCount: samples.length,
      elapsedMs: last.elapsedMs,
    },
    backlog: {
      initialPending: first.ingestStats.pending,
      finalPending: last.ingestStats.pending,
      pendingDelta: last.ingestStats.pending - first.ingestStats.pending,
      everNonEmpty: samples.some((sample) => sample.ingestStats.pending > 0),
      saturatedSamples: samples.filter((sample) => sample.ingest.backlog.saturated).length,
      finalOldestAgeMs: last.ingest.backlog.oldestAgeMs,
      finalOldestAgeLowerBoundMs: last.ingest.backlog.oldestAgeLowerBoundMs,
    },
    throughput: {
      ingestedDelta: last.ingestStats.ingested - first.ingestStats.ingested,
      outcomes: outcomeDelta,
      cumulativeOutcomes: last.ingest.outcomes,
      terminalCount,
      okPerMinute: outcomeDelta.ok / elapsedMinutes,
      finalRollingBattlesPerMinute: last.ingest.battlesPerMinute,
      discoveredToTerminalMs: last.ingest.discoveredToTerminalMs,
    },
    memory: {
      rssBytes: summarize(samples.map((sample) => sample.memory.rss)),
      heapUsedBytes: summarize(samples.map((sample) => sample.memory.heapUsed)),
      externalBytes: summarize(samples.map((sample) => sample.memory.external)),
      arrayBuffersBytes: summarize(samples.map((sample) => sample.memory.arrayBuffers)),
      warmRssSlopeMiBPerHour: rssSlopeBytesPerHour / 1024 / 1024,
      warmRssRangeMiB: warmRssRangeBytes / 1024 / 1024,
      plateauObservationMs: warmWindowMs,
      plateauEvidenceSufficient,
      plateau: rssPlateau,
    },
    utilization: {
      sampledDownloadOccupancy: downloadOccupancy,
      sampledParseOccupancy: parseOccupancy,
      sampledPersistOccupancy: persistOccupancy,
      adaptiveAdmission: last.ingest.admission,
      finalStages: last.ingest.stages,
      workerHighWater: last.workerPool.highWater,
      workerCumulative: last.workerPool.cumulative,
      workerRecycleReasons: last.workerPool.recycleReasons,
    },
    replay: {
      ...last.ingest.replay,
      processBudget: last.ingest.replayProcessByteBudget,
      fetchAdmission: last.ingest.replayFetchAdmission,
    },
    sqlite: last.ingest.sqlite,
    eventLoop: {
      windowP95Ms: summarize(samples.map((sample) => sample.eventLoop.p95Ms)),
      windowP99Ms: summarize(samples.map((sample) => sample.eventLoop.p99Ms)),
      windowMaxMs: summarize(samples.map((sample) => sample.eventLoop.maxMs)),
    },
    api: Object.fromEntries(API_PATHS.map((apiPath) => {
      const successful = samples
        .map((sample) => sample.api[apiPath])
        .filter((sample) => sample.status !== null && sample.status >= 200 && sample.status < 300)
      return [apiPath, {
        successful: successful.length,
        failed: samples.length - successful.length,
        latencyMs: successful.length > 0
          ? summarize(successful.map((sample) => sample.elapsedMs))
          : null,
        statuses: countValues(samples.map((sample) => String(sample.api[apiPath].status ?? 'error'))),
      }]
    })),
    decisionSignals: {
      lifecycleCouplingCandidate:
        first.ingestStats.pending > 0
        && parseOccupancy < 0.65
        && downloadOccupancy > parseOccupancy,
      persistPressureCandidate:
        last.ingest.sqlite.queueMs.count > 0
        && (last.ingest.sqlite.queueMs.p95Ms ?? 0) >= 100,
      networkPressureCandidate:
        last.ingest.replay.status.rateLimited429 > 0
        || last.ingest.replay.status.server5xx > 0
        || last.ingest.replay.retries > 0,
      memoryPressureCandidate: rssPlateau === false,
      cpuSaturationCandidate: parseOccupancy >= 0.85,
    },
  }
}

function summarize(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error('Нельзя суммировать пустую серию')
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1)!,
    mean: mean(sorted),
  }
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function linearSlope(xs: number[], ys: number[]): number {
  const xMean = mean(xs)
  const yMean = mean(ys)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    const xDelta = xs[index]! - xMean
    numerator += xDelta * (ys[index]! - yMean)
    denominator += xDelta * xDelta
  }
  return denominator === 0 ? 0 : numerator / denominator
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function finiteNanoseconds(value: number): number {
  return Number.isFinite(value) ? value / 1e6 : 0
}

function numberOption(prefix: string, fallback: number, min: number, max: number): number {
  const option = args.find((arg) => arg.startsWith(prefix))
  if (!option) return fallback
  const value = Number(option.slice(prefix.length))
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} должен быть числом ${min}..${max}`)
  }
  return value
}

async function waitUntil(deadlineMs: number): Promise<void> {
  const delayMs = deadlineMs - Date.now()
  if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} МиБ`
}

void main().catch((error: unknown) => {
  console.error(`[performance:soak] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
  if (requestAppShutdown) {
    shutdownRequestedAtMs = Date.now()
    requestAppShutdown('performance-soak-error', 1)
  }
})
