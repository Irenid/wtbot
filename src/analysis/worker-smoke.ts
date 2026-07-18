import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  closeWorkerPool,
  isWorkerPoolSchedulingError,
  runWorkerTask,
  transferableBuffer,
  WorkerPoolError,
} from '../workers/pool.js'
import type { ReplayEvents } from '../wrpl/replay-events.js'
import type { ReplayResults, WrplHeader } from '../wrpl/replay.js'

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
  assert.equal(isWorkerPoolSchedulingError(new WorkerPoolError('queue', 'QUEUE_MEMORY')), true)
  assert.equal(isWorkerPoolSchedulingError(new WorkerPoolError('oversized', 'TASK_TOO_LARGE')), false)

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
          assets: { unitIcons: [], mapImage: null, gameFont: false, fontFiles: [] },
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
  const [scoreboard, media] = await Promise.all([
    runWorkerTask({
      kind: 'render-scoreboard',
      input: {
        input: { missionName: '[Domination] Worker Smoke', header, results, dict: {} },
        assets: { unitIcons: [], mapImage: null, gameFont: false, fontFiles: [] },
      },
    }),
    runWorkerTask(
      {
        kind: 'render-media',
        input: {
          missionName: '[Domination] Worker Smoke',
          header,
          results,
          eventsBlob: blob,
          dict: {},
          mission: null,
          assets: {
            fontFiles: [],
            gameFont: false,
            tacticalMap: null,
            fallbackMap: null,
            seekers: [],
          },
        },
      },
      { transferList: [blob] },
    ),
  ])

  assert.equal(isPng(scoreboard), true, 'scoreboard worker вернул не PNG')
  assert.equal(isPng(media.log), true, 'log worker вернул не PNG')
  assert.equal(isPng(media.heatmapGround), true, 'ground heatmap worker вернул не PNG')
  assert.equal(isPng(media.heatmapAir), true, 'air heatmap worker вернул не PNG')
  assert.equal(media.summary.teamWon, 1)
  assert.equal(media.summary.endTimeMs, 60_000)
  assert.ok(maxLagMs < 250, `event loop задержался на ${Math.round(maxLagMs)} мс`)
  console.log(`[workers] smoke OK · max event-loop lag ${Math.round(maxLagMs)} мс`)
} finally {
  clearInterval(heartbeat)
  await closeWorkerPool()
}
