import assert from 'node:assert/strict'
import test from 'node:test'
import { emitBattleLifecycle } from '../battle-lifecycle.js'
import { startPsrPageReader, stopPsrPageReader } from './psr-page-reader.js'

const NOW = 1_800_000_000

test('a just-ended battle queues its squadrons, an old one and an unstored one read nothing', async () => {
  const read: string[][] = []
  startPsrPageReader({
    tagsOf: (id) => (id === 'new' ? ['=AAA=', '=BBB='] : ['=OLD=']),
    endOf: (id) => (id === 'new' ? NOW - 60 : id === 'old' ? NOW - 3 * 3_600 : null),
    fetchRatings: async (tags) => { read.push(tags) },
    nowSec: () => NOW,
  })
  try {
    emitBattleLifecycle({ kind: 'committed', sessionId: 'old' })
    emitBattleLifecycle({ kind: 'committed', sessionId: 'unstored' })
    emitBattleLifecycle({ kind: 'discovered', sessionIds: ['new'], bulk: false })
    emitBattleLifecycle({ kind: 'committed', sessionId: 'new' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(read, [['=AAA=', '=BBB=']])
  } finally {
    await stopPsrPageReader()
  }
})

test('a failed read is logged and the loop keeps going; after stop nothing is read', async () => {
  let calls = 0
  startPsrPageReader({
    tagsOf: () => ['=AAA='],
    endOf: () => NOW,
    fetchRatings: async () => { calls++; throw new Error('down') },
    nowSec: () => NOW,
  })
  const warn = console.warn
  console.warn = () => undefined
  try {
    emitBattleLifecycle({ kind: 'committed', sessionId: 'a' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
  } finally {
    console.warn = warn
    await stopPsrPageReader()
  }
  emitBattleLifecycle({ kind: 'committed', sessionId: 'b' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
})
