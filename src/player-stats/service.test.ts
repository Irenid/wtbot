import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, getLatestPlayerExternalCheck, getPlayerIdentityById, initDb, savePlayerIdentity } from '../db/index.js'
import { PlayerStatsService } from './service.js'
import type { PlayerExternalSnapshotStatus, PlayerReference, PlayerStatsProvider, RawPlayerStats } from './types.js'

let clock = 1_790_000_000

type Answer = (player: PlayerReference) => RawPlayerStats

const ok: Answer = (player) => ({
  player,
  fetchedAt: clock,
  sourceUpdatedAt: null,
  status: 'ok',
  rawJson: '{}',
  error: null,
  normalized: { totals: [], vehicles: [] },
})

const failed = (status: Exclude<PlayerExternalSnapshotStatus, 'ok'>): Answer => (player) => ({
  player,
  fetchedAt: clock,
  sourceUpdatedAt: null,
  status,
  rawJson: null,
  error: `${status} answer`,
  normalized: null,
})

/** Answers in the order of `answers` (ok once they run out) and records how many fetches overlap. */
class FakeProvider implements PlayerStatsProvider {
  readonly source = 'fake'
  readonly fetched: string[] = []
  candidates: PlayerReference[] = []
  answers: Answer[] = []
  active = 0
  maxActive = 0
  closed = 0
  gate: Promise<void> | null = null
  constructor(readonly requiresWtUserId = false) {}
  async resolvePlayer(): Promise<PlayerReference[]> {
    return this.candidates
  }
  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    this.fetched.push(player.nick)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await (this.gate ?? new Promise<void>((resolve) => setImmediate(resolve)))
      return (this.answers.shift() ?? ok)(player)
    } finally {
      this.active -= 1
    }
  }
  close(): void {
    this.closed += 1
  }
}

function setup(options: { ttlSeconds?: number; retryBaseSeconds?: number; retryMaxSeconds?: number; requiresWtUserId?: boolean } = {}) {
  initDb(':memory:')
  clock = 1_790_000_000
  const provider = new FakeProvider(options.requiresWtUserId)
  const service = new PlayerStatsService({
    provider,
    parserVersion: 'test',
    ttlSeconds: options.ttlSeconds ?? 3_600,
    retryBaseSeconds: options.retryBaseSeconds ?? 60,
    retryMaxSeconds: options.retryMaxSeconds ?? 200,
    now: () => clock,
  })
  const identity = (nick: string, wtUserId: string | null) => savePlayerIdentity({ wtUserId, canonicalNick: nick }).id
  return { provider, service, identity }
}

