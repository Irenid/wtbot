import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompanionProfileAuthError,
  decodeCompanionProfile,
  type CompanionProfile,
} from './companion-protobuf.js'

function varint(value: number): Buffer {
  let remaining = BigInt(value)
  const bytes: number[] = []
  do {
    let byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining !== 0n) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0n)
  return Buffer.from(bytes)
}

function varintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([varint(fieldNumber << 3), varint(value)])
}

function bytesField(fieldNumber: number, value: Uint8Array): Buffer {
  const bytes = Buffer.from(value)
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(bytes.length), bytes])
}

function stringField(fieldNumber: number, value: string): Buffer {
  return bytesField(fieldNumber, Buffer.from(value, 'utf8'))
}

function message(...fields: Uint8Array[]): Buffer {
  return Buffer.concat(fields.map((value) => Buffer.from(value)))
}

function profileFixture(): Buffer {
  const base = message(
    stringField(2, 'Venukbr'),
    stringField(4, 'Tank Destroyer'),
    stringField(6, 'WLILY'),
  )
  const level = message(varintField(1, 100))
  const pvp = message(
    varintField(1, 75),
    varintField(4, 3_600),
    varintField(6, 1_800),
    varintField(9, 120),
    varintField(10, 40),
    varintField(12, 100),
    varintField(20, 3),
  )
  const common = message(
    varintField(1, 1),
    bytesField(2, pvp),
    varintField(9, 55),
  )
  const vehicle = message(
    varintField(1, 4),
    varintField(2, 30),
    varintField(3, 50),
    varintField(5, 20),
    varintField(6, 60),
    varintField(7, 2),
    varintField(8, 70),
    stringField(11, 'us_m4a1'),
    varintField(12, 0),
  )
  return message(
    bytesField(1, base),
    bytesField(2, level),
    bytesField(6, common),
    bytesField(10, vehicle),
    stringField(11, 'en'),
  )
}

test('companion protobuf нормализует профиль, PvP и технику', () => {
  const profile = decodeCompanionProfile(profileFixture(), '123456')

  assert.equal(profile.userId, '123456')
  assert.equal(profile.nick, 'Venukbr')
  assert.equal(profile.title, 'Tank Destroyer')
  assert.equal(profile.clanTag, 'WLILY')
  assert.equal(profile.level, 100)

  assert.deepEqual(profile.stats.totals, [{
    gameType: null,
    mode: null,
    category: null,
    battles: 100,
    victories: 75,
    defeats: 25,
    deaths: 55,
    timePlayedSec: 5_400,
    respawns: null,
    airKills: 40,
    groundKills: 120,
    navalKills: 3,
  }, {
    gameType: null,
    mode: 'realistic',
    category: 'all',
    battles: 100,
    victories: 75,
    defeats: 25,
    deaths: 55,
    timePlayedSec: 5_400,
    respawns: null,
    airKills: 40,
    groundKills: 120,
    navalKills: 3,
  }])
  assert.deepEqual(profile.stats.vehicles, [{
    gameType: 'ground',
    mode: 'realistic',
    vehicleId: 'us_m4a1',
    flyouts: 60,
    victories: 30,
    defeats: 20,
    deaths: 20,
    airKills: 2,
    groundKills: 70,
    navalKills: 0,
    timePlayedSec: null,
  }])
})

test('companion protobuf распознаёт ответ об отсутствии авторизации', () => {
  const error = message(
    varintField(1, 400),
    stringField(2, '!ERROR:AUTH_RESPONSE_STATUS_IS_LOGINERROR'),
  )
  assert.throws(
    () => decodeCompanionProfile(error, '123456'),
    CompanionProfileAuthError,
  )
})

test('companion provider связывает точный ник с WT user id и сохраняет snapshot', async () => {
  const document: CompanionProfile = decodeCompanionProfile(profileFixture(), '123456')
  const { CompanionProfileProvider, COMPANION_PROFILE_SOURCE } = await import(
    './providers/companion-profile.js'
  )
  const provider = new CompanionProfileProvider({
    now: () => 1_700_000_000,
    fetchSearch: async () => [{
      source: COMPANION_PROFILE_SOURCE,
      sourcePlayerId: '123456',
      wtUserId: '123456',
      nick: 'Venukbr',
      platform: null,
    }],
    fetchProfile: async () => document,
  })

  const [reference] = await provider.resolvePlayer('Venukbr')
  assert.ok(reference)
  const result = await provider.fetchPlayerStats(reference)
  assert.equal(result.status, 'ok')
  assert.equal(result.fetchedAt, 1_700_000_000)
  assert.equal(result.player.wtUserId, '123456')
  assert.equal(result.player.nick, 'Venukbr')
  assert.deepEqual(result.normalized, document.stats)
  assert.match(result.rawJson ?? '', /"userId":"123456"/)
})
