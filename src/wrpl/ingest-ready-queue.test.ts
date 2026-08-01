import assert from 'node:assert/strict'
import test from 'node:test'
import { IngestReadyQueue } from './ingest-ready-queue.js'

test('ready queue applies high watermark and resumes at low watermark', async () => {
  const queue = new IngestReadyQueue<string>(1, 2, 1, 100, 50)
  const signal = new AbortController().signal

  assert.equal(await queue.enqueue('one', 20, signal), true)
  assert.equal(await queue.enqueue('two', 20, signal), true)
  let thirdQueued = false
  const third = queue.enqueue('three', 20, signal).then((queued) => {
    thirdQueued = queued
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(thirdQueued, false)

  assert.equal(await queue.take(signal), 'one')
  await third
  assert.equal(thirdQueued, true)
  assert.equal(await queue.take(signal), 'two')
  assert.equal(await queue.take(signal), 'three')
  queue.producerDone()
  assert.equal(await queue.take(signal), null)
})

test('ready queue aborts blocked producers and drains retained values', async () => {
  const queue = new IngestReadyQueue<string>(1, 1, 0, 10, 0)
  const controller = new AbortController()
  assert.equal(await queue.enqueue('retained', 20, controller.signal), true)

  const blocked = queue.enqueue('blocked', 1, controller.signal)
  controller.abort()
  queue.abortWaiters()

  assert.equal(await blocked, false)
  assert.deepEqual(queue.drain(), ['retained'])
  queue.producerDone()
  assert.equal(await queue.take(controller.signal), null)
})
