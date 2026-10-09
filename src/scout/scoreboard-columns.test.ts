import assert from 'node:assert/strict'
import test from 'node:test'
import { cellValue, findEnemyColumns, parseColumnTsv, zeroPrototype } from './scoreboard-columns.js'
import type { RgbaImage, ScoreboardRows } from './scoreboard-image.js'

/** A dark 2,000 × 400 table of eight 25 px rows from y 100, with white header icons (12 px squares) at `icons`. */
function table(icons: readonly number[]): { image: RgbaImage; layout: ScoreboardRows } {
  const width = 2000
  const height = 400
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) data.set([30, 34, 40, 255], i * 4)
  const rows = Array.from({ length: 8 }, (_, i) => ({ y0: 100 + i * 25 + 5, y1: 100 + i * 25 + 20 }))
  // Header icons centred 1.2 pitches above the first row's middle.
  const mid = (rows[0]!.y0 + rows[0]!.y1) / 2 - 1.2 * 25
  for (const x of icons) {
    for (let y = Math.round(mid - 6); y < Math.round(mid + 6); y += 1) {
      for (let dx = -6; dx < 6; dx += 1) data.set([235, 235, 235, 255], (y * width + x + dx) * 4)
    }
  }
  return { image: { width, height, data }, layout: { rows, textHeight: 12 } }
}

test('the enemy columns are found from their header icons: five evenly spaced, the score 1.76 spacings before', () => {
  // The 7WOLF screenshot's geometry: score 1472, then plane … skull 81 px apart.
  const icons = [1472, 1615, 1696, 1777, 1859, 1940]
  const { image, layout } = table(icons)
  const columns = findEnemyColumns(image, layout, 1000)
  assert.ok(columns)
  columns.centres.forEach((centre, i) => assert.ok(Math.abs(centre - icons[i]!) <= 1, `${centre} vs ${icons[i]}`))
  assert.ok(Math.abs(columns.spacing - 81) <= 1)
  // A crop that cuts the skull off: no columns rather than shifted ones.
  assert.equal(findEnemyColumns(table(icons.slice(0, 5)).image, layout, 1000), null)
  // An unknown middle reads nothing.
  assert.equal(findEnemyColumns(image, layout, null), null)
})

test('Tesseract words go to the cell placed under them; a cell with two words or a letter stays unread', () => {
  const cells = [
    { row: 0, column: 0, left: 24, width: 60 },
    { row: 0, column: 1, left: 192, width: 20 },
    { row: 1, column: 0, left: 24, width: 40 },
    { row: 1, column: 1, left: 172, width: 20 },
  ]
  const word = (left: number, top: number, width: number, text: string) => ['5', '1', '1', '1', '1', '1', left, top, width, 30, 95, text].join('\t')
  const tsv = [word(30, 10, 50, '226'), word(195, 12, 15, '1'), word(28, 100, 30, '15'), word(32, 101, 20, '9'), word(175, 100, 15, 'O')].join('\n')
  assert.deepEqual(parseColumnTsv(tsv, { cells, lineHeight: 91 }), [226, 1, null, null])
})

/** A 12 × 16 glyph from a predicate on its pixels, mean-centred and of unit length like the reader's. */
function glyph(ink: (x: number, y: number) => boolean): Float32Array {
  const values = Float32Array.from({ length: 12 * 16 }, (_, i) => (ink(i % 12, Math.floor(i / 12)) ? 1 : 0))
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const centred = values.map((v) => v - mean)
  const norm = Math.sqrt(centred.reduce((a, b) => a + b * b, 0))
  return centred.map((v) => v / norm)
}
const ring = glyph((x, y) => x < 3 || x > 8 || y < 3 || y > 12)
const one = glyph((x) => x >= 5 && x <= 7)

test('the picture\'s zero is the ring most cells share; a number read off a ring is a misread zero, never a kill', () => {
  const cells = [...Array.from({ length: 8 }, () => ({ glyph: ring, aspect: 0.65 })), { glyph: one, aspect: 0.3 }]
  const reads = [0, 0, 0, 0, 0, 9, null, 1, 1]
  const zero = zeroPrototype(cells, reads)
  assert.ok(zero)
  assert.equal(cellValue(9, cells[5]!, zero), 0) // the zero Tesseract read as 9
  assert.equal(cellValue(null, cells[6]!, zero), 0)
  assert.equal(cellValue(1, cells[8]!, zero), 1) // a real one keeps its kill
  assert.equal(cellValue(0, cells[8]!, zero), 0) // a 0 read stands
  assert.equal(cellValue(null, cells[8]!, zero), null)
  // Too few alike, or a shape Tesseract does not read as 0: no zero, the reads stand.
  assert.equal(zeroPrototype(cells.slice(4), reads.slice(4)), null)
  assert.equal(zeroPrototype(cells, cells.map(() => 8)), null)
  assert.equal(cellValue(9, cells[5]!, null), 9)
})
