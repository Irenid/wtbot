import assert from 'node:assert/strict'
import test from 'node:test'
import { emitBattleLifecycle, subscribeBattleLifecycle } from './battle-lifecycle.js'

test('battle lifecycle delivers typed events and unsubscribe stops delivery', () => {
  const received: string[] = []
  const unsubscribe = subscribeBattleLifecycle((event) => {
    received.push(event.kind)
  })

  emitBattleLifecycle({ kind: 'discovered', sessionIds: ['one'], bulk: false })
  emitBattleLifecycle({ kind: 'committed', sessionId: 'one' })
  unsubscribe()
  emitBattleLifecycle({ kind: 'committed', sessionId: 'two' })

  assert.deepEqual(received, ['discovered', 'committed'])
})

test('battle lifecycle isolates listener failures', () => {
  const originalError = console.error
  console.error = () => undefined
  const unsubscribeFailing = subscribeBattleLifecycle(() => {
    throw new Error('expected listener failure')
  })
  let delivered = false
  const unsubscribeHealthy = subscribeBattleLifecycle(() => {
    delivered = true
  })
  try {
    emitBattleLifecycle({ kind: 'committed', sessionId: 'one' })
    assert.equal(delivered, true)
  } finally {
    unsubscribeFailing()
    unsubscribeHealthy()
    console.error = originalError
  }
})
