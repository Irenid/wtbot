import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpus, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import {
  fetchReplayPart,
  REPLAY_FETCH_PAUSE_MS,
  REPLAY_PART_MAX_BYTES,
} from '../wrpl/replay-cache.js'
import {
  fetchReplayParts,
  ReplayPartsFetchError,
  REPLAY_TOTAL_MAX_BYTES,
  type ReplayPartsTiming,
} from '../wrpl/replay-events.js'
import { configureReplayUrlPolicy } from '../wrpl/replay-url-policy.js'

// Benchmark раздаёт fixture с локального http-сервера 127.0.0.1.
configureReplayUrlPolicy({ allowInsecureForTests: true })

interface NumericSummary {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
}

interface MemoryMeasurement {
  startRssBytes: number
  peakRssBytes: number
  endRssBytes: number
  peakDeltaBytes: number
  startArrayBuffersBytes: number
  peakArrayBuffersBytes: number
  peakArrayBuffersDeltaBytes: number
}

interface ServerStats {
  totalRequests: number
  okResponses: number
  retryResponses: number
  errorResponses: number
  abortedResponses: number
  bytesSent: number
  peakActive: number
}

interface ServerScenario {
  retryOnce?: string
  fatal?: string
  slowMultiplier?: number
}

interface FetchMeasurement {
  elapsedMs: number
  timing: ReplayPartsTiming
  memory: MemoryMeasurement
}

interface PipelineRun {
  index: number
  concurrency: number
  cold: FetchMeasurement
  warm: FetchMeasurement
  server: ServerStats
}

interface PipelineSummary {
  concurrency: number
  coldMs: NumericSummary
  warmMs: NumericSummary
  coldPeakRssDeltaBytes: NumericSummary
  coldPeakArrayBuffersDeltaBytes: NumericSummary
  serverPeakActive: number
  meanSlotWaitMs: number
  meanTtfbMs: number
  meanDownloadMs: number
}

interface ReplaySource {
  directory: string
  session: string
  names: string[]
  parts: Buffer[]
  totalBytes: number
}

const args = process.argv.slice(2)
const sourceDirectory = args.find((arg) => !arg.startsWith('--')) ?? 'data/replays/06efea670015c595'
const runs = integerOption('--runs=', 3, 1, 20)
const jsonPath = stringOption('--json=')
const jsonOnly = args.includes('--json-only')

