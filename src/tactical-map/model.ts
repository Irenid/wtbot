import type { BlkMap, BlkValue } from '../wrpl/blk.js'
import { interpretMission, type AreaShape, type MissionDifficulty, type MissionMap } from './mission.js'

/**
 * What the game's tactical map shows for a mission, in world coordinates
 * (x east, z north; metres), reverse-engineered from linux64/aces (build of
 * 2026-10-08) and checked on 158 in-game respawn-map snapshots (wt-tools): the
 * predicted grid lines are within 3 px of the snapshot's in all of them.
 *
 * The tank map record (level loader 0x266f570): map_min/map_max from
 * tankMapCoord0/1 (the texture's world rect), grid zero from
 * tankGridZeroPoint (default: the rect's north-west corner), size from
 * tankGridSize (default: the rect), steps from tankGridSteps (default 1, 1:
 * no grid) through adjustGridSteps. With useAlternativeMapCoord (the mission
 * setting after its difficulty override) a key of the level's
 * alternativeMapCoord block wins over the level's own (point getter 0x1bc55b0).
 *
 * The mission (0x266ef00): every area a missionBattleArea action marks
 * ground and mapArea (any team) joins one XZ bounding box; it replaces the
 * grid zero (its north-west corner) and size, and the steps are recomputed
 * with the action's newGridHorizontalCellCount. The texture rect stays.
 *
 * The respawn map shows a square of the grid's longer side around its centre,
 * moved back inside the texture rect when it overhangs; the grid lattice runs
 * through the whole view.
 */

export interface WorldRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

export type Team = 'A' | 'B'

export interface MapZone {
  letter: string
  x: number
  z: number
  radius: number
}

export interface MapSpawn {
  team: Team
  x: number
  z: number
  kind: 'tank' | 'fighter' | 'bomber' | 'helicopter' | 'other'
}

/** A battle-area shape on the ground plane: a (rotated) rectangle or a circle. */
export type GroundShape =
  | { kind: 'polygon'; points: [number, number][] }
  | { kind: 'circle'; x: number; z: number; r: number }

export interface MapBattleAreas {
  /** Where the team may drive: battle areas that are neither kill nor detection areas. */
  allowed: GroundShape[]
  /** Kill areas (exclusions): out of bounds although inside the allowed areas. */
  kill: GroundShape[]
}

export interface TacticalMapModel {
  mission: string
  level: string
  difficulty: MissionDifficulty
  /** The world rect the map image shows. */
  view: WorldRect
  /** The texture's world rect (tankMapCoord0/1). */
  texture: { name: string; rect: WorldRect; colorMult: [number, number, number, number] }
  /** Grid lattice: lines at zero.x + k·step and zero.z − k·step. */
  grid: { zeroX: number; zeroZ: number; step: number; sizeX: number; sizeZ: number }
  showCellSize: boolean
  /** battleAreaColorPresets entry of the mission (hud.blk), or null. */
  battleAreaPreset: string | null
  areas: Record<Team, MapBattleAreas>
  zones: MapZone[]
  spawns: MapSpawn[]
  missionMap: MissionMap
}

export type BlkSource = (archive: 'mis.vromfs.bin' | 'aces.vromfs.bin', name: string) => BlkMap | null

/** gameplay.blk tacticalMap tables of 2026-10-09: row x is the grid's longer side in metres. */
const DEFAULT_CELL_COUNT: [number, number][] = [[0, 7], [4999, 7], [5000, 10]]
const DEFAULT_GRID_STEP_DIV: [number, number][] = [[0, 5], [299, 5], [300, 10], [1399, 10], [1400, 25], [2599, 25], [2600, 50], [9999, 50], [10000, 100]]

const isMap = (value: BlkValue | undefined): value is BlkMap =>
  value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)

