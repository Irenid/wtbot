import type { BlkMap, BlkValue } from '../wrpl/blk.js'

/**
 * The map side of a mission: which battle areas, capture zones and respawn
 * bases exist once the mission has started, for one difficulty.
 *
 * A mission (mis.vromfs.bin, gamedata/missions/…) imports templates
 * (import_record: areas, units and triggers of other files, each part
 * switchable). The squadron missions are assembled by their triggers: on
 * initMission dom_template/conq_template set base names (dom_init: zone
 * "dom_capture_area_01", battle area "dom_battle_area"), the difficulty checks
 * add "_realistic" when those objects exist, else "_arcade", and the start
 * triggers call missionBattleArea, missionMarkAsCaptureZone and
 * missionMarkAsRespawnPoint with "@variable" names. This module runs that
 * initMission chain: variables, triggerEnable, the conditions that are known
 * before any unit moves (difficulty, objectExists, variable comparisons,
 * mission postfix, environment) and the map actions. Conditions on units are
 * false at the start; periodic triggers never run.
 */

export type MissionDifficulty = 'arcade' | 'realistic' | 'simulator'

export interface AreaShape {
  name: string
  type: 'Box' | 'Cylinder' | 'Sphere' | 'Point'
  /** Rows: the scaled X, Y, Z axes, then the position (Dagor TMatrix). */
  tm: [number[], number[], number[], number[]]
}

export interface BattleAreaMark {
  area: AreaShape
  team: 'A' | 'B' | 'Both'
  mapArea: boolean
  airMapArea: boolean
  ground: boolean
  air: boolean
  killArea: boolean
  detectionArea: boolean
  killOutOfBattleArea: boolean
  newGridHorizontalCellCount: number
}

export interface CaptureZoneMark {
  area: AreaShape
  /** The order of marking: 0 → A. */
  index: number
  army: number
}

export interface RespawnBaseMark {
  /** The target name: an area_squad (its members) or an area. */
  name: string
  team: 'A' | 'B' | 'Both'
  areas: AreaShape[]
  /** The area_squad's own transform, when the target is a squad. */
  squadTm: AreaShape['tm'] | null
  tags: string[]
  showOnMap: boolean
  isAirfield: boolean
  isUnit: boolean
  /** Spawn alternatives chosen at random per battle share a group. */
  group: number
}

export interface MissionMap {
  level: string
  type: string
  postfix: string
  /** mission_settings.mission with the difficulty's overrides applied. */
  settings: Record<string, BlkValue>
  battleAreas: BattleAreaMark[]
  captureZones: CaptureZoneMark[]
  respawnBases: RespawnBaseMark[]
  /** Triggers that reached a map action this interpreter does not know. */
  warnings: string[]
}

export type MissionLoader = (rel: string) => BlkMap | null

interface Trigger {
  name: string
  node: BlkMap
}

interface LoadedMission {
  areas: Map<string, AreaShape>
  squads: Map<string, { tm: AreaShape['tm']; members: string[] }>
  triggers: Trigger[]
  variables: Map<string, BlkValue>
  settings: BlkMap
}

const MAX_FILES = 64
const MAX_STEPS = 10_000

const asArray = (value: BlkValue | undefined): BlkValue[] =>
  value === undefined ? [] : Array.isArray(value) && !isVector(value) ? value : [value]

/** A numeric vector or matrix is a value, a list of blocks is a repeat. */
function isVector(value: BlkValue[]): boolean {
  return value.length > 0 && value.every((item) => typeof item === 'number' || (Array.isArray(item) && item.every((x) => typeof x === 'number')))
}

const isMap = (value: BlkValue | undefined): value is BlkMap =>
  value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)

function blocks(value: BlkValue | undefined): BlkMap[] {
  return asArray(value).filter(isMap)
}

function str(value: BlkValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function tmOf(value: BlkValue | undefined): AreaShape['tm'] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const rows = value.map((row) => (Array.isArray(row) && row.length === 3 && row.every((x) => typeof x === 'number') ? row as number[] : null))
  return rows.every((row) => row !== null) ? rows as AreaShape['tm'] : null
}

