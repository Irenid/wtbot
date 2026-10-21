import assert from 'node:assert/strict'
import test from 'node:test'
import { PLATOON_SIZE, SWAP_MIN_GAIN, planPlatoons, type Candidate } from './plan.js'

const NOW = 1_800_000_000

function player(userId: string, strength: number, room: string | null = null, extra: Partial<Candidate> = {}): Candidate {
  return { userId, room, deaf: false, standing: 'member', strength, since: NOW - 600, ...extra }
}

/** Players `${prefix}0`…, the first the weakest, 0.1 apart. */
function players(n: number, room: string | null = null, prefix = 'p', base = 0): Candidate[] {
  return Array.from({ length: n }, (_, index) => player(`${prefix}${index}`, base + index / 10, room))
}

const ids = (items: readonly { userId: string }[]) => items.map((item) => item.userId)
const sorted = (items: readonly { userId: string }[]) => ids(items).sort()

test('ten idle players: the strongest eight form a new platoon, not the first eight to come', () => {
  const lobby = players(10)
  lobby[0]!.since = NOW - 3600
  lobby[1]!.since = NOW - 3500
  const result = planPlatoons([], lobby)
  assert.equal(result.platoons.length, 1)
  assert.deepEqual(sorted(result.platoons[0]!), ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'])
  assert.deepEqual(ids(result.waiting), ['p1', 'p0'])
})

test('fewer than eight idle: no platoon, the waiting list puts who would play first on top', () => {
  const result = planPlatoons([], players(5))
  assert.deepEqual(result.platoons, [])
  assert.deepEqual(ids(result.waiting), ['p4', 'p3', 'p2', 'p1', 'p0'])
})

test('seventeen idle: two platoons, the stronger eight first', () => {
  const result = planPlatoons([], players(17))
  assert.deepEqual(result.platoons.map(sorted), [
    ['p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p9'],
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
  ])
  assert.deepEqual(ids(result.waiting), ['p0'])
})

test('a short room is filled with the strongest idle players before a new platoon forms', () => {
  const result = planPlatoons(['r1'], [...players(6, 'r1', 'r'), ...players(11, null, 'p', 1)])
  const [room] = result.rooms
  assert.equal(room!.lineup.length, 6)
  assert.deepEqual(room!.calls, [{ userId: 'p10', from: null }, { userId: 'p9', from: null }])
  assert.deepEqual(sorted(result.platoons[0]!), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
  // The one left over would not play: they are offered for the room's weakest instead.
  assert.deepEqual(room!.swap, { userId: 'p0', from: null, out: 'r0' })
  assert.deepEqual(result.waiting, [])
})

test('a full room is offered a swap for an idle player who would not play otherwise, past SWAP_MIN_GAIN only', () => {
  const room = players(8, 'r1', 'r')
  const swapped = planPlatoons(['r1'], [...room, player('late', 5)])
  assert.deepEqual(swapped.rooms[0]!.swap, { userId: 'late', from: null, out: 'r0' })
  assert.deepEqual(swapped.waiting, [], 'the swapped-in player waits no more')
  const close = planPlatoons(['r1'], [...room, player('close', SWAP_MIN_GAIN - 0.01)])
  assert.equal(close.rooms[0]!.swap, null)
  assert.deepEqual(ids(close.waiting), ['close'])
  // Eight strong idle players play anyway, in a platoon of their own: nobody is swapped.
  const many = planPlatoons(['r1'], [...room, ...players(8, null, 'p', 5)])
  assert.equal(many.rooms[0]!.swap, null)
  assert.equal(many.platoons.length, 1)
})

test('a swap goes to the room\'s weakest by strength, an unknown nick idle is never swapped in', () => {
  const room = [...players(7, 'r1', 'r', 1), player('u', 0.5, 'r1', { standing: 'unknown' })]
  const result = planPlatoons(['r1'], [...room, player('x', 5, null, { standing: 'unknown' }), player('m', 1)])
  // The unknown nick is the room's weakest; the idle member beats it by 0.5.
  assert.deepEqual(result.rooms[0]!.swap, { userId: 'm', from: null, out: 'u' })
})

test('two short rooms: the strongest of the later one fill the first, so one team can play', () => {
  const result = planPlatoons(['r1', 'r2'], [...players(5, 'r1', 'a'), ...players(4, 'r2', 'b', 1)])
  const [first, second] = result.rooms
  assert.deepEqual(first!.calls, [{ userId: 'b3', from: 'r2' }, { userId: 'b2', from: 'r2' }, { userId: 'b1', from: 'r2' }])
  assert.deepEqual(second!.lineup, ['b0'])
  assert.deepEqual(second!.calls, [])
})

test('a room beyond eight keeps its strongest eight; its reserve fills a short room', () => {
  const result = planPlatoons(['r1', 'r2'], [...players(10, 'r1', 'a'), ...players(7, 'r2', 'b')])
  const [first, second] = result.rooms
  assert.deepEqual([...first!.lineup].sort(), ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
  assert.deepEqual(second!.calls, [{ userId: 'a1', from: 'r1' }])
  assert.deepEqual(first!.reserve, ['a0'])
  assert.deepEqual(result.waiting, [{ userId: 'a0', from: 'r1' }])
})

test('two full rooms are never swapped between', () => {
  const result = planPlatoons(['r1', 'r2'], [...players(8, 'r1', 'a'), ...players(8, 'r2', 'b', 3)])
  assert.deepEqual(result.rooms.map((room) => room.swap), [null, null])
})

test('a deafened player waits unplaced in the lobby but plays in a room; a guest is never placed', () => {
  const lobby = [...players(7), player('deaf', 9, null, { deaf: true }), player('guest', 9, null, { standing: 'guest' })]
  const result = planPlatoons([], lobby)
  assert.deepEqual(result.platoons, [])
  assert.equal(result.waiting.length, 7)
  const room = [...players(7, 'r1', 'r'), player('rdeaf', 0, 'r1', { deaf: true }), player('rguest', 9, 'r1', { standing: 'guest' })]
  const seated = planPlatoons(['r1'], room).rooms[0]!
  assert.equal(seated.lineup.length, PLATOON_SIZE)
  assert.ok(seated.lineup.includes('rdeaf'))
  assert.ok(!seated.lineup.includes('rguest'))
})

test('an unknown nick comes after every member, however strong', () => {
  const result = planPlatoons([], [...players(8), player('x', 9, null, { standing: 'unknown' })])
  assert.deepEqual(sorted(result.platoons[0]!), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  assert.deepEqual(ids(result.waiting), ['x'])
})

test('a room of guests alone is not filled', () => {
  const result = planPlatoons(['r1'], [player('g', 1, 'r1', { standing: 'guest' }), ...players(8)])
  assert.deepEqual(result.rooms[0]!.calls, [])
  assert.equal(result.platoons.length, 1)
})
