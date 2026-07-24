import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import {
  closeDb,
  getLatestPlayerExternalSnapshot,
  getLatestPlayerExternalStats,
  getPlayerIdentityAliases,
  getPlayerIdentityByWtUserId,
  initDb,
  savePlayerIdentity,
} from '../db/index.js'
import { THUNDERINSIGHTS_PARSER_VERSION } from '../player-stats/normalizer.js'
import {
  ThunderInsightsProvider,
  type PlayerStatsFetch,
} from '../player-stats/providers/thunderinsights.js'
import { PlayerStatsService } from '../player-stats/service.js'
import {
  PlayerStatsProviderFailure,
  type NormalizedPlayerStats,
  type PlayerReference,
  type PlayerStatsProvider,
  type RawPlayerStats,
} from '../player-stats/types.js'

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  })
}

const profilePayload = [{
  userid: 42,
  nick: 'Pilot@live',
  last_update: '2026-07-21T10:00:00Z',
}]

const unitsPayload = [{
  name: 'us_m4a1_76w_sherman',
  type: 'tank',
  gamemode: 'realistic',
  spawns: 8,
  victories: 5,
  defeats: 3,
  deaths: 6,
  air_kills: 1,
  ground_kills: 12,
  naval_kills: 0,
}, {
  name: 'p-51d-30_na',
  type: 'aircraft',
  gamemode: null,
  spawns: 2,
  victories: 1,
  defeats: 1,
  deaths: 2,
}]

async function verifyThunderInsightsProvider(): Promise<void> {
  const calls: URL[] = []
  const fixtureFetch: PlayerStatsFetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(url)
    assert.ok(init?.signal instanceof AbortSignal)
    if (url.pathname.endsWith('/users/direct/search/')) {
      assert.equal(url.searchParams.get('nick'), 'Pilot@live')
      assert.equal(url.searchParams.get('limit'), '10')
      return jsonResponse([{ userid: 42, nick: 'Pilot@live' }])
    }
    if (url.pathname.endsWith('/users/stats/42/units/')) return jsonResponse(unitsPayload)
    if (url.pathname.endsWith('/users/stats/42')) return jsonResponse(profilePayload)
    return jsonResponse({ detail: 'not found' }, 404)
  }
  const provider = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    fetchImpl: fixtureFetch,
    now: () => 2_000,
  })
  const references = await provider.resolvePlayer('Pilot@live')
  assert.deepEqual(references, [{
    source: 'thunderinsights',
    sourcePlayerId: '42',
    wtUserId: '42',
    nick: 'Pilot@live',
    platform: 'live',
  }])

  const result = await provider.fetchPlayerStats(references[0]!)
  assert.equal(result.status, 'ok')
  assert.equal(result.fetchedAt, 2_000)
  assert.equal(result.sourceUpdatedAt, Date.parse('2026-07-21T10:00:00Z') / 1_000)
  assert.deepEqual(result.normalized?.totals, [])
  assert.deepEqual(result.normalized?.vehicles, [{
    gameType: 'tank',
    mode: 'realistic',
    vehicleId: 'us_m4a1_76w_sherman',
    flyouts: 8,
    victories: 5,
    defeats: 3,
    deaths: 6,
    airKills: 1,
    groundKills: 12,
    navalKills: 0,
    timePlayedSec: null,
  }, {
    gameType: 'aircraft',
    mode: null,
    vehicleId: 'p-51d-30_na',
    flyouts: 2,
    victories: 1,
    defeats: 1,
    deaths: 2,
    airKills: null,
    groundKills: null,
    navalKills: null,
    timePlayedSec: null,
  }])
  assert.deepEqual(Object.keys(JSON.parse(result.rawJson ?? '{}') as object), ['profile', 'units'])
  assert.equal(calls.length, 3)

  for (const [httpStatus, expected] of [[403, 'private'], [404, 'not_found'], [429, 'rate_limited']] as const) {
    const statusProvider = new ThunderInsightsProvider({
      baseUrl: 'https://fixture.invalid/v1',
      fetchImpl: async () => jsonResponse({ detail: expected }, httpStatus),
      now: () => 2_001,
    })
    const failed = await statusProvider.fetchPlayerStats(references[0]!)
    assert.equal(failed.status, expected)
    assert.equal(failed.normalized, null)
  }

  const malformedProvider = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    fetchImpl: async (input) => String(input).endsWith('/units/')
      ? jsonResponse([{ ...unitsPayload[0], victories: '5' }])
      : jsonResponse(profilePayload),
    now: () => 2_002,
  })
  assert.equal((await malformedProvider.fetchPlayerStats(references[0]!)).status, 'schema_error')

  const oversizedProvider = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    profileMaxBytes: 8,
    fetchImpl: async () => new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'content-length': '100',
      },
    }),
    now: () => 2_003,
  })
  assert.equal((await oversizedProvider.fetchPlayerStats(references[0]!)).status, 'schema_error')

  const timeoutProvider = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    timeoutMs: 5,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      assert.ok(signal)
      const keepAlive = setTimeout(() => reject(new Error('timeout signal не сработал')), 100)
      const rejectAbort = (): void => {
        clearTimeout(keepAlive)
        reject(signal?.reason ?? new Error('aborted'))
      }
      if (signal?.aborted) rejectAbort()
      else signal?.addEventListener('abort', rejectAbort, { once: true })
    }),
    now: () => 2_004,
  })
  assert.equal((await timeoutProvider.fetchPlayerStats(references[0]!)).status, 'error')

  const shutdownProvider = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    timeoutMs: 1_000,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      assert.ok(signal)
      const rejectAbort = (): void => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted) rejectAbort()
      else signal?.addEventListener('abort', rejectAbort, { once: true })
    }),
  })
  const interrupted = shutdownProvider.resolvePlayer('Pilot')
  await yieldImmediate()
  shutdownProvider.close()
  await assert.rejects(
    interrupted,
    (error: unknown) => error instanceof PlayerStatsProviderFailure && error.status === 'error',
  )

  const malformedSearch = new ThunderInsightsProvider({
    baseUrl: 'https://fixture.invalid/v1',
    fetchImpl: async () => jsonResponse({ users: [] }),
  })
  await assert.rejects(
    malformedSearch.resolvePlayer('Pilot'),
    (error: unknown) => error instanceof PlayerStatsProviderFailure && error.status === 'schema_error',
  )
}

