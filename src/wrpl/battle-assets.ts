import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic as writeAtomic } from '../atomic-file.js'
import { readResponseBuffer, readResponseJson, readResponseText } from '../http-response.js'

/**
 * Внешние ресурсы для картинки боя.
 *
 * Иконки техники — белые силуэты из датамайна игры
 * (atlases.vromfs.bin_u/units/<wpcost-id>.png, ~5–10 КБ каждая).
 * Скачиваются по мере надобности и кэшируются навсегда в data/unit-icons/.
 * Отсутствующие в датамайне id запоминаются пустым файлом *.miss,
 * чтобы не ходить на GitHub повторно.
 *
 * Тактические карты для хитмап — снимки игровой карты с wt-tools.app
 * (открытый бакет wt-map-files: 62 карты × все режимы). Картинка режима
 * покрывает ровно battleArea миссии (проверено по координатам зон), так
 * что привязка к миру точная. Кэш — data/maps/, качается один раз.
 *
 * Фон таблицы результатов — скриншот в data/maps/<level>.jpg|png
 * (кладётся руками); нет файла — рендер рисует тёмный градиент.
 */

const ICONS_DIR = './data/unit-icons'
const MAPS_DIR = './data/maps'
const MAP_ICON_FONT = './data/fonts/map-icons.ttf'
const ICONS_BASE =
  'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/atlases.vromfs.bin_u/units'
const WTTOOLS_MANIFEST_URL = 'https://wt-tools.app/manifest.json'
const WTTOOLS_MAPS_BASE = 'https://storage.googleapis.com/wt-map-files/maps'
const MANIFEST_FILE = path.join(MAPS_DIR, 'wt-tools-manifest.json')
const MANIFEST_TTL_MS = 7 * 24 * 3600 * 1000

/** "levels/avg_jungle.bin" → "avg_jungle" */
export function levelId(headerLevel: string): string {
  return headerLevel.replace(/^.*[/\\]/, '').replace(/\.bin$/i, '')
}

/** Возвращает id → бинарный PNG силуэта; недоступные иконки в Map не попадают */
export async function ensureUnitIcons(ids: string[]): Promise<Map<string, Buffer>> {
  await mkdir(ICONS_DIR, { recursive: true })
  const icons = new Map<string, Buffer>()
  const unique = [...new Set(ids.filter((id) => /^[a-z0-9_.-]+$/i.test(id)))]

  await Promise.all(
    unique.map(async (id) => {
      const uri = await ensureUnitIcon(id)
      if (uri) icons.set(id, uri)
    }),
  )
  return icons
}

const iconInflight = new Map<string, Promise<Buffer | null>>()

function ensureUnitIcon(id: string): Promise<Buffer | null> {
  const running = iconInflight.get(id)
  if (running) return running
  const task = loadUnitIcon(id).finally(() => iconInflight.delete(id))
  iconInflight.set(id, task)
  return task
}

async function loadUnitIcon(id: string): Promise<Buffer | null> {
  const file = path.join(ICONS_DIR, `${id}.png`)
  const miss = path.join(ICONS_DIR, `${id}.miss`)
  const cached = await readOptional(file)
  if (cached && isPng(cached) && cached.length <= 2 * 1024 * 1024) return cached
  if (cached) await rm(file, { force: true }).catch(() => undefined)
  if (await exists(miss)) return null
  try {
    const response = await fetch(`${ICONS_BASE}/${id}.png`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) {
      if (response.status === 404) await writeAtomic(miss, '')
      return null
    }
    const data = await readResponseBuffer(response, 2 * 1024 * 1024, `иконка ${id}`)
    if (!isPng(data) || data.length > 2 * 1024 * 1024) return null
    await writeAtomic(file, data)
    return data
  } catch {
    return null
  }
}

export interface BinaryImage {
  mime: 'image/png' | 'image/jpeg'
  data: Buffer
  viewport?: MapImageViewport
}

/** Нормализованная игровая область внутри полного изображения уровня. */
export interface MapImageViewport {
  x: number
  y: number
  width: number
  height: number
  /** Мировые координаты показанного игрового квадрата. */
  worldBounds?: { x0: number; z0: number; x1: number; z1: number }
  /** Шаг подписанной игровой сетки как доля ширины/высоты viewport. */
  gridStepX?: number
  gridStepY?: number
  gridStepMeters?: number
  captureZones?: { letter: string; x: number; y: number }[]
  groundSpawns?: { x: number; y: number }[]
}