/** Loads the mission and its imports; the first definition of a name wins. */
function loadMission(rel: string, load: MissionLoader): LoadedMission {
  const result: LoadedMission = { areas: new Map(), squads: new Map(), triggers: [], variables: new Map(), settings: {} }
  const visited = new Set<string>()
  const visit = (file: string, parts: { areas: boolean; units: boolean; triggers: boolean }, top: boolean): void => {
    const key = file.trim().toLowerCase().replace(/\\/g, '/')
    if (visited.has(key) || visited.size >= MAX_FILES) return
    visited.add(key)
    const doc = load(key)
    if (!doc) {
      if (top) throw new Error(`mission ${key} not found`)
      return
    }
    if (top && isMap(doc['mission_settings'])) result.settings = doc['mission_settings']
    if (parts.areas && isMap(doc['areas'])) {
      for (const [name, def] of Object.entries(doc['areas'])) {
        if (!isMap(def)) continue
        const type = str(def['type'])
        const tm = tmOf(def['tm'])
        const lower = name.toLowerCase()
        if (!tm || (type !== 'Box' && type !== 'Cylinder' && type !== 'Sphere' && type !== 'Point') || result.areas.has(lower)) continue
        result.areas.set(lower, { name, type, tm })
      }
    }
    if (parts.units && isMap(doc['units'])) {
      for (const squad of blocks(doc['units']['area_squad'])) {
        const name = str(squad['name'])
        const tm = tmOf(squad['tm'])
        const members = isMap(squad['props']) ? asArray(squad['props']['squad_members']).filter((m): m is string => typeof m === 'string') : []
        if (name && tm && !result.squads.has(name.toLowerCase())) result.squads.set(name.toLowerCase(), { tm, members })
      }
    }
    if (parts.triggers) {
      // A category (isCategory: true, a folder of the mission editor) holds its triggers as
      // child blocks; they run in place (air_spawn_template's heli_spawn_logic, ucav_spawn_logic).
      const collect = (block: BlkMap, depth: number): void => {
        for (const [name, node] of Object.entries(block)) {
          if (!isMap(node)) continue
          if (node['isCategory'] === true) {
            if (depth < 8) collect(node, depth + 1)
          } else if ('events' in node || 'actions' in node || 'conditions' in node) {
            result.triggers.push({ name, node })
          }
        }
      }
      if (isMap(doc['triggers'])) collect(doc['triggers'], 0)
      if (isMap(doc['variables'])) {
        for (const [name, value] of Object.entries(doc['variables'])) {
          if (!result.variables.has(name)) result.variables.set(name, value)
        }
      }
    }
    for (const record of blocks(isMap(doc['imports']) ? doc['imports']['import_record'] : undefined)) {
      const file = str(record['file'])
      if (!file) continue
      visit(file, {
        areas: parts.areas && record['importAreas'] !== false,
        units: parts.units && record['importUnits'] !== false,
        triggers: parts.triggers && record['importTriggers'] !== false,
      }, false)
    }
  }
  visit(rel, { areas: true, units: true, triggers: true }, true)
  return result
}

/** mission_settings.mission with the overrides of `difficulty` (mission[] blocks). */
function missionSettings(settings: BlkMap, difficulty: MissionDifficulty): Record<string, BlkValue> {
  const mission = isMap(settings['mission']) ? settings['mission'] : {}
  const merged: Record<string, BlkValue> = {}
  for (const [key, value] of Object.entries(mission)) if (key !== 'mission') merged[key] = value
  // The files spell simulator battles "hardcore" here and "simulator" in gameWhenDifficulty.
  const names = difficulty === 'simulator' ? ['simulator', 'hardcore'] : [difficulty]
  for (const override of blocks(mission['mission'])) {
    if (!names.includes(String(override['difficulty']))) continue
    for (const [key, value] of Object.entries(override)) if (key !== 'difficulty') merged[key] = value
  }
  return merged
}

export interface MissionOptions {
  difficulty?: MissionDifficulty
  /**
   * The battle's balance level (missionGetBalanceLevel → session_rank): economic rank, (BR − 1) × 3.
   * air_spawn_template picks the air spawns by it: < 20 arcade fighters and bombers, ≥ 20
   * "_hardcore", ≥ 32 "_top".
   */
  balanceLevel?: number
  /** Receives "trigger: actions|else_actions" for every trigger that fires (diagnostics). */
  trace?: string[]
}

