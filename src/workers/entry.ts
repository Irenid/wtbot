import { parentPort } from 'node:worker_threads'
import { formatBattleChat } from '../wrpl/battle-chat.js'
import { decodeEventsBlob, parseBattleParts, summarizeEvents } from '../wrpl/battle-transform.js'
import { applyRealNames, parseReplayResults, parseWrplHeader } from '../wrpl/replay.js'
import { buildBattleLogSvg } from '../wrpl/render-battle-log.js'
import { buildBattleSvg } from '../wrpl/render-battle.js'
import { buildHeatmapSvg } from '../wrpl/render-heatmap.js'
import { summarizeMissionDocument } from '../wrpl/mission-info.js'
import { unpackVromfs } from '../wrpl/vromfs.js'
import { buildVehicleDict } from '../wrpl/vehicles.js'
import type {
  AnyWorkerTask,
  MediaRenderInput,
  RenderedMediaResult,
  SerializedWorkerError,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js'

if (!parentPort) throw new Error('CPU worker запущен без parentPort')
const port = parentPort

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(data.byteLength)
  owned.set(data)
  return owned.buffer
}

function dataUri(mime: string, data: ArrayBuffer): string {
  return `data:${mime};base64,${Buffer.from(data).toString('base64')}`
}

async function rasterize(svg: string, fontFiles: string[]): Promise<ArrayBuffer> {
  // Native binding нужен только рендеру. Его отсутствие не должно выключать
  // WRPL parse/font/vehicle tasks во всём пуле.
  const { Resvg } = await import('@resvg/resvg-js')
  const png = new Resvg(svg, {
    font: { loadSystemFonts: true, fontFiles, defaultFontFamily: 'Segoe UI' },
  }).render().asPng()
  return exactArrayBuffer(png)
}

async function parseResults(input: Extract<AnyWorkerTask, { kind: 'parse-results' }>['input']) {
  const part = Buffer.from(input.part)
  const header = parseWrplHeader(part)
  if (header.resultsBlkOffset <= 0 || header.resultsBlkOffset >= part.length) return null
  const results = parseReplayResults(part.subarray(header.resultsBlkOffset))
  applyRealNames(results, new Map(input.realNames))
  return { header, results }
}

async function parseBattle(input: Extract<AnyWorkerTask, { kind: 'parse-battle' }>['input']) {
  const parts = input.parts.map((part) => Buffer.from(part))
  const parsed = await parseBattleParts(parts, new Map(input.realNames), input.meta, input.ecsHashesJson)
  const eventsBlob = exactArrayBuffer(parsed.battle.eventsBlob)
  return {
    value: {
      header: parsed.header,
      results: parsed.results,
      battle: { ...parsed.battle, eventsBlob },
      summary: parsed.summary,
    },
    transfer: [eventsBlob],
  }
}

async function renderScoreboard(input: Extract<AnyWorkerTask, { kind: 'render-scoreboard' }>['input']) {
  const svg = buildBattleSvg(input.input, {
    unitIcons: new Map(input.assets.unitIcons.map(([id, data]) => [id, dataUri('image/png', data)])),
    mapImage: input.assets.mapImage ? dataUri(input.assets.mapImage.mime, input.assets.mapImage.data) : null,
    gameFont: input.assets.gameFont,
  })
  const png = await rasterize(svg, input.assets.fontFiles)
  return { value: png, transfer: [png] }
}

