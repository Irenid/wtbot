import assert from 'node:assert/strict'
import test from 'node:test'
import { PNG } from 'pngjs'
import { fadeCutEdges } from './unit-icon-edges.js'

function tile(width: number, height: number, opaque: (x: number, y: number) => boolean): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      png.data[i] = png.data[i + 1] = png.data[i + 2] = 255
      png.data[i + 3] = opaque(x, y) ? 255 : 0
    }
  }
  return PNG.sync.write(png)
}

const alphaOf = (data: Buffer, x: number, y: number): number => {
  const png = PNG.sync.read(data)
  return png.data[(y * png.width + x) * 4 + 3]!
}

test('a tile cut at its left edge fades there and keeps the rest', () => {
  const cut = tile(40, 20, (x, y) => x < 30 && y > 4 && y < 16)
  const faded = fadeCutEdges(cut)
  assert.ok(alphaOf(faded, 0, 10) < 40, 'the cut edge is nearly transparent')
  assert.ok(alphaOf(faded, 4, 10) < 255 && alphaOf(faded, 4, 10) > alphaOf(faded, 0, 10), 'it ramps up')
  assert.equal(alphaOf(faded, 12, 10), 255, 'beyond the fade the silhouette is untouched')
  assert.equal(alphaOf(faded, 25, 10), 255, 'the uncut side keeps its edge')
})

test('a silhouette that only brushes the border is returned unchanged', () => {
  const brush = tile(40, 20, (x, y) => (x >= 1 && x < 30 && y > 4 && y < 16) || (x === 0 && y === 10))
  assert.equal(fadeCutEdges(brush), brush)
})

test('data that is not a PNG is returned unchanged', () => {
  const junk = Buffer.from('not a png')
  assert.equal(fadeCutEdges(junk), junk)
})
