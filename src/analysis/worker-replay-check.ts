import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, hostname } from 'node:os'
import path from 'node:path'
import { workerResourcePlan } from '../runtime-options.js'
import {
  CpuWorkerPool,
  transferableCopy,
  type WorkerTaskTiming,
} from '../workers/pool.js'
import type {
  ParsedBattleResult,
  WorkerMemorySnapshot,
  WorkerRenderProfile,
} from '../workers/protocol.js'
import type { BattleMediaKind } from '../wrpl/battle-media-kind.js'
import { readCachedEcsHashesJson } from '../wrpl/ecs.js'

type Temperature = 'cold' | 'warm'

interface ReplaySource {
  directory: string
  names: string[]
  files: Buffer[]
  inputBytes: number
  readMs: number
}

interface ReplayDescriptor {
  directory: string
  sessionIdHex: string
  parts: number
  inputBytes: number
  eventsBlobBytes: number
  players: number
  kills: number
  trajectories: number
  airTrajectories: number
}

interface ArtifactMeasurement {
  bytes: number
  sha256: string
}

interface RenderMeasurement {
  mode: 'single' | 'bundle'
  kind: BattleMediaKind | null
  elapsedMs: number
  outputBytes: number
  images: number
  artifacts: Record<string, ArtifactMeasurement>
  profile: WorkerRenderProfile
  timing: WorkerTaskTiming
}

interface MainMemoryMeasurement {
  start: WorkerMemorySnapshot
  peakObserved: WorkerMemorySnapshot
  end: WorkerMemorySnapshot
}

interface RunMeasurement {
  index: number
  temperature: Temperature
  inputPrepareMs: number
  parse: {
    elapsedMs: number
    timing: WorkerTaskTiming
  }
  render: RenderMeasurement | null
  eventLoopLagMs: number
  mainMemory: MainMemoryMeasurement
}

interface NumericSummary {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
}

interface ObservedResult<T> {
  value: T
  eventLoopLagMs: number
  mainMemory: MainMemoryMeasurement
}

const args = process.argv.slice(2)
const directoryArgs = args.filter((arg) => !arg.startsWith('--'))
if (directoryArgs.length === 0) {
  throw new Error(
    'Укажи один или несколько каталогов: npm run benchmark:workers -- data/replays/<session> [ещё-session] [--render] [--warm=10]',
  )
}

const kindOption = args.find((arg) => arg.startsWith('--kind='))
const rawKind = kindOption?.slice('--kind='.length)
const mediaKinds = new Set<BattleMediaKind>([
  'log',
  'heatmap-ground',
  'heatmap-air',
  'heatmap-team-0',
  'heatmap-team-1',
  'heatmap-team-air-0',
  'heatmap-team-air-1',
  'chat',
])
if (rawKind && !mediaKinds.has(rawKind as BattleMediaKind)) {
  throw new Error(`Неизвестный --kind=${rawKind}`)
}
if (kindOption && !rawKind) throw new Error('Укажи вид материала после --kind=')
const kind = rawKind as BattleMediaKind | undefined
const render = args.includes('--render') || kind !== undefined
const warmRuns = integerOption('--warm=', 0, 0, 100)
const resources = workerResourcePlan()
const workerCount = integerOption('--workers=', resources.workerThreads, 1, 8)

const jsonOption = args.find((arg) => arg === '--json' || arg.startsWith('--json='))
const rawJsonPath = jsonOption?.startsWith('--json=') ? jsonOption.slice('--json='.length) : null
if (jsonOption?.startsWith('--json=') && !rawJsonPath) throw new Error('Укажи файл после --json=')
const jsonPath = rawJsonPath ? path.resolve(rawJsonPath) : null
const jsonOnly = jsonOption === '--json'

const artifactsOption = args.find((arg) => arg.startsWith('--artifacts='))
const rawArtifactsDirectory = artifactsOption?.slice('--artifacts='.length)
if (artifactsOption && !rawArtifactsDirectory) throw new Error('Укажи каталог после --artifacts=')
const artifactsDirectory = rawArtifactsDirectory ? path.resolve(rawArtifactsDirectory) : null
const directories = directoryArgs.map((directory) => path.resolve(directory))
const ecsHashesJson = await readCachedEcsHashesJson()

