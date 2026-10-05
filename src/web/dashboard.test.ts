import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  DASHBOARD_LATEST_ITEMS_SQL,
  explainSiteQueryPlan,
  getAnnounceStats,
  getItemByExternalId,
  getLatestItemSummaries,
  initDb,
  markAnnounce,
  markAnnouncePending,
  recordCommandUse,
  saveItems,
  setBotState,
} from '../db/index.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { buildServer } from './index.js'
import { DASHBOARD_PATH } from './routes/pages.js'

test('dashboard отдаёт лёгкий кэшируемый снимок и инвалидируется после voice refresh', async () => {
  initDb(':memory:')
  saveItems('wt-replays', [
    { externalId: 'announce-first', title: 'Анонс 1', data: {} },
    { externalId: 'announce-pending', title: 'Анонс 2', data: {} },
    { externalId: 'announce-failed', title: 'Анонс 3', data: {} },
  ])
  setBotState('battles:lastAnnouncedId', '0')
  const pendingAnnounce = getItemByExternalId('wt-replays', 'announce-pending')
  const failedAnnounce = getItemByExternalId('wt-replays', 'announce-failed')
  assert.ok(pendingAnnounce)
  assert.ok(failedAnnounce)
  markAnnouncePending(pendingAnnounce.id, 'message-1')
  markAnnounce(failedAnnounce.id, 'failed', 'test-1')
  markAnnounce(failedAnnounce.id, 'failed', 'test-2')
  markAnnounce(failedAnnounce.id, 'failed', 'test-3')
  assert.deepEqual(getAnnounceStats(), {
    baselineId: 0,
    pending: 2,
    unattempted: 1,
    retrying: 1,
    sent: 0,
    failed: 1,
  })
  saveItems('demo', [{
    externalId: 'first',
    title: 'Первая запись',
    data: { payload: 'x'.repeat(100_000) },
  }])
  recordCommandUse('stats', null, 'test-user')

  let refreshes = 0
  let siteStatsReads = 0
  const app = buildServer(
    {
      getBotStatus: () => ({ online: true, tag: 'wtbot#test', guilds: 2, uptimeSec: 60 }),
      refreshVoice: async () => {
        refreshes += 1
        saveItems('demo', [{
          externalId: 'second',
          title: 'Вторая запись',
          data: { payload: 'y'.repeat(100_000) },
        }])
        return { players: 0, clans: 0 }
      },
      playerStats: new PlayerStatsCoordinator({ externalService: null }),
    },
    {
      loadDashboardStats: async () => {
        siteStatsReads += 1
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        return {
          players: 10,
          battlesTotal: 30,
          battlesRecent: 4,
          lastBattleAt: 100,
          byDay: [{ day: '1970-01-01', battles: 4 }],
        }
      },
    },
  )

  try {
    const first = await app.inject({ method: 'GET', url: '/api/dashboard' })
    assert.equal(first.statusCode, 200)
    assert.match(first.headers['cache-control'] ?? '', /max-age=5/)
    const firstBody = first.json()
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.runtime, null)
    assert.equal(firstBody.commands.total, 1)
    assert.equal(firstBody.announce.pending, 2)
    assert.equal(firstBody.recentItems[0].title, 'Первая запись')
    assert.equal('data' in firstBody.recentItems[0], false)

    const cached = await app.inject({ method: 'GET', url: '/api/dashboard' })
    assert.equal(cached.json().snapshotAt, firstBody.snapshotAt)

    const [siteStatsA, siteStatsB] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/site-stats' }),
      app.inject({ method: 'GET', url: '/api/site-stats' }),
    ])
    assert.equal(siteStatsReads, 1)
    assert.equal(siteStatsA.json().battlesTotal, 30)
    assert.equal(siteStatsB.json().players, 10)

    const refreshed = await app.inject({ method: 'POST', url: '/api/voice/refresh' })
    assert.equal(refreshed.statusCode, 200)
    assert.equal(refreshes, 1)
    const afterRefresh = await app.inject({ method: 'GET', url: '/api/dashboard' })
    assert.equal(afterRefresh.json().recentItems[0].title, 'Вторая запись')

    const page = await app.inject({ method: 'GET', url: DASHBOARD_PATH })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /\/api\/dashboard/)
    assert.match(page.body, /visibilitychange/)
    assert.doesNotMatch(page.body, /\/api\/items\?limit=8/)
    const script = /<script>([\s\S]+)<\/script>/.exec(page.body)?.[1]
    assert.ok(script)
    assert.doesNotThrow(() => new Function(script))

    const summaries = getLatestItemSummaries(2)
    assert.deepEqual(summaries.map((item) => item.title), ['Вторая запись', 'Первая запись'])
    const plan = explainSiteQueryPlan(DASHBOARD_LATEST_ITEMS_SQL).map((row) => row.detail).join('\n')
    assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/)
  } finally {
    await app.close()
    closeDb()
  }
})
