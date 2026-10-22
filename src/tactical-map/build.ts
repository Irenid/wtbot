import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import type { RgbaImage } from './dxp.js'
import { GameFiles, TACTICAL_MAP_SOURCES } from './game-files.js'
import { buildTacticalMapModel, type MapKind, type SpawnKind, type Team, type WorldRect } from './model.js'
import { balanceBucketRange } from './perspective.js'
import { applyHatch, applyTone, sampleFrame } from './raster.js'
import { GAME_MAP_STYLE, hatchStyle, MAP_SPAWN_KINDS, mergeSpawns, renderGeometry, tacticalMapOverlaySvg } from './render.js'
import { LABEL_FONT_FILE, TACTICAL_MAP_VERSION, tacticalMapSpec, type TacticalMapMeta, type TacticalMapSpec } from './spec.js'

/**
 * Draws tactical maps from the game files in a CPU worker: the spec (model.ts
 * from the archives, spec.ts), then any view of it (composeTacticalMap): the
 * texture resampled to the view with the game's tone and out-of-bounds hatch
 * (raster.ts), the overlay drawn by Resvg on a transparent layer and
 * composited over it (render.ts). A ground map is drawn whole and cached as an
 * image (build-tactical-map); an air map is cached as its spec and drawn for
 * each heatmap's view.
 */

/** The grid labels' font in ui/fonts.vromfs.bin (fonts.dynfont.blk tiny_text_hud). */
const LABEL_FONT = `ttfs/${LABEL_FONT_FILE}`

export interface TacticalMapBuildInput {
  gameDir: string
  /** gamedata/missions/….blk from the replay header. */
  mission: string
  /** The viewer: its bases in the own colour, the hatch of its battle areas. */
  team: Team
  /** missionGetBalanceLevel: (BR − 1) × 3; picks the rank's airfields, helipads and UCAV spawns. */
  balanceLevel: number
  size: number
  format: 'png' | 'jpeg'
  /** Where the label font is extracted once (data/fonts). */
  fontDir: string
}

export interface TacticalMapSpecInput {
  gameDir: string
  mission: string
  balanceLevel: number
  kind: MapKind
  fontDir: string
}

export interface TacticalMapBuildResult {
  image: Buffer
  mime: 'image/png' | 'image/jpeg'
  meta: TacticalMapMeta
}

export interface ComposeOptions {
  gameDir: string
  /** The world rect to draw (square); the spec's view by default. */
  view?: WorldRect
  size: number
  team: Team
  /** The label font (LABEL_FONT_FILE in the font folder); without it the labels fall back to no font. */
  fontFile: string | null
  /** Base kinds to draw; MAP_SPAWN_KINDS of the spec's kind by default. */
  kinds?: readonly SpawnKind[]
  /** false: no capture zones. */
  zones?: boolean
}

/** The label font extracted into fontDir (once; a parallel worker may win the race); null without it in the game files. */
function labelFont(files: GameFiles, fontDir: string): string | null {
  const file = path.resolve(fontDir, LABEL_FONT_FILE)
  if (existsSync(file)) return file
  const data = files.file(TACTICAL_MAP_SOURCES.fonts, LABEL_FONT)
  if (!data) return null
  // A sibling temporary file renamed into place.
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, data)
    renameSync(temporary, file)
  } catch (error) {
    if (!existsSync(file)) throw error
  } finally {
    rmSync(temporary, { force: true })
  }
  return file
}

/**
 * A mission's map spec from the archives; also extracts the label font the
 * drawing needs. A missing texture fails here, so no spec of an undrawable map
 * is cached (the air heatmaps then keep the level map captured from port 8111).
 */