interface FixtureResult {
  status: RawPlayerStats['status']
  rawJson: string | null
  error: string | null
  normalized: NormalizedPlayerStats | null
}

class FixtureProvider implements PlayerStatsProvider {
  readonly source = 'fixture-provider'
  readonly results: FixtureResult[] = []
  fetchCalls = 0
  resolveCalls = 0
  active = 0
  peakActive = 0
  resolveResults: PlayerReference[] | null = null

  constructor(private readonly now: () => number) {}

  async resolvePlayer(nick: string): Promise<PlayerReference[]> {
    this.resolveCalls += 1
    if (this.resolveResults !== null) return this.resolveResults
    return [{
      source: this.source,
      sourcePlayerId: '9001',
      wtUserId: '9001',
      nick,
      platform: null,
    }]
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    this.fetchCalls += 1
    this.active += 1
    this.peakActive = Math.max(this.peakActive, this.active)
    try {
      await yieldImmediate()
      const result = this.results.shift()
      if (result === undefined) throw new Error('FixtureProvider: нет подготовленного ответа')
      return {
        player,
        fetchedAt: this.now(),
        sourceUpdatedAt: 900,
        ...result,
      }
    } finally {
      this.active -= 1
    }
  }
}

function okResult(rawJson: string, vehicleId: string): FixtureResult {
  return {
    status: 'ok',
    rawJson,
    error: null,
    normalized: {
      totals: [],
      vehicles: [{
        gameType: 'tank',
        mode: null,
        vehicleId,
        flyouts: 3,
        victories: null,
        defeats: null,
        deaths: 2,
        airKills: null,
        groundKills: 4,
        navalKills: null,
        timePlayedSec: null,
      }],
    },
  }
}

