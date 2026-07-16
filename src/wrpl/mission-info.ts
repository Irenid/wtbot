import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Данные миссии из датамайна: границы поля боя и зоны захвата.
 *
 * Заголовок реплея хранит путь к файлу миссии (levelSettings, например
 * "gamedata/missions/cta/tanks/netherlands/netherlands_02_dom.blk") —
 * его JSON-разбор (.blkx) лежит в репозитории War-Thunder-Datamine.
 * Качаем при первом использовании, кэшируем в data/missions/ навсегда.
 *
 * Многие миссии сами областей не описывают, а собираются из шаблонов
 * (imports/import_record: dom_template, template_<карта>_battleareas и
 * т.п.) — области ищем и в импортируемых файлах тоже.
 *
 * В миссии интересны:
 *  - область "battleArea" (Box): центр + размер → границы тактической
 *    карты для хитмапы; либо явная ссылка battleArea.target, либо
 *    область *battle_area_<сложность> из шаблона (движок собирает имя
 *    триггерами dom_check_*: полковые бои — realistic, при отсутствии
 *    такой области берётся arcade);
 *  - иконки брифинга basezone_A/B/C → буквы зон и их координаты.
 */

const MISSIONS_DIR = './data/missions'
const DATAMINE_BASE = 'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/mis.vromfs.bin_u'

export interface MissionZone {
  letter: string
  x: number
  z: number
}

export interface MissionInfo {
  /** Границы поля боя в мировых координатах (квадрат) или null */
  area: { x0: number; z0: number; x1: number; z1: number } | null
  zones: MissionZone[]
}

type Json = { [k: string]: unknown } | Json[] | string | number | boolean | null

/** Достаёт данные миссии по пути из заголовка реплея; null — не нашли */
export async function fetchMissionInfo(levelSettings: string): Promise<MissionInfo | null> {
  const rel = levelSettings.trim().toLowerCase()
  if (!rel.startsWith('gamedata/')) return null
  const root = await fetchMissionJson(rel)
  if (root === null) return null

  // Импортируемые шаблоны (рекурсивно): в них живут battleArea и зоны
  const docs: Json[] = [root]
  const visited = new Set([rel])
  const queue = findImportFiles(root)
  while (queue.length > 0 && docs.length < 16) {
    const imp = queue.shift()!
    if (visited.has(imp)) continue
    visited.add(imp)
    const doc = await fetchMissionJson(imp)
    if (doc === null) continue
    docs.push(doc)
    queue.push(...findImportFiles(doc))
  }
  return extractMissionInfo(docs)
}

/** JSON-разбор BLK из датамайна; кэш в data/missions/ навсегда */
async function fetchMissionJson(rel: string): Promise<Json | null> {
  const cacheFile = path.join(MISSIONS_DIR, path.basename(rel) + 'x')
  let raw: string
  if (existsSync(cacheFile)) {
    raw = readFileSync(cacheFile, 'utf8')
  } else {
    try {
      const res = await fetch(`${DATAMINE_BASE}/${rel}x`)
      if (!res.ok) return null
      raw = await res.text()
      mkdirSync(MISSIONS_DIR, { recursive: true })
      writeFileSync(cacheFile, raw)
    } catch {
      return null
    }
  }
  try {
    return JSON.parse(raw) as Json
  } catch {
    return null
  }
}

/** Пути BLK-файлов из imports/import_record, у которых importAreas не выключен */
function findImportFiles(node: Json, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) findImportFiles(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'import_record') {
      for (const rec of Array.isArray(value) ? value : [value]) {
        const r = rec as { file?: unknown; importAreas?: unknown } | null
        if (r === null || typeof r.file !== 'string' || r.importAreas === false) continue
        const rel = r.file.trim().toLowerCase()
        if (rel.startsWith('gamedata/') && rel.endsWith('.blk')) out.push(rel)
      }
    } else {
      findImportFiles(value as Json, out)
    }
  }
  return out
}

