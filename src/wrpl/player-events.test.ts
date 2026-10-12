import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyPlayerEventFacts,
  botSlotOwners,
  creditBotSlots,
  derivePlayerEventFacts,
  isAiDrivenSlot,
  teamOfSquadMarker,
} from './player-events.js'
import type { ReplayDamage, ReplayKill, ReplayUnitPath, SlotPlayer } from './replay-events.js'
import type { ReplayPlayerResult } from './replay.js'

const slot = (userId: string, team: number, name = userId): SlotPlayer => ({ slot: 0, userId, name, clanTag: '', title: '', team })
const unit = (userId: string, model: string, t = 0): ReplayUnitPath => ({
  userId,
  model,
  source: 'ground',
  path: [{ t, x: 0, y: 0, z: 0 }],
})
const kill = (killerId: string, victimId: string): ReplayKill => ({
  time: 1,
  killerId,
  killerModel: '',
  killerPos: null,
  victimId,
  victimModel: '',
  victimPos: null,
  weapon: '',
})
const damage = (offenderId: string, victimId: string): ReplayDamage => ({
  time: 1,
  variant: 'severe',
  offenderId,
  offenderModel: '',
  victimId,
  victimModel: '',
  fire: false,
})
const player = (userId: string, team: number, squadId = -1, name = userId) => ({ userId, name, team, squadId })

test('a lone slotless player pairs with the lone bot slot of the team and gets its vehicles', () => {
  const facts = derivePlayerEventFacts([player('1', 1), player('2', 1), player('3', 2)], {
    players: [slot('1', 1), slot('-5', 1), slot('3', 2)],
    units: [unit('1', 'tankModels/t_one'), unit('-5', 'tankModels/t_bot'), unit('3', 'tankModels/t_three')],
    kills: [kill('-5', '3')],
  })

  assert.deepEqual(facts.get('2'), { team: 1, playedVehicles: ['t_bot'], botUserId: '-5', teamKills: 0, slotNick: null })
  assert.equal(facts.get('1')?.botUserId, null)
  assert.deepEqual(facts.get('1')?.playedVehicles, ['t_one'])
  assert.equal(facts.has('-5'), false, 'facts cover results rows only')
})

test('a team with two slotless players or two bot slots stays unpaired', () => {
  const twoPlayers = derivePlayerEventFacts([player('2', 1), player('4', 1)], {
    players: [slot('-5', 1)],
    units: [unit('-5', 't_bot')],
    kills: [],
  })
  assert.deepEqual([twoPlayers.get('2')?.botUserId, twoPlayers.get('4')?.botUserId], [null, null])
  assert.deepEqual(twoPlayers.get('2')?.playedVehicles, [])

  const twoBots = derivePlayerEventFacts([player('2', 1)], {
    players: [slot('-5', 1), slot('-6', 1)],
    units: [unit('-5', 't_bot')],
    kills: [],
  })
  assert.equal(twoBots.get('2')?.botUserId, null)
})

test('team 0 takes the team of the squad marker, then pairs like any other', () => {
  assert.deepEqual([teamOfSquadMarker(4096), teamOfSquadMarker(4097), teamOfSquadMarker(0)], [1, 2, null])

  const facts = derivePlayerEventFacts([player('2', 0, 4097), player('6', 0), player('7', 1)], {
    players: [slot('-5', 2), slot('7', 1)],
    units: [unit('-5', 't_bot')],
    kills: [],
  })
  assert.deepEqual(facts.get('2'), { team: 2, playedVehicles: ['t_bot'], botUserId: '-5', teamKills: 0, slotNick: null })
  assert.equal(facts.get('6')?.team, 0, 'no marker: the team stays unknown')
  assert.equal(facts.get('6')?.botUserId, null)
})

test('a player slot the AI drove keeps the player\'s nick from the ECS slot, a bot\'s own slot does not', () => {
  // Results name the row after the bot on the player's own id (2026-10-12: 6 of a team's 8)
  const facts = derivePlayerEventFacts(
    [player('7', 1, 4096, 'coop/Bot284'), player('8', 1, 4096, 'Player 8'), player('-3', 2, 0, 'coop/Bot168'), player('9', 2, 4097, 'coop/Bot12')],
    {
      players: [slot('7', 1, 'Самый Пивной'), slot('8', 1, 'Player 8'), slot('-3', 2, 'coop/Bot168'), slot('9', 2, 'coop/Bot12')],
      units: [unit('7', 'tankModels/sw_strv_m38'), unit('-3', 'tankModels/germ_pzkpfw_II_ausf_C')],
      kills: [],
    },
  )

  assert.deepEqual(facts.get('7'), { team: 1, playedVehicles: ['sw_strv_m38'], botUserId: null, teamKills: 0, slotNick: 'Самый Пивной' })
  assert.equal(facts.get('8')?.slotNick, null, 'results and slot agree')
  assert.equal(facts.get('-3')?.slotNick, null, 'a bot\'s own slot')
  assert.equal(facts.get('9')?.slotNick, null, 'no player nick in the slot')

  assert.deepEqual(
    [
      { userId: '7', name: 'coop/Bot284', slotNick: 'Самый Пивной' },
      { userId: '7', name: 'coop/Bot284' },
      { userId: '-3', name: 'coop/Bot168' },
      { userId: '8', name: 'Player 8', slotNick: null },
    ].map(isAiDrivenSlot),
    [true, true, false, false],
  )
})

