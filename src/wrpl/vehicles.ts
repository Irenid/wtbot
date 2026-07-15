import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Словарь техники War Thunder: внутренний id → человеческое название,
 * класс машины и страна. Собирается один раз из датамайна игры
 * (https://github.com/gszabi99/War-Thunder-Datamine):
 *
 *   lang/units.csv        — локализованные названия («us_m1a1_hc_abrams» → «M1A1 HC»)
 *   config/wpcost.blkx    — unitClass и страна каждой машины (~30 МБ, скачивается один раз)
 *   config/unittags.blkx  — уточнение: лёгкие танки (type_light_tank)
 *
 * Результат кэшируется в data/wt-vehicles.json (~200 КБ), исходники удаляются.
 */

/** F — самолёт, H — вертолёт, T — танк, L — лёгкий, AA — ПВО, ? — неизвестно */
export type VehicleClass = 'F' | 'H' | 'T' | 'L' | 'AA' | '?'

export interface VehicleInfo {
  name: string
  cls: VehicleClass
  country: string
}

export type VehicleDict = Record<string, VehicleInfo>

const RAW_BASE = 'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master'
const CACHE_FILE = './data/wt-vehicles.json'
const TMP_DIR = './data/wt-dict'

let loaded: VehicleDict | null = null

/** Возвращает словарь техники, при первом запуске собирает его из датамайна */
export async function ensureVehicleDict(): Promise<VehicleDict> {
  if (loaded) return loaded
  if (existsSync(CACHE_FILE)) {
    loaded = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as VehicleDict
    return loaded
  }
  console.log('[vehicles] Словаря нет — собираю из датамайна (одноразово, ~40 МБ)...')
  await mkdir(TMP_DIR, { recursive: true })
  const [csv, wpcostRaw, tagsRaw] = await Promise.all([
    fetchOrCached('units.csv', `${RAW_BASE}/lang.vromfs.bin_u/lang/units.csv`),
    fetchOrCached('wpcost.blkx', `${RAW_BASE}/char.vromfs.bin_u/config/wpcost.blkx`),
    fetchOrCached('unittags.blkx', `${RAW_BASE}/char.vromfs.bin_u/config/unittags.blkx`),
  ])

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
    dict[id] = {
      name: names.get(id) ?? id,
      cls,
      country: typeof unit.country === 'string' ? unit.country.replace(/^country_/, '') : '?',
    }
  }

  await writeFile(CACHE_FILE, JSON.stringify(dict))
  await rm(TMP_DIR, { recursive: true, force: true })
  console.log(`[vehicles] Готово: ${Object.keys(dict).length} машин → ${CACHE_FILE}`)
  loaded = dict
  return dict
}

/** Название/класс машины; для неизвестных id — сам id и класс «?» */
export function vehicleInfo(dict: VehicleDict, id: string): VehicleInfo {
  return dict[id] ?? { name: id, cls: '?', country: '?' }
}

async function fetchOrCached(file: string, url: string): Promise<string> {
  const p = path.join(TMP_DIR, file)
  if (existsSync(p)) return readFile(p, 'utf8')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании ${url}`)
  const text = await res.text()
  await writeFile(p, text)
  return text
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
