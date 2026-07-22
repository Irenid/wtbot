import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file.js'
import { readResponseBuffer, readResponseJson } from '../http-response.js'
import { levelId } from '../wrpl/battle-assets.js'

const DEFAULT_BASE_URL = 'http://localhost:8111'
const MAPS_DIR = './data/maps'
const FONTS_DIR = './data/fonts'
const MAP_FONT_FILE = path.join(FONTS_DIR, 'map-icons.ttf')

interface MapInfoResponse {
  valid: boolean
  map_generation: number
  map_min: [number, number]
  map_max: [number, number]
  grid_zero: [number, number]
  grid_size: [number, number]
  grid_steps: [number, number]
  hud_type?: number
}

interface MapObjectResponse {
  type?: unknown
  x?: unknown
  y?: unknown
  sx?: unknown
  sy?: unknown
  ex?: unknown
  ey?: unknown
  color?: unknown
  zone_label?: unknown
}

interface NormalizedPoint {
  x: number
  y: number
}

interface CapturedViewport {
  x: number
  y: number
  width: number
  height: number
  gridStepX: number
  gridStepY: number
  gridStepMeters: number
  captureZones: { letter: string; x: number; y: number }[]
  groundSpawns: NormalizedPoint[]
  airfields: { sx: number; sy: number; ex: number; ey: number; color: string }[]
  airSpawns: { x: number; y: number; color: string }[]
}

function finitePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
}

function validMapInfo(value: unknown): value is MapInfoResponse {
  if (value === null || typeof value !== 'object') return false
  const info = value as Partial<MapInfoResponse>
  return info.valid === true && typeof info.map_generation === 'number' &&
    finitePair(info.map_min) && finitePair(info.map_max) && finitePair(info.grid_zero) &&
    finitePair(info.grid_size) && finitePair(info.grid_steps) &&
    info.map_max[0] > info.map_min[0] && info.map_max[1] > info.map_min[1] &&
    info.grid_size[0] > 0 && info.grid_size[1] > 0 &&
    info.grid_steps[0] > 0 && info.grid_steps[1] > 0
}

function normalizedPoint(value: MapObjectResponse, viewport: CapturedViewport): NormalizedPoint | null {
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) ||
      typeof value.y !== 'number' || !Number.isFinite(value.y)) return null
  const x = (value.x - viewport.x) / viewport.width
  const y = (value.y - viewport.y) / viewport.height
  if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

function fullMapPoint(x: unknown, y: unknown): NormalizedPoint | null {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1 ||
      typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) return null
  return { x, y }
}

function mapColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#f2f4f7'
}

