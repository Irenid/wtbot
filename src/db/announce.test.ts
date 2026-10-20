import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getItemByExternalId,
  getPendingAnnounce,
  initDb,
  markAnnounce,
  nextAnnounceBaseline,
  saveItems,
  skipStaleAnnounce,
} from './index.js'

test('announce queue retries a failed battle and processes newest first', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [
      { externalId: '1', title: 'one', data: {} },
      { externalId: '2', title: 'two', data: {} },
    ])

    const first = getPendingAnnounce(0, 3, 2)
    assert.deepEqual(first.map((item) => item.externalId), ['2', '1'])

    const newest = getItemByExternalId('wt-replays', '2')
    assert.ok(newest)
    markAnnounce(newest.id, 'failed', 'network')

    const failed = getPendingAnnounce(0, 3, 2).find((item) => item.externalId === '2')
    assert.equal(failed?.announceStatus, 'failed')
    assert.equal(failed?.announceAttempts, 1)

    markAnnounce(newest.id, 'ok')
    assert.deepEqual(getPendingAnnounce(0, 3, 2).map((item) => item.externalId), ['1'])
    assert.equal(nextAnnounceBaseline(0, 3), 0)
  } finally {
    closeDb()
  }
})

test('stale battles are resolved unposted, failed ones too', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [
      { externalId: 'old', title: 'old', data: { startTime: 1_000 } },
      { externalId: 'old-failed', title: 'old-failed', data: { startTime: 1_100 } },
      { externalId: 'fresh', title: 'fresh', data: { startTime: 9_000 } },
      { externalId: 'no-time', title: 'no-time', data: {} },
    ])
    const id = (externalId: string) => getItemByExternalId('wt-replays', externalId)!.id
    markAnnounce(id('old-failed'), 'failed', 'network')

    assert.equal(skipStaleAnnounce(0, 3, 5_000), 2)
    assert.deepEqual(
      getPendingAnnounce(0, 3, 10).map((item) => item.externalId).sort(),
      ['fresh', 'no-time'],
    )
    // A repeat changes nothing.
    assert.equal(skipStaleAnnounce(0, 3, 5_000), 0)
  } finally {
    closeDb()
  }
})

test('a resolved battle never returns, and the baseline only moves forward without passing a waiting battle', () => {
  const maxAttempts = 3
  // xorshift32: the same operation sequence on every run.
  let seed = 0x2f6b_1d93
  const random = (bound: number): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % bound
  }
  try {
    initDb(':memory:', { allowCreate: true })
    // Item id → [status, attempts] as the queue must see it.
    const expected = new Map<number, { status: 'ok' | 'failed' | null; attempts: number }>()
    const resolved = new Set<number>()
    let baseline = 0
    let next = 0
    for (let step = 0; step < 400; step += 1) {
      const operation = random(10)
      const waiting = getPendingAnnounce(baseline, maxAttempts, 1_000)
      if (operation < 3 || waiting.length === 0) {
        const externalId = String(next)
        next += 1
        // Every fifth battle starts long ago: skipStaleAnnounce resolves it.
        saveItems('wt-replays', [{ externalId, title: externalId, data: { startTime: next % 5 === 0 ? 1_000 : 9_000 } }])
        expected.set(getItemByExternalId('wt-replays', externalId)!.id, { status: null, attempts: 0 })
      } else if (operation < 9) {
        const item = waiting[random(waiting.length)]!
        const state = expected.get(item.id)!
        const status = random(2) === 0 ? 'ok' : 'failed'
        markAnnounce(item.id, status, status === 'failed' ? 'network' : null)
        state.status = status
        state.attempts += 1
        if (status === 'ok') resolved.add(item.id)
      } else {
        const skipped = getPendingAnnounce(baseline, maxAttempts, 1_000)
          .filter((item) => (item.data as { startTime: number }).startTime < 5_000)
        assert.equal(skipStaleAnnounce(baseline, maxAttempts, 5_000), skipped.length)
        for (const item of skipped) {
          expected.get(item.id)!.status = 'ok'
          resolved.add(item.id)
        }
      }

      const pending = getPendingAnnounce(baseline, maxAttempts, 1_000)
      const pendingIds = new Set(pending.map((item) => item.id))
      assert.equal(pendingIds.size, pending.length, 'a battle is listed once')
      for (const id of resolved) assert.equal(pendingIds.has(id), false, `resolved battle ${id} came back`)
      for (const [id, state] of expected) {
        const shouldWait = id > baseline && state.status !== 'ok' && state.attempts < maxAttempts
        assert.equal(pendingIds.has(id), shouldWait, `battle ${id}: ${JSON.stringify(state)}`)
      }
      // The oldest-first sweep reads the same set.
      assert.deepEqual(
        getPendingAnnounce(baseline, maxAttempts, 1_000, 'oldest').map((item) => item.id).sort((a, b) => a - b),
        [...pendingIds].sort((a, b) => a - b),
      )

      const moved = nextAnnounceBaseline(baseline, maxAttempts)
      assert.ok(moved >= baseline, `the baseline went back from ${baseline} to ${moved}`)
      for (const id of pendingIds) assert.ok(id > moved, `the baseline ${moved} passed waiting battle ${id}`)
      if (pendingIds.size === 0) assert.equal(moved, Math.max(baseline, ...expected.keys()))
      baseline = moved
    }
    assert.ok(resolved.size > 50, 'the sequence resolves battles')
  } finally {
    closeDb()
  }
})

test('announce queue stops retrying after the configured failure limit', () => {
  try {
    initDb(':memory:', { allowCreate: true })
    saveItems('wt-replays', [{ externalId: '3', title: 'three', data: {} }])
    const item = getItemByExternalId('wt-replays', '3')
    assert.ok(item)

    markAnnounce(item.id, 'failed', 'one')
    markAnnounce(item.id, 'failed', 'two')
    assert.equal(getPendingAnnounce(0, 3, 1).length, 1)
    markAnnounce(item.id, 'failed', 'three')
    assert.equal(getPendingAnnounce(0, 3, 1).length, 0)
    assert.equal(nextAnnounceBaseline(0, 3), item.id)
  } finally {
    closeDb()
  }
})