const scenarios = []
for (const directory of directories) {
  const source = await readReplaySource(directory)
  const pool = new CpuWorkerPool({ size: workerCount })
  try {
    const scenarioArtifacts = artifactsDirectory
      ? directories.length === 1
        ? artifactsDirectory
        : path.join(artifactsDirectory, path.basename(directory))
      : null
    const coldResult = await executeRun(pool, source, 0, 'cold', scenarioArtifacts)
    logRun(coldResult.replay.sessionIdHex, coldResult.run)

    const warm = []
    const warmStarted = performance.now()
    for (let index = 0; index < warmRuns; index++) {
      const result = await executeRun(pool, source, index + 1, 'warm', null)
      assert.deepEqual(result.replay, coldResult.replay, 'Метаданные replay изменились между benchmark-прогонами')
      assertStableRender(coldResult.run.render, result.run.render)
      warm.push(result.run)
      logRun(result.replay.sessionIdHex, result.run)
    }
    const warmElapsedMs = performance.now() - warmStarted
    const warmResult = warm.length > 0
      ? {
          requestedRuns: warmRuns,
          elapsedMs: warmElapsedMs,
          throughputRunsPerSecond: warm.length * 1000 / warmElapsedMs,
          runs: warm,
          summary: summarizeRuns(warm),
        }
      : null
    if (!jsonOnly && warmResult) {
      const parse = warmResult.summary.parse.elapsedMs
      const renderSummary = warmResult.summary.render?.elapsedMs
      console.log(
        `[workers] ${coldResult.replay.sessionIdHex} warm p50/p95: parse ${formatPair(parse)}${
          renderSummary ? ` · render ${formatPair(renderSummary)}` : ''
        }`,
      )
    }
    scenarios.push({
      replay: coldResult.replay,
      read: { elapsedMs: source.readMs },
      cold: coldResult.run,
      warm: warmResult,
    })
  } finally {
    await pool.close()
  }
}

const allWarmRuns = scenarios.flatMap((scenario) => scenario.warm?.runs ?? [])
const benchmark = {
  schemaVersion: 2,
  timestamp: new Date().toISOString(),
  environment: {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    workerResourcePlan: resources,
  },
  configuration: {
    render,
    renderMode: render ? (kind ? 'single' : 'bundle') : 'none',
    kind: kind ?? null,
    warmRunsPerScenario: warmRuns,
    workerCount,
    cacheState: 'bypassed',
    artifactsEnabled: artifactsDirectory !== null,
  },
  scenarios,
  corpusWarmSummary: allWarmRuns.length > 0 ? summarizeRuns(allWarmRuns) : null,
}

const json = `${JSON.stringify(benchmark, null, 2)}\n`
if (jsonPath) {
  await mkdir(path.dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, json, 'utf8')
  if (!jsonOnly) console.log(`[workers] JSON сохранён: ${jsonPath}`)
} else if (jsonOnly) {
  process.stdout.write(json)
}

async function readReplaySource(directory: string): Promise<ReplaySource> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}\.wrpl$/i.test(name)).sort()
  assert.ok(names.length > 0, `В ${directory} нет частей *.wrpl`)
  const started = performance.now()
  const files = await Promise.all(names.map((name) => readFile(path.join(directory, name))))
  return {
    directory,
    names,
    files,
    inputBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
    readMs: performance.now() - started,
  }
}