export function extractMissionInfo(docs: Json[]): MissionInfo {
  // Области миссии и её импортов; при совпадении имён миссия главнее
  const areas = new Map<string, AreaDef>()
  for (const doc of docs) {
    for (const [name, def] of findAreas(doc)) {
      if (!areas.has(name)) areas.set(name, def)
    }
  }

  // Границы: явный battleArea.target, иначе кандидаты по имени
  const candidates = docs
    .map((doc) => findBattleAreaTarget(doc))
    .filter((t): t is string => t !== null)
    .concat(rankedBattleAreaNames(areas))
  let area: MissionInfo['area'] = null
  for (const name of candidates) {
    const def = areas.get(name)
    if (!def?.size) continue
    const half = Math.max(Math.abs(def.size[0]), Math.abs(def.size[2])) / 2
    area = {
      x0: def.pos[0] - half,
      z0: def.pos[2] - half,
      x1: def.pos[0] + half,
      z1: def.pos[2] + half,
    }
    break
  }

  // Зоны: иконки брифинга basezone_X → имя области → координаты
  const zones: MissionZone[] = []
  const seen = new Set<string>()
  for (const doc of docs) {
    for (const icon of findZoneIcons(doc)) {
      const def = areas.get(icon.target.toLowerCase())
      if (!def || seen.has(icon.letter)) continue
      seen.add(icon.letter)
      zones.push({ letter: icon.letter, x: def.pos[0], z: def.pos[2] })
    }
  }
  zones.sort((a, b) => a.letter.localeCompare(b.letter))
  return { area, zones }
}

/**
 * Имена областей-кандидатов на battleArea в порядке предпочтения движка
 * для полковых боёв: realistic, его фолбэк arcade, затем hardcore и
 * классические имена вроде briefing_battlearea. battlearea_exclude_* —
 * вырезы внутри поля боя, не границы.
 */
function rankedBattleAreaNames(areas: Map<string, AreaDef>): string[] {
  const rank = (n: string): number =>
    n.includes('realistic') ? 0
    : n.includes('arcade') ? 1
    : n.includes('hardcore') ? 2
    : 3
  return [...areas.keys()]
    .filter((n) => /battle_?area/.test(n) && !n.includes('exclude'))
    .sort((a, b) => rank(a) - rank(b))
}

interface AreaDef {
  pos: [number, number, number]
  /** Диагональ tm — размеры Box; у Point нулевая */
  size: [number, number, number] | null
}

/** Все области миссии: имя (в нижнем регистре) → позиция и размер */
function findAreas(node: Json, out = new Map<string, AreaDef>(), inAreas = false): Map<string, AreaDef> {
  if (Array.isArray(node)) {
    for (const item of node) findAreas(item, out, inAreas)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'areas' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, def] of Object.entries(value)) {
        const tm = (def as { tm?: unknown })?.tm
        if (!Array.isArray(tm) || tm.length !== 4) continue
        const rows = tm as number[][]
        const pos = rows[3]
        if (!Array.isArray(pos) || pos.length !== 3) continue
        const size: [number, number, number] = [
          Math.abs(rows[0]?.[0] ?? 0),
          Math.abs(rows[1]?.[1] ?? 0),
          Math.abs(rows[2]?.[2] ?? 0),
        ]
        out.set(name.toLowerCase(), {
          pos: [pos[0]!, pos[1]!, pos[2]!],
          size: size[0] > 1.5 || size[2] > 1.5 ? size : null,
        })
      }
    } else {
      findAreas(value as Json, out, inAreas)
    }
  }
  return out
}

/** Рекурсивный поиск battleArea: { target: "..." } */
function findBattleAreaTarget(node: Json): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findBattleAreaTarget(item)
      if (r) return r
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  for (const [key, value] of Object.entries(node)) {
    if (key === 'battleArea' && value !== null && typeof value === 'object') {
      const target = (value as { target?: unknown }).target
      if (typeof target === 'string') return target.toLowerCase()
    }
    const r = findBattleAreaTarget(value as Json)
    if (r) return r
  }
  return null
}

/** Иконки брифинга: basezone_A → { letter: "A", target } */
function findZoneIcons(node: Json, out: { letter: string; target: string }[] = []): { letter: string; target: string }[] {
  if (Array.isArray(node)) {
    for (const item of node) findZoneIcons(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const icontype = (node as { icontype?: unknown }).icontype
  const target = (node as { target?: unknown }).target
  if (typeof icontype === 'string' && typeof target === 'string') {
    const m = /^basezone_([a-z])$/i.exec(icontype)
    if (m) out.push({ letter: m[1]!.toUpperCase(), target })
  }
  for (const value of Object.values(node)) findZoneIcons(value as Json, out)
  return out
}
