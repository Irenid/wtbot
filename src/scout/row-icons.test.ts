import assert from 'node:assert/strict'
import test from 'node:test'
import { readEnemyRowIcons } from './row-icons.js'
import { findScoreboardRows, type RgbaImage } from './scoreboard-image.js'

type Rgb = [number, number, number]

/**
 * Eight rows 32 px apart (from y 150), the table middle at x 406: nick strokes
 * on both sides, red score strokes 18.5 pitches right of the middle, and an
 * icon 0.7 × 0.9 pitch centred 14.6 pitches right of it in the given rows.
 */
function scoreboard(width: number, icons: Record<number, Rgb>): RgbaImage {
  const height = 450
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) data.set([30, 34, 40, 255], i * 4)
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: Rgb) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < Math.min(x1, width); x += 1) data.set([...rgb, 255], (y * width + x) * 4)
  }
  for (let row = 0; row < 8; row += 1) {
    const y = 150 + row * 32
    for (let x = 120; x < 380; x += 7) fill(x, y, x + 3, y + 15, [220, 220, 220])
    for (let x = 420; x < 650; x += 7) fill(x, y, x + 3, y + 15, [230, 70, 70])
    fill(1000, y, 1004, y + 15, [230, 70, 70])
    const icon = icons[row]
    if (icon) fill(873 - 11, y + 7 - 14, 873 + 11, y + 7 + 15, icon)
  }
  return { width, height, data }
}

const PARACHUTE: Rgb = [63, 132, 197]
const FIGURE: Rgb = [238, 238, 238]

test('an icon in the enemy row says the player is not in a vehicle: a parachute or a figure', () => {
  const image = scoreboard(1100, { 2: PARACHUTE, 5: FIGURE })
  const layout = findScoreboardRows(image)
  assert.ok(layout)
  assert.deepEqual(readEnemyRowIcons(image, layout, 406), [null, null, 'parachute', null, null, 'figure', null, null])
})

test('no icon column in the picture, or no table middle: nothing is known', () => {
  const cropped = scoreboard(850, { 2: PARACHUTE })
  const layout = findScoreboardRows(cropped)
  assert.ok(layout)
  assert.equal(readEnemyRowIcons(cropped, layout, 406), null)
  const whole = scoreboard(1100, {})
  assert.equal(readEnemyRowIcons(whole, findScoreboardRows(whole)!, null), null)
  assert.deepEqual(readEnemyRowIcons(whole, findScoreboardRows(whole)!, 406), new Array(8).fill(null))
})