const source = await readReplaySource(sourceDirectory)
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'wtbot-replay-benchmark-'))
const fixtureServer = createFixtureServer(source)
try {
  const baseUrl = await fixtureServer.listen()
  const urls = source.names.map((name) => `${baseUrl}/${source.session}/${name}`)
  const pipelineRuns: PipelineRun[] = []

  for (const concurrency of [1, 2, 3]) {
    for (let index = 1; index <= runs; index += 1) {
      const cacheDirectory = path.join(temporaryRoot, `pipeline-${concurrency}-${index}`)
      fixtureServer.configure({})
      const cold = await measureFetch(urls, source.parts, concurrency, cacheDirectory)
      await fixtureServer.waitIdle()
      const server = fixtureServer.stats()
      assert.equal(cold.timing.cacheHits, 0, 'cold run неожиданно использовал cache')
      assert.equal(cold.timing.networkParts, source.parts.length)
      assert.equal(server.totalRequests, source.parts.length)
      assert.ok(server.peakActive <= concurrency, 'HTTP pipeline превысил заданную concurrency')

      fixtureServer.configure({})
      const warm = await measureFetch(urls, source.parts, concurrency, cacheDirectory)
      await fixtureServer.waitIdle()
      assert.equal(warm.timing.cacheHits, source.parts.length)
      assert.equal(fixtureServer.stats().totalRequests, 0, 'warm cache hit обратился к HTTP server')

      pipelineRuns.push({ index, concurrency, cold, warm, server })
      if (!jsonOnly) {
        console.log(
          `[replay-benchmark] c${concurrency} #${index}: cold ${cold.elapsedMs.toFixed(0)} мс, ` +
            `warm ${warm.elapsedMs.toFixed(1)} мс, peak HTTP ${server.peakActive}, ` +
            `RSS +${formatMiB(cold.memory.peakDeltaBytes)}`,
        )
      }
    }
  }

  const checks = {
    retry: await verifyRetry(fixtureServer, urls, source, temporaryRoot),
    fatalCancellation: await verifyFatalCancellation(fixtureServer, urls, temporaryRoot),
    explicitAbort: await verifyExplicitAbort(fixtureServer, urls, temporaryRoot),
    byteBudget: await verifyByteBudget(fixtureServer, urls, source, temporaryRoot),
    duplicateDeduplication: await verifyDuplicateDeduplication(
      fixtureServer,
      urls[0]!,
      source.parts[0]!,
      temporaryRoot,
    ),
  }

  const summaries = [1, 2, 3].map((concurrency) =>
    summarizePipeline(pipelineRuns.filter((run) => run.concurrency === concurrency)),
  )
  const baseline = summaries[0]!
  const production = summaries[1]!
  const third = summaries[2]!
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    fixture: {
      directory: source.directory,
      session: source.session,
      parts: source.parts.length,
      bytes: source.totalBytes,
      server: {
        fetchPauseMs: REPLAY_FETCH_PAUSE_MS,
        ttfbMs: '75 + (part % 3) * 15',
        chunkBytes: 128 * 1024,
        chunkDelayMs: '18 + (part % 2) * 4',
      },
    },
    limits: {
      partBytes: REPLAY_PART_MAX_BYTES,
      totalBytes: REPLAY_TOTAL_MAX_BYTES,
      productionConcurrency: 2,
    },
    comparison: {
      concurrency2ColdP50ImprovementPercent: percentImprovement(baseline.coldMs.p50, production.coldMs.p50),
      concurrency2ColdP95ImprovementPercent: percentImprovement(baseline.coldMs.p95, production.coldMs.p95),
      concurrency3Vs2ColdP50ImprovementPercent: percentImprovement(production.coldMs.p50, third.coldMs.p50),
      concurrency3Vs2ColdP95ImprovementPercent: percentImprovement(production.coldMs.p95, third.coldMs.p95),
    },
    summaries,
    checks,
    runs: pipelineRuns,
  }

  if (!jsonOnly) {
    for (const summary of summaries) {
      console.log(
        `[replay-benchmark] c${summary.concurrency}: cold p50/p95 ` +
          `${summary.coldMs.p50.toFixed(0)}/${summary.coldMs.p95.toFixed(0)} мс, ` +
          `warm ${summary.warmMs.p50.toFixed(1)}/${summary.warmMs.p95.toFixed(1)} мс, ` +
          `RSS Δ p95 ${formatMiB(summary.coldPeakRssDeltaBytes.p95)}`,
      )
    }
    console.log(
      `[replay-benchmark] проверки OK: retry, fatal cancellation, abort, byte budget, duplicate dedupe`,
    )
  }
  if (jsonPath) {
    await mkdir(path.dirname(jsonPath), { recursive: true })
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    if (!jsonOnly) console.log(`[replay-benchmark] JSON: ${jsonPath}`)
  }
  if (jsonOnly) console.log(JSON.stringify(result))
} finally {
  await fixtureServer.close()
  await removeTemporaryRoot(temporaryRoot)
}

async function readReplaySource(directory: string): Promise<ReplaySource> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}\.wrpl$/i.test(name)).sort()
  assert.ok(names.length >= 3, `${directory}: нужно минимум три части *.wrpl`)
  const parts = await Promise.all(names.map((name) => readFile(path.join(directory, name))))
  for (const [index, part] of parts.entries()) {
    assert.ok(part.length >= 1234, `${names[index]} короче WRPL header`)
    assert.deepEqual([...part.subarray(0, 4)], [0xe5, 0xac, 0x00, 0x10], `${names[index]} не WRPL`)
  }
  const session = path.basename(path.resolve(directory)).toLowerCase()
  assert.match(session, /^[0-9a-f]{12,20}$/i, 'Имя fixture-directory должно быть replay session id')
  return {
    directory,
    session,
    names,
    parts,
    totalBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
  }
}

async function measureFetch(
  urls: string[],
  expected: Buffer[],
  concurrency: number,
  cacheDirectory: string,
): Promise<FetchMeasurement> {
  await collectGarbage()
  let timing: ReplayPartsTiming | null = null
  const observed = await observeMemory(async () => {
    const started = performance.now()
    const parts = await fetchReplayParts(urls, undefined, {
      concurrency,
      cacheDirectory,
      onTiming: (value) => { timing = value },
    })
    const elapsedMs = performance.now() - started
    assertPartsEqual(parts, expected)
    return elapsedMs
  })
  return {
    elapsedMs: observed.value,
    timing: requireReplayTiming(timing, 'fetchReplayParts не вернул aggregate timing'),
    memory: observed.memory,
  }
}

