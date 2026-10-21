import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, initDb, listBotStateKeys, setBotState } from '../db/index.js'
import { botText } from '../i18n/index.js'
import { planPlatoons, type Candidate } from '../platoons/plan.js'
import type { RatedMember } from '../platoons/rate.js'
import { advicePost, type Advice } from './platoons.js'

const member = (userId: string, nick: string, extra: Partial<RatedMember> = {}): RatedMember => ({
  userId,
  identity: { wtNick: nick, standing: 'member', rosterNick: nick, guessed: false, wtUserId: '1' },
  strength: 0.4,
  battles: 50,
  capBattles: 5,
  vehicle: 'ussr_t_54_1947',
  ...extra,
})
const candidate = (userId: string, room: string | null, extra: Partial<Candidate> = {}): Candidate =>
  ({ userId, room, deaf: false, standing: 'member', strength: 0.4, since: 0, ...extra })
const guest = { wtNick: 'x', standing: 'guest' as const, rosterNick: null, guessed: false, wtUserId: '2' }
const vehicles = {
  ussr_t_54_1947: { name: 'T-54 (1947)', cls: 'T' as const, country: 'ussr' },
  ussr_zsu_57_2: { name: 'ZSU-57-2', cls: 'AA' as const, country: 'ussr' },
}

function advice(list: Candidate[], ratings: Map<string, { member: RatedMember }>, rooms: [string, string][] = []): Advice {
  return {
    lobbyId: 'L',
    rooms: new Map(rooms),
    plan: planPlatoons(rooms.map(([id]) => id), list),
    list,
    ratings,
    nicks: new Map(list.map((item) => [item.userId, `server-${item.userId}`])),
  }
}

test('a short room lists its players by role, whom to call in and from where, its guests; the unplaced say why; no rating', () => {
  const ratings = new Map<string, { member: RatedMember }>([
    ['a', { member: member('a', 'Alpha', { vehicle: 'ussr_zsu_57_2' }) }],
    ['b', { member: member('b', 'Bravo') }],
    ['g', { member: member('g', 'Golf', { identity: { ...guest, wtNick: 'Golf' } }) }],
    ['w', { member: member('w', 'Whiskey', { capBattles: 0, vehicle: null }) }],
    ['d', { member: member('d', 'Delta') }],
    ['x', { member: member('x', 'Xray', { identity: { ...guest, wtNick: 'Xray' } }) }],
  ])
  const list = [candidate('a', 'r1'), candidate('b', 'r1'), candidate('g', 'r1', { standing: 'guest' }),
    candidate('w', null), candidate('d', null, { deaf: true }), candidate('x', null, { standing: 'guest' }), candidate('n', null, { strength: 0 })]
  const embed = advicePost(botText('ru'), 'WLILY', 6, advice(list, ratings, [['r1', '1 взвод']]), vehicles)
  assert.equal(embed.title, 'Взводы WLILY · БР 6.0')
  const [room, notPlaced] = embed.fields!
  assert.equal(room!.name, '1 взвод · 2/8 · не хватает 6')
  assert.deepEqual(room!.value.split('\n'), [
    '**Bravo** — T-54 (1947) · танк',
    '**Alpha** — ZSU-57-2 · ЗСУ',
    '➕ **Whiskey** — нет боёв на этом БР, из <#L>',
    // Without strengths read the server name stands in.
    '➕ **server-n** — из <#L>',
    '**Golf** — T-54 (1947) · танк, не в полку',
  ])
  assert.deepEqual(notPlaced!.value.split('\n'), ['**Delta** — T-54 (1947) · танк, выключен звук', '**Xray** — T-54 (1947) · танк, не в полку'])
  assert.doesNotMatch(JSON.stringify(embed), /0\.4/, 'no strength is shown')
})

test('idle players beyond a full room form a new platoon; the one left over is offered as a swap', () => {
  const ratings = new Map<string, { member: RatedMember }>()
  const list: Candidate[] = []
  for (let index = 0; index < 8; index += 1) {
    list.push(candidate(`r${index}`, 'r1', { strength: index / 10 }))
    ratings.set(`r${index}`, { member: member(`r${index}`, `Room${index}`) })
  }
  for (let index = 0; index < 9; index += 1) {
    list.push(candidate(`p${index}`, null, { strength: 1 + index / 10 }))
    ratings.set(`p${index}`, { member: member(`p${index}`, `Lobby${index}`) })
  }
  const embed = advicePost(botText('en'), 'WLILY', null, advice(list, ratings, [['r1', 'Platoon 1']]), vehicles)
  assert.equal(embed.title, 'Platoons of WLILY')
  const [room, platoon, ...rest] = embed.fields!
  assert.equal(room!.name, 'Platoon 1 · 8/8')
  assert.equal(room!.value.split('\n').at(-1), '🔁 **Lobby0** instead of **Room0**')
  assert.equal(platoon!.name, 'New platoon · 8/8, needs a room')
  assert.equal(platoon!.value.split('\n').length, 8)
  assert.deepEqual(rest, [], 'nobody is left waiting')
})

test('nobody in voice: the post says so', () => {
  const embed = advicePost(botText('en'), 'WLILY', null, advice([], new Map()), {})
  assert.match(embed.description!, /Nobody is in voice yet/)
  assert.equal(embed.fields, undefined)
})

test('the configured servers are the bot_state keys under platoons:, no key beside them', () => {
  initDb(':memory:', { allowCreate: true })
  try {
    for (const key of ['platoons:1', 'platoons:22', 'platoonsx', 'platoon:3', 'squadron-stats:1']) setBotState(key, '{}')
    assert.deepEqual(listBotStateKeys('platoons:'), ['platoons:1', 'platoons:22'])
  } finally {
    closeDb()
  }
})
