import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { GameFiles, TACTICAL_MAP_SOURCES } from './game-files.js'
import { buildTacticalMapModel, type Team, type WorldRect } from './model.js'
import { applyHatch, applyTone, sampleFrame } from './raster.js'
import { GAME_MAP_STYLE, hatchStyle, mergeSpawns, renderGeometry, tacticalMapOverlaySvg } from './render.js'

/**
 * Builds one mission's tactical map from the game files (CPU worker task
 * build-tactical-map): the model (model.ts), the texture resampled to the view
 * with the game's tone and out-of-bounds hatch (raster.ts), the overlay drawn
 * by Resvg on a transparent layer and composited over it (render.ts).
 */

/** Bumped when the drawing changes: cached maps of older versions are rebuilt. */
export const TACTICAL_MAP_VERSION = 1

/** The grid labels' font: tiny_text_hud is PT Sans Web, reduced height (ui/fonts.vromfs.bin fonts.dynfont.blk). */
const LABEL_FONT = 'ttfs/pt_sans-web-regular-reducedheight.ttf'

export interface TacticalMapBuildInput {
  gameDir: string
  /** gamedata/missions/….blk from the replay header. */
  mission: string
  /** The viewer: its bases in the own colour, the hatch of its battle areas. */
  team: Team
  /** missionGetBalanceLevel: (BR − 1) × 3; picks the air spawns. */
  balanceLevel: number
  size: number
  format: 'png' | 'jpeg'
  /** Where the label font is extracted once (data/fonts). */
  fontDir: string
}

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
  /** Respawn bases as drawn: one per merged group. */
  spawns: { team: Team; kind: string; x: number; z: number }[]
}

export interface TacticalMapBuildResult {
  image: Buffer
  mime: 'image/png' | 'image/jpeg'
  meta: TacticalMapMeta
}

function labelFont(files: GameFiles, fontDir: string): string | null {
  const file = path.resolve(fontDir, path.basename(LABEL_FONT))
  if (existsSync(file)) return file
  const data = files.file(TACTICAL_MAP_SOURCES.fonts, LABEL_FONT)
  if (!data) return null
  // A sibling temporary file renamed into place; a parallel worker may win the race.
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

export function buildTacticalMap(input: TacticalMapBuildInput): TacticalMapBuildResult {
  const files = new GameFiles(input.gameDir)
  const model = buildTacticalMapModel(input.mission, (archive, name) => files.blk(archive, name), {
    difficulty: 'realistic',
    balanceLevel: input.balanceLevel,
  })
  const texture = files.texture(TACTICAL_MAP_SOURCES.maps, model.texture.name)
  if (!texture) throw new Error(`no texture ${model.texture.name} in ${TACTICAL_MAP_SOURCES.maps}`)
  const size = input.size
  const geometry = renderGeometry(model, size)
  const style = GAME_MAP_STYLE

  const base = sampleFrame(texture, model.texture.rect, model.view, size, [0, 0, 0, 255], model.texture.colorMult)
  applyTone(base, style.tone)
  if (model.battleAreaPreset !== null) {
    const metres = size / (model.view.x1 - model.view.x0)
    applyHatch(base, model.areas[input.team], (x, z) => [geometry.px(x), geometry.py(z)], metres, hatchStyle(style, geometry.k))
  }

  const icons = { get: (name: string) => files.file(TACTICAL_MAP_SOURCES.icons, `gameuiskin/${name}.svg`)?.toString('utf8') }
  const svg = tacticalMapOverlaySvg(model, geometry, null, icons, { team: input.team })
  const font = labelFont(files, input.fontDir)
  const overlay = new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles: font ? [font] : [], defaultFontFamily: style.fontFamily },
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

  const image = input.format === 'jpeg'
    ? Buffer.from(jpeg.encode({ data: out, width: size, height: size }, 92).data)
    : PNG.sync.write(Object.assign(new PNG({ width: size, height: size }), { data: out }))
  return {
    image,
    mime: input.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    meta: {
      version: TACTICAL_MAP_VERSION,
      mission: input.mission,
      level: model.level,
      team: input.team,
      balanceLevel: input.balanceLevel,
      size,
      view: model.view,
      grid: { zeroX: model.grid.zeroX, zeroZ: model.grid.zeroZ, step: model.grid.step },
      zones: model.zones,
      spawns: mergeSpawns(model.spawns, style.spawnMergeMeters),
    },
  }
}