async function verifyRetry(
  server: ReturnType<typeof createFixtureServer>,
  urls: string[],
  source: ReplaySource,
  root: string,
): Promise<{ timing: ReplayPartsTiming; server: ServerStats }> {
  server.configure({ retryOnce: source.names[1]! })
  const measurement = await measureFetch(urls, source.parts, 2, path.join(root, 'retry'))
  await server.waitIdle()
  const stats = server.stats()
  assert.equal(measurement.timing.retries, 1)
  assert.equal(measurement.timing.httpErrors, 1)
  assert.equal(stats.retryResponses, 1)
  assert.equal(stats.totalRequests, source.parts.length + 1)
  return { timing: measurement.timing, server: stats }
}

async function verifyFatalCancellation(
  server: ReturnType<typeof createFixtureServer>,
  urls: string[],
  root: string,
): Promise<{ elapsedMs: number; timing: ReplayPartsTiming; server: ServerStats }> {
  server.configure({ fatal: path.basename(urls[1]!), slowMultiplier: 5 })
  let timing: ReplayPartsTiming | null = null
  const started = performance.now()
  let caught: unknown
  try {
    await fetchReplayParts(urls, undefined, {
      concurrency: 2,
      cacheDirectory: path.join(root, 'fatal'),
      onTiming: (value) => { timing = value },
    })
  } catch (error) {
    caught = error
  }
  const elapsedMs = performance.now() - started
  await server.waitIdle()
  const stats = server.stats()
  assert.ok(caught instanceof ReplayPartsFetchError, 'HTTP 500 не вернул ReplayPartsFetchError')
  const completedTiming = requireReplayTiming(timing, 'fatal run не вернул timing')
  assert.equal(completedTiming.outcome, 'error')
  assert.ok(completedTiming.completedParts < urls.length)
  assert.ok(stats.errorResponses >= 1)
  assert.ok(stats.abortedResponses >= 1, 'фатальная ошибка не отменила соседний response')
  assert.ok(elapsedMs < 2_000, `фатальная отмена заняла ${elapsedMs.toFixed(0)} мс`)
  return { elapsedMs, timing: completedTiming, server: stats }
}

async function verifyExplicitAbort(
  server: ReturnType<typeof createFixtureServer>,
  urls: string[],
  root: string,
): Promise<{ elapsedMs: number; timing: ReplayPartsTiming; server: ServerStats }> {
  server.configure({ slowMultiplier: 5 })
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 220)
  let timing: ReplayPartsTiming | null = null
  const started = performance.now()
  let caught: unknown
  try {
    await fetchReplayParts(urls, controller.signal, {
      concurrency: 2,
      cacheDirectory: path.join(root, 'abort'),
      onTiming: (value) => { timing = value },
    })
  } catch (error) {
    caught = error
  } finally {
    clearTimeout(abortTimer)
  }
  const elapsedMs = performance.now() - started
  await server.waitIdle()
  const stats = server.stats()
  assert.ok(caught instanceof ReplayPartsFetchError)
  assert.equal(caught.name, 'AbortError')
  const completedTiming = requireReplayTiming(timing, 'abort run не вернул timing')
  assert.equal(completedTiming.outcome, 'aborted')
  assert.ok(stats.abortedResponses >= 1)
  assert.ok(elapsedMs < 1_500, `явный abort занял ${elapsedMs.toFixed(0)} мс`)
  return { elapsedMs, timing: completedTiming, server: stats }
}

async function verifyByteBudget(
  server: ReturnType<typeof createFixtureServer>,
  urls: string[],
  source: ReplaySource,
  root: string,
): Promise<{ limitBytes: number; timing: ReplayPartsTiming; server: ServerStats }> {
  server.configure({})
  const limitBytes = REPLAY_PART_MAX_BYTES + source.parts[0]!.byteLength - 1
  let timing: ReplayPartsTiming | null = null
  let caught: unknown
  try {
    await fetchReplayParts(urls, undefined, {
      concurrency: 1,
      maxTotalBytes: limitBytes,
      cacheDirectory: path.join(root, 'budget'),
      onTiming: (value) => { timing = value },
    })
  } catch (error) {
    caught = error
  }
  await server.waitIdle()
  const stats = server.stats()
  assert.ok(caught instanceof ReplayPartsFetchError)
  const completedTiming = requireReplayTiming(timing, 'byte-budget run не вернул timing')
  assert.equal(completedTiming.outcome, 'error')
  assert.equal(completedTiming.completedParts, 1)
  assert.equal(stats.totalRequests, 1)
  assert.ok(completedTiming.peakBudgetBytes <= limitBytes)
  return { limitBytes, timing: completedTiming, server: stats }
}

