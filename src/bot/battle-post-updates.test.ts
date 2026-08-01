import assert from 'node:assert/strict'
import test from 'node:test'
import {
  queueBattlePostUpdates,
  type BattlePost,
  type BattlePostPayload,
} from './commands/battle.js'

const payload = (content: string): BattlePostPayload => ({
  content,
  files: [],
  components: [],
})

test('обновление ПКР применяется сразу, не ожидая durable summary', async () => {
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
    updateBytes: 0,
  }

  queueBattlePostUpdates(post, async (next) => {
    applied.push(next.content)
    if (applied.length === 1) firstApplied?.()
    if (applied.length === 2) allApplied?.()
  })

  await firstApply
  assert.deepEqual(applied, ['ratings'])
  releaseWinner?.()
  await complete
  assert.deepEqual(applied, ['ratings', 'winner'])
})
