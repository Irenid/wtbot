import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMissionInfo } from './mission-info.js'

test('повёрнутая battleArea Test Site сохраняет реальный размер и положение', () => {
  const mission = extractMissionInfo([{
    mission: {
      briefing: {
        battleArea: { target: 'dom_battle_area_arcade' },
      },
    },
    areas: {
      dom_battle_area_arcade: {
        type: 'Box',
        tm: [
          [-0.00011019, 0, 1700],
          [0, 400, 0],
          [-1700, 0, -0.000110188],
          [2003.59, -19.5642, 2023.27],
        ],
      },
    },
  }])

  assert.ok(mission.area)
  assert.ok(Math.abs(mission.area.x0 - 1153.59) < 0.01)
  assert.ok(Math.abs(mission.area.z0 - 1173.27) < 0.01)
  assert.ok(Math.abs(mission.area.x1 - 2853.59) < 0.01)
  assert.ok(Math.abs(mission.area.z1 - 2873.27) < 0.01)
})
