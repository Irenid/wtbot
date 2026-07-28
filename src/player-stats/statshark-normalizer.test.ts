import assert from 'node:assert/strict'
import test from 'node:test'
import { StatSharkProvider } from './providers/statshark.js'
import {
  normalizeStatSharkBundle,
  STATSHARK_SOURCE,
  StatSharkSchemaError,
} from './statshark-normalizer.js'
import type { StatSharkBundle } from './statshark-client.js'

function pvp(
  games: number,
  wins: number,
  timePlayed: number,
  respawns: number,
  airKillsP: number,
  groundKillsP: number,
  navalKillsP: number,
) {
  return {
    games,
    wins,
    timePlayed,
    respawns,
    airKillsP,
    groundKillsP,
    navalKillsP,
  }
}

function vehicleRow(): unknown[] {
  const row = Array<unknown>(16).fill(null)
  row[3] = 6
  row[4] = 10
  row[5] = 60
  row[6] = 12
  row[7] = 5
  row[8] = 9
  row[9] = 2
  row[10] = 0
  row[15] = 'plane_a'
  return row
}

function fixture(): StatSharkBundle {
  return {
    schemaVersion: 1,
    playerId: '82922922',
    profile: {
      Basics: {
        uid: '82922922',
        nickname: 'FixturePilot',
        lastupdate: '2026-07-26T13:08:48.000Z',
      },
      Profile: {
        arcade: {
          pvp_played: pvp(10, 6, 1_000, 12, 9, 2, 0),
          skirmish_played: pvp(2, 1, 100, 2, 1, 0, 0),
        },
        rb: {
          pvp_played: pvp(5, 2, 800, 7, 4, 3, 0),
          skirmish_played: pvp(0, 0, 0, 0, 0, 0, 0),
        },
        Leaderboard: {
          arcade: { value_total: { deaths: { value_total: 5 } } },
          historical: { value_total: { deaths: { value_total: 3 } } },
        },
      },
      Vehicles: [[vehicleRow()], [], []],
    },
    vehicleHistory: {
      0: [{
        date: '2026-07-26T12:00:00Z',
        diff: { plane_a: { 3: 1, 4: 2, 5: 50, 6: 2 } },
      }],
      1: [],
      2: [],
    },
    leaderboardHistory: [],
    vehicleInfo: {
      plane_a: { unitClass: 'aircraft', name: 'Fixture aircraft' },
      unused_tank: { unitClass: 'tank', name: 'Not stored for this player' },
    },
  }
}

test('StatShark: PvP-режимы складываются отдельно от skirmish', () => {
  const normalized = normalizeStatSharkBundle(fixture())
  assert.equal(normalized.playerId, '82922922')
  assert.equal(normalized.nick, 'FixturePilot')
  assert.equal(normalized.sourceUpdatedAt, 1_785_071_328)

  const aggregate = normalized.stats.totals[0]
  assert.deepEqual(aggregate, {
    gameType: null,
    mode: null,
    category: null,
    battles: 15,
    victories: 8,
    defeats: 7,
    deaths: 8,
    timePlayedSec: 1_800,
    respawns: 19,
    airKills: 13,
    groundKills: 5,
    navalKills: 0,
  })
  assert.equal(
    normalized.stats.totals.find((row) => row.category === 'skirmish')?.battles,
    2,
  )
})

test('StatShark: массив техники использует документированные индексы frontend-а', () => {
  const vehicle = normalizeStatSharkBundle(fixture()).stats.vehicles[0]
  assert.deepEqual(vehicle, {
    gameType: 'aircraft',
    mode: 'arcade',
    vehicleId: 'plane_a',
    flyouts: 12,
    victories: 6,
    defeats: 4,
    deaths: 5,
    airKills: 9,
    groundKills: 2,
    navalKills: 0,
    timePlayedSec: null,
  })
})

test('StatShark: ответ другого player id отклоняется', () => {
  const bundle = fixture()
  bundle.playerId = '1'
  assert.throws(() => normalizeStatSharkBundle(bundle), StatSharkSchemaError)
})

test('StatShark provider сохраняет только используемую часть глобального vehicleInfo', async () => {
  const provider = new StatSharkProvider({
    now: () => 2_000,
    fetchBundle: async () => fixture(),
  })
  const result = await provider.fetchPlayerStats({
    source: STATSHARK_SOURCE,
    sourcePlayerId: '82922922',
    wtUserId: '82922922',
    nick: 'OldNick',
    platform: null,
  })

  assert.equal(provider.requiresWtUserId, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.player.nick, 'FixturePilot')
  assert.equal(result.player.wtUserId, '82922922')
  assert.equal(result.normalized?.vehicles.length, 1)
  const raw = JSON.parse(result.rawJson!) as {
    vehicleInfo: Record<string, unknown>
    vehicleHistory: unknown
    leaderboardHistory: unknown
  }
  assert.deepEqual(Object.keys(raw.vehicleInfo), ['plane_a'])
  assert.ok(raw.vehicleHistory)
  assert.ok(raw.leaderboardHistory)
})
