/**
 * The icon column of the enemy's scoreboard rows. The game draws an icon
 * there only for a player not in a vehicle (gui.vromfs.bin
 * scripts/statistics/mpstatisticsutil.nut, `unitIcon`): `dead.svg`, a blue
 * parachute, while not spawned yet or after being destroyed (`isDead`), a white
 * camera while watching, a white figure while not in the battle (loading, left).
 * Realistic battles hide the enemy's vehicles, so an enemy in a vehicle has
 * an empty cell, and exactly those players show a flag above the table
 * (mpstatistics.nut `getCountriesByTeam` skips `isDead`; flag-evidence.ts).
 */

import type { RgbaImage, ScoreboardRows } from './scoreboard-image.js'

/** parachute — not spawned yet or destroyed; figure — not in the battle, or watching after death. */
export type RowIcon = 'parachute' | 'figure'

/**
 * Where to look, in row pitches right of the table middle (flags.ts
 * tableMiddle): the icons' centres stood 14.2–15.1 pitches out on five
 * screenshots 1,623–2,158 px wide; the score column starts past 18.
 */
const ICON_WINDOW_PITCHES = [12.5, 17] as const
/** The column is in the picture when an icon at its far end would be whole. */
const ICON_VISIBLE_PITCHES = 15.8
/** Icon pixels a row needs, in pitch²: a parachute covered 0.27–0.33. */
const MIN_ICON_AREA = 0.08

/** The parachute's #3f84c5 through scaling and JPEG. */
const isParachuteBlue = (r: number, g: number, b: number): boolean => b > 100 && b - r > 60 && g - r > 20 && b - g > 25
const isWhite = (r: number, g: number, b: number): boolean => Math.min(r, g, b) > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 45

/**
 * Per scoreboard row, the icon in the enemy's column; null — none (in a
 * vehicle). The whole result null: the column is not in the picture or the
 * table middle is unknown.
 */
export function readEnemyRowIcons(image: RgbaImage, layout: ScoreboardRows, middle: number | null): (RowIcon | null)[] | null {
  const mids = layout.rows.map((row) => (row.y0 + row.y1) / 2)
  if (middle === null || mids.length < 2) return null
  const pitch = (mids[mids.length - 1]! - mids[0]!) / (mids.length - 1)
  if (middle + ICON_VISIBLE_PITCHES * pitch > image.width) return null
  const x0 = Math.max(0, Math.round(middle + ICON_WINDOW_PITCHES[0] * pitch))
  const x1 = Math.min(image.width, Math.round(middle + ICON_WINDOW_PITCHES[1] * pitch))
  const minPixels = MIN_ICON_AREA * pitch * pitch
  return mids.map((mid) => {
    const y0 = Math.max(0, Math.round(mid - pitch / 2))
    const y1 = Math.min(image.height, Math.round(mid + pitch / 2))
    let blue = 0
    let white = 0
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * image.width + x) * 4
        const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]
        if (isParachuteBlue(r, g, b)) blue += 1
        else if (isWhite(r, g, b)) white += 1
      }
    }
    return blue >= minPixels ? 'parachute' : white >= minPixels ? 'figure' : null
  })
}