async function executeRun(
  pool: CpuWorkerPool,
  source: ReplaySource,
  index: number,
  temperature: Temperature,
  runArtifactsDirectory: string | null,
): Promise<{ replay: ReplayDescriptor; run: RunMeasurement }> {
  const observed = await observeMainThread(async () => {
    const inputPrepareStarted = performance.now()
    const parts = source.files.map((file) => transferableCopy(file))
    const inputPrepareMs = performance.now() - inputPrepareStarted
    let parseTiming: WorkerTaskTiming | null = null
    const parseStarted = performance.now()
    const parsed = await pool.run(
      { kind: 'parse-battle', input: { parts, realNames: [], meta: {}, ecsHashesJson } },
      {
        priority: 'background',
        transferList: parts,
        timeoutMs: 180_000,
        onTiming: (timing) => { parseTiming = timing },
      },
    )
    const parseMs = performance.now() - parseStarted
    const replay = replayDescriptor(source, parsed)
    const renderMeasurement = render
      ? await renderParsed(pool, parsed, runArtifactsDirectory)
      : null
    return {
      replay,
      inputPrepareMs,
      parse: { elapsedMs: parseMs, timing: requireTiming(parseTiming, 'parse-battle') },
      render: renderMeasurement,
    }
  })
  return {
    replay: observed.value.replay,
    run: {
      index,
      temperature,
      inputPrepareMs: observed.value.inputPrepareMs,
      parse: observed.value.parse,
      render: observed.value.render,
      eventLoopLagMs: observed.eventLoopLagMs,
      mainMemory: observed.mainMemory,
    },
  }
}

function replayDescriptor(source: ReplaySource, parsed: ParsedBattleResult): ReplayDescriptor {
  return {
    directory: source.directory,
    sessionIdHex: parsed.header.sessionIdHex,
    parts: source.names.length,
    inputBytes: source.inputBytes,
    eventsBlobBytes: parsed.battle.eventsBlob.byteLength,
    players: parsed.results.players.length,
    kills: parsed.summary.kills,
    trajectories: parsed.summary.units,
    airTrajectories: parsed.summary.airUnits,
  }
}

async function renderParsed(
  pool: CpuWorkerPool,
  parsed: ParsedBattleResult,
  runArtifactsDirectory: string | null,
): Promise<RenderMeasurement> {
  const input = {
    missionName: parsed.battle.missionName,
    header: parsed.header,
    results: parsed.results,
    eventsBlob: parsed.battle.eventsBlob,
    dict: {},
    mission: null,
    assets: {
      fontFiles: [],
      gameFont: false,
      mapIconFont: false,
      tacticalMap: null,
      fallbackMap: null,
      seekers: [],
    },
  }
  let timing: WorkerTaskTiming | null = null
  const started = performance.now()
  if (kind) {
    const selected = await pool.run(
      { kind: 'render-media-kind', input: { ...input, kind } },
      {
        priority: 'normal',
        transferList: [parsed.battle.eventsBlob],
        timeoutMs: 180_000,
        onTiming: (value) => { timing = value },
      },
    )
    const elapsedMs = performance.now() - started
    const outputBytes = typeof selected.media === 'string'
      ? Buffer.byteLength(selected.media, 'utf8')
      : selected.media.byteLength
    if (kind !== 'chat') assert.equal(isPng(selected.media as ArrayBuffer), true)
    if (runArtifactsDirectory) {
      await writeArtifact(
        runArtifactsDirectory,
        `${kind}.${kind === 'chat' ? 'txt' : 'png'}`,
        selected.media,
      )
    }
    return {
      mode: 'single',
      kind,
      elapsedMs,
      outputBytes,
      images: kind === 'chat' ? 0 : 1,
      artifacts: { [kind]: { bytes: outputBytes, sha256: sha256(selected.media) } },
      profile: selected.profile,
      timing: requireTiming(timing, 'render-media-kind'),
    }
  }

  const media = await pool.run(
    { kind: 'render-media', input },
    {
      priority: 'normal',
      transferList: [parsed.battle.eventsBlob],
      timeoutMs: 180_000,
      onTiming: (value) => { timing = value },
    },
  )
  const elapsedMs = performance.now() - started
  assert.equal(isPng(media.log), true)
  assert.equal(isPng(media.heatmapGround), true)
  assert.equal(isPng(media.heatmapAir), true)
  const artifacts = {
    log: media.log,
    'heatmap-ground': media.heatmapGround,
    'heatmap-air': media.heatmapAir,
    'heatmap-team-0': media.heatmapTeamGround[0],
    'heatmap-team-1': media.heatmapTeamGround[1],
    'heatmap-team-air-0': media.heatmapTeamAir[0],
    'heatmap-team-air-1': media.heatmapTeamAir[1],
  }
  if (runArtifactsDirectory) {
    await Promise.all(
      Object.entries(artifacts).map(([name, artifact]) =>
        writeArtifact(runArtifactsDirectory, `${name}.png`, artifact),
      ),
    )
  }
  const measurements = Object.fromEntries(
    Object.entries(artifacts).map(([name, artifact]) => [
      name,
      { bytes: artifact.byteLength, sha256: sha256(artifact) },
    ]),
  )
  return {
    mode: 'bundle',
    kind: null,
    elapsedMs,
    outputBytes: Object.values(artifacts).reduce((sum, artifact) => sum + artifact.byteLength, 0),
    images: Object.keys(artifacts).length,
    artifacts: measurements,
    profile: media.profile,
    timing: requireTiming(timing, 'render-media'),
  }
}

