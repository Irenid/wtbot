import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFlag, findFlagLine, readScoreboardFlags, splitFlagSides, tableMiddle, templateGrids, type FlagTemplatePack } from './flags.js'
import { findScoreboardRows, type RgbaImage } from './scoreboard-image.js'

type Rgb = [number, number, number]
const RED: Rgb = [200, 30, 40]
const WHITE: Rgb = [240, 240, 240]
const BLUE: Rgb = [20, 60, 170]
const GREEN: Rgb = [30, 140, 60]
const YELLOW: Rgb = [250, 200, 20]

/** Flags as functions of (u, v) in [0, 1): stripes and a cross, like the game's. */
const FLAGS: Record<string, (u: number, v: number) => Rgb> = {
  stripes: (_u, v) => (v < 1 / 3 ? WHITE : v < 2 / 3 ? BLUE : RED),
  bands: (u) => (u < 1 / 3 ? GREEN : u < 2 / 3 ? WHITE : RED),
  cross: (u, v) => (Math.abs(u - 0.4) < 0.08 || Math.abs(v - 0.5) < 0.12 ? YELLOW : BLUE),
  disc: (u, v) => ((u - 0.5) ** 2 * 2.3 + (v - 0.5) ** 2 < 0.06 ? RED : WHITE),
}

function pack(): FlagTemplatePack {
  const width = 60
  const height = 40
  const icons = Object.keys(FLAGS)
  const rgb = new Uint8Array(icons.length * width * height * 3)
  icons.forEach((icon, index) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) rgb.set(FLAGS[icon]!((x + 0.5) / width, (y + 0.5) / height), ((index * height + y) * width + x) * 3)
    }
  })
  return { icons, width, height, rgb }
}

/**
 * A scoreboard 32 px a row (rows from y 150) with a line of 32×21 flags
 * 2.35 pitches above the first row: `allies` end at x 398, `enemies` start at
 * 414; thin "Tickets: 0" strokes on both sides of the line.
 */
function scoreboard(allies: string[], enemies: string[]): RgbaImage {
  const width = 800
  const height = 500
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) data.set([30, 34, 40, 255], i * 4)
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: Rgb) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) data.set([...rgb, 255], (y * width + x) * 4)
  }
  for (let row = 0; row < 8; row += 1) {
    const y = 150 + row * 32
    for (let x = 120; x < 380; x += 7) fill(x, y, x + 3, y + 15, [220, 220, 220])
    for (let x = 420; x < 650; x += 7) fill(x, y, x + 3, y + 15, [230, 70, 70])
  }
  const top = Math.round(157.5 - 2.35 * 32 - 10.5)
  for (const [x0, x1] of [[210, 320], [530, 640]] as const) for (let x = x0; x < x1; x += 6) fill(x, top + 3, x + 2, top + 18, [220, 220, 220])
  const draw = (icon: string, x0: number) => {
    for (let y = 0; y < 21; y += 1) for (let x = 0; x < 32; x += 1) data.set([...FLAGS[icon]!((x + 0.5) / 32, (y + 0.5) / 21), 255], ((top + y) * width + x0 + x) * 4)
  }
  allies.forEach((icon, i) => draw(icon, 398 - (allies.length - i) * 36 + 4))
  enemies.forEach((icon, i) => draw(icon, 414 + i * 36))
  return { width, height, data }
}

const icons = (flags: readonly { candidates: { icon: string }[] }[]) => flags.map((flag) => flag.candidates[0]!.icon)

test('the flag line above the table: each team its own side of the widest gap, every flag its template', () => {
  const image = scoreboard(['stripes', 'bands'], ['cross', 'disc', 'stripes'])
  const layout = findScoreboardRows(image)
  assert.ok(layout)
  const line = findFlagLine(image, layout)
  assert.ok(line)
  assert.equal(line.boxes.length, 5, 'the text strokes beside the flags are no boxes')
  const read = readScoreboardFlags(image, layout, pack(), 406)
  assert.ok(read)
  assert.deepEqual(icons(read.allies), ['stripes', 'bands'])
  assert.deepEqual(icons(read.enemies), ['cross', 'disc', 'stripes'])
  assert.ok(read.enemies.every((flag) => flag.candidates[0]!.likelihood === 1 && flag.candidates[0]!.distance < 30))
})

test('one team spawned: its flags take the side of the table middle they stand on', () => {
  const image = scoreboard([], ['cross', 'disc'])
  const layout = findScoreboardRows(image)!
  assert.deepEqual(icons(readScoreboardFlags(image, layout, pack(), 406)!.enemies), ['cross', 'disc'])
  assert.deepEqual(readScoreboardFlags(image, layout, pack(), null), { allies: [], enemies: [] })
  // The middle sits 1.46 row pitches right of the own nicks' right edge.
  assert.equal(tableMiddle(360, layout), 360 + 1.46 * 32)
  assert.equal(tableMiddle(null, layout), null)
})

test('no flags above the table, and boxes no flag is near, read nothing', () => {
  const plain = scoreboard([], [])
  assert.equal(findFlagLine(plain, findScoreboardRows(plain)!), null)
  const image = scoreboard([], ['cross'])
  const data = image.data
  const layout = findScoreboardRows(image)!
  const line = findFlagLine(image, layout)!
  // Paint the flag grey: a box like a flag, matching none.
  for (let y = line.y0; y < line.y1; y += 1) for (let x = 414; x < 446; x += 1) data.set([128, 128, 128, 255], (y * image.width + x) * 4)
  const templates = pack()
  assert.equal(classifyFlag(image, line.y0, line.y1, line.boxes[0]!, templates, templateGrids(templates), null), null)
})

test('the widest gap parts the teams only near the table middle', () => {
  const boxes = [0, 36, 72, 124, 160].map((x0) => ({ x0, x1: x0 + 32 }))
  assert.deepEqual(splitFlagSides(boxes, 116).enemies.map((box) => box.x0), [124, 160])
  // The same gap far from the middle is a flag missing inside a team: the middle places each flag,
  const side = splitFlagSides(boxes, 30)
  assert.deepEqual([side.allies.map((box) => box.x0), side.enemies.map((box) => box.x0)], [[0], [36, 72, 124, 160]])
  // and a flag astride it means the line is not where the nick columns say.
  assert.deepEqual(splitFlagSides(boxes, 50), { allies: [], enemies: [] })
})