function validMapViewport(value: unknown): value is MapImageViewport {
  if (value === null || typeof value !== 'object') return false
  const viewport = value as Partial<MapImageViewport>
  const numbers = [viewport.x, viewport.y, viewport.width, viewport.height]
  const gridSteps = [viewport.gridStepX, viewport.gridStepY]
  const gridMetersValid = viewport.gridStepMeters === undefined ||
    (typeof viewport.gridStepMeters === 'number' && Number.isFinite(viewport.gridStepMeters) &&
      viewport.gridStepMeters > 0 && viewport.gridStepMeters <= 100_000)
  const normalizedPoint = (point: unknown): point is { x: number; y: number } => {
    if (point === null || typeof point !== 'object') return false
    const candidate = point as { x?: unknown; y?: unknown }
    return typeof candidate.x === 'number' && Number.isFinite(candidate.x) && candidate.x >= 0 && candidate.x <= 1 &&
      typeof candidate.y === 'number' && Number.isFinite(candidate.y) && candidate.y >= 0 && candidate.y <= 1
  }
  const zonesValid = viewport.captureZones === undefined ||
    (Array.isArray(viewport.captureZones) && viewport.captureZones.length <= 16 &&
      viewport.captureZones.every((zone) => normalizedPoint(zone) && /^[A-Z0-9]$/.test(zone.letter)))
  const spawnsValid = viewport.groundSpawns === undefined ||
    (Array.isArray(viewport.groundSpawns) && viewport.groundSpawns.length <= 8 &&
      viewport.groundSpawns.every(normalizedPoint))
  const worldBounds = viewport.worldBounds
  const worldBoundsValid = worldBounds === undefined ||
    ([worldBounds.x0, worldBounds.z0, worldBounds.x1, worldBounds.z1]
      .every((part) => typeof part === 'number' && Number.isFinite(part)) &&
      worldBounds.x1 > worldBounds.x0 && worldBounds.z1 > worldBounds.z0)
  return numbers.every((part) => typeof part === 'number' && Number.isFinite(part)) &&
    viewport.x! >= 0 && viewport.y! >= 0 && viewport.width! > 0 && viewport.height! > 0 &&
    viewport.x! + viewport.width! <= 1.000_001 && viewport.y! + viewport.height! <= 1.000_001 &&
    gridSteps.every((step) => step === undefined ||
      (typeof step === 'number' && Number.isFinite(step) && step > 0 && step <= 1)) &&
    gridMetersValid && zonesValid && spawnsValid && worldBoundsValid
}

/** map_info: grid_zero — левый верхний угол, grid_size — размер игровой области в метрах. */
function worldBoundsFromMapInfo(value: unknown): MapImageViewport['worldBounds'] {
  if (value === null || typeof value !== 'object') return undefined
  const mapInfo = value as { grid_size?: unknown; grid_zero?: unknown }
  if (!Array.isArray(mapInfo.grid_size) || !Array.isArray(mapInfo.grid_zero)) return undefined
  const [width, height] = mapInfo.grid_size
  const [x0, z1] = mapInfo.grid_zero
  if (
    typeof width !== 'number' || !Number.isFinite(width) || width <= 0 ||
    typeof height !== 'number' || !Number.isFinite(height) || height <= 0 ||
    typeof x0 !== 'number' || !Number.isFinite(x0) ||
    typeof z1 !== 'number' || !Number.isFinite(z1)
  ) return undefined
  return { x0, z0: z1 - height, x1: x0 + width, z1 }
}

async function loadMapViewport(id: string): Promise<MapImageViewport | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(MAPS_DIR, `${id}.map.json`), 'utf8'))
    const document = parsed as { viewport?: unknown; mapInfo?: unknown } | null
    const viewport = document?.viewport
    if (!validMapViewport(viewport)) return undefined
    const worldBounds = viewport.worldBounds ?? worldBoundsFromMapInfo(document?.mapInfo)
    return worldBounds ? { ...viewport, worldBounds } : viewport
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Фон карты из data/maps/<level>.(jpg|jpeg|png). Для полного map.img рядом можно
 * положить <level>.map.json с viewport игровой области; base64 кодирует CPU worker.
 */
