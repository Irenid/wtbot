import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  closeWorkerPool,
  isWorkerPoolSchedulingError,
  runWorkerTask,
  transferableBuffer,
  workerPoolSnapshot,
  WorkerPoolError,
} from '../workers/pool.js'
import { workerResourcePlan } from '../runtime-options.js'
import type { ReplayEvents } from '../wrpl/replay-events.js'
import type { ReplayResults, WrplHeader } from '../wrpl/replay.js'
import { routePath } from '../wrpl/render-heatmap.js'

const header: WrplHeader = {
  version: 1,
  level: 'levels/test.bin',
  battleType: 'Domination',
  environment: 'day',
  visibility: '',
  resultsBlkOffset: 0,
  difficulty: 0,
  sessionId: '1',
  sessionIdHex: '0000000000000001',
  partNumber: 0,
  isServer: true,
  settingsBlkSize: 0,
  locName: 'Worker Smoke',
  startTime: 1_700_000_000,
  timeLimit: 0,
  scoreLimit: 0,
  battleClass: '',
}
const results: ReplayResults = { status: 'ok', timePlayed: 60, players: [] }
const events: ReplayEvents = {
  teamWon: 1,
  players: [],
  kills: [],
  damage: [],
  chat: [],
  units: [],
  zones: [],
  endTime: 60_000,
  errors: [],
}
const renderMissionName = '[Domination] Полигон サーモン_04'