export function buildTacticalMapSpec(input: TacticalMapSpecInput): TacticalMapSpec {
  const files = new GameFiles(input.gameDir)
  const build = (balanceLevel: number) => buildTacticalMapModel(input.mission, (archive, name) => files.blk(archive, name), {
    difficulty: 'realistic',
    balanceLevel,
    kind: input.kind,
  })
  const model = build(input.balanceLevel)
  // The map serves its whole bucket: a patch's new rankRange or rank check would draw it right at one end only.
  const signature = (m: typeof model): string => JSON.stringify([m.view, m.grid, m.areas, m.zones, m.spawns])
  const [first, last] = balanceBucketRange(input.balanceLevel)
  for (const level of new Set([first, last])) {
    if (level !== input.balanceLevel && signature(build(level)) !== signature(model)) {
      console.warn(`[maps] ${input.mission}: the ${input.kind} map of rank ${level} differs from rank ${input.balanceLevel}; BALANCE_LEVEL_THRESHOLDS lacks a threshold in ${first}–${last}`)
    }
  }
  if (!files.hasMapTexture(model.texture.name)) throw new Error(`no texture ${model.texture.name} in ${TACTICAL_MAP_SOURCES.maps}`)
  labelFont(files, input.fontDir)
  return tacticalMapSpec(model, input.balanceLevel, (name) => files.file(TACTICAL_MAP_SOURCES.icons, `gameuiskin/${name}.svg`)?.toString('utf8'))
}

/** One view of a map as RGBA: the texture (the HQ pack's when installed), tone, hatch, overlay. */
export function composeTacticalMap(spec: TacticalMapSpec, options: ComposeOptions): RgbaImage {
  const files = new GameFiles(options.gameDir)
  const texture = files.mapTexture(spec.texture.name)
  if (!texture) throw new Error(`no texture ${spec.texture.name} in ${TACTICAL_MAP_SOURCES.maps}`)
  const size = options.size
  const geometry = renderGeometry({ view: options.view ?? spec.view }, size)
  const style = GAME_MAP_STYLE

  const base = sampleFrame(texture, spec.texture.rect, geometry.view, size, [0, 0, 0, 255], spec.texture.colorMult)
  applyTone(base, style.tone)
  if (spec.battleAreaPreset !== null) {
    const metres = size / (geometry.view.x1 - geometry.view.x0)
    applyHatch(base, spec.areas[options.team], (x, z) => [geometry.px(x), geometry.py(z)], metres, hatchStyle(style, geometry.k))
  }

  const icons = { get: (name: string) => spec.icons[name] }
  const svg = tacticalMapOverlaySvg(spec, geometry, null, icons, {
    team: options.team,
    kinds: options.kinds ?? MAP_SPAWN_KINDS[spec.kind],
    ...(options.zones === undefined ? {} : { zones: options.zones }),
  })
  const overlay = new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles: options.fontFile ? [options.fontFile] : [], defaultFontFamily: style.fontFamily },
  }).render()
  if (overlay.width !== size || overlay.height !== size) throw new Error('overlay size mismatch')
  // Resvg returns straight (non-premultiplied) RGBA: out = overlay over base.
  const top = overlay.pixels
  const out = base.data
  for (let i = 0; i < out.length; i += 4) {
    const a = top[i + 3]! / 255
    if (a === 0) continue
    out[i] = Math.round(top[i]! * a + out[i]! * (1 - a))
    out[i + 1] = Math.round(top[i + 1]! * a + out[i + 1]! * (1 - a))
    out[i + 2] = Math.round(top[i + 2]! * a + out[i + 2]! * (1 - a))
    out[i + 3] = 255
  }
  return base
}

export function encodeMapImage(image: RgbaImage, format: 'png' | 'jpeg', quality = 92): Buffer {
  return format === 'jpeg'
    ? Buffer.from(jpeg.encode({ data: image.data, width: image.width, height: image.height }, quality).data)
    : PNG.sync.write(Object.assign(new PNG({ width: image.width, height: image.height }), { data: image.data }))
}

/** A mission's ground map (the respawn screen of tanks) as one team sees it. */
export function buildTacticalMap(input: TacticalMapBuildInput): TacticalMapBuildResult {
  const spec = buildTacticalMapSpec({ gameDir: input.gameDir, mission: input.mission, balanceLevel: input.balanceLevel, kind: 'tank', fontDir: input.fontDir })
  const fontFile = path.resolve(input.fontDir, LABEL_FONT_FILE)
  const image = composeTacticalMap(spec, {
    gameDir: input.gameDir,
    size: input.size,
    team: input.team,
    fontFile: existsSync(fontFile) ? fontFile : null,
  })
  return {
    image: encodeMapImage(image, input.format),
    mime: input.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    meta: {
      version: TACTICAL_MAP_VERSION,
      mission: input.mission,
      level: spec.level,
      team: input.team,
      balanceLevel: input.balanceLevel,
      size: input.size,
      view: spec.view,
      grid: spec.grid,
      zones: spec.zones,
      spawns: mergeSpawns(spec.spawns),
    },
  }
}
