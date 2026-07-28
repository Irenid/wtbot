import assert from 'node:assert/strict'
import test from 'node:test'

process.env['TOKEN'] ??= 'test-token'

const { retryAfterWtSessionRefresh } = await import('./wt-request.js')

test('повторяет запрос один раз после успешного обновления WT-сессии', async () => {
  let requests = 0
  let refreshes = 0

  const result = await retryAfterWtSessionRefresh(
    async () => ({ empty: requests++ === 0 }),
    (response) => response.empty,
    'пустой Replay API',
    async () => {
      refreshes += 1
      return true
    },
  )

  assert.deepEqual(result, { empty: false })
  assert.equal(requests, 2)
  assert.equal(refreshes, 1)
})

test('не обновляет сессию для нормального ответа', async () => {
  let refreshes = 0

  const result = await retryAfterWtSessionRefresh(
    async () => ({ empty: false }),
    (response) => response.empty,
    'пустой Replay API',
    async () => {
      refreshes += 1
      return true
    },
  )

  assert.deepEqual(result, { empty: false })
  assert.equal(refreshes, 0)
})

test('не повторяет запрос, если Edge не смог обновить сессию', async () => {
  let requests = 0

  const result = await retryAfterWtSessionRefresh(
    async () => {
      requests += 1
      return { empty: true }
    },
    (response) => response.empty,
    'пустой Replay API',
    async () => false,
  )

  assert.deepEqual(result, { empty: true })
  assert.equal(requests, 1)
})
