import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cutRanges,
  cutsFor,
  smallestCrossDistance,
  smallestDistance,
  smallestMapDistance,
  smallestNormalDistance,
  swatch,
} from '../analysis/heatmap-palette.js'
import { heatmapPalette } from './heatmap-palette.js'

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8]
/** The table's worst pairs (8 v 8): ΔE 0.123 inside a team, 0.126 across (2026-10-22). */
const MIN_NORMAL = 0.12
const MIN_WEIGHTED = 0.12
const MIN_CROSS = 0.125
const hues = (colours: readonly string[]): number[] => colours.map((hex) => swatch(hex).hue)

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
      if (own > 1) assert.ok(smallestNormalDistance(mine) >= MIN_NORMAL, `own ${own} v ${enemy}: ${smallestNormalDistance(mine)}`)
      if (enemy > 1) assert.ok(smallestNormalDistance(theirs) >= MIN_NORMAL, `enemy ${own} v ${enemy}: ${smallestNormalDistance(theirs)}`)
      if (own > 1) assert.ok(smallestDistance(mine) >= MIN_WEIGHTED, `own ${own} v ${enemy}: ${smallestDistance(mine)}`)
      if (enemy > 1) assert.ok(smallestDistance(theirs) >= MIN_WEIGHTED, `enemy ${own} v ${enemy}: ${smallestDistance(theirs)}`)
      assert.ok(smallestCrossDistance(mine, theirs) >= MIN_CROSS, `cross ${own} v ${enemy}`)
      assert.ok(smallestMapDistance([...mine, ...theirs]) >= 0.149, `map ${own} v ${enemy}`)
    }
  }
})

test('no track colour is dark, pale or a dark yellow (the maps\' khaki)', () => {
  for (const own of SIZES) {
    for (const enemy of SIZES) {
      for (const hex of heatmapPalette(own, enemy).flat()) {
        const { lightness, chroma, hue } = swatch(hex)
        assert.ok(lightness >= 0.595, `${hex} lightness ${lightness}`)
        assert.ok(chroma >= 0.11, `${hex} chroma ${chroma}`)
        if (hue >= 75 && hue <= 135) assert.ok(lightness >= 0.795, `${hex} is olive`)
      }
    }
  }
})

test('each team keeps its hues, cool for the image\'s own team and warm for the other, split by the cuts its sizes allow', () => {
  for (const own of SIZES) {
    for (const enemy of SIZES) {
      const [mine, theirs] = heatmapPalette(own, enemy)
      assert.ok(cutsFor(hues(mine), hues(theirs), cutRanges(own, enemy)), `${own} v ${enemy}`)
    }
  }
  // Balanced teams carry no green or magenta: aquamarine to purple against pink to yellow.
  for (const size of SIZES) {
    const [mine, theirs] = heatmapPalette(size, size)
    for (const hue of hues(mine)) assert.ok(hue >= 165 && hue <= 313, `own ${size} v ${size}: ${hue}`)
    for (const hue of hues(theirs)) assert.ok(hue <= 115 || hue >= 347, `enemy ${size} v ${size}: ${hue}`)
  }
  // 8 v 4: the cuts may move 20° toward the smaller team, which keeps its core.
  assert.deepEqual(cutRanges(8, 4), { green: [117, 143], magenta: [327, 353] })
  assert.deepEqual(cutRanges(4, 8), { green: [137, 163], magenta: [307, 333] })
})

test('a small team gets colours far apart, and each size has its own set', () => {
  for (let size = 2; size < 8; size++) {
    const fewer = smallestNormalDistance(heatmapPalette(size, size)[0])
    const more = smallestNormalDistance(heatmapPalette(size + 1, size + 1)[0])
    assert.ok(fewer >= more, `${size}: ${fewer} < ${more}`)
  }
  const [three] = heatmapPalette(3, 3)
  const [four] = heatmapPalette(4, 4)
  assert.notDeepEqual(four.slice(0, 3).sort(), three.slice().sort(), 'the fourth player moves the first three')
})

test('the bigger team widens its hues and the smaller one gives way (8 v 4 against 8 v 8)', () => {
  assert.ok(smallestDistance(heatmapPalette(8, 4)[0]) > smallestDistance(heatmapPalette(8, 8)[0]))
  assert.ok(smallestDistance(heatmapPalette(4, 8)[1]) > smallestDistance(heatmapPalette(8, 8)[1]))
})

test('team sizes beyond the table clamp to its edges', () => {
  assert.deepEqual(heatmapPalette(12, 0), heatmapPalette(8, 1))
})
