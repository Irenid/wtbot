import assert from 'node:assert/strict'
import {
  closeDb,
  initDb,
  saveBattle,
  syncVoicePresence,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import {
  PlayerStatsCoordinator,
  type PlayerStatsComparison,
} from '../player-stats/comparison.js'
import { PlayerStatsService } from '../player-stats/service.js'
import type {
  PlayerReference,
  PlayerStatsProvider,
  RawPlayerStats,
} from '../player-stats/types.js'
import { buildServer } from '../web/index.js'

function player(userId: string, nick: string, team: number, vehicleId: string): BattlePlayerInput {
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
    vehicle: vehicleId,
    vehicles: [vehicleId],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

function battle(
  sessionId: string,
  startTime: number,
  teamWon: number,
  battlePlayer: BattlePlayerInput,
): BattleInput {
  return {
    sessionId,
    sessionHex: sessionId,
    missionName: 'player-stats-api-smoke',
    level: 'levels/test.bin',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime,
    durationSec: 600,
    endTimeMs: (startTime + 600) * 1_000,
    teamWon,
    gameVersion: null,
    missionSettings: null,
    players: [battlePlayer],
    kills: [],
    chat: [],
    eventsBlob: Buffer.alloc(0),
  }
}

class FixtureProvider implements PlayerStatsProvider {
  readonly source = 'fixture-player-stats'
  calls = 0
  closed = false

  constructor(private readonly now: () => number) {}

  async resolvePlayer(nick: string): Promise<PlayerReference[]> {
    const sourcePlayerId = nick === 'VoicePilot@psn' ? '701' : '501'
    return [{
      source: this.source,
      sourcePlayerId,
      wtUserId: sourcePlayerId,
      nick,
      platform: null,
    }]
  }

  async fetchPlayerStats(playerReference: PlayerReference): Promise<RawPlayerStats> {
    this.calls += 1
    const second = this.calls > 1
    const battles = second ? 25 : 20
    const victories = second ? 15 : 12
    const flyouts = second ? 14 : 10
    return {
      player: playerReference,
      fetchedAt: this.now(),
      sourceUpdatedAt: this.now(),
      status: 'ok',
      rawJson: JSON.stringify({ version: this.calls, battles, victories, flyouts }),
      error: null,
      normalized: {
        totals: [{
          gameType: null,
          mode: null,
          category: null,
          battles,
          victories,
          defeats: battles - victories,
          timePlayedSec: null,
          respawns: flyouts,
          airKills: 7,
          groundKills: 1,
          navalKills: 0,
        }],
        vehicles: [{
          gameType: 'aircraft',
          mode: 'arcade',
          vehicleId: 'test_plane',
          flyouts,
          victories,
          defeats: battles - victories,
          deaths: second ? 8 : 7,
          airKills: second ? 9 : 7,
          groundKills: 1,
          navalKills: 0,
          timePlayedSec: null,
        }],
      },
    }
  }

  close(): void {
    this.closed = true
  }
}

function deps(playerStats: PlayerStatsCoordinator) {
  return {
    getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
    refreshVoice: async () => ({ players: 0, clans: 0 }),
    playerStats,
  }
}

async function main(): Promise<void> {
  initDb(':memory:')
  saveBattle(battle('known-win', 1_000, 1, player('501', 'PilotOne', 1, 'test_plane')))
  saveBattle(battle('known-loss', 2_000, 2, player('501', 'PilotOne', 1, 'test_plane')))
  saveBattle(battle('ambiguous-a', 3_000, 1, player('601', 'SharedNick', 1, 'plane_a')))
  saveBattle(battle('ambiguous-b', 4_000, 2, player('602', 'SharedNick', 2, 'plane_b')))
  syncVoicePresence([{
    guildId: 'guild',
    guildName: 'Smoke guild',
    channelId: 'voice',
    channelName: 'Smoke voice',
    userId: 'discord-user',
    displayName: 'VoicePilot@psn (Тест)',
    wtNick: 'VoicePilot@psn',
  }])

  let now = 10_000
  const provider = new FixtureProvider(() => now)
  const service = new PlayerStatsService({
    provider,
    parserVersion: 'fixture-v1',
    ttlSeconds: 60,
    retryBaseSeconds: 5,
    retryMaxSeconds: 60,
    now: () => now,
  })
  const coordinator = new PlayerStatsCoordinator({ externalService: service })
  const app = buildServer(deps(coordinator))
  const disabledApp = buildServer(deps(new PlayerStatsCoordinator({
    externalService: null,
    externalSource: provider.source,
  })))
  const rateLimitApp = buildServer(deps(new PlayerStatsCoordinator({
    externalService: null,
    externalSource: provider.source,
  })))

  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { ok: true })

    const page = await app.inject({ method: 'GET', url: '/' })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /id="player-stats-form"/)
    assert.match(page.body, /\/api\/player-stats/)
    assert.doesNotMatch(page.body, /\.innerHTML\b/)
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    Function(script)

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: {},
    })
    assert.equal(invalid.statusCode, 400)

    const invalidPeriod = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne', from: 2_000, to: 1_000 },
    })
    assert.equal(invalidPeriod.statusCode, 400)

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'UnknownPilot' },
    })
    assert.equal(unknown.statusCode, 404)
    assert.equal((unknown.json() as { code: string }).code, 'PLAYER_NOT_FOUND')

    const ambiguous = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'SharedNick' },
    })
    assert.equal(ambiguous.statusCode, 409)
    const ambiguousBody = ambiguous.json() as { candidates: { wtUserId: string | null }[] }
    assert.deepEqual(
      ambiguousBody.candidates.map((entry) => entry.wtUserId).sort(),
      ['601', '602'],
    )

    const first = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne', from: 900, to: 3_000 },
    })
    assert.equal(first.statusCode, 200)
    const firstBody = first.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(firstBody.stats.account.state, 'pending')
    assert.equal(firstBody.stats.account.refreshQueued, true)
    assert.equal(firstBody.stats.replay.stats?.battles, 2)
    assert.equal(firstBody.stats.replay.stats?.wins, 1)
    assert.equal(firstBody.stats.replay.stats?.losses, 1)
    assert.equal(firstBody.stats.replay.stats?.winRate, 0.5)

    await service.waitForIdle()
    const cached = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: '501', from: 900, to: 3_000 },
    })
    const cachedBody = cached.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(cachedBody.stats.account.state, 'fresh')
    assert.equal(cachedBody.stats.account.vehicles[0]?.flyouts, 10)
    assert.equal(cachedBody.stats.comparison.vehicleOverlapCount, 1)
    assert.equal(provider.calls, 1)

    now += 61
    const stale = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne' },
    })
    const staleBody = stale.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(staleBody.stats.account.state, 'stale')
    assert.equal(staleBody.stats.account.refreshQueued, true)
    await service.waitForIdle()

    const changed = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne' },
    })
    const changedBody = changed.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(changedBody.stats.account.vehicles[0]?.flyouts, 14)
    assert.equal(changedBody.stats.account.delta?.vehicles[0]?.flyouts, 4)
    assert.equal(changedBody.stats.account.delta?.totals[0]?.battles, 5)
    assert.ok(Math.abs((changedBody.stats.comparison.indicativeWinRateDifference ?? 0) + 0.1) < 1e-9)

    const baseNickMustNotMerge = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'VoicePilot' },
    })
    assert.equal(baseNickMustNotMerge.statusCode, 404)

    const voicePending = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'VoicePilot@psn' },
    })
    const voicePendingBody = voicePending.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(voicePendingBody.stats.player.wtUserId, null)
    assert.equal(voicePendingBody.stats.account.refreshQueued, true)
    assert.equal(voicePendingBody.stats.replay.available, false)
    await service.waitForIdle()
    const voiceResolved = await app.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'VoicePilot@psn' },
    })
    const voiceResolvedBody = voiceResolved.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(voiceResolvedBody.stats.player.wtUserId, '701')
    assert.equal(voiceResolvedBody.stats.replay.available, true)
    assert.equal(voiceResolvedBody.stats.replay.stats?.battles, 0)

    const disabled = await disabledApp.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne' },
    })
    const disabledBody = disabled.json() as { ok: true; stats: PlayerStatsComparison }
    assert.equal(disabledBody.stats.account.state, 'disabled_cached')
    assert.equal(disabledBody.stats.replay.stats?.battles, 2)

    for (let request = 0; request < 20; request += 1) {
      const allowed = await rateLimitApp.inject({
        method: 'POST',
        url: '/api/player-stats',
        payload: { player: 'PilotOne' },
      })
      assert.equal(allowed.statusCode, 200)
    }
    const limited = await rateLimitApp.inject({
      method: 'POST',
      url: '/api/player-stats',
      payload: { player: 'PilotOne' },
    })
    assert.equal(limited.statusCode, 429)
    assert.ok(limited.headers['retry-after'])

    console.log('[player-stats-api-smoke] OK: identity, API, UI, cache, delta, coverage и rate limit')
  } finally {
    await Promise.allSettled([app.close(), disabledApp.close(), rateLimitApp.close()])
    await service.stop()
    assert.equal(provider.closed, true)
    closeDb()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
