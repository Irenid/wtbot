import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { config } from '../config.js'
import { getBattleWeaponIds, markBattleIngest, saveBattle } from '../db/index.js'
import {
  runWorkerTask,
  transferableBuffer,
  type WorkerPriority,
  type WorkerTaskControl,
} from '../workers/pool.js'
import type { BattleEventSummary } from '../workers/protocol.js'
import { loadBattleData, reconstructBattle, type BattleItemMeta } from './battle-data.js'
import {
  ensureTacticalMap,
  ensureWeaponSeekers,
  loadLocalTacticalMap,
  loadMapBackground,
  loadMapIconFontPath,
} from './battle-assets.js'
import { fetchMissionInfo } from './mission-info.js'
import { dropReplayCache } from './replay-cache.js'
import type { ReplayResults, WrplHeader } from './replay.js'
import { ensureVehicleDict, promoteVehicleDictLoad } from './vehicles.js'
import { ensureGameFonts, promoteGameFontLoad } from './wt-fonts.js'
import {
  heatmapSelection,
  type BattleHeatmapKind,
  type BattleMediaKind,
} from './battle-media-kind.js'

export type { BattleHeatmapKind, BattleMediaKind } from './battle-media-kind.js'

/**
 * Дополнительные материалы боя. Диск/сеть/SQLite остаются в main thread,
 * а gunzip/JSON, SVG и Resvg-рендеры выполняются одной bundle-задачей
 * в CPU worker, без повторного клонирования больших траекторий.
 */

const CACHE_DIR = './data/battles'
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CHAT_BYTES = 2 * 1024 * 1024

export interface BattleMedia {
  log: Buffer
  heatmapGround: Buffer
  heatmapAir: Buffer
  heatmapTeamGround: [Buffer, Buffer]
  heatmapTeamAir: [Buffer, Buffer]
  chat: string
}

export interface BuiltBattleMedia extends BattleMedia {
  header: WrplHeader
  summary: BattleEventSummary
}

const cacheFile = (sessionIdHex: string, kind: BattleMediaKind): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}${kind === 'chat' ? '.txt' : '.png'}`)

const highResCacheFile = (sessionIdHex: string, kind: BattleHeatmapKind): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}@2x-v${BATTLE_MEDIA_VERSION}.png`)

