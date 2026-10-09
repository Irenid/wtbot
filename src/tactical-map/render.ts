import { gridLabels, type MapSpawn, type Team, type TacticalMapModel } from './model.js'
import type { HatchStyle, MapTone } from './raster.js'

/**
 * The respawn screen's tactical map as the game draws it, measured on its
 * in-game snapshots (wt-tools, captured at 2560×1440: the map is 1153 px, and
 * the HUD, designed for 1080p, scales by 1440/1080). Sizes below are 1080p UI
 * pixels; at an output size of S px one UI pixel is S / UI_MAP_WIDTH px.
 *
 * Layers, bottom to top: the texture (tone ≈7% darker), the out-of-bounds
 * hatch, grid lines, grid labels, capture zones, tank bases, the cell size
 * bar. Icons are the game's white SVGs (ui/atlases.vromfs.bin
 * gameuiskin/<name>.svg, sizes from hud.blk tacticalMap:
 * "basezone_small_mark_a.svg:21:21", "objective_tank.svg:36:36") multiplied by
 * the draw colour.
 */

/** The map's width in 1080p UI pixels (1153 px at 1440p). */
export const UI_MAP_WIDTH = 1153 * 1080 / 1440

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
  zoneIcon: number
  tankIcon: number
  tankOutlineOpacity: number
  /** Respawn areas of one team closer than this merge into one icon (hud.blk minDistBetweenZonesOnRespawnBases). */
  spawnMergeMeters: number
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
  zoneIcon: 21,
  tankIcon: 36,
  tankOutlineOpacity: 0.45,
  spawnMergeMeters: 200,
  scaleBar: { thickness: 2.25, bottom: 0.75, textBaseline: 4.6 },
}

export interface MapIcons {
  /** gameuiskin/<name>.svg → markup. */
  get(name: string): string | undefined
}

const r2 = (n: number): string => (Math.round(n * 100) / 100).toString()

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/** The icon as a nested <svg> centred on (cx, cy), `width`×`height` px, optionally tinted. */
function icon(markup: string, cx: number, cy: number, width: number, height: number, tint: string | null, opacity = 1): string {
  const open = /<svg\b[^>]*>/i.exec(markup)
  if (!open) return ''
  const viewBox = /viewBox="([^"]+)"/i.exec(open[0])?.[1] ?? (() => {
    const w = /\bwidth="([\d.]+)/i.exec(open[0])?.[1]
    const h = /\bheight="([\d.]+)/i.exec(open[0])?.[1]
    return w && h ? `0 0 ${w} ${h}` : `0 0 ${width} ${height}`
  })()
  const body = markup.slice(open.index + open[0].length).replace(/<\/svg>\s*$/i, '')
  const filter = tint ? ` filter="url(#tint-${tint.slice(1)})"` : ''
  const alpha = opacity < 1 ? ` opacity="${r2(opacity)}"` : ''
  return `<g${filter}${alpha}><svg x="${r2(cx - width / 2)}" y="${r2(cy - height / 2)}" width="${r2(width)}" height="${r2(height)}" viewBox="${viewBox}" preserveAspectRatio="none" overflow="visible">${body}</svg></g>`
}

/** Multiplies RGB by the tint: white becomes the tint, black stays black, alpha is kept. */
function tintFilter(color: string): string {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  return `<filter id="tint-${color.slice(1)}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${c[0]} 0 0 0 0 0 ${c[1]} 0 0 0 0 0 ${c[2]} 0 0 0 0 0 1 0"/></filter>`
}

