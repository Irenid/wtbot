import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalizeReplayEvents, repairStoredEvents, signedUserId } from './events-repair.js'
import { fakeNamesFromItem } from './replay.js'

function events() {
  const kill = {
    time: 10, killerId: '1', killerModel: 'm', killerPos: { t: 10, x: 1, y: 2, z: 3 },
    victimId: '', victimModel: 'air_defence/germ_88mm_flak36', victimPos: { t: 10, x: 4, y: 5, z: 6 }, weapon: 'ap',
  }
  return {
    teamWon: 1,
    players: [{ slot: 0, userId: '1', name: 'Real', clanTag: '', title: '', team: 1 }],
    kills: [kill, { ...kill }, { ...kill, victimPos: { t: 10, x: 9, y: 5, z: 6 } }],
    damage: [],
    chat: [
      { time: 1, sender: 'Fake1234', message: 'hi', channel: 0, channelValid: true },
      { time: 2, sender: 'Real', message: '\u0002текст', channel: 46, channelValid: false },
      { time: 3, sender: 'Real', message: '\u0002верный канал', channel: 1, channelValid: true },
    ],
    units: [],
    zones: [],
    endTime: 100,
  }
}

test('ingest: анонимные отправители чата → настоящие имена, точные дубли убийств — один раз', () => {
  const value = events()
  const counts = canonicalizeReplayEvents(value, new Map([['Fake1234', 'Real']]))
  assert.deepEqual(counts, { chatNames: 1, duplicateKills: 1 })
  assert.deepEqual(value.chat.map((m) => m.sender), ['Real', 'Real', 'Real'])
  assert.equal(value.kills.length, 2, 'зенитка в другой точке — другое убийство')
  const again = canonicalizeReplayEvents(value, new Map([['Fake1234', 'Real']]))
  assert.deepEqual(again, { chatNames: 0, duplicateKills: 0 }, 'повтор ничего не меняет')
})

test('починка записанного боя: знаковые id, обломок длины в чате, округление', () => {
  const bot = '18446744073709551603'
  const value = {
    ...events(),
    players: [{ slot: 1, userId: bot, name: 'coop/Bot', clanTag: '', title: '', team: 2 }],
    units: [{ userId: bot, model: 'm', source: 'ground' as const, path: [{ t: 0.4, x: 1.5, y: 2, z: -2.5 }] }],
    damage: [{ time: 1, variant: 'severe' as const, offenderId: bot, offenderModel: 'm', victimId: '7', victimModel: 'n', fire: false }],
  }
  const result = repairStoredEvents(value, new Map())
  assert.equal(result.changed, true)
  assert.equal(value.players[0]!.userId, '-13')
  assert.equal(value.units[0]!.userId, '-13')
  assert.equal(value.damage[0]!.offenderId, '-13')
  assert.deepEqual(value.units[0]!.path[0], { t: 0, x: 2, y: 2, z: -2 })
  assert.equal(value.chat[1]!.message, 'текст', 'старший байт длины снят только у сообщения с неверным каналом')
  assert.equal(value.chat[2]!.message, '\u0002верный канал')
  assert.equal(result.brokenChat, 1)
  assert.deepEqual(repairStoredEvents(value, new Map()).changed, false, 'починенное больше не меняется')
})

test('знаковый userId: только 64-битные числа за пределом int64', () => {
  assert.equal(signedUserId('18446744073709551615'), '-1')
  assert.equal(signedUserId('9223372036854775808'), '-9223372036854775808')
  assert.equal(signedUserId('9223372036854775807'), '9223372036854775807')
  assert.equal(signedUserId('133986760'), '133986760')
  assert.equal(signedUserId('-13'), '-13')
  assert.equal(signedUserId(''), '')
  assert.equal(signedUserId('18446744073709551616'), '18446744073709551616', 'больше uint64 — не id, как есть')
})

test('анонимные имена из записи Replay API: только пары с fakeName', () => {
  assert.deepEqual(
    fakeNamesFromItem({ players: {
      team_1: [
        { userId: '1', name: 'Real', fakeName: 'Fake1234' },
        { userId: '2', name: 'Open', fakeName: '' },
        { userId: '3', name: 'Same', fakeName: 'Same' },
      ],
      team_2: [{ userId: '4', name: 'Other', fakeName: 'Fake9' }, null, 'мусор'],
    } }),
    [['Fake1234', 'Real'], ['Fake9', 'Other']],
  )
  assert.deepEqual(fakeNamesFromItem({}), [])
  assert.deepEqual(fakeNamesFromItem({ players: null }), [])
})

test('починка: в ранних блобах нет channelValid — неверный канал считается по номеру', () => {
  const value = { ...events(), chat: [
    { time: 1, sender: 'Real', message: '\u0001обломок', channel: 102 },
    { time: 2, sender: 'Real', message: '\u0001канал верный', channel: 2 },
  ] }
  const result = repairStoredEvents(value, new Map())
  assert.equal(result.brokenChat, 1)
  assert.deepEqual(value.chat.map((m) => m.message), ['обломок', '\u0001канал верный'])
})