/** Cache hit без синхронного чтения большого PNG на Discord event loop. */
export async function cachedBattleMedia(sessionIdHex: string, kind: BattleMediaKind): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  if (!(await cachedBattleMeta(sessionIdHex))) return null
  const file = cacheFile(sessionIdHex, kind)
  try {
    const maxBytes = kind === 'chat' ? MAX_CHAT_BYTES : MAX_IMAGE_BYTES
    if ((await stat(file)).size > maxBytes) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const data = await readFile(file)
    if (kind !== 'chat' && !isPng(data)) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const now = new Date()
    await utimes(file, now, now).catch(() => undefined)
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface BattleMeta {
  version?: 40
  renderOptions?: string
  teamWon: number
  endTimeMs: number
  hasAir: boolean
  hasChat: boolean
}

/** Ленивый 2×-кэш одной выбранной карты; обычный bundle при этом не пересобирается. */
export async function cachedBattleHeatmap2x(
  sessionIdHex: string,
  kind: BattleHeatmapKind,
): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  if (!(await cachedBattleMeta(sessionIdHex))) return null
  const file = highResCacheFile(sessionIdHex, kind)
  try {
    if ((await stat(file)).size > MAX_IMAGE_BYTES) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const data = await readFile(file)
    if (!isPng(data)) {
      await rm(file, { force: true }).catch(() => undefined)
      return null
    }
    const now = new Date()
    await utimes(file, now, now).catch(() => undefined)
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const BATTLE_MEDIA_VERSION = 40
const BATTLE_MEDIA_RENDER_OPTIONS = JSON.stringify(config.heatmapOptions)

export async function cachedBattleMeta(sessionIdHex: string): Promise<BattleMeta | null> {
  if (!config.battleCacheEnabled) return null
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return null
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(CACHE_DIR, `${sessionIdHex}-meta.json`), 'utf8'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as BattleMeta).version === BATTLE_MEDIA_VERSION &&
      (parsed as BattleMeta).renderOptions === BATTLE_MEDIA_RENDER_OPTIONS &&
      Number.isFinite((parsed as BattleMeta).teamWon) &&
      Number.isFinite((parsed as BattleMeta).endTimeMs) &&
      typeof (parsed as BattleMeta).hasAir === 'boolean' &&
      typeof (parsed as BattleMeta).hasChat === 'boolean'
    ) {
      await touchBattleBundle(sessionIdHex)
      return parsed as BattleMeta
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

interface MediaBuildState {
  priority: WorkerPriority
  workerControls: Set<WorkerTaskControl>
}

const inflightBuilds = new Map<string, { promise: Promise<BuiltBattleMedia>; state: MediaBuildState }>()
const inflightHeatmapBuilds = new Map<string, { promise: Promise<Buffer>; state: MediaBuildState }>()
const activeCacheSessions = new Set<string>()

/** Рендерит только запрошенную heatmap в 2×, не создавая остальные материалы боя. */
export function buildBattleHeatmap2x(
  sessionId: string,
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const sessionHex = toSessionHex(sessionId)
  const key = `${sessionHex}:${kind}:2`
  const running = inflightHeatmapBuilds.get(key)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  activeCacheSessions.add(sessionHex)
  const build = doBuildBattleHeatmap2x(sessionId, kind, meta, state).finally(() => {
    inflightHeatmapBuilds.delete(key)
    activeCacheSessions.delete(sessionHex)
  })
  inflightHeatmapBuilds.set(key, { promise: build, state })
  return build
}

async function doBuildBattleHeatmap2x(
  sessionId: string,
  kind: BattleHeatmapKind,
  meta: BattleItemMeta,
  state: MediaBuildState,
): Promise<Buffer> {
  const stored = reconstructBattle(sessionId)
  if (!stored?.eventsBlob) throw new Error('Бой ещё не сохранён в базе для HD-рендера')

  const missionName = meta.missionName ?? stored.header.locName ?? ''
  const weaponIds = getBattleWeaponIds(stored.header.sessionId)
  const trackMission = workerControlTracker(state)
  const [dict, mission, gameFontFiles, seekers, mapIconFont] = await Promise.all([
    ensureVehicleDict(state.priority),
    stored.missionSettings
      ? fetchMissionInfo(stored.missionSettings, () => state.priority, trackMission)
      : Promise.resolve(null),
    ensureGameFonts(state.priority),
    ensureWeaponSeekers(weaponIds),
    loadMapIconFontPath(),
  ])
  const fontFiles = mapIconFont ? [...gameFontFiles, mapIconFont] : gameFontFiles
  const tacticalMap = mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(stored.header.level))
    : null
  const fallbackMap = await loadMapBackground(stored.header.level)
  const wireBlob = transferableBuffer(stored.eventsBlob)
  const wireTacticalMap = tacticalMap ? transferableBuffer(tacticalMap) : null
  const wireFallbackMap = fallbackMap
    ? {
        mime: fallbackMap.mime,
        data: transferableBuffer(fallbackMap.data),
        ...(fallbackMap.viewport ? { viewport: fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
  if (wireFallbackMap) transferList.push(wireFallbackMap.data)
  const selection = heatmapSelection(kind)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-heatmap',
      input: {
        missionName,
        header: stored.header,
        results: stored.results,
        eventsBlob: wireBlob,
        dict,
        mission,
        heatmapOptions: config.heatmapOptions,
        mode: selection.mode,
        ...(selection.teamIndex === undefined ? {} : { teamIndex: selection.teamIndex }),
        scale: 2,
        assets: {
          fontFiles,
          gameFont: gameFontFiles.length > 0,
          mapIconFont: mapIconFont !== null,
          tacticalMap: wireTacticalMap,
          fallbackMap: wireFallbackMap,
          seekers: [...seekers],
        },
      },
    },
    {
      priority: state.priority,
      transferList,
      timeoutMs: 120_000,
      onControl: (control) => trackRender(control),
    },
  ).finally(() => trackRender(null))
  const png = Buffer.from(rendered)
  if (png.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`HD-карта слишком велика: ${(png.byteLength / 1024 / 1024).toFixed(1)} МБ`)
  }
  // Флаг управляет повторным использованием, но результат каждого рендера
  // сохраняется на диск независимо от него.
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFileAtomic(highResCacheFile(stored.header.sessionIdHex, kind), png)
  await enforceCacheCap()
  return png
}

export function buildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string> = new Map(),
  priority: WorkerPriority = 'interactive',
): Promise<BuiltBattleMedia> {
  const sessionHex = toSessionHex(sessionId)
  const running = inflightBuilds.get(sessionHex)
  if (running) {
    promoteBuild(running.state, priority)
    return running.promise
  }
  const state: MediaBuildState = { priority, workerControls: new Set() }
  activeCacheSessions.add(sessionHex)
  const build = doBuildBattleMedia(sessionId, partUrls, meta, realNames, state).finally(() => {
    inflightBuilds.delete(sessionHex)
    activeCacheSessions.delete(sessionHex)
  })
  inflightBuilds.set(sessionHex, { promise: build, state })
  return build
}