async function verifyDuplicateDeduplication(
  server: ReturnType<typeof createFixtureServer>,
  url: string,
  expected: Buffer,
  root: string,
): Promise<{ server: ServerStats; distinctBuffers: boolean }> {
  server.configure({})
  const cacheDirectory = path.join(root, 'duplicate')
  const [first, second] = await Promise.all([
    fetchReplayPart(url, { cacheDirectory }),
    fetchReplayPart(url, { cacheDirectory }),
  ])
  await server.waitIdle()
  assert.ok(first.equals(expected))
  assert.ok(second.equals(expected))
  assert.notEqual(first, second)
  assert.notEqual(first.buffer, second.buffer, 'callers получили общий detachable ArrayBuffer')
  const stats = server.stats()
  assert.equal(stats.totalRequests, 1, 'одинаковая часть скачалась более одного раза')
  return { server: stats, distinctBuffers: first.buffer !== second.buffer }
}

function summarizePipeline(runsForConcurrency: PipelineRun[]): PipelineSummary {
  assert.ok(runsForConcurrency.length > 0)
  const coldTimings = runsForConcurrency.map((run) => run.cold.timing)
  return {
    concurrency: runsForConcurrency[0]!.concurrency,
    coldMs: summarize(runsForConcurrency.map((run) => run.cold.elapsedMs)),
    warmMs: summarize(runsForConcurrency.map((run) => run.warm.elapsedMs)),
    coldPeakRssDeltaBytes: summarize(runsForConcurrency.map((run) => run.cold.memory.peakDeltaBytes)),
    coldPeakArrayBuffersDeltaBytes: summarize(
      runsForConcurrency.map((run) => run.cold.memory.peakArrayBuffersDeltaBytes),
    ),
    serverPeakActive: Math.max(...runsForConcurrency.map((run) => run.server.peakActive)),
    meanSlotWaitMs: mean(coldTimings.map((timing) => timing.slotWaitMs)),
    meanTtfbMs: mean(coldTimings.map((timing) => timing.ttfbMs)),
    meanDownloadMs: mean(coldTimings.map((timing) => timing.downloadMs)),
  }
}

function createFixtureServer(source: ReplaySource): {
  listen: () => Promise<string>
  configure: (scenario: ServerScenario) => void
  stats: () => ServerStats
  waitIdle: () => Promise<void>
  close: () => Promise<void>
} {
  const byName = new Map(source.names.map((name, index) => [name, { index, data: source.parts[index]! }]))
  let scenario: ServerScenario = {}
  let active = 0
  let currentStats = emptyServerStats()
  const requestCounts = new Map<string, number>()

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      response.destroy()
    })
  })

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const name = path.posix.basename(pathname)
    const fixture = byName.get(name)
    currentStats.totalRequests += 1
    active += 1
    currentStats.peakActive = Math.max(currentStats.peakActive, active)
    try {
      if (!fixture || !pathname.includes(`/${source.session}/`)) {
        currentStats.errorResponses += 1
        response.writeHead(404).end()
        await responseDone(response)
        return
      }
      const requestCount = (requestCounts.get(name) ?? 0) + 1
      requestCounts.set(name, requestCount)
      const multiplier = scenario.slowMultiplier ?? 1
      await delay((75 + (fixture.index % 3) * 15) * multiplier)
      if (response.destroyed) return

      if (scenario.retryOnce === name && requestCount === 1) {
        currentStats.retryResponses += 1
        response.writeHead(429, { 'retry-after': '0.01' }).end('retry')
        await responseDone(response)
        return
      }
      if (scenario.fatal === name) {
        currentStats.errorResponses += 1
        response.writeHead(500).end('fatal')
        await responseDone(response)
        return
      }

      currentStats.okResponses += 1
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(fixture.data.byteLength),
      })
      const chunkBytes = 128 * 1024
      for (let offset = 0; offset < fixture.data.byteLength; offset += chunkBytes) {
        if (response.destroyed) return
        const chunk = fixture.data.subarray(offset, Math.min(offset + chunkBytes, fixture.data.byteLength))
        response.write(chunk)
        currentStats.bytesSent += chunk.byteLength
        if (offset + chunkBytes < fixture.data.byteLength) {
          await delay((18 + (fixture.index % 2) * 4) * multiplier)
        }
      }
      response.end()
      await responseDone(response)
    } finally {
      if (!response.writableFinished) currentStats.abortedResponses += 1
      active -= 1
    }
  }

  return {
    listen: async () => {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      return `http://127.0.0.1:${address.port}`
    },
    configure: (next) => {
      assert.equal(active, 0, 'fixture server ещё обрабатывает предыдущий сценарий')
      scenario = { ...next }
      currentStats = emptyServerStats()
      requestCounts.clear()
    },
    stats: () => ({ ...currentStats }),
    waitIdle: async () => {
      const deadline = Date.now() + 5_000
      while (active > 0 && Date.now() < deadline) await delay(5)
      assert.equal(active, 0, 'fixture server не завершил ответы за 5 секунд')
    },
    close: async () => {
      if (!server.listening) return
      server.close()
      await once(server, 'close')
    },
  }
}

