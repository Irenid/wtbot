import assert from 'node:assert/strict'
import test from 'node:test'
import {
  queueBattlePostRecheck,
  queueBattlePostUpdates,
  seasonMaxBrSuffix,
  type BattlePost,
  type BattlePostPayload,
} from './commands/battle.js'

const payload = (content: string): BattlePostPayload => ({
  content,
  files: [],
  components: [],
})

test('анонс добавляет рядом с Match ID только максимальный БР', () => {
  assert.equal(
    seasonMaxBrSuffix({
      season: { id: '2026', name: 'Сезон 2026', startsAt: 0, endsAt: 10_000, active: true },
      stages: [],
      currentStage: { week: 5, startsAt: 0, endsAt: 1, maxBr: 8.7 },
    }),
    ' · Макс. БР 8.7',
  )
  assert.equal(
    seasonMaxBrSuffix({
      season: { id: '2026', name: 'Сезон 2026', startsAt: 0, endsAt: 10_000, active: false },
      stages: [],
      currentStage: null,
    }),
    '',
  )
})

test('PSR applies at once; the winner and then the squadron lookup follow in order', async () => {
  let releaseWinner: (() => void) | undefined
  const winnerReady = new Promise<void>((resolve) => {
    releaseWinner = resolve
  })
  let firstApplied: (() => void) | undefined
  const firstApply = new Promise<void>((resolve) => {
    firstApplied = resolve
  })
  let allApplied: (() => void) | undefined
  const complete = new Promise<void>((resolve) => {
    allApplied = resolve
  })
  const applied: string[] = []
  const post: BattlePost = {
    payload: payload('initial'),
    sessionIdHex: 'rating-update-test',
    buildRatingsPayload: async () => payload('ratings'),
    buildWinnerPayload: async () => {
      await winnerReady
      return payload('winner')
    },
    // Built only after the winner is applied, so its redraw keeps the winner.
    buildLookupPayload: async () => payload('lookup'),
    buildRecheckPayload: null,
    recheckAt: 0,
    updateBytes: 0,
  }

  queueBattlePostUpdates(post, async (next) => {
    applied.push(next.content)
    if (applied.length === 1) firstApplied?.()
    if (applied.length === 3) allApplied?.()
  })

  await firstApply
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(applied, ['ratings'])
  releaseWinner?.()
  await complete
  assert.deepEqual(applied, ['ratings', 'winner', 'lookup'])
})

test('the PSR recheck waits until due and for the post\'s other updates, then redraws', async () => {
  let releaseLookup!: () => void
  const lookupHeld = new Promise<void>((resolve) => {
    releaseLookup = resolve
  })
  let rechecked!: () => void
  const recheckDone = new Promise<void>((resolve) => {
    rechecked = resolve
  })
  const applied: string[] = []
  const post: BattlePost = {
    payload: payload('initial'),
    sessionIdHex: 'recheck-test',
    buildRatingsPayload: async () => payload('ratings'),
    buildWinnerPayload: null,
    buildLookupPayload: async () => {
      await lookupHeld
      return payload('lookup')
    },
    buildRecheckPayload: async () => payload('recheck'),
    recheckAt: Date.now() + 20,
    updateBytes: 1024,
  }
  const apply = async (next: BattlePostPayload) => {
    applied.push(next.content)
    if (next.content === 'recheck') rechecked()
  }
  queueBattlePostUpdates(post, apply)
  queueBattlePostRecheck(post, apply)

  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(applied, ['ratings'], 'due, but the lookup update still runs')
  releaseLookup()
  await recheckDone
  assert.deepEqual(applied, ['ratings', 'lookup', 'recheck'])
})

test('a PSR recheck already due or redrawing past the deadline is not queued', async () => {
  let builds = 0
  const post = (sessionIdHex: string, recheckAt: number): BattlePost => ({
    payload: payload('initial'),
    sessionIdHex,
    buildRatingsPayload: null,
    buildWinnerPayload: null,
    buildLookupPayload: null,
    buildRecheckPayload: async () => {
      builds += 1
      return payload('recheck')
    },
    recheckAt,
    updateBytes: 0,
  })
  queueBattlePostRecheck(post('recheck-past', Date.now() - 1), async () => undefined)
  queueBattlePostRecheck(post('recheck-late', Date.now() + 10), async () => undefined, Date.now())
  // Due before the deadline, but it redraws PSR_RECHECK_STORE_WAIT_SEC later.
  queueBattlePostRecheck(post('recheck-wait', Date.now() + 10), async () => undefined, Date.now() + 60_000)
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  assert.equal(builds, 0)
})