async function doBuildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string>,
  state: MediaBuildState,
): Promise<BuiltBattleMedia> {
  let header: WrplHeader
  let results: ReplayResults
  let eventsBlob: Buffer
  let missionSettings: string | null
  let weaponIds: string[]
  let parseErrors: string[] = []

  const stored = reconstructBattle(sessionId)
  if (stored?.eventsBlob) {
    header = stored.header
    results = stored.results
    eventsBlob = stored.eventsBlob
    missionSettings = stored.missionSettings
    weaponIds = getBattleWeaponIds(header.sessionId)
  } else {
    const trackLoad = workerControlTracker(state)
    const loaded = await loadBattleData(
      partUrls,
      realNames,
      meta,
      () => state.priority,
      undefined,
      (control) => trackLoad(control),
    ).finally(() => trackLoad(null))
    header = loaded.header
    results = loaded.results
    eventsBlob = loaded.battle.eventsBlob
    missionSettings = loaded.battle.missionSettings
    weaponIds = loaded.battle.kills.map((kill) => kill.weapon).filter(Boolean)
    parseErrors = loaded.summary.errors
    if (parseErrors.length > 0) {
      console.warn(
        `[wrpl] события ${header.sessionId}: ${parseErrors.length} ошибок разбора, первая: ${parseErrors[0]}`,
      )
    }
    try {
      saveBattle(loaded.battle)
      markBattleIngest(header.sessionId, 'ok')
      await dropReplayCache(header.sessionIdHex)
    } catch (error) {
      console.warn(`[wrpl] не сохранил бой ${header.sessionId} в БД: ${(error as Error).message}`)
    }
  }

  const missionName = meta.missionName ?? header.locName ?? ''
  const trackMission = workerControlTracker(state)
  const [dict, mission, gameFontFiles, seekers, mapIconFont] = await Promise.all([
    ensureVehicleDict(state.priority),
    missionSettings
      ? fetchMissionInfo(missionSettings, () => state.priority, trackMission)
      : Promise.resolve(null),
    ensureGameFonts(state.priority),
    ensureWeaponSeekers(weaponIds),
    loadMapIconFontPath(),
  ])
  const fontFiles = mapIconFont ? [...gameFontFiles, mapIconFont] : gameFontFiles
  const tacticalMap = mission?.area
    ? (await ensureTacticalMap(missionName) ?? await loadLocalTacticalMap(header.level))
    : null
  const fallbackMap = await loadMapBackground(header.level)

  const wireBlob = transferableBuffer(eventsBlob)
  const wireTacticalMap = tacticalMap ? transferableBuffer(tacticalMap) : null
  const wireFallbackMap = fallbackMap
    ? {
        mime: fallbackMap.mime,
        data: transferableBuffer(fallbackMap.data),
        ...(fallbackMap.viewport ? { viewport: fallbackMap.viewport } : {}),
      }
    : null
  const transferList = [wireBlob]
  if (wireTacticalMap) transferList.push(wireTacticalMap)
  if (wireFallbackMap) transferList.push(wireFallbackMap.data)
  const trackRender = workerControlTracker(state)
  const rendered = await runWorkerTask(
    {
      kind: 'render-media',
      input: {
        missionName,
        header,
        results,
        eventsBlob: wireBlob,
        dict,
        mission,
        heatmapOptions: config.heatmapOptions,
        assets: {
          fontFiles,
          gameFont: gameFontFiles.length > 0,
          mapIconFont: mapIconFont !== null,
          tacticalMap: wireTacticalMap,
          fallbackMap: wireFallbackMap,
          seekers: [...seekers],
        },
      },
    },
    {
      priority: state.priority,
      transferList,
      timeoutMs: 120_000,
      onControl: (control) => trackRender(control),
    },
  ).finally(() => trackRender(null))
  const log = Buffer.from(rendered.log)
  const heatmapGround = Buffer.from(rendered.heatmapGround)
  const heatmapAir = Buffer.from(rendered.heatmapAir)
  const heatmapTeamGround: [Buffer, Buffer] = [
    Buffer.from(rendered.heatmapTeamGround[0]),
    Buffer.from(rendered.heatmapTeamGround[1]),
  ]
  const heatmapTeamAir: [Buffer, Buffer] = [
    Buffer.from(rendered.heatmapTeamAir[0]),
    Buffer.from(rendered.heatmapTeamAir[1]),
  ]
  const summary = { ...rendered.summary, errors: parseErrors }
  const metadata = JSON.stringify({
    version: BATTLE_MEDIA_VERSION,
    renderOptions: BATTLE_MEDIA_RENDER_OPTIONS,
    teamWon: summary.teamWon,
    endTimeMs: summary.endTimeMs,
    hasAir: summary.airModels.some((model) => {
      const vehicleClass = dict[model.replace(/^.*\//, '')]?.cls
      return vehicleClass === 'F' || vehicleClass === 'H'
    }),
    hasChat: summary.chat > 0,
  } satisfies BattleMeta)

  // Даже при отключённом reuse сохраняем последнее поколение материалов.
  await mkdir(CACHE_DIR, { recursive: true })
  const metaFile = path.join(CACHE_DIR, `${header.sessionIdHex}-meta.json`)
  // meta.json — commit marker. Пока все материалы не опубликованы целиком,
  // cache readers видят miss и не отдают смесь старого и нового поколения.
  await rm(metaFile, { force: true })
  await Promise.all([
    writeFileAtomic(cacheFile(header.sessionIdHex, 'log'), log),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-ground'), heatmapGround),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-air'), heatmapAir),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-team-0'), heatmapTeamGround[0]),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-team-1'), heatmapTeamGround[1]),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-team-air-0'), heatmapTeamAir[0]),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'heatmap-team-air-1'), heatmapTeamAir[1]),
    writeFileAtomic(cacheFile(header.sessionIdHex, 'chat'), rendered.chat),
  ])
  await writeFileAtomic(metaFile, metadata)
  await enforceCacheCap()

  return { log, heatmapGround, heatmapAir, heatmapTeamGround, heatmapTeamAir, chat: rendered.chat, header, summary }
}