function emptyServerStats(): ServerStats {
  return {
    totalRequests: 0,
    okResponses: 0,
    retryResponses: 0,
    errorResponses: 0,
    abortedResponses: 0,
    bytesSent: 0,
    peakActive: 0,
  }
}

function responseDone(response: ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    response.once('finish', resolve)
    response.once('close', resolve)
  })
}

async function observeMemory<T>(task: () => Promise<T>): Promise<{ value: T; memory: MemoryMeasurement }> {
  const start = process.memoryUsage()
  let peakRssBytes = start.rss
  let peakArrayBuffersBytes = start.arrayBuffers
  const timer = setInterval(() => {
    const current = process.memoryUsage()
    peakRssBytes = Math.max(peakRssBytes, current.rss)
    peakArrayBuffersBytes = Math.max(peakArrayBuffersBytes, current.arrayBuffers)
  }, 5)
  try {
    const value = await task()
    const end = process.memoryUsage()
    peakRssBytes = Math.max(peakRssBytes, end.rss)
    peakArrayBuffersBytes = Math.max(peakArrayBuffersBytes, end.arrayBuffers)
    return {
      value,
      memory: {
        startRssBytes: start.rss,
        peakRssBytes,
        endRssBytes: end.rss,
        peakDeltaBytes: Math.max(0, peakRssBytes - start.rss),
        startArrayBuffersBytes: start.arrayBuffers,
        peakArrayBuffersBytes,
        peakArrayBuffersDeltaBytes: Math.max(0, peakArrayBuffersBytes - start.arrayBuffers),
      },
    }
  } finally {
    clearInterval(timer)
  }
}

function assertPartsEqual(actual: Buffer[], expected: Buffer[]): void {
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(actual[index]!.equals(expected[index]!), `часть ${index} вернулась не в исходном порядке`)
  }
}

function summarize(values: number[]): NumericSummary {
  assert.ok(values.length > 0)
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    mean: mean(sorted),
  }
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function percentImprovement(baseline: number, candidate: number): number {
  return baseline > 0 ? ((baseline - candidate) / baseline) * 100 : 0
}

function requireReplayTiming(value: ReplayPartsTiming | null, message: string): ReplayPartsTiming {
  assert.ok(value, message)
  return value
}

function integerOption(prefix: string, fallback: number, min: number, max: number): number {
  const option = args.find((arg) => arg.startsWith(prefix))
  if (!option) return fallback
  const value = Number(option.slice(prefix.length))
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} должно быть целым числом от ${min} до ${max}`)
  }
  return value
}

function stringOption(prefix: string): string | null {
  const option = args.find((arg) => arg.startsWith(prefix))
  return option ? option.slice(prefix.length) : null
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МиБ`
}

async function collectGarbage(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) return
  gc()
  await delay(0)
  gc()
}

async function removeTemporaryRoot(directory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const expectedParent = path.resolve(tmpdir()) + path.sep
  if (!resolved.startsWith(expectedParent) || !path.basename(resolved).startsWith('wtbot-replay-benchmark-')) {
    throw new Error(`Отказ очистить неожиданный временный путь: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