async function observeMainThread<T>(action: () => Promise<T>): Promise<ObservedResult<T>> {
  const start = memorySnapshot()
  let peakObserved = { ...start }
  let lastHeartbeat = performance.now()
  let maxLagMs = 0
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxLagMs = Math.max(maxLagMs, now - lastHeartbeat - 10)
    lastHeartbeat = now
    peakObserved = maxMemory(peakObserved, memorySnapshot())
  }, 10)
  try {
    const value = await action()
    const end = memorySnapshot()
    return {
      value,
      eventLoopLagMs: maxLagMs,
      mainMemory: {
        start,
        peakObserved: maxMemory(peakObserved, end),
        end,
      },
    }
  } finally {
    clearInterval(heartbeat)
  }
}

function summarizeRuns(runs: RunMeasurement[]) {
  const renderRuns = runs.flatMap((run) => run.render ? [run.render] : [])
  return {
    runs: runs.length,
    inputPrepareMs: summarize(runs.map((run) => run.inputPrepareMs)),
    parse: {
      elapsedMs: summarize(runs.map((run) => run.parse.elapsedMs)),
      scheduler: summarizeTimings(runs.map((run) => run.parse.timing)),
    },
    render: renderRuns.length > 0
      ? {
          elapsedMs: summarize(renderRuns.map((run) => run.elapsedMs)),
          outputBytes: summarize(renderRuns.map((run) => run.outputBytes)),
          workerProfileMs: summarize(renderRuns.map((run) => run.profile.totalMs)),
          scheduler: summarizeTimings(renderRuns.map((run) => run.timing)),
          phasesMs: summarizePhases(renderRuns.map((run) => run.profile)),
          phaseTotalsMs: summarizePhaseTotals(renderRuns.map((run) => run.profile)),
          workerMemory: {
            peakObserved: summarizeMemory(renderRuns.map((run) => run.profile.memory.peakObserved)),
            end: summarizeMemory(renderRuns.map((run) => run.profile.memory.end)),
          },
        }
      : null,
    eventLoopLagMs: summarize(runs.map((run) => run.eventLoopLagMs)),
    mainMemory: {
      peakObserved: summarizeMemory(runs.map((run) => run.mainMemory.peakObserved)),
      end: summarizeMemory(runs.map((run) => run.mainMemory.end)),
    },
  }
}

function summarizeTimings(timings: WorkerTaskTiming[]) {
  return {
    coldWorkerRuns: timings.filter((timing) => timing.coldWorker).length,
    queueMs: summarize(timings.map((timing) => timing.queueMs)),
    schedulerWaitMs: summarize(timings.map((timing) => timing.schedulerWaitMs)),
    workerStartupMs: summarize(timings.map((timing) => timing.workerStartupMs)),
    inputTransferMs: summarizeNullable(timings.map((timing) => timing.inputTransferMs)),
    executionMs: summarizeNullable(timings.map((timing) => timing.executionMs)),
    resultTransferMs: summarizeNullable(timings.map((timing) => timing.resultTransferMs)),
    totalMs: summarize(timings.map((timing) => timing.totalMs)),
  }
}