const point2 = (value: BlkValue | undefined): [number, number] | null => {
  // A repeated key holds its occurrences; the game reads the first one.
  const first = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value
  return Array.isArray(first) && first.length >= 2 && typeof first[0] === 'number' && typeof first[1] === 'number'
    ? [first[0], first[1]]
    : null
}

/** A gameplay.blk table: `row` points (x, value), sorted by x. */
function table(node: BlkValue | undefined, fallback: [number, number][]): [number, number][] {
  const rows = isMap(node) ? node['row'] : undefined
  const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows : rows === undefined ? [] : [rows]
  const parsed = list.map(point2).filter((row): row is [number, number] => row !== null).sort((a, b) => a[0] - b[0])
  return parsed.length > 0 ? parsed : fallback
}

/** 0x266d6e0's lookup: linear between rows, clamped at both ends. */
function lerpTable(rows: [number, number][], x: number): number {
  if (x <= rows[0]![0]) return rows[0]![1]
  if (x >= rows[rows.length - 1]![0]) return rows[rows.length - 1]![1]
  for (let i = 1; i < rows.length; i++) {
    const [x0, v0] = rows[i - 1]!
    const [x1, v1] = rows[i]!
    if (x < x1) return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0)
  }
  return rows[rows.length - 1]![1]
}

/**
 * adjustSteps (0x266d6e0): a step of 1 or less keeps the grid as it is; a
 * cell count gives size / cells; otherwise floor(m / (cells(m)·unit(m)))·unit(m)
 * for the longer side m. The step is square: the x step is used for both.
 */
export function gridStep(sizeX: number, sizeZ: number, cells: number, current: number, cellCount = DEFAULT_CELL_COUNT, stepDiv = DEFAULT_GRID_STEP_DIV): number {
  if (current <= 1) return current
  if (cells > 0) return sizeX / cells
  const m = Math.max(sizeX, sizeZ)
  const unit = lerpTable(stepDiv, m)
  return Math.floor(m / (lerpTable(cellCount, m) * unit)) * unit
}

/** 0x1e3f200: a box scales the unit cube [-0.5, 0.5]³, a cylinder or sphere the unit radius. */
export function areaRect(area: AreaShape): WorldRect {
  const [a, b, c, p] = area.tm
  if (area.type === 'Box') {
    const hx = 0.5 * (Math.abs(a[0]!) + Math.abs(b[0]!) + Math.abs(c[0]!))
    const hz = 0.5 * (Math.abs(a[2]!) + Math.abs(b[2]!) + Math.abs(c[2]!))
    return { x0: p[0]! - hx, z0: p[2]! - hz, x1: p[0]! + hx, z1: p[2]! + hz }
  }
  const r = area.type === 'Point' ? 0 : Math.max(Math.hypot(...a), Math.hypot(...c))
  return { x0: p[0]! - r, z0: p[2]! - r, x1: p[0]! + r, z1: p[2]! + r }
}

/** The area's footprint: a box's corners in order, a cylinder or sphere as a circle. */
export function groundShape(area: AreaShape): GroundShape | null {
  const [a, , c, p] = area.tm
  if (area.type === 'Box') {
    const corner = (u: number, v: number): [number, number] => [p[0]! + (u * a[0]! + v * c[0]!) / 2, p[2]! + (u * a[2]! + v * c[2]!) / 2]
    return { kind: 'polygon', points: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] }
  }
  if (area.type === 'Point') return null
  return { kind: 'circle', x: p[0]!, z: p[2]!, r: Math.max(Math.hypot(...a), Math.hypot(...c)) }
}

/** The view: a square of the grid's longer side around its centre, moved back inside `bounds`. */
export function viewRect(grid: { zeroX: number; zeroZ: number; sizeX: number; sizeZ: number }, bounds: WorldRect): WorldRect {
  const side = Math.max(grid.sizeX, grid.sizeZ)
  const cx = grid.zeroX + grid.sizeX / 2
  const cz = grid.zeroZ - grid.sizeZ / 2
  let x0 = cx - side / 2
  let z1 = cz + side / 2
  if (side <= bounds.x1 - bounds.x0) x0 = Math.min(Math.max(x0, bounds.x0), bounds.x1 - side)
  if (side <= bounds.z1 - bounds.z0) z1 = Math.max(Math.min(z1, bounds.z1), bounds.z0 + side)
  return { x0, z0: z1 - side, x1: x0 + side, z1 }
}

