import { gridLabels, type GroundShape, type MapBattleAreas, type MapSpawn, type SpawnKind, type Team, type TacticalMapModel, type WorldRect } from './model.js'
import type { HatchStyle, MapTone } from './raster.js'

/**
 * The respawn screen's tactical map as the game draws it, measured on its
 * in-game snapshots (wt-tools, captured at 2560×1440: the map is 1153 px, and
 * the HUD, designed for 1080p, scales by 1440/1080). Sizes below are 1080p UI
 * pixels; at an output size of S px one UI pixel is S / UI_MAP_WIDTH px.
 *
 * Layers, bottom to top: the texture (tone ≈7% darker), the out-of-bounds
 * hatch, grid lines, spawn detection zones, grid labels, capture zones, respawn
 * bases, the cell size bar. Icons are the game's white SVGs (ui/atlases.vromfs.bin
 * gameuiskin/<name>.svg, sizes from hud.blk tacticalMap:
 * "basezone_small_mark_a.svg:21:21", "objective_tank.svg:36:36",
 * "objective_airfield.svg:45:25") multiplied by the draw colour. The tank map
 * draws tank bases; the air map every kind. A crop of a map (an air heatmap's
 * view) keeps the line widths, label and icon sizes in UI pixels, as the game's
 * zoomed map does.
 */

/** The map's width in 1080p UI pixels (1153 px at 1440p). */
export const UI_MAP_WIDTH = 1153 * 1080 / 1440

export interface SpawnIconStyle {
  /** gameuiskin/<icon>.svg, white. */
  icon: string
  /** Its dark outline, drawn under it (an unselected base); null: none. */
  outline: string | null
  width: number
  height: number
}

export interface TacticalMapStyle {
  tone: MapTone
  hatch: { color: [number, number, number]; alpha: number; texel: number; phase: number }
  gridColor: string
  gridOpacity: number
  gridWidth: number
  fontFamily: string
  fontSize: number
  fontColor: string
  /** Column labels: baseline below the top edge; row labels: centre x and baseline below the cell centre. */
  columnBaseline: number
  rowCenterX: number
  rowBaseline: number
  ownColor: string
  enemyColor: string
  /** Spawn detection zones: a dashed outline in the spawning team's colour (not the game's style: it outlines them only near a player). */
  detection: { width: number; dash: [number, number]; opacity: number }
  zoneIcon: number
  spawnIcons: Record<Exclude<SpawnKind, 'other'>, SpawnIconStyle>
  spawnOutlineOpacity: number
  /** Respawn areas of one team closer than this merge into one icon (hud.blk minDistBetweenZonesOnRespawnBases). */
  spawnMergeMeters: number
  /** The same for aircraft bases (minDistBetweenZonesOnAircraftRespawnBases). */
  aircraftSpawnMergeMeters: number
  scaleBar: { thickness: number; bottom: number; textBaseline: number }
}

export const GAME_MAP_STYLE: TacticalMapStyle = {
  // Fitted per channel on berlin__conquest-1 against the decoded texture (428k pixels, 2026-10-09); a fit
  // over 108 snapshots (R 0.972·x − 6.9) scored worse: captures differ more than the curve.
  tone: [[0.9395, -3.54], [0.9349, -3.56], [0.9230, -1.87]],
  // battleAreaColorPresets.battleArea [0, 75, 255, 30] (B, G, R, A); the pattern texel is screen height / 1000
  // px (1.44 px at 1440p: a stripe period of 23.03 px along x on every snapshot); phase from berlin__conquest-1.
  hatch: { color: [255, 75, 0], alpha: 30 / 255, texel: 1.08, phase: 16.44 },
  gridColor: '#000000',
  gridOpacity: 80 / 255,
  gridWidth: 1.3,
  fontFamily: 'PT Sans',
  // tiny_text_hud: 18 px at hRes.1080 (fonts.dynfont.blk), PT Sans Web reduced height.
  fontSize: 18,
  fontColor: '#000000',
  columnBaseline: 18.75,
  rowCenterX: 10.6,
  rowBaseline: 7.6,
  ownColor: '#054afb',
  enemyColor: '#f61914',
  detection: { width: 1.5, dash: [6, 4], opacity: 0.8 },
  zoneIcon: 21,
  spawnIcons: {
    tank: { icon: 'objective_tank', outline: 'objective_tank_outline', width: 36, height: 36 },
    fighter: { icon: 'objective_fighter', outline: 'objective_fighter_outline', width: 36, height: 36 },
    bomber: { icon: 'objective_bomber', outline: 'objective_bomber_outline', width: 36, height: 36 },
    helicopter: { icon: 'objective_helicopter', outline: 'objective_helicopter_outline', width: 36, height: 36 },
    ucav: { icon: 'objective_ucav', outline: 'objective_ucav_outline', width: 36, height: 36 },
    airfield: { icon: 'objective_airfield', outline: null, width: 45, height: 25 },
  },
  spawnOutlineOpacity: 0.45,
  spawnMergeMeters: 200,
  aircraftSpawnMergeMeters: 2000,
  scaleBar: { thickness: 2.25, bottom: 0.75, textBaseline: 4.6 },
}