test('one refresh at a time, one per player however often it is asked', async () => {
  const { provider, service, identity } = setup()
  try {
    const alpha = identity('Alpha', '101')
    const bravo = identity('Bravo', '102')
    assert.equal(service.request(alpha).refreshQueued, true)
    assert.equal(service.request(alpha).refreshQueued, true)
    service.request(bravo)
    await service.waitForIdle()
    assert.deepEqual(provider.fetched, ['Alpha', 'Bravo'])
    assert.equal(provider.maxActive, 1)
    assert.equal(service.getMetrics().queued, 2)
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a fresh snapshot is not fetched again; past the TTL it is, and the old one is served meanwhile', async () => {
  const { provider, service, identity } = setup({ ttlSeconds: 3_600 })
  try {
    const alpha = identity('Alpha', '101')
    service.request(alpha)
    await service.waitForIdle()
    const fresh = service.request(alpha)
    assert.ok(fresh.stats)
    assert.equal(fresh.stale, false)
    assert.equal(fresh.refreshQueued, false)
    assert.equal(service.getMetrics().skippedFresh, 1)
    clock += 3_600
    const old = service.request(alpha)
    assert.equal(old.stale, true)
    assert.equal(old.refreshQueued, true)
    assert.ok(old.stats, 'the last good snapshot is served while the refresh runs')
    await service.waitForIdle()
    assert.equal(provider.fetched.length, 2)
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a failed check is retried after the base delay, doubling to the cap; a success clears it', async () => {
  const { provider, service, identity } = setup({ retryBaseSeconds: 60, retryMaxSeconds: 200 })
  try {
    const alpha = identity('Alpha', '101')
    provider.answers = [failed('error'), failed('error'), failed('error')]
    const expectedDelays = [60, 120, 200]
    for (const delay of expectedDelays) {
      const start = clock
      service.request(alpha)
      await service.waitForIdle()
      const after = service.request(alpha)
      assert.equal(after.nextRetryAt, start + delay)
      assert.equal(after.refreshQueued, false, 'no refresh before the retry time')
      clock = start + delay
    }
    service.request(alpha)
    await service.waitForIdle()
    const recovered = service.request(alpha)
    assert.equal(recovered.nextRetryAt, null)
    assert.equal(recovered.lastCheck?.status, 'ok')
    assert.equal(service.getMetrics().skippedBackoff, 3)
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a private or unknown player waits the whole TTL, not the error back-off', async () => {
  const { provider, service, identity } = setup({ ttlSeconds: 3_600, retryBaseSeconds: 60 })
  try {
    const alpha = identity('Alpha', '101')
    provider.answers = [failed('private')]
    service.request(alpha)
    await service.waitForIdle()
    assert.equal(service.request(alpha).nextRetryAt, clock + 3_600)
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a 429 pauses every player and drops queued refreshes; repeated 429s double the pause', async () => {
  const { provider, service, identity } = setup({ retryBaseSeconds: 60, retryMaxSeconds: 200 })
  try {
    const alpha = identity('Alpha', '101')
    const bravo = identity('Bravo', '102')
    provider.answers = [failed('rate_limited')]
    service.request(alpha)
    service.request(bravo)
    await service.waitForIdle()
    assert.deepEqual(provider.fetched, ['Alpha'], "Bravo's queued refresh was dropped")
    assert.equal(service.request(bravo).refreshQueued, false)
    clock += 60
    provider.answers = [failed('rate_limited')]
    service.request(bravo)
    await service.waitForIdle()
    clock += 119
    assert.equal(service.request(identity('Charlie', '103')).refreshQueued, false, 'the second 429 paused for 120 s')
    clock += 1
    service.request(identity('Delta', '104'))
    await service.waitForIdle()
    assert.deepEqual(provider.fetched, ['Alpha', 'Bravo', 'Delta'])
    assert.ok(service.getMetrics().skippedBackoff >= 3)
  } finally {
    await service.stop()
    closeDb()
  }
})

test('answers that break the provider contract are stored as schema_error', async () => {
  const { provider, service, identity } = setup()
  try {
    const cases: [string, Answer][] = [
      ['ok without metrics', (player) => ({ ...ok(player), normalized: null })],
      ['a failure with metrics', (player) => ({ ...failed('error')(player), normalized: { totals: [], vehicles: [] } })],
      ['another source', (player) => ok({ ...player, source: 'other' })],
    ]
    for (const [label, answer] of cases) {
      const id = identity(label.replace(/\W/g, ''), String(200 + cases.findIndex(([name]) => name === label)))
      provider.answers = [answer]
      service.request(id)
      await service.waitForIdle()
      assert.equal(getLatestPlayerExternalCheck(id, 'fake')?.status, 'schema_error', label)
    }
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a nick-only identity links the account on one exact match; none or several link nothing', async () => {
  const { provider, service, identity } = setup()
  try {
    const reference = (nick: string, wtUserId: string): PlayerReference => ({ source: 'fake', sourcePlayerId: wtUserId, wtUserId, nick, platform: null })
    const lonely = identity('Lonely', null)
    provider.candidates = [reference('Lonelyy', '500')]
    service.request(lonely)
    await service.waitForIdle()
    assert.equal(getLatestPlayerExternalCheck(lonely, 'fake')?.status, 'not_found')

    const twin = identity('Twin', null)
    provider.candidates = [reference('Twin', '501'), reference('twin', '502')]
    service.request(twin)
    await service.waitForIdle()
    assert.equal(getLatestPlayerExternalCheck(twin, 'fake')?.status, 'error')

    const single = identity('Single', null)
    provider.candidates = [reference('single', '503')]
    service.request(single)
    await service.waitForIdle()
    assert.equal(getLatestPlayerExternalCheck(single, 'fake')?.status, 'ok')
    assert.equal(getPlayerIdentityById(single)?.wtUserId, '503')
    assert.deepEqual(provider.fetched, ['single'])
  } finally {
    await service.stop()
    closeDb()
  }
})

test('a source that needs a WT user id never queues an identity without one', async () => {
  const { provider, service, identity } = setup({ requiresWtUserId: true })
  try {
    assert.equal(service.request(identity('Nameless', null)).refreshQueued, false)
    await service.waitForIdle()
    assert.deepEqual(provider.fetched, [])
  } finally {
    await service.stop()
    closeDb()
  }
})

test('stop drops queued refreshes, lets the running one finish and closes the provider', async () => {
  const { provider, service, identity } = setup()
  try {
    let open!: () => void
    provider.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const ids = ['Alpha', 'Bravo', 'Charlie'].map((nick, index) => identity(nick, String(300 + index)))
    for (const id of ids) service.request(id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(provider.active, 1)
    const stopped = service.stop()
    assert.equal(service.request(ids[1]!).refreshQueued, false, 'nothing new is queued once stopping')
    open()
    await stopped
    assert.deepEqual(provider.fetched, ['Alpha'])
    assert.equal(provider.closed, 1)
    assert.equal(getLatestPlayerExternalCheck(ids[0]!, 'fake')?.status, 'ok')
  } finally {
    closeDb()
  }
})