async function verifyService(): Promise<void> {
  initDb(':memory:')
  let now = 1_000
  const provider = new FixtureProvider(() => now)
  const service = new PlayerStatsService({
    provider,
    parserVersion: 'fixture-v1',
    ttlSeconds: 100,
    retryBaseSeconds: 10,
    retryMaxSeconds: 40,
    now: () => now,
  })
  try {
    const identity = savePlayerIdentity({
      wtUserId: '42',
      canonicalNick: 'Pilot@live',
      platform: 'live',
    })
    provider.results.push(okResult('{"profile":1}', 'tank_alpha'))
    assert.deepEqual(service.request(identity.id), {
      stats: null,
      stale: false,
      refreshQueued: true,
      lastCheck: null,
      nextRetryAt: null,
    })
    assert.equal(service.request(identity.id).refreshQueued, true)
    await service.waitForIdle()
    assert.equal(provider.fetchCalls, 1, 'одновременные request должны дедуплицироваться')
    const firstStats = getLatestPlayerExternalStats(identity.id, provider.source)
    assert.equal(firstStats?.vehicles[0]?.vehicleId, 'tank_alpha')

    now = 1_050
    const fresh = service.request(identity.id)
    assert.equal(fresh.stale, false)
    assert.equal(fresh.refreshQueued, false)
    assert.equal(provider.fetchCalls, 1)

    now = 1_200
    provider.results.push({
      status: 'rate_limited',
      rawJson: '{"detail":"slow down"}',
      error: 'HTTP 429',
      normalized: null,
    })
    const staleBeforeRefresh = service.request(identity.id)
    assert.equal(staleBeforeRefresh.stale, true)
    assert.equal(staleBeforeRefresh.refreshQueued, true)
    await service.waitForIdle()
    assert.equal(getLatestPlayerExternalSnapshot(identity.id, provider.source)?.status, 'rate_limited')
    assert.equal(getLatestPlayerExternalStats(identity.id, provider.source)?.snapshot.id, firstStats?.snapshot.id)

    const backedOff = service.request(identity.id)
    assert.equal(backedOff.stale, true)
    assert.equal(backedOff.refreshQueued, false)
    assert.equal(backedOff.nextRetryAt, 1_210)
    assert.equal(provider.fetchCalls, 2)

    now = 1_210
    provider.results.push(okResult('{"profile":1}', 'tank_alpha'))
    assert.equal(service.request(identity.id).refreshQueued, true)
    await service.waitForIdle()
    const refreshed = getLatestPlayerExternalStats(identity.id, provider.source)
    assert.equal(refreshed?.snapshot.id, firstStats?.snapshot.id)
    assert.equal(refreshed?.snapshot.lastCheckedAt, 1_210)
    assert.equal(service.request(identity.id).stale, false)

    now = 2_000
    const second = savePlayerIdentity({ wtUserId: '43', canonicalNick: 'Second', platform: null })
    const third = savePlayerIdentity({ wtUserId: '44', canonicalNick: 'Third', platform: null })
    provider.results.push(okResult('{"profile":2}', 'tank_beta'))
    provider.results.push(okResult('{"profile":3}', 'tank_gamma'))
    service.request(second.id)
    service.request(third.id)
    await service.waitForIdle()
    assert.equal(provider.peakActive, 1, 'provider queue не должна запускаться с наложением')
    assert.equal(provider.resolveCalls, 0, 'известный wt_user_id не требует resolve по нику')

    now = 2_100
    const unresolved = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'ResolvedPilot',
      platform: null,
    })
    provider.results.push(okResult('{"profile":9001}', 'tank_resolved'))
    service.request(unresolved.id)
    await service.waitForIdle()
    assert.equal(getPlayerIdentityByWtUserId('9001')?.id, unresolved.id)
    assert.deepEqual(getPlayerIdentityAliases(unresolved.id), [{
      identityId: unresolved.id,
      source: provider.source,
      externalId: '9001',
      nick: 'ResolvedPilot',
      nickBase: 'ResolvedPilot',
      firstSeenAt: 2_100,
      lastSeenAt: 2_100,
      matchMethod: 'user_id',
      matchConfidence: 'high',
    }])
    assert.equal(provider.resolveCalls, 1)

    now = 2_200
    const ambiguous = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'SameNick',
      platform: null,
    })
    provider.resolveResults = ['9101', '9102'].map((id) => ({
      source: provider.source,
      sourcePlayerId: id,
      wtUserId: id,
      nick: 'SameNick',
      platform: null,
    }))
    const fetchCallsBeforeAmbiguous = provider.fetchCalls
    service.request(ambiguous.id)
    await service.waitForIdle()
    assert.equal(provider.fetchCalls, fetchCallsBeforeAmbiguous)
    assert.equal(getLatestPlayerExternalSnapshot(ambiguous.id, provider.source)?.status, 'error')
    assert.equal(getPlayerIdentityByWtUserId('9101'), null)
    assert.equal(getPlayerIdentityByWtUserId('9102'), null)

    now = 2_300
    const missing = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'MissingPilot',
      platform: null,
    })
    provider.resolveResults = []
    service.request(missing.id)
    await service.waitForIdle()
    const negativeCache = service.request(missing.id)
    assert.equal(negativeCache.lastCheck?.status, 'not_found')
    assert.equal(negativeCache.refreshQueued, false)
    assert.equal(negativeCache.nextRetryAt, 2_400, 'not_found должен использовать полный TTL')
    provider.resolveResults = null

    const metrics = service.getMetrics()
    assert.equal(metrics.succeeded, 5)
    assert.equal(metrics.failed, 3)
    assert.equal(metrics.byStatus.rate_limited, 1)
    assert.equal(metrics.byStatus.error, 1)
    assert.equal(metrics.byStatus.not_found, 1)
    assert.ok(metrics.skippedFresh >= 2)
    assert.equal(metrics.skippedBackoff, 2)
    await service.stop()
    const fetchCallsAfterStop = provider.fetchCalls
    assert.equal(service.request(identity.id).refreshQueued, false)
    assert.equal(provider.fetchCalls, fetchCallsAfterStop)
  } finally {
    await service.stop()
    closeDb()
  }
}

await verifyThunderInsightsProvider()
await verifyService()
console.log(`ThunderInsights ${THUNDERINSIGHTS_PARSER_VERSION}, TTL и stale fallback: smoke-тест пройден`)
