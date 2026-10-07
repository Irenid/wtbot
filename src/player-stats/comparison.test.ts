import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getPlayerIdentityByWtUserId,
  initDb,
  saveBattle,
  savePlayerIdentity,
} from '../db/index.js'
import { PlayerStatsCoordinator, resolveKnownPlayer } from './comparison.js'
import { PlayerStatsService } from './service.js'
import type { PlayerReference, PlayerStatsProvider, RawPlayerStats } from './types.js'

function replayPlayer(userId: string, nick: string) {
  return {
    userId,
    nick,
    clanTag: '',
    team: 1,
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
    vehicle: null,
    vehicles: [],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

function saveReplay(sessionId: string, players: ReturnType<typeof replayPlayer>[]): void {
  saveBattle({
    sessionId,
    sessionHex: sessionId.padStart(16, '0'),
    missionName: 'fixture',
    level: 'fixture',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime: 100,
    durationSec: 0,
    endTimeMs: 0,
    teamWon: 0,
    gameVersion: null,
    missionSettings: null,
    players,
    kills: [],
    chat: [],
    eventsBlob: Buffer.from('{}'),
  })
}

function nickOnlyIdentity(nick: string) {
  return savePlayerIdentity({
    wtUserId: null,
    canonicalNick: nick,
    platform: null,
    aliases: [{
      source: 'voice',
      externalId: null,
      nick,
      seenAt: 10,
      matchMethod: 'exact_nick',
      matchConfidence: 'medium',
    }],
  })
}

test('появившийся WT user id усыновляет существующую nick-only identity', () => {
  initDb(':memory:')
  try {
    // Игрок сначала стал identity по нику (voice), а потом попал в реплей с user id.
    const early = nickOnlyIdentity('Pilot')
    saveReplay('1', [replayPlayer('555', 'Pilot')])

    const resolved = resolveKnownPlayer('Pilot')
    assert.equal(resolved.status, 'ok')
    assert.ok(resolved.status === 'ok')
    assert.equal(resolved.identity.id, early.id, 'снимки прежней identity должны остаться достижимы')
    assert.equal(resolved.identity.wtUserId, '555')
    assert.equal(getPlayerIdentityByWtUserId('555')?.id, early.id)
  } finally {
    closeDb()
  }
})

test('несколько nick-only identity одного ника не сливаются автоматически', () => {
  initDb(':memory:')
  try {
    const first = nickOnlyIdentity('Twin')
    const second = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'Twin-second',
      platform: null,
      aliases: [{
        source: 'clan-rating',
        externalId: null,
        nick: 'Twin',
        seenAt: 20,
        matchMethod: 'exact_nick',
        matchConfidence: 'medium',
      }],
    })
    assert.notEqual(first.id, second.id)
    saveReplay('2', [replayPlayer('777', 'Twin')])

    const resolved = resolveKnownPlayer('Twin')
    assert.equal(resolved.status, 'ambiguous')
    assert.equal(getPlayerIdentityByWtUserId('777'), null, 'неоднозначный ник не должен получить user id')
  } finally {
    closeDb()
  }
})

class SourceFixture implements PlayerStatsProvider {
  status: 'ok' | 'error' = 'ok'
  constructor(readonly source: string, private readonly now: () => number) {}

  async resolvePlayer(nick: string): Promise<PlayerReference[]> {
    return [{ source: this.source, sourcePlayerId: '555', wtUserId: '555', nick, platform: null }]
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    const base = { player, fetchedAt: this.now(), sourceUpdatedAt: null }
    if (this.status !== 'ok') {
      return { ...base, status: this.status, rawJson: null, error: 'login required', normalized: null }
    }
    return {
      ...base,
      status: 'ok',
      rawJson: JSON.stringify({ source: this.source }),
      error: null,
      normalized: {
        totals: [{
          gameType: null, mode: null, category: null, battles: 10, victories: 5, defeats: 5, deaths: null,
          timePlayedSec: null, respawns: null, airKills: null, groundKills: null, navalKills: null,
        }],
        vehicles: [],
      },
    }
  }
}

test('the first source with a fresh snapshot is primary; a failed or stale one gives way', async () => {
  initDb(':memory:')
  try {
    saveReplay('10', [replayPlayer('555', 'Primary')])
    let now = 10_000
    const companion = new SourceFixture('companion-profile', () => now)
    const statshark = new SourceFixture('statshark', () => now)
    const service = (provider: SourceFixture, ttlSeconds: number) => new PlayerStatsService({
      provider, parserVersion: `${provider.source}-v1`, ttlSeconds, retryBaseSeconds: 1, retryMaxSeconds: 1, now: () => now,
    })
    const coordinator = new PlayerStatsCoordinator({
      externalServices: [service(companion, 60), service(statshark, 600)],
    })
    const primary = () => {
      const result = coordinator.lookup({ player: 'Primary' })
      assert.ok(result.status === 'ok')
      assert.equal(result.stats.accountSources[0]?.source, result.stats.account.source)
      return result.stats.account.source
    }

    companion.status = 'error'
    primary()
    await coordinator.waitForIdle()
    assert.equal(primary(), 'statshark', 'companion without a session has no snapshot')

    companion.status = 'ok'
    now += 2
    primary()
    await coordinator.waitForIdle()
    assert.equal(primary(), 'companion-profile')

    now += 61
    assert.equal(primary(), 'statshark', 'a stale companion snapshot gives way to a fresh StatShark one')
    await coordinator.waitForIdle()
    assert.equal(primary(), 'companion-profile', 'refreshed companion leads again')

    now += 700
    assert.equal(primary(), 'companion-profile', 'with every source stale the configured order holds')
    await coordinator.waitForIdle()
    await coordinator.stop()
  } finally {
    closeDb()
  }
})
