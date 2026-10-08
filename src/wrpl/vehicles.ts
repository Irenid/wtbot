import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic as writeAtomic } from '../atomic-file.js'
import { readResponseBuffer } from '../http-response.js'
import {
  runWorkerTask,
  transferableBuffer,
  type WorkerPriority,
  type WorkerTaskControl,
} from '../workers/pool.js'

/**
 * War Thunder vehicle dictionary: internal id → display name, vehicle class
 * and country, built from the game datamine
 * (https://github.com/gszabi99/War-Thunder-Datamine):
 *
 *   lang/units.csv        — localized names ("us_m1a1_hc_abrams" → "M1A1 HC")
 *   config/wpcost.blkx    — unitClass and country of every vehicle (~30 MB)
 *   config/unittags.blkx  — light tanks (type_light_tank) and the operator
 *                           country (operatorCountry: the flag the game shows)
 *
 * Cached in data/wt-vehicles.json (~200 KB), the sources are deleted. Patches
 * add vehicles, and a missing one shows its raw id with class "?": a
 * dictionary older than REFRESH_AFTER_MS is rebuilt in the background while
 * the old one keeps serving.
 */

/** F — aircraft, H — helicopter, T — tank, L — light tank, AA — SPAA, ? — unknown */
export type VehicleClass = 'F' | 'H' | 'T' | 'L' | 'AA' | '?'

export interface VehicleInfo {
  name: string
  cls: VehicleClass
  /** The research tree's nation. */
  country: string
  /** The operator's flag when it is not the tree's (`norway` for the Swedish tree's K9 Vidar; unittags operatorCountry). */
  operator?: string
}

export type VehicleDict = Record<string, VehicleInfo>

const RAW_BASE = 'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master'
const CACHE_FILE = './data/wt-vehicles.json'
const TMP_DIR = './data/wt-dict'
const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000
const REFRESH_RETRY_MS = 6 * 3600 * 1000
/** A rebuild with fewer vehicles than this share of the old one means a datamine format change. */
const MIN_REFRESH_RATIO = 0.9

let loaded: VehicleDict | null = null
let loading: Promise<VehicleDict> | null = null
let loadingPriority: WorkerPriority = 'normal'
let loadingControl: WorkerTaskControl | null = null
let refreshDueAt = Number.POSITIVE_INFINITY
let refreshing = false

/** The vehicle dictionary; the first run builds it, a stale one is rebuilt in the background. */
export function ensureVehicleDict(priority: WorkerPriority = 'normal'): Promise<VehicleDict> {
  if (loaded) {
    if (Date.now() >= refreshDueAt) refreshInBackground(loaded)
    return Promise.resolve(loaded)
  }
  if (loading) {
    promoteLoading(priority)
    return loading
  }
  loadingPriority = priority
  loading = loadVehicleDict().then((dict) => {
    loaded = dict
    return dict
  }).finally(() => {
    loading = null
    loadingControl = null
  })
  return loading
}

/** Повышает уже запущенную singleton-сборку, когда к фоновой media присоединился Discord. */
export function promoteVehicleDictLoad(priority: WorkerPriority): void {
  promoteLoading(priority)
}