/** Base kinds each map draws: the respawn screen of tanks shows tank bases, the air map all of them. */
export const MAP_SPAWN_KINDS: Record<TacticalMapModel['kind'], readonly SpawnKind[]> = {
  tank: ['tank'],
  air: ['airfield', 'tank', 'helicopter', 'ucav', 'bomber', 'fighter'],
}

/** Zone letters with an icon in gameuiskin (basezone_small_mark_a … _p). */
const ZONE_LETTERS = 'abcdefghijklmnop'

/** The icon names a map of these base kinds draws: zone letters, bases and their outlines. */
export function mapIconNames(kinds: readonly SpawnKind[], style: TacticalMapStyle = GAME_MAP_STYLE): string[] {
  const names = [...ZONE_LETTERS].map((letter) => `basezone_small_mark_${letter}`)
  for (const kind of kinds) {
    if (kind === 'other') continue
    const icon = style.spawnIcons[kind]
    names.push(icon.icon, ...(icon.outline ? [icon.outline] : []))
  }
  return names
}

export interface MapIcons {
  /** gameuiskin/<name>.svg → markup. */
  get(name: string): string | undefined
}

const r2 = (n: number): string => (Math.round(n * 100) / 100).toString()

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * The icon's markup as a nested <svg> centred on (cx, cy), `width`×`height` px,
 * optionally tinted. Ids and classes get the icon's name as a prefix: icons
 * reuse "a" and "cls-1", and one document holds several.
 */
function icon(name: string, markup: string, cx: number, cy: number, width: number, height: number, tint: string | null, opacity = 1): string {
  const open = /<svg\b[^>]*>/i.exec(markup)
  if (!open) return ''
  const viewBox = /viewBox="([^"]+)"/i.exec(open[0])?.[1] ?? (() => {
    const w = /\bwidth="([\d.]+)/i.exec(open[0])?.[1]
    const h = /\bheight="([\d.]+)/i.exec(open[0])?.[1]
    return w && h ? `0 0 ${w} ${h}` : `0 0 ${width} ${height}`
  })()
  const prefix = `${name.replace(/[^\w-]/g, '_')}-`
  const body = markup.slice(open.index + open[0].length).replace(/<\/svg>\s*$/i, '')
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
    .replace(/\bclass="([^"]+)"/g, (_all, list: string) => `class="${list.split(/\s+/).map((c) => prefix + c).join(' ')}"`)
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_all, attrs: string, css: string) =>
      `<style${attrs}>${css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, `.${prefix}$1`)}</style>`)
  const filter = tint ? ` filter="url(#tint-${tint.slice(1)})"` : ''
  const alpha = opacity < 1 ? ` opacity="${r2(opacity)}"` : ''
  return `<g${filter}${alpha}><svg x="${r2(cx - width / 2)}" y="${r2(cy - height / 2)}" width="${r2(width)}" height="${r2(height)}" viewBox="${viewBox}" preserveAspectRatio="none" overflow="visible">${body}</svg></g>`
}

/** Multiplies RGB by the tint: white becomes the tint, black stays black, alpha is kept. */
function tintFilter(color: string): string {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  return `<filter id="tint-${color.slice(1)}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${c[0]} 0 0 0 0 0 ${c[1]} 0 0 0 0 0 ${c[2]} 0 0 0 0 0 1 0"/></filter>`
}

