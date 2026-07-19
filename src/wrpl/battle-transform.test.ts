import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import { summarizeEvents } from './battle-transform.js'

function eventsWithUnits(units: ReplayEvents['units']): ReplayEvents {
  return {
    teamWon: 0,
    players: [],
    kills: [],
    damage: [],
    chat: [],
    units,
    zones: [],
    endTime: 0,
    errors: [],
  }
}

test('сводка считает только реально появившиеся воздушные траектории', () => {
  const summary = summarizeEvents(eventsWithUnits([
    { userId: 'ground', model: 'tank', source: 'ground', path: [] },
    {
      userId: '',
      model: 'ucav_recon_micro_flir',
      source: 'air',
      path: [
        { t: 1, x: 0, y: 0, z: 0 },
        { t: 2, x: 1, y: 1, z: 1 },
      ],
    },
    { userId: 'short-air', model: 'plane', source: 'air', path: [{ t: 1, x: 0, y: 0, z: 0 }] },
    {
      userId: 'air',
      model: 'plane',
      source: 'air',
      path: [
        { t: 1, x: 0, y: 0, z: 0 },
        { t: 2, x: 1, y: 1, z: 1 },
      ],
    },
  ]))

  assert.equal(summary.airUnits, 1)
  assert.deepEqual(summary.airModels, ['plane'])
})
