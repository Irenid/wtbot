import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayEvents } from './replay-events.js'
import { battleParticipants, summarizeEvents } from './battle-transform.js'

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

test('battleParticipants отбрасывает только фантомного бота вне состава Replay API', () => {
  const players = [
    { userId: '501', vehicles: ['us_m1_abrams'] },
    { userId: '502', vehicles: [] },
    { userId: '-10', vehicles: [] },
    { userId: '-11', vehicles: [] },
    { userId: '-12', vehicles: ['us_m1_abrams'] },
  ]

  // Бот -11 есть в составе сайта — участник; -10 без машины и вне состава — фантом.
  assert.deepEqual(
    battleParticipants(players, ['501', '502', '-11', '-12']).map((player) => player.userId),
    ['501', '502', '-11', '-12'],
  )
  assert.equal(battleParticipants(players, undefined).length, 5, 'без состава никто не отбрасывается')
})