export function interpretMission(rel: string, load: MissionLoader, options: MissionDifficulty | MissionOptions = 'realistic'): MissionMap {
  const { difficulty = 'realistic', balanceLevel = 0, trace } = typeof options === 'string' ? { difficulty: options } : options
  const mission = loadMission(rel, load)
  const settings = missionSettings(mission.settings, difficulty)
  const variables = new Map(mission.variables)
  const enabled = new Map<string, boolean>()
  const byName = new Map<string, Trigger>()
  for (const trigger of mission.triggers) {
    if (!byName.has(trigger.name)) byName.set(trigger.name, trigger)
    enabled.set(trigger.name, trigger.node['is_enabled'] !== false)
  }
  const result: MissionMap = {
    level: str(settings['level']) ?? '',
    type: str(settings['type']) ?? '',
    postfix: str(settings['postfix']) ?? '',
    settings,
    battleAreas: [],
    captureZones: [],
    respawnBases: [],
    warnings: [],
  }
  let respawnGroup = 0

  const resolve = (value: BlkValue | undefined): string | null => {
    const s = str(value)
    if (s === null) return null
    if (!s.startsWith('@')) return s
    const v = variables.get(s.slice(1))
    return typeof v === 'string' ? v : v === undefined ? null : String(v)
  }
  const names = (value: BlkValue | undefined): string[] =>
    asArray(value).map(resolve).filter((name): name is string => name !== null && name !== '')
  const area = (name: string): AreaShape | null => mission.areas.get(name.toLowerCase()) ?? null
  const squad = (name: string) => mission.squads.get(name.toLowerCase()) ?? null
  const exists = (name: string, type: string): boolean => {
    if (type === 'area') return area(name) !== null
    if (type === 'squad') return squad(name) !== null
    return area(name) !== null || squad(name) !== null
  }
  const team = (value: BlkValue | undefined): 'A' | 'B' | 'Both' =>
    value === 'A' || value === 'B' ? value : 'Both'

  const condition = (kind: string, c: BlkMap): boolean => {
    switch (kind) {
      case 'gameWhenDifficulty': {
        const want = String(c['difficulty'])
        const same = want === difficulty || (difficulty === 'simulator' && want === 'hardcore')
        return c['is'] === 'notEqual' ? !same : same
      }
      case 'objectExists':
        return names(c['target']).length > 0 && names(c['target']).every((name) => exists(name, String(c['type'] ?? '')))
      case 'varCompareBool':
      case 'varCompareInt':
      case 'varCompareString': {
        const name = str(c['var_value'])
        const left = name === null ? undefined : variables.get(name)
        const right = c['value']
        const op = String(c['comparasion_func'] ?? 'equal')
        if (left === undefined || right === undefined) return false
        if (op === 'equal') return left === right
        if (op === 'notEqual') return left !== right
        // The mission files use equal, notEqual, less, more, notLess and notMore.
        if (typeof left === 'number' && typeof right === 'number') {
          if (op === 'less') return left < right
          if (op === 'more') return left > right
          if (op === 'notLess') return left >= right
          if (op === 'notMore') return left <= right
        }
        return false
      }
      case 'missionNamePostfix':
        return str(c['postfix'])?.toLowerCase() === result.postfix.toLowerCase()
      case 'missionEnvironment': {
        const environments = isMap(c['environments']) ? c['environments'] : {}
        const environment = String(settings['environment'] ?? '').toLowerCase()
        return Object.entries(environments).some(([key, on]) => on === true && key.toLowerCase() === environment)
      }
      default:
        // Unit positions and states are unknown before the battle.
        return false
    }
  }

  const conditionsHold = (node: BlkMap): boolean => {
    const conditions = isMap(node['conditions']) ? node['conditions'] : {}
    const results: boolean[] = []
    for (const [kind, value] of Object.entries(conditions)) {
      for (const c of blocks(value)) results.push(condition(kind, c))
    }
    if (results.length === 0) return true
    const any = isMap(node['props']) && node['props']['conditionsType'] === 'ANY'
    return any ? results.some(Boolean) : results.every(Boolean)
  }

  // Triggers a running trigger enables; they fire after its actions, before its siblings (depth
  // first): air_spawn_template's rank checks set one variable in turn, and each enabled marker must
  // read its own value (rank ≥ 32 marks both the "_hardcore" and the "_top" spawns, as the snapshots show).
  let pending: Trigger[] = []
  const fired = new Set<string>()
  const onInit = (trigger: Trigger): boolean => isMap(trigger.node['events']) && 'initMission' in trigger.node['events']
  const enable = (name: string, on: boolean): void => {
    enabled.set(name, on)
    const trigger = byName.get(name)
    if (on && trigger && onInit(trigger) && !fired.has(name)) pending.push(trigger)
  }

  const action = (kind: string, a: BlkMap, trigger: string): void => {
    switch (kind) {
      case 'varSetString':
      case 'varSetBool':
      case 'varSetInt':
      case 'varSetReal': {
        const value = kind === 'varSetString' ? (resolve(a['value']) ?? '') : a['value']
        if (value === undefined) return
        for (const name of asArray(a['var'])) if (typeof name === 'string') variables.set(name, value)
        return
      }
      case 'varAddString': {
        const suffix = resolve(a['value']) ?? ''
        for (const name of asArray(a['var'])) {
          if (typeof name !== 'string') continue
          const current = variables.get(name)
          variables.set(name, `${typeof current === 'string' ? current : ''}${suffix}`)
        }
        return
      }
      case 'varModify': {
        const name = str(a['var'])
        const current = name === null ? undefined : variables.get(name)
        if (name === null || typeof current !== 'number' || typeof a['value'] !== 'number') return
        const op = String(a['operator'])
        variables.set(name, op === 'add' ? current + a['value'] : op === 'mul' ? current * a['value'] : current)
        return
      }
      case 'missionGetBalanceLevel': {
        const name = str(a['input_var'])
        if (name) variables.set(name, balanceLevel)
        return
      }
      case 'triggerEnable':
      case 'triggerDisable':
        for (const name of names(a['target'])) enable(name, kind === 'triggerEnable')
        return
      case 'getNearestAreaByMask': {
        const out = str(a['out_var'])
        const targets = names(a['target']).flatMap((name) => {
          const s = squad(name)
          return s ? [s.tm[3]] : (area(name) ? [area(name)!.tm[3]] : [])
        })
        const min = typeof a['dist_min_value'] === 'number' ? a['dist_min_value'] : 0
        const max = typeof a['dist_max_value'] === 'number' ? a['dist_max_value'] : Infinity
        let best: { name: string; distance: number } | null = null
        for (const name of names(a['areas'])) {
          const shape = area(name)
          if (!shape) continue
          for (const target of targets) {
            const distance = Math.hypot(shape.tm[3][0]! - target[0]!, shape.tm[3][2]! - target[2]!)
            if (distance >= min && distance <= max && (!best || distance < best.distance)) best = { name: shape.name, distance }
          }
        }
        if (out) variables.set(out, best?.name ?? '')
        return
      }
      case 'missionBattleArea': {
        // The area may be an area_squad: battlearea_exclude_template marks its members.
        const name = resolve(a['area']) ?? resolve(a['target'])
        const s = name ? squad(name) : null
        const shapes = s
          ? s.members.map(area).filter((shape): shape is AreaShape => shape !== null)
          : (name && area(name) ? [area(name)!] : [])
        for (const shape of shapes) result.battleAreas.push({
          area: shape,
          team: team(a['team']),
          mapArea: a['mapArea'] === true,
          airMapArea: a['airMapArea'] === true,
          ground: a['ground'] !== false,
          air: a['air'] === true,
          killArea: a['killArea'] === true,
          detectionArea: a['detectionArea'] === true,
          killOutOfBattleArea: a['killOutOfBattleArea'] === true,
          newGridHorizontalCellCount: typeof a['newGridHorizontalCellCount'] === 'number' ? a['newGridHorizontalCellCount'] : 0,
        })
        return
      }
      case 'missionMarkAsCaptureZone': {
        for (const name of names(a['target'])) {
          const shape = area(name)
          if (shape) result.captureZones.push({ area: shape, index: result.captureZones.length, army: typeof a['army'] === 'number' ? a['army'] : 0 })
        }
        return
      }
      case 'missionMarkAsRespawnPoint': {
        const targets = names(a['target'])
        const group = respawnGroup++
        const tags = isMap(a['tags']) ? Object.entries(a['tags']).filter(([, on]) => on === true).map(([tag]) => tag) : []
        for (const name of targets) {
          const s = squad(name)
          const areas = s
            ? s.members.map(area).filter((shape): shape is AreaShape => shape !== null)
            : (area(name) ? [area(name)!] : [])
          if (areas.length === 0) continue
          result.respawnBases.push({
            name,
            team: team(a['team']),
            areas,
            squadTm: s?.tm ?? null,
            tags,
            showOnMap: a['showOnMap'] !== false,
            isAirfield: a['isAirfield'] === true,
            isUnit: a['isUnit'] === true,
            group,
          })
        }
        return
      }
      case 'missionMarkAsRearmZone':
      case 'missionMarkAsExitZone':
      case 'duplicateAreaAtPos':
        result.warnings.push(`${trigger}: ${kind} is not drawn`)
        return
      default:
        return
    }
  }

  let steps = 0
  const run = (trigger: Trigger): void => {
    if (fired.has(trigger.name) || enabled.get(trigger.name) === false) return
    if (++steps > MAX_STEPS) throw new Error(`mission ${rel}: the initMission chain does not settle`)
    fired.add(trigger.name)
    const branch = conditionsHold(trigger.node) ? 'actions' : 'else_actions'
    trace?.push(`${trigger.name}: ${branch}`)
    const actions = isMap(trigger.node[branch]) ? trigger.node[branch] : {}
    const outer = pending
    pending = []
    for (const [kind, value] of Object.entries(actions)) {
      for (const a of blocks(value)) action(kind, a, trigger.name)
    }
    const enabledHere = pending
    pending = outer
    for (const next of enabledHere) run(next)
  }

  for (const trigger of mission.triggers) {
    if (onInit(trigger)) run(trigger)
  }
  return result
}
