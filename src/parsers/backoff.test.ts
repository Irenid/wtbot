import assert from 'node:assert/strict'
import test from 'node:test'
import { parserBackoffMs } from './index.js'

test('backoff parser растёт экспоненциально и ограничен 30 минутами', () => {
  assert.equal(parserBackoffMs(20_000, 0), 20_000)
  assert.equal(parserBackoffMs(20_000, 1), 20_000)
  assert.equal(parserBackoffMs(20_000, 2), 40_000)
  assert.equal(parserBackoffMs(20_000, 4), 160_000)
  assert.equal(parserBackoffMs(20_000, 20), 30 * 60_000)
})