/** Respawn areas of one team and kind merged within `meters`; the icon sits at the group's mean. */
export function mergeSpawns(spawns: MapSpawn[], meters: number): MapSpawn[] {
  const groups: MapSpawn[][] = []
  for (const spawn of spawns) {
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
  /** Output pixels per UI pixel. */
  k: number
  px(x: number): number
  py(z: number): number
}

export function renderGeometry(model: TacticalMapModel, size: number): RenderGeometry {
  const v = model.view
  return {
    size,
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

export interface OverlayOptions {
  /** The viewer's team: its bases are drawn in the own colour. */
  team: Team
  style?: TacticalMapStyle
}

/** The overlay over `baseImageUri`, or on a transparent canvas when null (build.ts composites it). */
export function tacticalMapOverlaySvg(model: TacticalMapModel, geometry: RenderGeometry, baseImageUri: string | null, icons: MapIcons, options: OverlayOptions): string {
  const style = options.style ?? GAME_MAP_STYLE
  const { size, k, px, py } = geometry
  const v = model.view
  const inside = (x: number, z: number): boolean => x >= v.x0 && x <= v.x1 && z >= v.z0 && z <= v.z1
  const colorOf = (team: Team): string => (team === options.team ? style.ownColor : style.enemyColor)
  const parts: string[] = baseImageUri ? [`<image x="0" y="0" width="${size}" height="${size}" href="${baseImageUri}"/>`] : []

  // Grid lines on pixel centres, as the game's line drawer places them.
  const lines: string[] = []
  const step = model.grid.step
  if (step > 1) {
    for (let x = model.grid.zeroX + Math.ceil((v.x0 - model.grid.zeroX) / step) * step; x <= v.x1; x += step) {
      const sx = Math.floor(px(x)) + 0.5
      if (sx > 1 && sx < size - 1) lines.push(`M${sx} 0V${size}`)
    }
    for (let z = model.grid.zeroZ - Math.ceil((model.grid.zeroZ - v.z1) / step) * step; z >= v.z0; z -= step) {
      const sy = Math.floor(py(z)) + 0.5
      if (sy > 1 && sy < size - 1) lines.push(`M0 ${sy}H${size}`)
    }
  }
  if (lines.length > 0) {
    parts.push(`<path d="${lines.join('')}" fill="none" stroke="${style.gridColor}" stroke-opacity="${r2(style.gridOpacity)}" stroke-width="${r2(style.gridWidth * k)}"/>`)
  }

  const text = (x: number, y: number, label: string, anchor: 'middle' | 'start' = 'middle'): string =>
    `<text x="${r2(x)}" y="${r2(y)}" text-anchor="${anchor}" font-family="${style.fontFamily}" font-size="${r2(style.fontSize * k)}" fill="${style.fontColor}">${esc(label)}</text>`
  const { columns, rows } = gridLabels(model)
  for (const column of columns) parts.push(text(px(column.x), style.columnBaseline * k, column.label))
  for (const row of rows) parts.push(text(style.rowCenterX * k, py(row.z) + style.rowBaseline * k, row.label))

  for (const zone of model.zones) {
    if (!inside(zone.x, zone.z)) continue
    const markup = icons.get(`basezone_small_mark_${zone.letter.toLowerCase()}`)
    if (markup) parts.push(icon(markup, px(zone.x), py(zone.z), style.zoneIcon * k, style.zoneIcon * k, null))
  }

  // Tank bases inside the view. The game's arrows to bases outside it (arrow_mark.svg) are not
  // drawn yet: the snapshots show helicopter, UCAV and airfield spawns among them (ROADMAP).
  const tank = icons.get('objective_tank')
  const outline = icons.get('objective_tank_outline')
  const tints = new Set<string>()
  for (const spawn of mergeSpawns(model.spawns, style.spawnMergeMeters)) {
    if (spawn.kind !== 'tank' || !tank || !inside(spawn.x, spawn.z)) continue
    const color = colorOf(spawn.team)
    // An unselected base: a dark outline (the snapshots' enemy bases; the own one is the selected spawn).
    const s = style.tankIcon * k
    if (outline) parts.push(icon(outline, px(spawn.x), py(spawn.z), s, s, '#000000', style.tankOutlineOpacity))
    parts.push(icon(tank, px(spawn.x), py(spawn.z), s, s, color))
    tints.add(color)
    tints.add('#000000')
  }

  if (model.showCellSize && step > 1) {
    // One cell long, on the last whole lattice cell left of the right edge.
    const cell = (step / (v.x1 - v.x0)) * size
    const last = px(model.grid.zeroX + Math.floor((v.x1 - model.grid.zeroX) / step - 1e-6) * step)
    const right = last >= cell ? last : size - cell
    const bar = style.scaleBar
    parts.push(`<rect x="${r2(right - cell)}" y="${r2(size - (bar.bottom + bar.thickness) * k)}" width="${r2(cell)}" height="${r2(bar.thickness * k)}" fill="#000"/>`)
    parts.push(text(right - cell / 2, size - bar.textBaseline * k, `${Math.round(step)} m`))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs>${[...tints].map(tintFilter).join('')}</defs>${parts.join('')}</svg>`
}