async function renderMedia(input: MediaRenderInput): Promise<{ value: RenderedMediaResult; transfer: ArrayBuffer[] }> {
  const events = decodeEventsBlob(Buffer.from(input.eventsBlob))
  const seekers = new Map(input.assets.seekers)
  const tacticalMap = input.assets.tacticalMap ? dataUri('image/png', input.assets.tacticalMap) : null
  const fallbackMap = input.assets.fallbackMap
    ? dataUri(input.assets.fallbackMap.mime, input.assets.fallbackMap.data)
    : null
  const shared = {
    missionName: input.missionName,
    header: input.header,
    results: input.results,
    events,
    dict: input.dict,
  }
  const log = await rasterize(buildBattleLogSvg(shared), input.assets.fontFiles)
  const heatmapGround = await rasterize(
    buildHeatmapSvg(
      { ...shared, mission: input.mission, mode: 'ground', seekers },
      input.assets.gameFont,
      tacticalMap,
      fallbackMap,
    ),
    input.assets.fontFiles,
  )
  const heatmapAir = await rasterize(
    buildHeatmapSvg(
      { ...shared, mission: input.mission, mode: 'air', seekers },
      input.assets.gameFont,
      tacticalMap,
      fallbackMap,
    ),
    input.assets.fontFiles,
  )
  const heatmapTeamGround: [ArrayBuffer, ArrayBuffer] = [
    await rasterize(
      buildHeatmapSvg(
        { ...shared, mission: input.mission, mode: 'ground', seekers, teamIndex: 0 },
        input.assets.gameFont,
        tacticalMap,
        fallbackMap,
      ),
      input.assets.fontFiles,
    ),
    await rasterize(
      buildHeatmapSvg(
        { ...shared, mission: input.mission, mode: 'ground', seekers, teamIndex: 1 },
        input.assets.gameFont,
        tacticalMap,
        fallbackMap,
      ),
      input.assets.fontFiles,
    ),
  ]
  const heatmapTeamAir: [ArrayBuffer, ArrayBuffer] = [
    await rasterize(
      buildHeatmapSvg(
        { ...shared, mission: input.mission, mode: 'air', seekers, teamIndex: 0 },
        input.assets.gameFont,
        tacticalMap,
        fallbackMap,
      ),
      input.assets.fontFiles,
    ),
    await rasterize(
      buildHeatmapSvg(
        { ...shared, mission: input.mission, mode: 'air', seekers, teamIndex: 1 },
        input.assets.gameFont,
        tacticalMap,
        fallbackMap,
      ),
      input.assets.fontFiles,
    ),
  ]
  return {
    value: {
      log,
      heatmapGround,
      heatmapAir,
      heatmapTeamGround,
      heatmapTeamAir,
      chat: formatBattleChat(events),
      summary: summarizeEvents(events),
    },
    transfer: [log, heatmapGround, heatmapAir, ...heatmapTeamGround, ...heatmapTeamAir],
  }
}

function extractGameFont(input: Extract<AnyWorkerTask, { kind: 'extract-game-font' }>['input']) {
  const files = unpackVromfs(Buffer.from(input.vromfs))
  const font = files.find((file) => file.name === 'ttfs/symbols_skyquake.ttf')
  if (!font) return { value: null, transfer: [] }
  const data = exactArrayBuffer(font.data)
  return { value: data, transfer: [data] }
}

function buildVehicles(input: Extract<AnyWorkerTask, { kind: 'build-vehicle-dict' }>['input']) {
  return {
    value: buildVehicleDict(
      Buffer.from(input.csv).toString('utf8'),
      Buffer.from(input.wpcost).toString('utf8'),
      Buffer.from(input.tags).toString('utf8'),
    ),
    transfer: [],
  }
}

function parseMission(input: Extract<AnyWorkerTask, { kind: 'parse-mission' }>['input']) {
  return {
    value: summarizeMissionDocument(Buffer.from(input.document).toString('utf8')),
    transfer: [],
  }
}

async function execute(task: AnyWorkerTask): Promise<{ value: unknown; transfer: ArrayBuffer[] }> {
  switch (task.kind) {
    case 'parse-results':
      return { value: await parseResults(task.input), transfer: [] }
    case 'parse-battle':
      return parseBattle(task.input)
    case 'render-scoreboard':
      return await renderScoreboard(task.input)
    case 'render-media':
      return await renderMedia(task.input)
    case 'extract-game-font':
      return extractGameFont(task.input)
    case 'build-vehicle-dict':
      return buildVehicles(task.input)
    case 'parse-mission':
      return parseMission(task.input)
  }
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'Error', message: String(error) }
}

port.on('message', (request: WorkerRequest) => {
  void execute(request.task).then(
    ({ value, transfer }) => {
      const response: WorkerResponse = { id: request.id, ok: true, value }
      const message: WorkerMessage = { type: 'result', response }
      port.postMessage(message, transfer)
    },
    (error: unknown) => {
      const response: WorkerResponse = { id: request.id, ok: false, error: serializeError(error) }
      port.postMessage({ type: 'result', response } satisfies WorkerMessage)
    },
  )
})

port.postMessage({ type: 'ready' } satisfies WorkerMessage)