/** Respawn areas of one team and kind merged within the kind's distance; the icon sits at the group's mean. */
export function mergeSpawns(spawns: readonly MapSpawn[], style: Pick<TacticalMapStyle, 'spawnMergeMeters' | 'aircraftSpawnMergeMeters'> = GAME_MAP_STYLE): MapSpawn[] {
  const groups: MapSpawn[][] = []
  for (const spawn of spawns) {
    const meters = spawn.kind === 'tank' || spawn.kind === 'other' ? style.spawnMergeMeters : style.aircraftSpawnMergeMeters
    const near = groups.filter((group) => group[0]!.team === spawn.team && group[0]!.kind === spawn.kind &&
      group.some((other) => Math.hypot(other.x - spawn.x, other.z - spawn.z) <= meters))
    if (near.length === 0) groups.push([spawn])
    else {
      // A spawn joining two groups merges them.
      const [first, ...rest] = near
      first!.push(spawn, ...rest.flat())
      for (const group of rest) groups.splice(groups.indexOf(group), 1)
    }
  }
  return groups.map((group) => ({
    team: group[0]!.team,
    kind: group[0]!.kind,
    x: group.reduce((sum, s) => sum + s.x, 0) / group.length,
    z: group.reduce((sum, s) => sum + s.z, 0) / group.length,
  }))
}

export interface RenderGeometry {
  size: number
  /** The world rect the output shows. */
  view: WorldRect
  /** Output pixels per UI pixel. */
  k: number
  px(x: number): number
  py(z: number): number
}

/** A square output of `size` px over `frame.view` (a map's own view or a crop of it). */
export function renderGeometry(frame: { view: WorldRect }, size: number): RenderGeometry {
  const v = { ...frame.view }
  return {
    size,
    view: v,
    k: size / UI_MAP_WIDTH,
    px: (x) => ((x - v.x0) / (v.x1 - v.x0)) * size,
    py: (z) => ((v.z1 - z) / (v.z1 - v.z0)) * size,
  }
}

/** The hatch in output pixels for the raster pass. */
export function hatchStyle(style: TacticalMapStyle, k: number): HatchStyle {
  return {
    color: style.hatch.color,
    alpha: style.hatch.alpha,
    periodX: 16 * style.hatch.texel * k,
    phase: style.hatch.phase * k,
  }
}

/** A ground shape in output pixels. */
type PixelShape = { kind: 'polygon'; points: [number, number][] } | { kind: 'circle'; x: number; y: number; r: number }

/** The part [t0, t1] of segment p→q inside a convex shape, or null. */
function insideInterval(shape: PixelShape, p: [number, number], q: [number, number]): [number, number] | null {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  if (shape.kind === 'circle') {
    const fx = p[0] - shape.x
    const fy = p[1] - shape.y
    const a = dx * dx + dy * dy
    const b = fx * dx + fy * dy
    const disc = b * b - a * (fx * fx + fy * fy - shape.r * shape.r)
    if (a === 0 || disc <= 0) return null
    const t0 = Math.max(0, (-b - Math.sqrt(disc)) / a)
    const t1 = Math.min(1, (-b + Math.sqrt(disc)) / a)
    return t0 < t1 ? [t0, t1] : null
  }
  // Cyrus–Beck: the segment against each edge's inner half-plane (the centroid's side, either winding).
  const points = shape.points
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!
    const [bx, by] = points[(i + 1) % points.length]!
    const flip = (ay - by) * (cx - ax) + (bx - ax) * (cy - ay) < 0 ? -1 : 1
    const nx = flip * (ay - by)
    const ny = flip * (bx - ax)
    const start = nx * (p[0] - ax) + ny * (p[1] - ay)
    const along = nx * dx + ny * dy
    if (along === 0) {
      if (start < 0) return null
    } else if (along > 0) t0 = Math.max(t0, -start / along)
    else t1 = Math.min(t1, -start / along)
    if (t0 >= t1) return null
  }
  return [t0, t1]
}

/**
 * SVG path data of the outline of a union of convex shapes: each shape's boundary
 * without its parts inside another (overlapping circles of one spawn zone draw
 * as one outline). Circles become polygons within `tolerance` px.
 */