const CACHE_CAP_BYTES = Math.max(50, Number(config.battleCacheMb) || 400) * 1024 * 1024
let cacheCapChecked = false
let cacheCapRun: Promise<void> | null = null

function enforceCacheCap(): Promise<void> {
  if (cacheCapRun) return cacheCapRun
  cacheCapRun = doEnforceCacheCap().finally(() => {
    cacheCapRun = null
  })
  return cacheCapRun
}

async function doEnforceCacheCap(): Promise<void> {
  try {
    const entries = await readdir(CACHE_DIR, { withFileTypes: true })
    interface CacheFile {
      path: string
      size: number
      mtime: number
    }
    interface CacheBundle {
      session: string | null
      files: CacheFile[]
      size: number
      mtime: number
    }
    const bundles = new Map<string, CacheBundle>()
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
      const session = /^([0-9a-f]{12,20})(?:-|\.png$)/i.exec(entry.name)?.[1]?.toLowerCase() ?? null
      const file = path.join(CACHE_DIR, entry.name)
      try {
        const info = await stat(file)
        const key = session ? `session:${session}` : `file:${entry.name}`
        const bundle = bundles.get(key) ?? { session, files: [], size: 0, mtime: 0 }
        bundle.files.push({ path: file, size: info.size, mtime: info.mtimeMs })
        bundle.size += info.size
        bundle.mtime = Math.max(bundle.mtime, info.mtimeMs)
        bundles.set(key, bundle)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const candidates = [...bundles.values()]
    let total = candidates.reduce((sum, bundle) => sum + bundle.size, 0)
    if (total <= CACHE_CAP_BYTES) {
      cacheCapChecked = true
      return
    }
    const target = CACHE_CAP_BYTES * 0.9
    candidates.sort((left, right) => left.mtime - right.mtime)
    let removedFiles = 0
    let removedBundles = 0
    for (const bundle of candidates) {
      if (total <= target) break
      if (bundle.session && activeCacheSessions.has(bundle.session)) continue
      try {
        let unchanged = true
        for (const file of bundle.files) {
          const current = await stat(file.path)
          if (current.size !== file.size || current.mtimeMs !== file.mtime) {
            unchanged = false
            break
          }
        }
        if (!unchanged || (bundle.session && activeCacheSessions.has(bundle.session))) continue
        // Commit marker удаляется первым: читатель увидит cache miss, а не
        // частично вытесненное поколение PNG/TXT.
        const marker = bundle.files.find((file) => file.path.endsWith('-meta.json'))
        if (marker) await rm(marker.path, { force: true })
        await Promise.all(
          bundle.files.filter((file) => file !== marker).map((file) => rm(file.path, { force: true })),
        )
        total -= bundle.size
        removedFiles += bundle.files.length
        removedBundles++
      } catch {
        // Гонка очистки/чтения не должна ломать готовый ответ Discord.
      }
    }
    if (!cacheCapChecked && removedFiles > 0) {
      console.log(
        `[battle-media] кэш картинок превысил ${(CACHE_CAP_BYTES / 1024 / 1024) | 0} МБ — ` +
          `вытеснено ${removedBundles} наборов (${removedFiles} файлов)`,
      )
    }
    cacheCapChecked = true
  } catch {
    // Каталога ещё нет или нет прав: рендер уже готов, не ломаем ответ.
  }
}

async function touchBattleBundle(sessionIdHex: string): Promise<void> {
  const now = new Date()
  const files = [
    path.join(CACHE_DIR, `${sessionIdHex}.png`),
    path.join(CACHE_DIR, `${sessionIdHex}-meta.json`),
    cacheFile(sessionIdHex, 'log'),
    cacheFile(sessionIdHex, 'heatmap-ground'),
    cacheFile(sessionIdHex, 'heatmap-air'),
    cacheFile(sessionIdHex, 'heatmap-team-0'),
    cacheFile(sessionIdHex, 'heatmap-team-1'),
    cacheFile(sessionIdHex, 'heatmap-team-air-0'),
    cacheFile(sessionIdHex, 'heatmap-team-air-1'),
    cacheFile(sessionIdHex, 'chat'),
  ]
  await Promise.all(files.map((file) => utimes(file, now, now).catch(() => undefined)))
}

function isPng(data: Uint8Array): boolean {
  return (
    data.byteLength >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  )
}

function toSessionHex(sessionId: string): string {
  try {
    return (/^\d+$/.test(sessionId) ? BigInt(sessionId) : BigInt(`0x${sessionId.replace(/^0x/i, '')}`))
      .toString(16)
      .padStart(16, '0')
  } catch {
    return sessionId.toLowerCase()
  }
}

function promoteBuild(state: MediaBuildState, priority: WorkerPriority): void {
  const order: WorkerPriority[] = ['interactive', 'normal', 'background']
  if (order.indexOf(priority) >= order.indexOf(state.priority)) return
  state.priority = priority
  for (const control of state.workerControls) control.promote(priority)
  // Эти cold-start зависимости — process-wide singleton jobs и могут уже
  // выполняться параллельно с mission. Их controls принадлежат своим модулям.
  promoteVehicleDictLoad(priority)
  promoteGameFontLoad(priority)
}

function workerControlTracker(state: MediaBuildState): (control: WorkerTaskControl | null) => void {
  let active: WorkerTaskControl | null = null
  return (control) => {
    if (active) state.workerControls.delete(active)
    active = control
    if (control) {
      state.workerControls.add(control)
      control.promote(state.priority)
    }
  }
}
