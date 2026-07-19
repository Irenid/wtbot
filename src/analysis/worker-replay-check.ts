import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { closeWorkerPool, runWorkerTask, transferableBuffer } from '../workers/pool.js'
import { readCachedEcsHashesJson } from '../wrpl/ecs.js'

const directoryArg = process.argv[2]
if (!directoryArg) throw new Error('Укажи каталог с частями: npm run benchmark:workers -- data/replays/<session>')
const render = process.argv.includes('--render')
const directory = path.resolve(directoryArg)
const names = (await readdir(directory)).filter((name) => /^\d{4}\.wrpl$/i.test(name)).sort()
assert.ok(names.length > 0, `В ${directory} нет частей *.wrpl`)

const files = await Promise.all(names.map((name) => readFile(path.join(directory, name))))
const totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0)
const parts = files.map(transferableBuffer)
const ecsHashesJson = await readCachedEcsHashesJson()
let lastHeartbeat = performance.now()
let maxLagMs = 0
const heartbeat = setInterval(() => {
  const now = performance.now()
  maxLagMs = Math.max(maxLagMs, now - lastHeartbeat - 10)
  lastHeartbeat = now
}, 10)

const started = performance.now()
try {
  const parsed = await runWorkerTask(
    { kind: 'parse-battle', input: { parts, realNames: [], meta: {}, ecsHashesJson } },
    { priority: 'background', transferList: parts, timeoutMs: 180_000 },
  )
  const elapsed = performance.now() - started
  const blobBytes = parsed.battle.eventsBlob.byteLength
  console.log(
    `[workers] replay ${parsed.header.sessionIdHex} · ${(totalBytes / 1024 / 1024).toFixed(1)} МБ · ` +
      `${elapsed.toFixed(0)} мс · event-loop lag ${maxLagMs.toFixed(0)} мс · ` +
      `игроков ${parsed.results.players.length}, убийств ${parsed.summary.kills}, ` +
      `траекторий ${parsed.summary.units}, blob ${(blobBytes / 1024 / 1024).toFixed(1)} МБ`,
  )
  if (render) {
    const renderStarted = performance.now()
    const media = await runWorkerTask(
      {
        kind: 'render-media',
        input: {
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
        },
      },
      { priority: 'normal', transferList: [parsed.battle.eventsBlob], timeoutMs: 180_000 },
    )
    assert.equal(isPng(media.log), true)
    assert.equal(isPng(media.heatmapGround), true)
    assert.equal(isPng(media.heatmapAir), true)
    console.log(
      `[workers] media ${Math.round(performance.now() - renderStarted)} мс · ` +
        `PNG ${Math.round((media.log.byteLength + media.heatmapGround.byteLength + media.heatmapAir.byteLength) / 1024)} КБ · ` +
        `event-loop lag ${maxLagMs.toFixed(0)} мс`,
    )
  }
} finally {
  clearInterval(heartbeat)
  await closeWorkerPool()
}

function isPng(data: ArrayBuffer): boolean {
  const signature = Buffer.from(data).subarray(0, 8)
  return signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}
