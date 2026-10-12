import type { MapBattleAreas, MapKind, MapSpawn, MapZone, Team, TacticalMapModel, WorldRect } from './model.js'
import { MAP_SPAWN_KINDS, mapIconNames } from './render.js'

/**
 * Maps as data, importable by the main thread (no Resvg): the cache version, a
 * map's spec and the meta of a built ground map. build.ts draws them in a CPU
 * worker.
 */

/** The grid labels' font (tiny_text_hud: PT Sans Web, reduced height), extracted from ui/fonts.vromfs.bin ttfs/. */
export const LABEL_FONT_FILE = 'pt_sans-web-regular-reducedheight.ttf'

/**
 * Bumped when the drawing changes: cached maps and specs of older versions are rebuilt.
 * 2: the HQ textures (content.hq, 2048²), air maps, every base kind in the meta.
 */
export const TACTICAL_MAP_VERSION = 2

/**
 * A map without its texture's pixels: what composeTacticalMap (build.ts) draws
 * any view of. The air map's cache entry: built once per mission and rank from
 * the archives (~170 MB unpacked), drawn for each heatmap's view with only the
 * texture read from its pack.
 */
export interface TacticalMapSpec {
  version: number
  kind: MapKind
  mission: string
  level: string
  balanceLevel: number
  texture: TacticalMapModel['texture']
  /** The map's own view (the respawn screen's frame): grid labels count from its first cell. */
  view: WorldRect
  grid: { zeroX: number; zeroZ: number; step: number }
  showCellSize: boolean
  battleAreaPreset: string | null
  areas: Record<Team, MapBattleAreas>
  zones: MapZone[]
  /** Respawn areas as marked; the overlay merges them by kind. */
  spawns: MapSpawn[]
  /** gameuiskin/<name>.svg markup of every icon the map can draw. */
  icons: Record<string, string>
}

export function tacticalMapSpec(model: TacticalMapModel, balanceLevel: number, icon: (name: string) => string | undefined): TacticalMapSpec {
  const icons: Record<string, string> = {}
  for (const name of mapIconNames(MAP_SPAWN_KINDS[model.kind])) {
    const markup = icon(name)
    if (markup) icons[name] = markup
  }
  return {
    version: TACTICAL_MAP_VERSION,
    kind: model.kind,
    mission: model.mission,
    level: model.level,
    balanceLevel,
    texture: model.texture,
    view: model.view,
    grid: { zeroX: model.grid.zeroX, zeroZ: model.grid.zeroZ, step: model.grid.step },
    showCellSize: model.showCellSize,
    battleAreaPreset: model.battleAreaPreset,
    areas: model.areas,
    zones: model.zones,
    spawns: model.spawns,
    icons,
  }
}

/** A built ground map's meta (data/maps/game/*.json). */
export interface TacticalMapMeta {
  version: number
  mission: string
  level: string
  team: Team
  balanceLevel: number
  size: number
  /** The world rect the image covers (x east, z north). */
  view: WorldRect
  grid: { zeroX: number; zeroZ: number; step: number }
  zones: { letter: string; x: number; z: number; radius: number }[]
  /** Respawn bases of every kind, one per merged group (the image draws the tank ones). */
  spawns: { team: Team; kind: string; x: number; z: number }[]
}
