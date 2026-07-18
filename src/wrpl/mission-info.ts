import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
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

export interface MissionAreaDef {
  pos: [number, number, number]
  /** Диагональ tm — размеры Box; у Point нулевая */
  size: [number, number, number] | null
}

/** Компактный результат одного большого JSON-документа для main thread. */
export interface MissionDocSummary {
  imports: string[]
  areas: [string, MissionAreaDef][]
  battleAreaTargets: string[]
  zoneIcons: { letter: string; target: string }[]
}

/** Достаёт данные миссии по пути из заголовка реплея; null — не нашли */
export async function fetchMissionInfo(
  levelSettings: string,
  priority: WorkerPriority | (() => WorkerPriority) = 'normal',
  onWorkerControl?: (control: WorkerTaskControl | null) => void,
): Promise<MissionInfo | null> {
  const rel = levelSettings.trim().toLowerCase()
  if (!rel.startsWith('gamedata/')) return null
  const currentPriority = (): WorkerPriority => (typeof priority === 'function' ? priority() : priority)

  // Импортируемые шаблоны обходятся рекурсивно, но JSON.parse и глубокие
  // сканы каждого документа выполняет CPU worker.
  const docs: MissionDocSummary[] = []
  const visited = new Set<string>()
  const queue = [rel]
  while (queue.length > 0 && docs.length < 16) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const source = await fetchMissionRaw(current)
    if (source === null) {
      if (current === rel) return null
      continue
    }
    const document = transferableBuffer(source.data)
    let controlled = false
    try {
      const summary = await runWorkerTask(
        { kind: 'parse-mission', input: { document } },
        {
          priority: currentPriority(),
          transferList: [document],
          timeoutMs: 30_000,
          onControl: (control) => {
            controlled = true
            onWorkerControl?.(control)
            control.promote(currentPriority())
          },
        },
      )
      docs.push(summary)
      queue.push(...summary.imports)
    } catch (error) {
      // Очередь/timeout/shutdown не означают, что дисковый JSON битый.
      if (error instanceof Error && error.name === 'SyntaxError') {
        await rm(source.cacheFile, { force: true }).catch(() => undefined)
        if (current === rel) return null
        continue
      }
      throw error
    } finally {
      if (controlled) onWorkerControl?.(null)
    }
  }
  return extractMissionSummaries(docs)
}

/** Сырые BLKX-байты; JSON-разбор выполняется только в CPU worker. */
async function fetchMissionRaw(rel: string): Promise<{ data: Buffer; cacheFile: string } | null> {
  // basename недостаточен: в датамайне есть одноимённые шаблоны из разных
  // каталогов (например sinai и sinai_sands). Хэш полного rel исключает коллизии.
  const stem = path.basename(rel).replace(/\.blk$/i, '')
  const relHash = createHash('sha256').update(rel).digest('hex').slice(0, 16)
  const cacheFile = path.join(MISSIONS_DIR, `${stem}-${relHash}.blkx`)
  try {
    return { data: await readFile(cacheFile), cacheFile }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let data: Buffer
  try {
    const res = await fetch(`${DATAMINE_BASE}/${rel}x`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    data = await readResponseBuffer(res, 8 * 1024 * 1024, `миссия ${path.basename(rel)}`)
  } catch {
    return null
  }
  await writeAtomic(cacheFile, data).catch((error: unknown) => {
    console.warn(`[missions] не удалось сохранить ${path.basename(rel)}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return { data, cacheFile }
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

/** CPU worker entry: JSON.parse + глубокий обход одного BLKX. */
export function summarizeMissionDocument(raw: string): MissionDocSummary {
  return summarizeMissionJson(JSON.parse(raw) as Json)
}

function summarizeMissionJson(doc: Json): MissionDocSummary {
  const target = findBattleAreaTarget(doc)
  return {
    imports: findImportFiles(doc),
    areas: [...findAreas(doc)],
    battleAreaTargets: target ? [target] : [],
    zoneIcons: findZoneIcons(doc),
  }
}

export function extractMissionInfo(docs: Json[]): MissionInfo {
  return extractMissionSummaries(docs.map(summarizeMissionJson))
}

export function extractMissionSummaries(docs: MissionDocSummary[]): MissionInfo {
  // Области миссии и её импортов; при совпадении имён миссия главнее
  const areas = new Map<string, MissionAreaDef>()
  for (const doc of docs) {
    for (const [name, def] of doc.areas) {
      if (!areas.has(name)) areas.set(name, def)
    }
  }

  // Границы: явный battleArea.target, иначе кандидаты по имени
  const candidates = docs
    .flatMap((doc) => doc.battleAreaTargets)
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
    for (const icon of doc.zoneIcons) {
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
function rankedBattleAreaNames(areas: Map<string, MissionAreaDef>): string[] {
  const rank = (n: string): number =>
    n.includes('realistic') ? 0
    : n.includes('arcade') ? 1
    : n.includes('hardcore') ? 2
    : 3
  return [...areas.keys()]
    .filter((n) => /battle_?area/.test(n) && !n.includes('exclude'))
    .sort((a, b) => rank(a) - rank(b))
}

/** Все области миссии: имя (в нижнем регистре) → позиция и размер */
function findAreas(
  node: Json,
  out = new Map<string, MissionAreaDef>(),
  inAreas = false,
): Map<string, MissionAreaDef> {
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