async function loadVehicleDict(): Promise<VehicleDict> {
  try {
    const [text, info] = await Promise.all([readFile(CACHE_FILE, 'utf8'), stat(CACHE_FILE)])
    const dict = JSON.parse(text) as VehicleDict
    // Built before operator flags were kept (2026-10-08): rebuilt in the background at the next call.
    refreshDueAt = Object.values(dict).some((info) => info.operator !== undefined) ? info.mtimeMs + REFRESH_AFTER_MS : 0
    return dict
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  console.log('[vehicles] No dictionary: building it from the datamine (~40 MB)...')
  const dict = await buildFromDatamine(loadingPriority, (control) => {
    loadingControl = control
    control.promote(loadingPriority)
  })
  await writeAtomic(CACHE_FILE, JSON.stringify(dict))
  refreshDueAt = Date.now() + REFRESH_AFTER_MS
  console.log(`[vehicles] Done: ${Object.keys(dict).length} vehicles → ${CACHE_FILE}`)
  return dict
}

/** Single-flight rebuild; failures keep the old dictionary and retry after REFRESH_RETRY_MS. */
function refreshInBackground(current: VehicleDict): void {
  if (refreshing) return
  refreshing = true
  refreshDueAt = Date.now() + REFRESH_RETRY_MS
  void (async () => {
    // Sources left by a crashed earlier build belong to an older datamine.
    await rm(TMP_DIR, { recursive: true, force: true })
    const next = await buildFromDatamine('background')
    const before = Object.keys(current).length
    const after = Object.keys(next).length
    if (after < before * MIN_REFRESH_RATIO) {
      throw new Error(`the rebuild has ${after} vehicles against ${before}`)
    }
    await writeAtomic(CACHE_FILE, JSON.stringify(next))
    loaded = next
    refreshDueAt = Date.now() + REFRESH_AFTER_MS
    console.log(`[vehicles] Dictionary refreshed: ${before} → ${after} vehicles`)
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vehicles] Dictionary refresh failed, the old one stays: ${message}`)
  }).finally(() => {
    refreshing = false
  })
}

/** Downloads the sources and builds the dictionary in a worker; sources survive only a failed download. */
async function buildFromDatamine(
  priority: WorkerPriority,
  onControl?: (control: WorkerTaskControl) => void,
): Promise<VehicleDict> {
  await mkdir(TMP_DIR, { recursive: true })
  const [csvBuffer, wpcostBuffer, tagsBuffer] = await Promise.all([
    fetchOrCached('units.csv', `${RAW_BASE}/lang.vromfs.bin_u/lang/units.csv`),
    fetchOrCached('wpcost.blkx', `${RAW_BASE}/char.vromfs.bin_u/config/wpcost.blkx`),
    fetchOrCached('unittags.blkx', `${RAW_BASE}/char.vromfs.bin_u/config/unittags.blkx`),
  ])
  const csv = transferableBuffer(csvBuffer)
  const wpcost = transferableBuffer(wpcostBuffer)
  const tags = transferableBuffer(tagsBuffer)
  try {
    return await runWorkerTask(
      { kind: 'build-vehicle-dict', input: { csv, wpcost, tags } },
      {
        priority,
        transferList: [csv, wpcost, tags],
        timeoutMs: 120_000,
        ...(onControl ? { onControl } : {}),
      },
    )
  } finally {
    await rm(TMP_DIR, { recursive: true, force: true })
  }
}

function promoteLoading(priority: WorkerPriority): void {
  const order: WorkerPriority[] = ['interactive', 'normal', 'background']
  if (order.indexOf(priority) >= order.indexOf(loadingPriority)) return
  loadingPriority = priority
  loadingControl?.promote(priority)
}

/** Название/класс машины; для неизвестных id — сам id и класс «?» */
export function vehicleInfo(dict: VehicleDict, id: string): VehicleInfo {
  return dict[id] ?? { name: id, cls: '?', country: '?' }
}

async function fetchOrCached(file: string, url: string): Promise<Buffer> {
  const p = path.join(TMP_DIR, file)
  try {
    return await readFile(p)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`)
  const data = await readResponseBuffer(res, 64 * 1024 * 1024, `datamine ${file}`)
  await writeAtomic(p, data)
  return data
}

/** CPU-часть одноразовой сборки словаря; вызывается worker entry. */
export function buildVehicleDict(csv: string, wpcostRaw: string, tagsRaw: string): VehicleDict {
  const names = parseUnitsCsv(csv)
  const wpcost = JSON.parse(wpcostRaw) as Record<string, unknown>
  const unittags = JSON.parse(tagsRaw) as Record<string, unknown>
  const dict: VehicleDict = {}
  for (const [id, raw] of Object.entries(wpcost)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const unit = raw as { unitClass?: unknown; country?: unknown }
    if (typeof unit.unitClass !== 'string') continue
    let cls = classFromUnitClass(unit.unitClass)
    if (cls === 'T' && isLightTank(unittags[id])) cls = 'L'
    const country = typeof unit.country === 'string' ? unit.country.replace(/^country_/, '') : '?'
    const operator = operatorOf(unittags[id])
    dict[id] = {
      name: names.get(id) ?? id,
      cls,
      country,
      ...(operator !== null && operator !== country ? { operator } : {}),
    }
  }
  return dict
}

function classFromUnitClass(unitClass: string): VehicleClass {
  switch (unitClass) {
    case 'exp_fighter':
    case 'exp_assault':
    case 'exp_bomber':
      return 'F'
    case 'exp_helicopter':
      return 'H'
    case 'exp_SPAA':
      return 'AA'
    case 'exp_tank':
    case 'exp_heavy_tank':
    case 'exp_tank_destroyer':
      return 'T'
    default:
      return '?' // корабли и прочее — в наземных боях не встречаются
  }
}

function operatorOf(tagsEntry: unknown): string | null {
  if (tagsEntry === null || typeof tagsEntry !== 'object') return null
  const operator = (tagsEntry as { operatorCountry?: unknown }).operatorCountry
  return typeof operator === 'string' && operator.startsWith('country_') ? operator.slice('country_'.length) : null
}

function isLightTank(tagsEntry: unknown): boolean {
  if (tagsEntry === null || typeof tagsEntry !== 'object') return false
  const tags = (tagsEntry as { tags?: Record<string, unknown> }).tags
  return tags !== undefined && tags['type_light_tank'] === true
}

/** units.csv: строки вида "id_shop";"English";... — берём английское название */
function parseUnitsCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of csv.split('\n')) {
    const m = /^"(.+?)_shop";"((?:[^"]|"")*)"/.exec(line)
    if (!m) continue
    map.set(m[1]!, m[2]!.replace(/""/g, '"'))
  }
  return map
}
