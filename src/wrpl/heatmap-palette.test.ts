import assert from 'node:assert/strict'
import test from 'node:test'
import { smallestCrossDistance, smallestDistance, smallestMapDistance } from '../analysis/heatmap-palette.js'
import { heatmapPalette } from './heatmap-palette.js'

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8]

test('the palette has one colour per player of each team, none repeated, for every pair of sizes', () => {
  for (const own of SIZES) {
    for (const enemy of SIZES) {
      const [mine, theirs] = heatmapPalette(own, enemy)
      assert.equal(mine.length, own)
      assert.equal(theirs.length, enemy)
      assert.equal(new Set([...mine, ...theirs]).size, own + enemy, `${own} v ${enemy}`)
      for (const hex of [...mine, ...theirs]) assert.match(hex, /^#[0-9A-F]{6}$/)
    }
  }
})

test('every pair keeps its tracks apart: within a team, between the teams, and from the map', () => {
  for (const own of SIZES) {
    for (const enemy of SIZES) {
      const [mine, theirs] = heatmapPalette(own, enemy)
      assert.ok(smallestDistance(mine) >= 0.085, `own ${own} v ${enemy}: ${smallestDistance(mine)}`)
      assert.ok(smallestDistance(theirs) >= 0.05, `enemy ${own} v ${enemy}: ${smallestDistance(theirs)}`)
      assert.ok(smallestCrossDistance(mine, theirs) >= 0.119, `cross ${own} v ${enemy}`)
      assert.ok(smallestMapDistance([...mine, ...theirs]) >= 0.149, `map ${own} v ${enemy}`)
    }
  }
})

test('a small team gets colours far apart and a growing team re-picks its colours', () => {
  assert.ok(smallestDistance(heatmapPalette(2, 2)[0]) >= 0.28)
  assert.ok(smallestDistance(heatmapPalette(3, 3)[0]) >= 0.2)
  assert.ok(smallestDistance(heatmapPalette(4, 4)[0]) >= 0.15)
  const [three] = heatmapPalette(3, 3)
  const [four] = heatmapPalette(4, 4)
  assert.notDeepEqual(four.slice(0, 3).sort(), three.slice().sort(), 'the fourth player moves the first three')
})

test('the larger team widens its hues and the smaller one gives way (8 v 2 against 8 v 8)', () => {
  const crowded = smallestDistance(heatmapPalette(8, 8)[0])
  const lopsided = smallestDistance(heatmapPalette(8, 2)[0])
  assert.ok(lopsided >= crowded, `${lopsided} vs ${crowded}`)
  assert.ok(smallestDistance(heatmapPalette(2, 8)[1]) >= smallestDistance(heatmapPalette(8, 8)[1]))
})

test('team sizes beyond the table clamp to its edges', () => {
  assert.deepEqual(heatmapPalette(12, 0), heatmapPalette(8, 1))
})