function summarizePhases(profiles: WorkerRenderProfile[]): Record<string, NumericSummary> {
  const names = new Set(profiles.flatMap((profile) => Object.keys(profile.phasesMs)))
  return Object.fromEntries(
    [...names].sort().map((name) => [
      name,
      summarize(profiles.flatMap((profile) => profile.phasesMs[name] === undefined ? [] : [profile.phasesMs[name]])),
    ]),
  )
}

function summarizePhaseTotals(profiles: WorkerRenderProfile[]) {
  return {
    eventDecode: summarizePhaseGroup(profiles, (name) => name.startsWith('events.')),
    svg: summarizePhaseGroup(profiles, (name) => name.endsWith('.svg')),
    scenePrepare: summarizePhaseGroup(profiles, (name) => name.endsWith('.prepare')),
    resvgInit: summarizePhaseGroup(profiles, (name) => name.endsWith('.resvg.init')),
    resvgRender: summarizePhaseGroup(profiles, (name) => name.endsWith('.resvg.render')),
    pngEncode: summarizePhaseGroup(profiles, (name) => name.endsWith('.resvg.png')),
  }
}

function summarizePhaseGroup(
  profiles: WorkerRenderProfile[],
  matches: (name: string) => boolean,
): NumericSummary | null {
  const totals = profiles.flatMap((profile) => {
    const values = Object.entries(profile.phasesMs)
      .filter(([name]) => matches(name))
      .map(([, value]) => value)
    return values.length > 0 ? [values.reduce((sum, value) => sum + value, 0)] : []
  })
  return totals.length > 0 ? summarize(totals) : null
}

function summarizeMemory(snapshots: WorkerMemorySnapshot[]) {
  return {
    rssBytes: summarize(snapshots.map((snapshot) => snapshot.rssBytes)),
    heapUsedBytes: summarize(snapshots.map((snapshot) => snapshot.heapUsedBytes)),
    externalBytes: summarize(snapshots.map((snapshot) => snapshot.externalBytes)),
    arrayBuffersBytes: summarize(snapshots.map((snapshot) => snapshot.arrayBuffersBytes)),
  }
}

function summarizeNullable(values: Array<number | null>): NumericSummary | null {
  const present = values.flatMap((value) => value === null ? [] : [value])
  return present.length > 0 ? summarize(present) : null
}

function summarize(values: number[]): NumericSummary {
  assert.ok(values.length > 0, 'Нельзя вычислить percentile пустой серии')
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]!
}

function assertStableRender(baseline: RenderMeasurement | null, candidate: RenderMeasurement | null): void {
  assert.equal(candidate?.mode ?? null, baseline?.mode ?? null, 'Режим render изменился между прогонами')
  assert.deepEqual(candidate?.artifacts ?? null, baseline?.artifacts ?? null, 'SHA-256 или размер render изменился')
}

function requireTiming(timing: WorkerTaskTiming | null, kindName: string): WorkerTaskTiming {
  assert.ok(timing, `CPU pool не вернул timing для ${kindName}`)
  return timing
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

function logRun(sessionId: string, run: RunMeasurement): void {
  if (jsonOnly) return
  console.log(
    `[workers] ${sessionId} ${run.temperature} #${run.index}: parse ${run.parse.elapsedMs.toFixed(0)} мс${
      run.render ? ` · ${run.render.mode} ${run.render.elapsedMs.toFixed(0)} мс` : ''
    } · event-loop lag ${run.eventLoopLagMs.toFixed(1)} мс`,
  )
}

function formatPair(summary: NumericSummary): string {
  return `${summary.p50.toFixed(0)}/${summary.p95.toFixed(0)} мс`
}

function isPng(data: ArrayBuffer): boolean {
  const signature = Buffer.from(data).subarray(0, 8)
  return signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

function memorySnapshot(): WorkerMemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  }
}

function maxMemory(left: WorkerMemorySnapshot, right: WorkerMemorySnapshot): WorkerMemorySnapshot {
  return {
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    arrayBuffersBytes: Math.max(left.arrayBuffersBytes, right.arrayBuffersBytes),
  }
}

function sha256(data: ArrayBuffer | string): string {
  return createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest('hex')
}

async function writeArtifact(directory: string, name: string, data: ArrayBuffer | string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, name), typeof data === 'string' ? data : new Uint8Array(data))
}