/**
 * Grid labels at the lattice cells whose centre is strictly inside the view
 * (alaska_town_dom: 7.5 cells, no "8" and no "h" on the snapshot): columns 1,
 * 2, … and rows a, b, …
 */
export function gridLabels(model: Pick<TacticalMapModel, 'grid' | 'view'>): { columns: { x: number; label: string }[]; rows: { z: number; label: string }[] } {
  const { grid, view } = model
  const columns: { x: number; label: string }[] = []
  const rows: { z: number; label: string }[] = []
  if (grid.step <= 1) return { columns, rows }
  const eps = 1e-3
  for (let k = Math.floor((view.x0 - grid.zeroX) / grid.step) - 1; grid.zeroX + (k + 0.5) * grid.step < view.x1 - eps; k++) {
    const x = grid.zeroX + (k + 0.5) * grid.step
    if (x > view.x0 + eps) columns.push({ x, label: String(columns.length + 1) })
  }
  for (let k = Math.floor((grid.zeroZ - view.z1) / grid.step) - 1; grid.zeroZ - (k + 0.5) * grid.step > view.z0 + eps; k++) {
    const z = grid.zeroZ - (k + 0.5) * grid.step
    if (z < view.z1 - eps && rows.length < 26) rows.push({ z, label: String.fromCharCode(97 + rows.length) })
  }
  return { columns, rows }
}

function spawnKind(tags: string[]): MapSpawn['kind'] {
  if (tags.includes('tank')) return 'tank'
  if (tags.some((tag) => tag.includes('helicopter'))) return 'helicopter'
  if (tags.some((tag) => tag.includes('bomber'))) return 'bomber'
  if (tags.length === 0 || tags.some((tag) => tag.includes('fighter') || tag === 'air')) return 'fighter'
  return 'other'
}

