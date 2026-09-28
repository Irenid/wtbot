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
import { PlayerNotFoundError, PlayerSessionError } from '../parsers/sources/wt-player.js'
import { WtRequestError } from '../parsers/sources/wt-request.js'
import { OFFICIAL_PROFILE_PARSER_VERSION } from '../player-stats/normalizer.js'
import { OfficialProfileProvider } from '../player-stats/providers/official-profile.js'
import { PlayerStatsService } from '../player-stats/service.js'
import {
  type NormalizedPlayerStats,
  type PlayerReference,
  type PlayerStatsProvider,
  type RawPlayerStats,
} from '../player-stats/types.js'

/** Фрагмент страницы профиля с той же разметкой, что и на warthunder.com. */
function profileFixture(nick: string): string {
  const row = (titles: string[], arcade: Array<string | null>): string => `
    <div class="user-stat__list-row">
      <ul class="user-stat__list user-stat__list--titles">
        ${titles.map((title) => `<li class="user-stat__list-item">${title}</li>`).join('')}
      </ul>
      <ul class="user-stat__list arcadeFightTab is-visible">
        ${arcade.map((value) => `<li class="user-stat__list-item">${value ?? 'N/A'}</li>`).join('')}
      </ul>
    </div>`
  return `<!doctype html><html><body>
    <div class="user-profile">
      <ul class="user-profile__data-list">
        <li class="user-profile__data-nick">${nick}</li>
        <li class="user-profile__data-clan"><a href="/en/community/claninfo/x">┾WLILY┿</a></li>
        <li class="user-profile__data-item">Level 100</li>
        <li class="user-profile__data-regdate">Registration date 03.03.2019</li>
      </ul>
    </div>
    <div class="user-profile__stat user-stat">
      ${row(
        [
          'Statistics', 'Victories', 'Completed missions', 'Victories/battles ratio', 'Deaths',
          'Lions earned', 'Play time', 'Air targets destroyed', 'Ground targets destroyed',
          'Naval targets destroyed',
        ],
        ['Arcade battles', '477', '954', '50%', '2,442', '3,655,382', '4d 10h', '2704', '755', null],
      )}
    </div>
    <div class="user-profile__stat user-stat user-stat--tabs">
      ${row(
        ['Air battles', 'Air battles in fighters', 'Time played in air battles', 'Air targets destroyed'],
        ['1644', '1644', '2d 8h', '2559'],
      )}
    </div>
  </body></html>`
}

async function verifyOfficialProfileProvider(): Promise<void> {
  const requested: string[] = []
  const provider = new OfficialProfileProvider({
    now: () => 2_000,
    fetchProfile: async (nickname) => {
      requested.push(nickname)
      if (nickname === 'Missing') throw new PlayerNotFoundError(`профиль ${nickname}: игрок не найден`)
      if (nickname === 'Expired') throw new PlayerSessionError(`профиль ${nickname}: сессия WT истекла`)
      if (nickname === 'Limited') throw new WtRequestError(429, false, 'HTTP 429')
      if (nickname === 'Broken') {
        return { html: '<html><body><div class="user-profile"><ul><li class="user-profile__data-nick">Broken</li></ul></div></body></html>', url: 'https://warthunder.com/' }
      }
      return { html: profileFixture(nickname), url: `https://warthunder.com/en/community/userinfo/?nick=${nickname}` }
    },
  })

  // Профиль адресуется ником: поиска нет, ссылка одна и без числового id.
  const references = await provider.resolvePlayer('Venukbr')
  assert.deepEqual(references, [{
    source: 'official-profile',
    sourcePlayerId: 'Venukbr',
    wtUserId: null,
    nick: 'Venukbr',
    platform: null,
  }])
  assert.equal((await provider.resolvePlayer('Console@psn'))[0]?.platform, 'psn')

  const ok = await provider.fetchPlayerStats({
    source: 'official-profile',
    sourcePlayerId: 'Venukbr',
    // Числовой id известен identity из локальных реплеев, но страница его не
    // публикует и найдена по нику: provider не должен «подтверждать» id — иначе
    // статистика переименованного ника легла бы под чужой wt_user_id с высокой уверенностью.
    wtUserId: '82922922',
    nick: 'Venukbr',
    platform: null,
  })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.error, null)
  assert.equal(ok.player.wtUserId, null)
  assert.equal(ok.fetchedAt, 2_000)
  assert.ok(ok.rawJson !== null)
  // В raw snapshot должны лежать извлечённые строки, а не HTML страницы.
  assert.ok(!ok.rawJson.includes('<html'), 'raw snapshot не должен содержать HTML')
  assert.ok(ok.rawJson.length < 8_000, 'raw snapshot должен быть компактным ради дедупликации')

  const totals = ok.normalized?.totals ?? []
  const aggregate = totals.find((row) => row.gameType === null && row.mode === null && row.category === null)
  assert.equal(aggregate?.battles, 954)
  assert.equal(aggregate?.victories, 477)
  assert.equal(aggregate?.defeats, 477)
  const arcade = totals.find((row) => row.gameType === null && row.mode === 'arcade')
  assert.equal(arcade?.deaths, 2_442)
  assert.equal(arcade?.timePlayedSec, 4 * 86_400 + 10 * 3_600)
  // «N/A» остаётся неизвестным значением, а не нулём.
  assert.equal(arcade?.navalKills, null)
  const air = totals.find((row) => row.gameType === 'air' && row.category === 'all')
  assert.equal(air?.respawns, 1_644)
  assert.equal(air?.airKills, 2_559)
  assert.equal(air?.battles, null, 'выходы на задания нельзя выдавать за бои')
  assert.equal(ok.normalized?.vehicles.length, 0, 'профиль не публикует статистику по технике')

  // Ошибки транспорта должны различаться в статусе snapshot.
  for (const [nick, status] of [
    ['Missing', 'not_found'],
    ['Expired', 'private'],
    ['Limited', 'rate_limited'],
    ['Broken', 'schema_error'],
  ] as const) {
    const failed = await provider.fetchPlayerStats({
      source: 'official-profile',
      sourcePlayerId: nick,
      wtUserId: null,
      nick,
      platform: null,
    })
    assert.equal(failed.status, status, `${nick} → ${status}`)
    assert.equal(failed.normalized, null)
    assert.ok(failed.error !== null && failed.error !== '')
  }
  assert.deepEqual(requested, ['Venukbr', 'Missing', 'Expired', 'Limited', 'Broken'])
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

await verifyOfficialProfileProvider()
await verifyService()
console.log(`Профиль warthunder.com ${OFFICIAL_PROFILE_PARSER_VERSION}, TTL и stale fallback: smoke-тест пройден`)