export async function loadMapBackground(headerLevel: string): Promise<BinaryImage | null> {
  const id = levelId(headerLevel)
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const file = path.join(MAPS_DIR, `${id}.${ext}`)
    try {
      const data = await readFile(file)
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
      const viewport = await loadMapViewport(id)
      return { mime, data, ...(viewport ? { viewport } : {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

/** Шрифт значков карты, сохранённый командой capture:map с локального сервера игры. */
export async function loadMapIconFontPath(): Promise<string | null> {
  try {
    const info = await stat(MAP_ICON_FONT)
    return info.size >= 12 && info.size <= 2 * 1024 * 1024 ? path.resolve(MAP_ICON_FONT) : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// ---------- ГСН ракет (для значков причины смерти на хитмапе) ----------

export type MissileSeeker = 'ir' | 'sarh' | 'arh'

const WEAPONS_FILE = './data/weapons.json'
const ROCKETGUNS_BASE =
  'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/aces.vromfs.bin_u/gamedata/weapons/rocketguns'

/**
 * Тип ГСН по id оружия из события убийства: ИК / полуактивная РЛ /
 * активная РЛ. Ракеты авиации описаны в rocketguns/<id>.blkx датамайна
 * (radarSeeker.active → АРЛ, radarSeeker → ПАРЛ, opticalSeeker → ИК);
 * снаряды, пули и ЗУР зениток отдельных файлов не имеют — для них в
 * кэш пишется "none" и в ответ они не попадают. Кэш — data/weapons.json.
 */
let weaponQueue: Promise<void> = Promise.resolve()

export function ensureWeaponSeekers(ids: string[]): Promise<Map<string, MissileSeeker>> {
  const result = weaponQueue.then(() => loadWeaponSeekers(ids), () => loadWeaponSeekers(ids))
  weaponQueue = result.then(() => undefined, () => undefined)
  return result
}

async function loadWeaponSeekers(ids: string[]): Promise<Map<string, MissileSeeker>> {
  let cache: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(WEAPONS_FILE, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') cache = parsed as Record<string, string>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  const unique = [...new Set(ids.filter((id) => /^[a-z0-9_.-]+$/i.test(id)))]
  const missing = unique.filter((id) => !(id in cache))

  await Promise.all(
    missing.map(async (id) => {
      try {
        const res = await fetch(`${ROCKETGUNS_BASE}/${id}.blkx`, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) {
          if (res.status === 404) cache[id] = 'none'
          return
        }
        const blk = await readResponseJson<{
          rocket?: { guidance?: { radarSeeker?: { active?: unknown }; opticalSeeker?: unknown } }
        }>(res, 2 * 1024 * 1024, `оружие ${id}`)
        const guidance = blk.rocket?.guidance
        cache[id] =
          guidance?.radarSeeker ? (guidance.radarSeeker.active === true ? 'arh' : 'sarh')
          : guidance?.opticalSeeker ? 'ir'
          : 'none'
      } catch {
        // сеть недоступна — не кэшируем, попробуем в другой раз
      }
    }),
  )
  if (missing.some((id) => id in cache)) {
    await writeAtomic(WEAPONS_FILE, JSON.stringify(cache))
  }

  const seekers = new Map<string, MissileSeeker>()
  for (const id of unique) {
    const s = cache[id]
    if (s === 'ir' || s === 'sarh' || s === 'arh') seekers.set(id, s)
  }
  return seekers
}

// ---------- тактические карты (wt-tools.app) ----------

interface WtToolsManifest {
  [mapKey: string]: { [modeKey: string]: { image: string; size: number; tile_size: number } }
}

/** " [Domination #2] North Holland" → { mapKey: "north_holland", modeKey: "domination-2" } */
export function tacticalMapKeys(missionName: string): { mapKey: string; modeKey: string } | null {
  // в item.title перед режимом стоит сложность — "[realistic] [Conquest #3] …"
  const cleaned = missionName.trim().replace(/^\[(arcade|realistic|simulation|hardcore)\]\s*/i, '')
  const m = /^\s*\[([a-zа-я ]+?)(?:\s*#(\d+))?\]\s*(.+)$/i.exec(cleaned)
  if (!m) return null
  const mode = m[1]!.trim().toLowerCase()
  const num = m[2] ?? '1'
  const mapKey = m[3]!
    .trim()
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!mapKey || !/^[a-z]+$/.test(mode)) return null
  return { mapKey, modeKey: `${mode}-${num}` }
}

/** Манифест wt-tools: кэш с обновлением раз в неделю; сбой сети → старый кэш */
let manifestInflight: Promise<WtToolsManifest | null> | null = null

function loadWtToolsManifest(): Promise<WtToolsManifest | null> {
  if (manifestInflight) return manifestInflight
  manifestInflight = doLoadWtToolsManifest().finally(() => {
    manifestInflight = null
  })
  return manifestInflight
}

async function doLoadWtToolsManifest(): Promise<WtToolsManifest | null> {
  let fresh = false
  try {
    fresh = Date.now() - (await stat(MANIFEST_FILE)).mtimeMs < MANIFEST_TTL_MS
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!fresh) {
    try {
      const res = await fetch(WTTOOLS_MANIFEST_URL, { signal: AbortSignal.timeout(20_000) })
      if (res.ok) {
        const body = await readResponseText(res, 4 * 1024 * 1024, 'manifest wt-tools')
        JSON.parse(body) // валидация до записи
        await writeAtomic(MANIFEST_FILE, body)
      }
    } catch {
      // нет сети — попробуем отдать старый кэш ниже
    }
  }
  try {
    return JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as WtToolsManifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    return null
  }
}

/**
 * Снимок игровой тактической карты для конкретного режима миссии
 * (бинарный PNG) или null, если карты/режима нет в коллекции.
 * Картинка покрывает ровно battleArea миссии — накладывать по нему.
 * Чужой режим не подставляем: на снимке запечены зоны и спавны,
 * для другой миссии они врут.
 */
export async function ensureTacticalMap(missionName: string): Promise<Buffer | null> {
  const keys = tacticalMapKeys(missionName)
  if (!keys) return null
  // хитмапы наземки и авиации собираются параллельно — не качаем дважды
  const id = `${keys.mapKey}__${keys.modeKey}`
  let pending = inflightMaps.get(id)
  if (!pending) {
    pending = fetchTacticalMap(keys).finally(() => inflightMaps.delete(id))
    inflightMaps.set(id, pending)
  }
  const file = await pending
  if (!file) return null
  try {
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const inflightMaps = new Map<string, Promise<string | null>>()

async function fetchTacticalMap(keys: { mapKey: string; modeKey: string }): Promise<string | null> {
  const file = path.join(MAPS_DIR, `${keys.mapKey}__${keys.modeKey}.png`)
  const miss = path.join(MAPS_DIR, `${keys.mapKey}__${keys.modeKey}.miss`)
  const cached = await readOptional(file)
  if (cached && isPng(cached) && cached.length <= 32 * 1024 * 1024) return file
  if (cached) await rm(file, { force: true }).catch(() => undefined)
  if (await exists(miss)) return null

  const manifest = await loadWtToolsManifest()
  const entry = manifest?.[keys.mapKey]?.[keys.modeKey]
  if (!entry) {
    if (manifest) {
      await writeAtomic(miss, '')
      console.log(`[maps] в коллекции wt-tools нет ${keys.mapKey}/${keys.modeKey} — хитмапа будет без карты`)
    }
    return null
  }
  try {
    const res = await fetch(`${WTTOOLS_MAPS_BASE}/${keys.mapKey}/${keys.modeKey}/${entry.image}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      if (res.status === 404) await writeAtomic(miss, '')
      return null
    }
    const buf = await readResponseBuffer(res, 32 * 1024 * 1024, 'тактическая карта')
    if (!isPng(buf) || buf.length > 32 * 1024 * 1024) return null
    await writeAtomic(file, buf)
    console.log(`[maps] тактическая карта ${keys.mapKey}/${keys.modeKey} сохранена (${Math.round(buf.length / 1024)} КБ)`)
    return file
  } catch {
    return null // сеть недоступна — в другой раз получится
  }
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function isPng(data: Uint8Array): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  )
}
