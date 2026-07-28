import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeDb,
  getLatestPlayerExternalSnapshot,
  getLatestPlayerExternalStats,
  getPlayerIdentityAliases,
  getPlayerIdentityByWtUserId,
  getPlayerReplayStats,
  initDb,
  saveBattle,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'

function player(
  userId: string,
  nick: string,
  team: number,
  vehicle: string | null,
  vehicles: string[],
): BattlePlayerInput {
  return {
    userId,
    nick,
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
    squadId: -1,
    vehicle,
    vehicles,
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

function battle(
  sessionId: string,
  startTime: number,
  durationSec: number,
  teamWon: number,
  battlePlayer: BattlePlayerInput,
): BattleInput {
  return {
    sessionId,
    sessionHex: sessionId,
    missionName: 'player-stats-smoke',
    level: 'levels/test.bin',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime,
    durationSec,
    endTimeMs: (startTime + durationSec) * 1_000,
    teamWon,
    gameVersion: null,
    missionSettings: null,
    players: [battlePlayer],
    kills: [],
    chat: [],
    eventsBlob: Buffer.alloc(0),
  }
}

function verifyExistingDatabaseMigration(): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-player-stats-'))
  const dbPath = path.join(directory, 'existing.db')
  const existing = new DatabaseSync(dbPath)
  existing.exec(`
    CREATE TABLE preserved_data (value TEXT NOT NULL);
    INSERT INTO preserved_data (value) VALUES ('не изменять');
  `)
  existing.close()

  try {
    initDb(dbPath)
    const identity = savePlayerIdentity({
      wtUserId: '77',
      canonicalNick: 'PersistentPilot',
      platform: null,
    })
    savePlayerExternalSnapshot({
      identityId: identity.id,
      source: 'smoke-provider',
      sourcePlayerId: '77',
      nick: 'PersistentPilot',
      fetchedAt: 5_000,
      sourceUpdatedAt: null,
      status: 'ok',
      rawJson: '{"battles":1}',
      parserVersion: 'smoke-1',
      error: null,
      normalized: {
        totals: [],
        vehicles: [{
          gameType: 'aircraft',
          mode: null,
          vehicleId: 'persistent_plane',
          flyouts: 1,
          victories: null,
          defeats: null,
          deaths: null,
          airKills: null,
          groundKills: null,
          navalKills: null,
          timePlayedSec: null,
        }],
      },
    })
    closeDb()

    initDb(dbPath)
    assert.equal(getPlayerIdentityByWtUserId('77')?.id, identity.id)
    assert.equal(getLatestPlayerExternalSnapshot(identity.id, 'smoke-provider')?.rawJson, '{"battles":1}')
    assert.equal(
      getLatestPlayerExternalStats(identity.id, 'smoke-provider')?.vehicles[0]?.vehicleId,
      'persistent_plane',
    )
    closeDb()

    const inspected = new DatabaseSync(dbPath)
    try {
      const row = inspected.prepare('SELECT value FROM preserved_data').get() as { value: string }
      assert.equal(row.value, 'не изменять')
    } finally {
      inspected.close()
    }
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
}

function main(): void {
  initDb(':memory:')
  try {
    saveBattle(battle(
      'battle-win',
      1_000,
      100,
      1,
      {
        ...player('42', 'Pilot', 1, 'tank_alpha', ['tank_alpha', 'tank_bravo', 'tank_alpha']),
        kills: 2,
        groundKills: 1,
        aiKills: 1,
        assists: 1,
        deaths: 1,
        score: 1_000,
      },
    ))
    saveBattle(battle(
      'battle-loss',
      2_000,
      200,
      1,
      {
        ...player('42', 'RenamedPilot@live', 2, 'tank_charlie', []),
        kills: 1,
        groundKills: 2,
        aiGroundKills: 1,
        assists: 2,
        deaths: 2,
        score: 500,
        teamKills: 1,
      },
    ))
    saveBattle(battle(
      'battle-unknown',
      3_000,
      300,
      0,
      {
        ...player('42', 'RenamedPilot@live', 2, null, ['tank_alpha']),
        navalKills: 1,
        deaths: 1,
        score: 250,
      },
    ))
    saveBattle(battle(
      'battle-same-nick-other-id',
      4_000,
      999,
      1,
      player('99', 'Pilot', 1, 'tank_foreign', ['tank_foreign']),
    ))

    assert.deepEqual(getPlayerReplayStats({ userId: '42' }), {
      battles: 3,
      wins: 1,
      losses: 1,
      unknownResults: 1,
      winRate: 0.5,
      airKills: 3,
      groundKills: 3,
      navalKills: 1,
      aiAirKills: 1,
      aiGroundKills: 1,
      assists: 3,
      deaths: 4,
      score: 1_750,
      teamKills: 1,
      observedBattleTimeSec: 600,
      firstBattleAt: 1_000,
      lastBattleAt: 3_000,
      vehicles: [
        { vehicleId: 'tank_alpha', battles: 2 },
        { vehicleId: 'tank_bravo', battles: 1 },
        { vehicleId: 'tank_charlie', battles: 1 },
      ],
      coverageBattles: 3,
    })

    assert.deepEqual(getPlayerReplayStats({ userId: '42' }, { from: 2_000, to: 3_000 }), {
      battles: 1,
      wins: 0,
      losses: 1,
      unknownResults: 0,
      winRate: 0,
      airKills: 1,
      groundKills: 2,
      navalKills: 0,
      aiAirKills: 0,
      aiGroundKills: 1,
      assists: 2,
      deaths: 2,
      score: 500,
      teamKills: 1,
      observedBattleTimeSec: 200,
      firstBattleAt: 2_000,
      lastBattleAt: 2_000,
      vehicles: [{ vehicleId: 'tank_charlie', battles: 1 }],
      coverageBattles: 1,
    })

    const unknownOnly = getPlayerReplayStats({ userId: '42' }, { from: 3_000, to: 3_001 })
    assert.equal(unknownOnly.wins, 0)
    assert.equal(unknownOnly.losses, 0)
    assert.equal(unknownOnly.unknownResults, 1)
    assert.equal(unknownOnly.winRate, null)

    assert.deepEqual(getPlayerReplayStats({ userId: 'missing' }), {
      battles: 0,
      wins: 0,
      losses: 0,
      unknownResults: 0,
      winRate: null,
      airKills: 0,
      groundKills: 0,
      navalKills: 0,
      aiAirKills: 0,
      aiGroundKills: 0,
      assists: 0,
      deaths: 0,
      score: 0,
      teamKills: 0,
      observedBattleTimeSec: 0,
      firstBattleAt: null,
      lastBattleAt: null,
      vehicles: [],
      coverageBattles: 0,
    })
    assert.throws(() => getPlayerReplayStats({ userId: '   ' }), /непустой WT user id/)
    assert.throws(
      () => getPlayerReplayStats({ userId: '42' }, { from: 2_000, to: 1_000 }),
      /не может быть позже/,
    )

    const firstIdentity = savePlayerIdentity({
      wtUserId: '42',
      canonicalNick: 'Pilot@live',
      platform: 'live',
      aliases: [{
        source: 'wrpl',
        externalId: '42',
        nick: 'Pilot@live',
        seenAt: 1_000,
        matchMethod: 'user_id',
        matchConfidence: 'high',
      }, {
        source: 'manual',
        externalId: null,
        nick: 'Pilot@live',
        seenAt: 1_500,
        matchMethod: 'manual',
        matchConfidence: 'high',
      }],
    })
    const repeatedIdentity = savePlayerIdentity({
      wtUserId: '42',
      canonicalNick: 'RenamedPilot@live',
      aliases: [
        {
          source: 'wrpl',
          externalId: '42',
          nick: 'Pilot@live',
          seenAt: 2_000,
          matchMethod: 'user_id',
          matchConfidence: 'high',
        },
        {
          source: 'wrpl',
          externalId: '42',
          nick: 'RenamedPilot@live',
          seenAt: 3_000,
          matchMethod: 'user_id',
          matchConfidence: 'high',
        },
        {
          source: 'manual',
          externalId: null,
          nick: 'Pilot@live',
          seenAt: 2_500,
          matchMethod: 'manual',
          matchConfidence: 'high',
        },
      ],
    })
    assert.equal(repeatedIdentity.id, firstIdentity.id)
    assert.equal(repeatedIdentity.canonicalNick, 'RenamedPilot@live')
    assert.equal(repeatedIdentity.platform, 'live')
    assert.deepEqual(getPlayerIdentityByWtUserId('42'), repeatedIdentity)
    assert.deepEqual(getPlayerIdentityAliases(firstIdentity.id), [
      {
        identityId: firstIdentity.id,
        source: 'wrpl',
        externalId: '42',
        nick: 'Pilot@live',
        nickBase: 'Pilot',
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        matchMethod: 'user_id',
        matchConfidence: 'high',
      },
      {
        identityId: firstIdentity.id,
        source: 'manual',
        externalId: null,
        nick: 'Pilot@live',
        nickBase: 'Pilot',
        firstSeenAt: 1_500,
        lastSeenAt: 2_500,
        matchMethod: 'manual',
        matchConfidence: 'high',
      },
      {
        identityId: firstIdentity.id,
        source: 'wrpl',
        externalId: '42',
        nick: 'RenamedPilot@live',
        nickBase: 'RenamedPilot',
        firstSeenAt: 3_000,
        lastSeenAt: 3_000,
        matchMethod: 'user_id',
        matchConfidence: 'high',
      },
    ])

    const rawJson = '{"battles":10,"victories":6}'
    const normalized = {
      totals: [{
        gameType: null,
        mode: 'realistic',
        category: 'all',
        battles: 10,
        victories: 6,
        defeats: 4,
        deaths: 9,
        timePlayedSec: null,
        respawns: 14,
        airKills: 2,
        groundKills: 8,
        navalKills: null,
      }],
      vehicles: [{
        gameType: 'tank',
        mode: 'realistic',
        vehicleId: 'tank_alpha',
        flyouts: 7,
        victories: 4,
        defeats: 3,
        deaths: 5,
        airKills: null,
        groundKills: 8,
        navalKills: null,
        timePlayedSec: null,
      }],
    } as const
    const firstSnapshot = savePlayerExternalSnapshot({
      identityId: firstIdentity.id,
      source: 'thunderinsights',
      sourcePlayerId: '42',
      nick: 'RenamedPilot@live',
      fetchedAt: 10_000,
      sourceUpdatedAt: 9_000,
      status: 'ok',
      rawJson,
      parserVersion: 'smoke-1',
      error: null,
      normalized,
    })
    assert.equal(firstSnapshot.created, true)
    assert.match(firstSnapshot.snapshot.contentHash ?? '', /^[a-f0-9]{64}$/)

    const repeatedSnapshot = savePlayerExternalSnapshot({
      identityId: firstIdentity.id,
      source: 'thunderinsights',
      sourcePlayerId: '42',
      nick: 'RenamedPilot@live',
      fetchedAt: 11_000,
      sourceUpdatedAt: 9_000,
      status: 'ok',
      rawJson,
      parserVersion: 'smoke-1',
      error: null,
      normalized,
    })
    assert.equal(repeatedSnapshot.created, false)
    assert.equal(repeatedSnapshot.snapshot.id, firstSnapshot.snapshot.id)
    assert.equal(repeatedSnapshot.snapshot.fetchedAt, 10_000)
    assert.equal(repeatedSnapshot.snapshot.lastCheckedAt, 11_000)

    const changedSnapshot = savePlayerExternalSnapshot({
      identityId: firstIdentity.id,
      source: 'thunderinsights',
      sourcePlayerId: '42',
      nick: 'RenamedPilot@live',
      fetchedAt: 12_000,
      sourceUpdatedAt: 12_000,
      status: 'ok',
      rawJson: '{"battles":11,"victories":7}',
      parserVersion: 'smoke-1',
      error: null,
      normalized: {
        totals: [{ ...normalized.totals[0], battles: 11, victories: 7 }],
        vehicles: [{ ...normalized.vehicles[0], flyouts: 8, victories: 5 }],
      },
    })
    assert.equal(changedSnapshot.created, true)
    assert.notEqual(changedSnapshot.snapshot.id, firstSnapshot.snapshot.id)
    assert.deepEqual(
      getLatestPlayerExternalSnapshot(firstIdentity.id, 'thunderinsights'),
      changedSnapshot.snapshot,
    )
    const latestStats = getLatestPlayerExternalStats(firstIdentity.id, 'thunderinsights')
    assert.equal(latestStats?.snapshot.id, changedSnapshot.snapshot.id)
    assert.equal(latestStats === null ? true : 'rawJson' in latestStats.snapshot, false)
    assert.deepEqual(latestStats?.totals, [{
      snapshotId: changedSnapshot.snapshot.id,
      ...normalized.totals[0],
      battles: 11,
      victories: 7,
    }])
    assert.deepEqual(latestStats?.vehicles, [{
      snapshotId: changedSnapshot.snapshot.id,
      ...normalized.vehicles[0],
      flyouts: 8,
      victories: 5,
    }])

    const failedSnapshot = savePlayerExternalSnapshot({
      identityId: firstIdentity.id,
      source: 'thunderinsights',
      sourcePlayerId: '42',
      nick: 'RenamedPilot@live',
      fetchedAt: 12_500,
      sourceUpdatedAt: null,
      status: 'rate_limited',
      rawJson: '{"detail":"too many requests"}',
      parserVersion: 'smoke-1',
      error: 'HTTP 429',
    })
    assert.equal(
      getLatestPlayerExternalSnapshot(firstIdentity.id, 'thunderinsights')?.id,
      failedSnapshot.snapshot.id,
    )
    assert.equal(
      getLatestPlayerExternalStats(firstIdentity.id, 'thunderinsights')?.snapshot.id,
      changedSnapshot.snapshot.id,
    )
    assert.throws(
      () => savePlayerExternalSnapshot({
        identityId: firstIdentity.id,
        source: 'thunderinsights',
        sourcePlayerId: '42',
        nick: 'RenamedPilot@live',
        fetchedAt: 13_000,
        sourceUpdatedAt: null,
        status: 'schema_error',
        rawJson: '{',
        parserVersion: 'smoke-1',
        error: 'bad json',
      }),
      /валидным JSON/,
    )
    assert.throws(
      () => savePlayerExternalSnapshot({
        identityId: firstIdentity.id,
        source: 'thunderinsights',
        sourcePlayerId: '42',
        nick: 'RenamedPilot@live',
        fetchedAt: 14_000,
        sourceUpdatedAt: null,
        status: 'ok',
        rawJson: '{"battles":12}',
        parserVersion: 'smoke-1',
        error: null,
        normalized: {
          totals: [],
          vehicles: [{ ...normalized.vehicles[0], deaths: -1 }],
        },
      }),
      /неотрицательным целым числом/,
    )
  } finally {
    closeDb()
  }

  verifyExistingDatabaseMigration()
  console.log('Replay-статистика, identity и snapshots: smoke-тест пройден')
}

main()
