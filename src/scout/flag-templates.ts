/**
 * Raster templates of the game's flags for flags.ts, drawn from the atlas
 * SVGs (game-flags.ts) in a worker: Resvg is created only there. Flags hold
 * no text, so system fonts are not loaded (loading them took 6 s; the 86
 * flags draw in 14 ms).
 */

import { Resvg } from '@resvg/resvg-js'
import { FLAG_ASPECT, FLAG_BACKGROUND, type FlagTemplatePack } from './flags.js'

export const FLAG_TEMPLATE_WIDTH = 60
const FLAG_TEMPLATE_HEIGHT = Math.round(FLAG_TEMPLATE_WIDTH / FLAG_ASPECT)

/** Round badges and the placeholder are no scoreboard flags. */
const isFlag = (name: string): boolean => !name.endsWith('_round') && name !== '0'

export function renderFlagTemplates(svgs: readonly (readonly [string, string])[]): FlagTemplatePack {
  const icons: string[] = []
  const images: Uint8Array[] = []
  for (const [name, svg] of svgs) {
    if (!isFlag(name)) continue
    let rendered
    try {
      rendered = new Resvg(svg, { fitTo: { mode: 'width', value: FLAG_TEMPLATE_WIDTH }, font: { loadSystemFonts: false } }).render()
    } catch {
      continue
    }
    if (rendered.width !== FLAG_TEMPLATE_WIDTH || rendered.height !== FLAG_TEMPLATE_HEIGHT) continue
    const rgba = rendered.pixels
    const rgb = new Uint8Array(FLAG_TEMPLATE_WIDTH * FLAG_TEMPLATE_HEIGHT * 3)
    for (let i = 0; i < FLAG_TEMPLATE_WIDTH * FLAG_TEMPLATE_HEIGHT; i += 1) {
      const alpha = rgba[i * 4 + 3]! / 255
      for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = Math.round(rgba[i * 4 + c]! * alpha + FLAG_BACKGROUND[c]! * (1 - alpha))
    }
    icons.push(name)
    images.push(rgb)
  }
  const rgb = new Uint8Array(images.length * FLAG_TEMPLATE_WIDTH * FLAG_TEMPLATE_HEIGHT * 3)
  images.forEach((image, index) => rgb.set(image, index * image.length))
  return { icons, width: FLAG_TEMPLATE_WIDTH, height: FLAG_TEMPLATE_HEIGHT, rgb }
}