function unionOutline(shapes: PixelShape[], tolerance: number): string {
  const ring = (shape: PixelShape): [number, number][] => {
    if (shape.kind === 'polygon') return shape.points
    const n = Math.min(720, Math.max(24, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tolerance / shape.r)))))
    return Array.from({ length: n }, (_, i): [number, number] =>
      [shape.x + shape.r * Math.cos((2 * Math.PI * i) / n), shape.y + shape.r * Math.sin((2 * Math.PI * i) / n)])
  }
  const at = (a: [number, number], b: [number, number], t: number): string =>
    `${r2(a[0] + (b[0] - a[0]) * t)} ${r2(a[1] + (b[1] - a[1]) * t)}`
  // Two equal shapes would hide each other's whole boundary.
  const unique = [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()]
  let d = ''
  unique.forEach((shape, index) => {
    const points = ring(shape)
    let path = ''
    let joined = false
    let whole = true
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      const hidden = unique
        .map((other, j) => (j === index ? null : insideInterval(other, a, b)))
        .filter((part): part is [number, number] => part !== null)
        .sort((x, y) => x[0] - y[0])
      let t = 0
      const visible: [number, number][] = []
      for (const [h0, h1] of hidden) {
        if (h0 > t) visible.push([t, h0])
        t = Math.max(t, h1)
      }
      if (t < 1) visible.push([t, 1])
      if (visible.length !== 1 || visible[0]![0] > 0 || visible[0]![1] < 1) whole = false
      for (const [v0, v1] of visible) {
        if (!joined || v0 > 0) path += `M${at(a, b, v0)}`
        path += `L${at(a, b, v1)}`
        joined = v1 === 1
      }
      if (visible.length === 0) joined = false
    }
    d += whole ? `${path}Z` : path
  })
  return d
}

/** What the overlay draws: the map's lattice and own view (it names the cells), detection zones, zones, bases, the cell size bar. */
export interface MapOverlaySpec extends Pick<TacticalMapModel, 'view' | 'zones' | 'spawns' | 'showCellSize'> {
  grid: { zeroX: number; zeroZ: number; step: number }
  /** Each team's detection areas (tank maps); none drawn without. */
  areas?: Record<Team, Pick<MapBattleAreas, 'detection'>>
}

export interface OverlayOptions {
  /** The viewer's team: its bases are drawn in the own colour. */
  team: Team
  /** Base kinds to draw (MAP_SPAWN_KINDS of the map). */
  kinds?: readonly SpawnKind[]
  /** false: no capture zones (an air heatmap insets the ground map over them). */
  zones?: boolean
  style?: TacticalMapStyle
}

