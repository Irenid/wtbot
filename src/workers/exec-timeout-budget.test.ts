import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecTimeoutBudget } from './exec-timeout-budget.js'

test('после limit таймаутов подряд задача считается обычной ошибкой', () => {
  const budget = new ExecTimeoutBudget(3)
  assert.equal(budget.register('battle-1'), false)
  assert.equal(budget.register('battle-1'), false)
  assert.equal(budget.count('battle-1'), 2)
  assert.equal(budget.register('battle-1'), true)
  // Счётчик сброшен: следующая попытка снова получает полный бюджет.
  assert.equal(budget.count('battle-1'), 0)
  assert.equal(budget.register('battle-1'), false)
})

test('успех сбрасывает серию, ключи независимы и не копятся бесконечно', () => {
  const budget = new ExecTimeoutBudget(2, 2)
  assert.equal(budget.register('a'), false)
  budget.clear('a')
  assert.equal(budget.register('a'), false)
  assert.equal(budget.register('b'), false)
  assert.equal(budget.register('c'), false)
  // maxKeys = 2: самый старый ключ вытеснен.
  assert.equal(budget.count('a'), 0)
  assert.equal(budget.count('b'), 1)
  assert.equal(budget.count('c'), 1)
  assert.throws(() => new ExecTimeoutBudget(0), /положительным/)
})