function isPng(data: ArrayBuffer): boolean {
  const signature = Buffer.from(data).subarray(0, 8)
  return signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

let lastHeartbeat = performance.now()
let maxLagMs = 0
const heartbeat = setInterval(() => {
  const now = performance.now()
  maxLagMs = Math.max(maxLagMs, now - lastHeartbeat - 10)
  lastHeartbeat = now
}, 10)

try {
  const cpuPlan = workerResourcePlan({ env: {}, availableCpus: 12, totalMemoryMb: 16_384 })
  assert.equal(cpuPlan.workerThreads, 8)
  assert.equal(cpuPlan.reservedCpus, 1)
  assert.equal(cpuPlan.backgroundReserveSlots, 1)
  assert.equal(cpuPlan.backgroundWorkerThreads, 7)
  assert.equal(cpuPlan.ingestConcurrency, 7)

  const memoryPlan = workerResourcePlan({
    env: { WT_INGEST_CONCURRENCY: '8' },
    availableCpus: 16,
    totalMemoryMb: 2_048,
    freeMemoryMb: 2_048,
  })
  assert.equal(memoryPlan.workerThreads, 3)
  assert.equal(memoryPlan.memoryLimitedThreads, 3)
  assert.equal(memoryPlan.replayProcessByteBudgetMb, 576)
  assert.equal(
    memoryPlan.workerThreads * memoryPlan.estimatedWorkerMemoryMb +
      memoryPlan.replayProcessByteBudgetMb,
    memoryPlan.freeMemoryMb - memoryPlan.reservedMemoryMb,
  )
  assert.equal(memoryPlan.ingestConcurrency, 8)

  const explicitPlan = workerResourcePlan({
    env: {
      WT_WORKER_THREADS: '4',
      WT_WORKER_RESERVE_CPUS: '2',
      WT_WORKER_BACKGROUND_RESERVE: '2',
      WT_INGEST_CONCURRENCY: '2',
      WT_WORKER_MAX_OLD_SPACE_MB: '512',
    },
    availableCpus: 12,
    totalMemoryMb: 16_384,
  })
  assert.equal(explicitPlan.workerThreads, 4)
  assert.equal(explicitPlan.explicitWorkerThreads, true)
  assert.equal(explicitPlan.backgroundReserveSlots, 2)
  assert.equal(explicitPlan.ingestConcurrency, 2)
  assert.equal(explicitPlan.maxOldGenerationSizeMb, 512)

  const cappedExplicitPlan = workerResourcePlan({
    env: { WT_WORKER_THREADS: '9' },
    availableCpus: 12,
    totalMemoryMb: 16_384,
  })
  assert.equal(cappedExplicitPlan.workerThreads, 8)
  assert.equal(cappedExplicitPlan.backgroundWorkerThreads, 7)

  const cappedIngestPlan = workerResourcePlan({
    env: { WT_INGEST_CONCURRENCY: '999' },
    availableCpus: 12,
    totalMemoryMb: 16_384,
  })
  assert.equal(cappedIngestPlan.ingestConcurrency, 32)

  assert.equal(isWorkerPoolSchedulingError(new WorkerPoolError('queue', 'QUEUE_MEMORY')), true)
  assert.equal(isWorkerPoolSchedulingError(new WorkerPoolError('execution timeout', 'EXEC_TIMEOUT')), true)
  assert.equal(isWorkerPoolSchedulingError(new WorkerPoolError('oversized', 'TASK_TOO_LARGE')), false)

  assert.equal(
    routePath([
      { x: 0, y: 0, time: 0 },
      { x: 20, y: 0, time: 1 },
      { x: 20, y: 20, time: 2 },
    ]),
    'M0 0L13 0Q20 0 20 7L20 20',
    'поворот маршрута не получил ограниченное скругление',
  )
  assert.equal(
    routePath([
      { x: 0, y: 0, time: 0 },
      { x: 20, y: 0, time: 1 },
      { x: 40, y: 0, time: 2 },
    ]),
    'M0 0L20 0L40 0',
    'прямой маршрут не должен изгибаться',
  )
  assert.equal(
    routePath([
      { x: 0, y: 0, time: 0 },
      { x: 20, y: 0, time: 1 },
      { x: 0, y: 0, time: 2 },
    ]),
    'M0 0L20 0L0 0',
    'резкий разворот маршрута должен оставаться явным',
  )

  const malformed = transferableBuffer(Uint8Array.from([1, 2, 3, 4]))
  await assert.rejects(
    runWorkerTask(
      { kind: 'parse-results', input: { part: malformed, realNames: [] } },
      { transferList: [malformed] },
    ),
    /короче заголовка/,
  )

  await assert.rejects(
    runWorkerTask(
      {
        kind: 'render-scoreboard',
        input: {
          input: { missionName: '[Domination] Timeout check', header, results, dict: {} },
          assets: { unitIcons: [], mapImage: null, gameFont: false, gameFlags: [], fontFiles: [] },
        },
      },
      { timeoutMs: 1 },
    ),
    /таймаут/,
  )

  const csv = transferableBuffer(Buffer.from('"test_tank_shop";"Test Tank"\n'))
  const wpcost = transferableBuffer(Buffer.from('{"test_tank":{"unitClass":"exp_tank","country":"country_usa"}}'))
  const tags = transferableBuffer(Buffer.from('{}'))
  const dict = await runWorkerTask(
    { kind: 'build-vehicle-dict', input: { csv, wpcost, tags } },
    { transferList: [csv, wpcost, tags] },
  )
  assert.equal(dict['test_tank']?.name, 'Test Tank')

  // /scout flag templates: Resvg is imported in the worker only for this task.
  const flagSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="66" viewBox="0 0 100 66"><rect width="100" height="66" fill="#0000ff"/></svg>'
  const flagTemplates = await runWorkerTask({ kind: 'render-flag-templates', input: { svgs: [['test', flagSvg], ['test_round', flagSvg]] } })
  assert.deepEqual(flagTemplates.icons, ['test'], 'round badges are no flags')
  assert.deepEqual([...new Uint8Array(flagTemplates.rgb).subarray(0, 3)], [0, 0, 255])

  const missionDocument = transferableBuffer(Buffer.from(JSON.stringify({
    imports: { import_record: { file: 'gamedata/missions/template.blk', importAreas: true } },
    areas: {
      test_area: { tm: [[100, 0, 0], [0, 1, 0], [0, 0, 120], [10, 0, 20]] },
    },
    battleArea: { target: 'test_area' },
    briefing: { icontype: 'basezone_A', target: 'test_area' },
  })))
  const mission = await runWorkerTask(
    { kind: 'parse-mission', input: { document: missionDocument } },
    { transferList: [missionDocument] },
  )
  assert.deepEqual(mission.imports, ['gamedata/missions/template.blk'])
  assert.equal(mission.areas[0]?.[0], 'test_area')
  assert.equal(mission.zoneIcons[0]?.letter, 'A')

  const blob = transferableBuffer(gzipSync(Buffer.from(JSON.stringify({ ...events, errors: undefined }))))
  const selectedBlob = transferableBuffer(gzipSync(Buffer.from(JSON.stringify({ ...events, errors: undefined }))))
  const chatBlob = transferableBuffer(gzipSync(Buffer.from(JSON.stringify({ ...events, errors: undefined }))))
  const [scoreboard, media, selected, chat] = await Promise.all([
    runWorkerTask({
      kind: 'render-scoreboard',
      input: {
        input: { missionName: renderMissionName, header, results, dict: {} },
        assets: { unitIcons: [], mapImage: null, gameFont: false, gameFlags: [], fontFiles: [] },
      },
    }),
    runWorkerTask(
      {
        kind: 'render-media',
        input: {
          missionName: renderMissionName,
          header,
          results,
          eventsBlob: blob,
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
        },
      },
      { transferList: [blob] },
    ),
    runWorkerTask(
      {
        kind: 'render-media-kind',
        input: {
          kind: 'heatmap-air',
          missionName: renderMissionName,
          header,
          results,
          eventsBlob: selectedBlob,
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
        },
      },
      { transferList: [selectedBlob] },
    ),
    runWorkerTask(
      {
        kind: 'render-media-kind',
        input: {
          kind: 'chat',
          missionName: renderMissionName,
          header,
          results,
          eventsBlob: chatBlob,
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
        },
      },
      { transferList: [chatBlob] },
    ),
  ])

  assert.equal(isPng(scoreboard), true, 'scoreboard worker вернул не PNG')
  assert.equal(isPng(media.log), true, 'log worker вернул не PNG')
  assert.equal(isPng(media.heatmapGround), true, 'ground heatmap worker вернул не PNG')
  assert.equal(isPng(media.heatmapTeamGround[0]), true, 'team 1 heatmap worker вернул не PNG')
  assert.equal(isPng(media.heatmapTeamGround[1]), true, 'team 2 heatmap worker вернул не PNG')
  assert.equal(media.heatmapAir, null, 'ground-only bundle не должен рендерить air heatmap')
  assert.equal(media.heatmapTeamAir, null, 'ground-only bundle не должен рендерить team air heatmaps')
  assert.equal(media.summary.teamWon, 1)
  assert.equal(media.summary.endTimeMs, 60_000)
  assert.equal(media.summary.airUnits, 0)
  assert.ok(selected.media instanceof ArrayBuffer, 'одиночная heatmap вернула не ArrayBuffer')
  assert.equal(isPng(selected.media), true, 'одиночная heatmap worker вернула не PNG')
  assert.equal(selected.summary.teamWon, media.summary.teamWon)
  assert.equal(typeof chat.media, 'string')
  assert.equal(chat.media, media.chat)
  assert.ok(selected.profile.totalMs > 0)
  assert.ok(media.profile.font, 'bundle profile не содержит конфигурацию шрифтов')
  if (media.profile.font.uiFileCount === 0) assert.equal(media.profile.font.loadSystemFonts, true)
  assert.ok(media.profile.font.defaultFamily.length > 0)
  assert.ok(
    media.profile.font.scriptFileCount > 0 || media.profile.font.loadSystemFonts,
    'CJK-текст не получил явный шрифт или системный fallback',
  )
  assert.equal(selected.profile.font?.source, media.profile.font.source)
  const poolSnapshot = workerPoolSnapshot()
  assert.equal(poolSnapshot.current.queued, 0)
  assert.equal(poolSnapshot.current.running, 0)
  assert.ok(poolSnapshot.highWater.queued >= 1)
  assert.ok(poolSnapshot.highWater.running >= 1)
  assert.ok(poolSnapshot.cumulative.completed >= 7)
  assert.ok(poolSnapshot.cumulative.failed >= 2)
  assert.ok(
    (poolSnapshot.cumulative.reasons['EXEC_TIMEOUT'] ?? 0) +
      (poolSnapshot.cumulative.reasons['QUEUE_TIMEOUT'] ?? 0) >= 1,
    'pool snapshot не зафиксировал timeout reason',
  )
  const renderMetrics = poolSnapshot.workloads.find((entry) => entry.kind === 'render-media')
  assert.ok(renderMetrics && renderMetrics.outputTransferBytes > 0)
  const parseErrorMetrics = poolSnapshot.workloads.find((entry) => entry.kind === 'parse-results')
  assert.ok(parseErrorMetrics && parseErrorMetrics.failed >= 1)
  assert.ok(maxLagMs < 250, `event loop задержался на ${Math.round(maxLagMs)} мс`)
  console.log(`[workers] smoke OK · max event-loop lag ${Math.round(maxLagMs)} мс`)
} finally {
  clearInterval(heartbeat)
  await closeWorkerPool()
}
