import assert from 'node:assert/strict'
import test from 'node:test'
import { mapConcurrent } from './concurrency.js'

test('mapConcurrent ограничивает параллелизм и сохраняет порядок результатов', async () => {
  let active = 0
  let peak = 0
  const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    active -= 1
    return value * 10
  })

  assert.equal(peak, 2)
  assert.deepEqual(results, [10, 20, 30, 40, 50])
})

test('mapConcurrent отклоняет некорректный предел параллелизма', async () => {
  await assert.rejects(
    mapConcurrent([1], 0, async (value) => value),
    /положительным целым/,
  )
})

test('mapConcurrent после ошибки дожидается остальных задач', async () => {
  const completed: number[] = []
  await assert.rejects(
    mapConcurrent([1, 2, 3], 2, async (value) => {
      if (value === 1) throw new Error('test failure')
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      completed.push(value)
    }),
    /test failure/,
  )
  assert.deepEqual(completed.sort(), [2, 3])
})