/** The overlay over `baseImageUri`, or on a transparent canvas when null (build.ts composites it). */
export function tacticalMapOverlaySvg(spec: MapOverlaySpec, geometry: RenderGeometry, baseImageUri: string | null, icons: MapIcons, options: OverlayOptions): string {
  const style = options.style ?? GAME_MAP_STYLE
  const kinds = new Set(options.kinds ?? MAP_SPAWN_KINDS.tank)
  const { size, k, px, py, view: v } = geometry
  const inside = (x: number, z: number): boolean => x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1
  const colorOf = (team: Team): string => (team === options.team ? style.ownColor : style.enemyColor)
  const parts: string[] = baseImageUri ? [`<image x="0" y="0" width="${size}" height="${size}" href="${baseImageUri}"/>`] : []

  // Grid lines on pixel centres, as the game's line drawer places them.
  const lines: string[] = []
  const step = spec.grid.step
  if (step > 1) {
    for (let x = spec.grid.zeroX + Math.ceil((v.x0 - spec.grid.zeroX) / step) * step; x <= v.x1; x += step) {
      const sx = Math.floor(px(x)) + 0.5
      if (sx > 1 && sx < size - 1) lines.push(`M${sx} 0V${size}`)
    }
    for (let z = spec.grid.zeroZ - Math.ceil((spec.grid.zeroZ - v.z1) / step) * step; z >= v.z0; z -= step) {
      const sy = Math.floor(py(z)) + 0.5
      if (sy > 1 && sy < size - 1) lines.push(`M0 ${sy}H${size}`)
    }
  }
  if (lines.length > 0) {
    parts.push(`<path d="${lines.join('')}" fill="none" stroke="${style.gridColor}" stroke-opacity="${r2(style.gridOpacity)}" stroke-width="${r2(style.gridWidth * k)}"/>`)
  }

  // A team's detection areas surround the other team's spawns: each outline takes the spawning team's colour.
  const metres = size / (v.x1 - v.x0)
  const toPixels = (shape: GroundShape): PixelShape => shape.kind === 'circle'
    ? { kind: 'circle', x: px(shape.x), y: py(shape.z), r: shape.r * metres }
    : { kind: 'polygon', points: shape.points.map(([x, z]): [number, number] => [px(x), py(z)]) }
  for (const revealed of ['A', 'B'] as const) {
    const shapes = spec.areas?.[revealed].detection ?? []
    const d = shapes.length > 0 ? unionOutline(shapes.map(toPixels), 0.25) : ''
    if (!d) continue
    const { width, dash, opacity } = style.detection
    parts.push(`<path d="${d}" fill="none" stroke="${colorOf(revealed === 'A' ? 'B' : 'A')}" stroke-opacity="${r2(opacity)}" ` +
      `stroke-width="${r2(width * k)}" stroke-dasharray="${dash.map((n) => r2(n * k)).join(' ')}"/>`)
  }

  const text = (x: number, y: number, label: string, anchor: 'middle' | 'start' = 'middle'): string =>
    `<text x="${r2(x)}" y="${r2(y)}" text-anchor="${anchor}" font-family="${style.fontFamily}" font-size="${r2(style.fontSize * k)}" fill="${style.fontColor}">${esc(label)}</text>`
  const { columns, rows } = gridLabels(spec, v)
  for (const column of columns) parts.push(text(px(column.x), style.columnBaseline * k, column.label))
  for (const row of rows) parts.push(text(style.rowCenterX * k, py(row.z) + style.rowBaseline * k, row.label))

  for (const zone of options.zones === false ? [] : spec.zones) {
    if (!inside(zone.x, zone.z)) continue
    const name = `basezone_small_mark_${zone.letter.toLowerCase()}`
    const markup = icons.get(name)
    if (markup) parts.push(icon(name, markup, px(zone.x), py(zone.z), style.zoneIcon * k, style.zoneIcon * k, null))
  }

  // Bases inside the view. The game's arrows to bases outside it (arrow_mark.svg) are not drawn
  // yet (ROADMAP); an air map's view holds every base of a squadron mission.
  const tints = new Set<string>()
  for (const spawn of mergeSpawns(spec.spawns, style)) {
    if (spawn.kind === 'other' || !kinds.has(spawn.kind) || !inside(spawn.x, spawn.z)) continue
    const kind = style.spawnIcons[spawn.kind]
    const markup = icons.get(kind.icon)
    if (!markup) continue
    const color = colorOf(spawn.team)
    const w = kind.width * k
    const h = kind.height * k
    // A dark outline under the coloured icon (the snapshots' bases; the yellow brackets are the selection).
    const outline = kind.outline ? icons.get(kind.outline) : undefined
    if (kind.outline && outline) parts.push(icon(kind.outline, outline, px(spawn.x), py(spawn.z), w, h, '#000000', style.spawnOutlineOpacity))
    parts.push(icon(kind.icon, markup, px(spawn.x), py(spawn.z), w, h, color))
    tints.add(color)
    if (outline) tints.add('#000000')
  }

  if (spec.showCellSize && step > 1) {
    // One cell long, on the last whole lattice cell left of the right edge.
    const cell = (step / (v.x1 - v.x0)) * size
    const last = px(spec.grid.zeroX + Math.floor((v.x1 - spec.grid.zeroX) / step - 1e-6) * step)
    const right = last >= cell ? last : size - cell
    const bar = style.scaleBar
    parts.push(`<rect x="${r2(right - cell)}" y="${r2(size - (bar.bottom + bar.thickness) * k)}" width="${r2(cell)}" height="${r2(bar.thickness * k)}" fill="#000"/>`)
    parts.push(text(right - cell / 2, size - bar.textBaseline * k, `${Math.round(step)} m`))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs>${[...tints].map(tintFilter).join('')}</defs>${parts.join('')}</svg>`
}