test('played vehicles follow spawn order without repeats; no tracks at all is unknown', () => {
  const tracked = derivePlayerEventFacts([player('1', 1), player('3', 1)], {
    players: [slot('1', 1), slot('3', 1)],
    units: [
      unit('1', 'tankModels/second', 50),
      unit('1', 'first_plane', 10),
      unit('1', 'tankModels/second', 90),
      unit('', 'tankModels/drone', 0),
    ],
    kills: [],
  })
  assert.deepEqual(tracked.get('1')?.playedVehicles, ['first_plane', 'second'])
  assert.deepEqual(tracked.get('3')?.playedVehicles, [], 'never spawned')

  const untracked = derivePlayerEventFacts([player('1', 1)], { players: [slot('1', 1)], units: [], kills: [] })
  assert.equal(untracked.get('1')?.playedVehicles, null)
})

test('team kills come from the kill feed, a bot slot credits its player', () => {
  const facts = derivePlayerEventFacts([player('1', 1), player('2', 1), player('3', 2)], {
    players: [slot('1', 1), slot('-5', 1), slot('3', 2)],
    units: [],
    kills: [
      kill('1', '2'), // teammate without a slot: the results team counts
      kill('-5', '1'), // the bot slot of 2
      kill('3', '1'), // an enemy kill
      kill('1', '1'), // a suicide
      kill('', '1'), // no killer (crash, drowning)
      kill('1', '999'), // a victim of no known team
    ],
  })

  assert.deepEqual(
    ['1', '2', '3'].map((userId) => facts.get(userId)?.teamKills),
    [1, 1, 0],
  )
})

test('applyPlayerEventFacts writes the facts onto the results rows', () => {
  const row = (userId: string, team: number, squadId: number): ReplayPlayerResult => ({
    userId,
    name: userId,
    clanTag: '',
    team,
    kills: 0,
    groundKills: 0,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 0,
    deaths: 0,
    captureZone: 0,
    damageZone: 0,
    score: 0,
    awardDamage: 0,
    teamKills: 0,
    squadId,
    autoSquad: false,
    vehicles: ['lineup_tank'],
  })
  const players = [row('1', 1, 4096), row('2', 0, 4096)]

  const ai = { ...row('3', 1, 4096), name: 'coop/Bot77' }
  players.push(ai)

  applyPlayerEventFacts(players, {
    players: [slot('1', 1), slot('-5', 1), slot('3', 1, 'Real Nick')],
    units: [unit('-5', 't_bot')],
    kills: [kill('-5', '1')],
  })
  assert.deepEqual(
    players.map(({ team, teamKills, playedVehicles, botUserId, vehicles, name, slotNick }) =>
      ({ team, teamKills, playedVehicles, botUserId, vehicles, name, slotNick })),
    [
      { team: 1, teamKills: 0, playedVehicles: [], botUserId: null, vehicles: ['lineup_tank'], name: '1', slotNick: null },
      { team: 1, teamKills: 1, playedVehicles: ['t_bot'], botUserId: '-5', vehicles: ['lineup_tank'], name: '2', slotNick: null },
      { team: 1, teamKills: 0, playedVehicles: [], botUserId: null, vehicles: ['lineup_tank'], name: 'coop/Bot77', slotNick: 'Real Nick' },
    ],
  )
  players.pop()

  applyPlayerEventFacts(players, { players: [slot('1', 1)], units: [], kills: [] })
  assert.equal(players[0]?.playedVehicles, undefined, 'unknown: readers use the lineup')
})

test('creditBotSlots moves tracks, kills and damage of a paired bot slot to its player', () => {
  const owners = botSlotOwners([{ userId: '2', botUserId: '-5' }, { userId: '1', botUserId: null }, { userId: '3' }])
  assert.deepEqual([...owners], [['-5', '2']])

  const events = {
    units: [unit('-5', 't_bot'), unit('1', 't_one'), unit('-6', 't_other_bot')],
    kills: [kill('-5', '1'), kill('1', '-5')],
    damage: [damage('-5', '3'), damage('3', '-5')],
  }
  creditBotSlots(events, owners)

  assert.deepEqual(events.units.map((entry) => entry.userId), ['2', '1', '-6'])
  assert.deepEqual(events.kills.map((entry) => [entry.killerId, entry.victimId]), [['2', '1'], ['1', '2']])
  assert.deepEqual(events.damage.map((entry) => [entry.offenderId, entry.victimId]), [['2', '3'], ['3', '2']])
})