export function buildTacticalMapModel(
  missionRel: string,
  source: BlkSource,
  options: { difficulty?: MissionDifficulty; balanceLevel?: number } = {},
): TacticalMapModel {
  const difficulty = options.difficulty ?? 'realistic'
  const missionMap = interpretMission(missionRel, (rel) => source('mis.vromfs.bin', rel), { difficulty, balanceLevel: options.balanceLevel ?? 0 })
  const level = missionMap.level.replace(/^.*[/\\]/, '').replace(/\.bin$/i, '')
  const settings = source('aces.vromfs.bin', `levels/${level}.blk`)
  if (!settings) throw new Error(`level ${level} has no settings in aces.vromfs.bin`)
  const gameplay = source('aces.vromfs.bin', 'config/gameplay.blk')
  const tactical = gameplay && isMap(gameplay['tacticalMap']) ? gameplay['tacticalMap'] : {}
  const cellCount = table(tactical['cellCount'], DEFAULT_CELL_COUNT)
  const stepDiv = table(tactical['gridStepDiv'], DEFAULT_GRID_STEP_DIV)

  const alternative = missionMap.settings['useAlternativeMapCoord'] === true && isMap(settings['alternativeMapCoord'])
    ? settings['alternativeMapCoord']
    : null
  const get = (key: string): [number, number] | null => point2(alternative?.[key]) ?? point2(settings[key])
  const mapMin = get('tankMapCoord0') ?? [-15000, -15000]
  const mapMax = get('tankMapCoord1') ?? [15000, 15000]
  if (mapMax[0] <= mapMin[0] || mapMax[1] <= mapMin[1]) throw new Error(`level ${level} has an empty tank map rect`)
  const textureRect = { x0: mapMin[0], z0: mapMin[1], x1: mapMax[0], z1: mapMax[1] }
  const zero = get('tankGridZeroPoint')
  const size = get('tankGridSize') ?? [mapMax[0] - mapMin[0], mapMax[1] - mapMin[1]]
  const levelStep = (get('tankGridSteps') ?? [1, 1])[0]
  // "numY < 0! Incorrect tankGridZeroPoint" (0x266ffe3): a zero below the rect falls back to its corner.
  const levelZero: [number, number] = zero && zero[1] > mapMin[1] ? zero : [mapMin[0], mapMax[1]]
  let grid = {
    zeroX: levelZero[0],
    zeroZ: levelZero[1],
    sizeX: size[0],
    sizeZ: size[1],
    step: gridStep(size[0], size[1], 0, levelStep, cellCount, stepDiv),
  }
  const mapAreas = missionMap.battleAreas.filter((area) => area.mapArea && area.ground)
  if (mapAreas.length > 0) {
    const rects = mapAreas.map((area) => areaRect(area.area))
    const x0 = Math.min(...rects.map((r) => r.x0))
    const z0 = Math.min(...rects.map((r) => r.z0))
    const x1 = Math.max(...rects.map((r) => r.x1))
    const z1 = Math.max(...rects.map((r) => r.z1))
    const cells = mapAreas.find((area) => area.newGridHorizontalCellCount > 0)?.newGridHorizontalCellCount ?? 0
    grid = { zeroX: x0, zeroZ: z1, sizeX: x1 - x0, sizeZ: z1 - z0, step: gridStep(x1 - x0, z1 - z0, cells, grid.step, cellCount, stepDiv) }
  }
  const view = viewRect(grid, textureRect)

  const textureName = (typeof settings['customLevelTankMap'] === 'string' ? settings['customLevelTankMap'] : `${level}_tankmap`)
    .replace(/[*$?].*$/, '')
  const mult = settings['tankMapColorMult']
  const colorMult: [number, number, number, number] = Array.isArray(mult) && mult.length === 4 && mult.every((x) => typeof x === 'number')
    // BLK colours are E3DCOLOR bytes: blue, green, red, alpha.
    ? [mult[2] as number, mult[1] as number, mult[0] as number, mult[3] as number]
    : [255, 255, 255, 255]

  const areasFor = (team: Team): MapBattleAreas => {
    const mine = missionMap.battleAreas.filter((area) => area.ground && (area.team === 'Both' || area.team === team))
    const shapes = (list: typeof mine): GroundShape[] =>
      list.map((area) => groundShape(area.area)).filter((shape): shape is GroundShape => shape !== null)
    return {
      allowed: shapes(mine.filter((area) => !area.killArea && !area.detectionArea)),
      kill: shapes(mine.filter((area) => area.killArea)),
    }
  }

  const zones = missionMap.captureZones.map((zone) => ({
    letter: String.fromCharCode(65 + zone.index),
    x: zone.area.tm[3][0]!,
    z: zone.area.tm[3][2]!,
    radius: (areaRect(zone.area).x1 - areaRect(zone.area).x0) / 2,
  }))

  const spawns: MapSpawn[] = []
  for (const base of missionMap.respawnBases) {
    if (!base.showOnMap || base.team === 'Both') continue
    const kind = spawnKind(base.tags)
    for (const area of base.areas) spawns.push({ team: base.team, x: area.tm[3][0]!, z: area.tm[3][2]!, kind })
  }

  return {
    mission: missionRel,
    level,
    difficulty,
    view,
    texture: { name: textureName, rect: textureRect, colorMult },
    grid,
    showCellSize: missionMap.settings['showTacticalMapCellSize'] === true,
    battleAreaPreset: typeof missionMap.settings['battleAreaColorPreset'] === 'string' ? missionMap.settings['battleAreaColorPreset'] : null,
    areas: { A: areasFor('A'), B: areasFor('B') },
    zones,
    spawns,
    missionMap,
  }
}