/** Объединяет десятки разрешённых позиций появления в один значок базы. */
function clusterSpawnPoints(points: NormalizedPoint[]): NormalizedPoint[] {
  const pending = [...points]
  const groups: NormalizedPoint[][] = []
  const radius = 0.13
  while (pending.length > 0) {
    const group = [pending.pop()!]
    for (let i = 0; i < group.length; i++) {
      const pivot = group[i]!
      for (let j = pending.length - 1; j >= 0; j--) {
        const candidate = pending[j]!
        if (Math.hypot(candidate.x - pivot.x, candidate.y - pivot.y) <= radius) {
          group.push(candidate)
          pending.splice(j, 1)
        }
      }
    }
    groups.push(group)
  }
  return groups
    .map((group) => ({
      x: group.reduce((sum, point) => sum + point.x, 0) / group.length,
      y: group.reduce((sum, point) => sum + point.y, 0) / group.length,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, 8)
}

function buildViewport(info: MapInfoResponse, objects: MapObjectResponse[]): CapturedViewport {
  const spanX = info.map_max[0] - info.map_min[0]
  const spanY = info.map_max[1] - info.map_min[1]
  const viewport: CapturedViewport = {
    x: (info.grid_zero[0] - info.map_min[0]) / spanX,
    y: (info.map_max[1] - info.grid_zero[1]) / spanY,
    width: info.grid_size[0] / spanX,
    height: info.grid_size[1] / spanY,
    gridStepX: info.grid_steps[0] / info.grid_size[0],
    gridStepY: info.grid_steps[1] / info.grid_size[1],
    gridStepMeters: info.grid_steps[0],
    captureZones: [],
    groundSpawns: [],
    airfields: [],
    airSpawns: [],
  }
  if (viewport.x < 0 || viewport.y < 0 || viewport.width <= 0 || viewport.height <= 0 ||
      viewport.x + viewport.width > 1.000_001 || viewport.y + viewport.height > 1.000_001) {
    throw new Error('map_info.json содержит игровую область за пределами map.img')
  }

  viewport.captureZones = objects
    .filter((object) => object.type === 'capture_zone')
    .map((object, index) => {
      const point = normalizedPoint(object, viewport)
      const label = typeof object.zone_label === 'string' && /^[A-Z0-9]$/.test(object.zone_label)
        ? object.zone_label
        : String.fromCharCode(65 + index)
      return point ? { letter: label, ...point } : null
    })
    .filter((zone): zone is { letter: string; x: number; y: number } => zone !== null)
    .sort((a, b) => a.letter.localeCompare(b.letter))

  const spawnPoints = objects
    .filter((object) => object.type === 'respawn_base_tank')
    .map((object) => normalizedPoint(object, viewport))
    .filter((point): point is NormalizedPoint => point !== null)
  viewport.groundSpawns = clusterSpawnPoints(spawnPoints)

  viewport.airfields = objects
    .filter((object) => object.type === 'airfield')
    .map((object) => {
      const start = fullMapPoint(object.sx, object.sy)
      const end = fullMapPoint(object.ex, object.ey)
      return start && end
        ? { sx: start.x, sy: start.y, ex: end.x, ey: end.y, color: mapColor(object.color) }
        : null
    })
    .filter((airfield): airfield is { sx: number; sy: number; ex: number; ey: number; color: string } => airfield !== null)
    .slice(0, 32)

  viewport.airSpawns = objects
    .filter((object) => object.type === 'respawn_base_fighter')
    .map((object) => {
      const point = fullMapPoint(object.x, object.y)
      return point ? { ...point, color: mapColor(object.color) } : null
    })
    .filter((spawn): spawn is { x: number; y: number; color: string } => spawn !== null)
    .slice(0, 16)
  return viewport
}

async function fetchChecked(baseUrl: string, endpoint: string): Promise<Response> {
  const response = await fetch(`${baseUrl}${endpoint}`, { signal: AbortSignal.timeout(7_000) })
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`)
  return response
}

function imageExtension(data: Uint8Array): 'jpg' | 'png' {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  throw new Error('map.img не является JPEG или PNG')
}

function validTtf(data: Uint8Array): boolean {
  return data.length >= 12 && data.length <= 2 * 1024 * 1024 &&
    ((data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0) ||
      String.fromCharCode(...data.subarray(0, 4)) === 'OTTO')
}

async function captureMap(rawLevel: string, baseUrl = DEFAULT_BASE_URL): Promise<void> {
  const id = levelId(rawLevel)
  if (!/^[a-z0-9_.-]+$/i.test(id)) throw new Error(`Недопустимый id уровня: ${id}`)
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const [rawInfo, rawObjects, imageResponse, fontResponse] = await Promise.all([
    readResponseJson<unknown>(await fetchChecked(normalizedBase, '/map_info.json'), 128 * 1024, 'map_info.json'),
    readResponseJson<unknown>(await fetchChecked(normalizedBase, '/map_obj.json'), 4 * 1024 * 1024, 'map_obj.json'),
    fetchChecked(normalizedBase, '/map.img'),
    fetchChecked(normalizedBase, '/icons.ttf'),
  ])
  if (!validMapInfo(rawInfo)) throw new Error('map_info.json имеет неизвестный формат или карта ещё не загружена')
  if (!Array.isArray(rawObjects)) throw new Error('map_obj.json должен содержать массив')
  const objects = rawObjects.filter((value): value is MapObjectResponse => value !== null && typeof value === 'object')
  const viewport = buildViewport(rawInfo, objects)
  const image = await readResponseBuffer(imageResponse, 32 * 1024 * 1024, 'map.img')
  const font = await readResponseBuffer(fontResponse, 2 * 1024 * 1024, 'icons.ttf')
  if (!validTtf(font)) throw new Error('icons.ttf имеет неизвестный формат')

  await Promise.all([mkdir(MAPS_DIR, { recursive: true }), mkdir(FONTS_DIR, { recursive: true })])
  const ext = imageExtension(image)
  const imageFile = path.join(MAPS_DIR, `${id}.${ext}`)
  const metadataFile = path.join(MAPS_DIR, `${id}.map.json`)
  const metadata = {
    source: `${normalizedBase}/map_info.json + map_obj.json + map.img`,
    capturedAt: new Date().toISOString(),
    mapGeneration: rawInfo.map_generation,
    mapInfo: rawInfo,
    viewport,
  }
  await Promise.all([
    writeFileAtomic(imageFile, image),
    writeFileAtomic(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`),
    writeFileAtomic(MAP_FONT_FILE, font),
  ])
  console.log(
    `[maps] ${id}: сохранены ${imageFile}, ${metadataFile}; ` +
    `зоны: ${viewport.captureZones.length}, наземные спавны: ${viewport.groundSpawns.length}, ` +
    `аэродромы: ${viewport.airfields.length}, воздушные спавны: ${viewport.airSpawns.length}`,
  )
}

const level = process.argv[2]
if (!level) {
  console.error('Использование: npm run capture:map -- <level-id> [http://localhost:8111]')
  process.exitCode = 1
} else {
  captureMap(level, process.argv[3]).catch((error: unknown) => {
    console.error(`[maps] Не удалось сохранить карту: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
