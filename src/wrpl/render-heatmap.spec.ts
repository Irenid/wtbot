import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeNearbyCamps,
  routeStrokeParts,
  segmentIntersection,
  type PreparedCamp,
  type RouteSegment,
} from './render-heatmap.js'

const MAP_PX = 1000

function campsAtScale(worldSpan: number): PreparedCamp[] {
  const px = (worldX: number): number => 500 + (worldX / worldSpan) * MAP_PX
  return [
    { x: px(0), y: 500, durMs: 60000, time: 60000 },
    { x: px(100), y: 500, durMs: 60000, time: 180000 },
  ]
}

test('объединение стоянок учитывает масштаб карты', () => {
  const detailedMap = mergeNearbyCamps(campsAtScale(2000))
  assert.equal(detailedMap.length, 2)

  const wideMap = mergeNearbyCamps(campsAtScale(4000))
  assert.equal(wideMap.length, 1)
  assert.equal(wideMap[0]?.durMs, 120000)
  assert.equal(wideMap[0]?.time, 180000)
  assert.equal(wideMap[0]?.x, 512.5)
})

test('совпадающие маршруты рисуются поздним поверх раннего', () => {
  const parts = routeStrokeParts([
    {
      baseOrder: 1,
      color: '#ff8c1a',
      d: 'M0 0L100 100',
      attrs: 'data-route-player="second"',
      directionArrows: 0,
    },
    {
      baseOrder: 0,
      color: '#ef233c',
      d: 'M0 0L100 100',
      attrs: 'data-route-player="first"',
      directionArrows: 0,
    },
  ])

  assert.equal(parts.length, 6)
  assert.match(parts[2]!, /data-route-stroke-pass="color" data-route-player="first"/)
  assert.match(parts[3]!, /data-route-stroke-pass="color" data-route-player="second"/)
  assert.match(parts[4]!, /data-route-stroke-pass="shared-reveal" data-route-player="first"/)
  assert.match(parts[5]!, /data-route-stroke-pass="shared-reveal" data-route-player="second"/)
  assert.match(parts[5]!, /stroke="#ff8c1a" stroke-width="1\.2"/)
  assert.ok(parts.every((part) => !part.includes('stroke-dasharray')))
})

test('близкие параллельные отрезки считаются общим участком', () => {
  const segment = (x1: number, y1: number, x2: number, y2: number): RouteSegment => ({
    from: { x: x1, y: y1, time: 0 },
    to: { x: x2, y: y2, time: 1000 },
    length: Math.hypot(x2 - x1, y2 - y1),
  })

  const contact = segmentIntersection(
    segment(0, 0, 100, 0),
    segment(0, 4, 100, 4),
  )
  assert.ok(contact)
  assert.ok(contact.first > 0.45 && contact.first < 0.55)
  assert.ok(contact.second > 0.45 && contact.second < 0.55)
  assert.equal(segmentIntersection(segment(0, 0, 100, 0), segment(0, 20, 100, 20)), null)
})
