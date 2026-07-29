import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { closeDb, initDb } from '../db/index.js'
import { startParsers, stopParsers } from './index.js'
import type { ParserSource } from './types.js'

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Таймаут ожидания parser scheduler')
    await delay(5)
  }
}

test('parser scheduler не накладывает запуски и останавливает timers', async () => {
  initDb(':memory:')
  let attempts = 0
  let active = 0
  let maxActive = 0
  const source: ParserSource = {
    name: 'scheduler-test',
    intervalMs: 5,
    async run() {
      attempts++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        await delay(10)
        if (attempts <= 2) throw new Error('ожидаемая ошибка fixture')
        return { summary: `попытка ${attempts}` }
      } finally {
        active--
      }
    },
  }

  try {
    startParsers([source])
    await waitFor(() => attempts >= 4)
    stopParsers()
    const stoppedAt = attempts
    await delay(40)
    assert.equal(maxActive, 1)
    assert.equal(attempts, stoppedAt)
  } finally {
    stopParsers()
    closeDb()
  }
})

test('parser scheduler отвергает duplicate source и некорректный interval', () => {
  const source: ParserSource = {
    name: 'duplicate',
    intervalMs: 100,
    async run() {
      return { summary: 'ok' }
    },
  }
  assert.throws(() => startParsers([source, source]), /Повторяющееся имя/)
  assert.throws(
    () => startParsers([{ ...source, name: 'invalid', intervalMs: 0 }]),
    /Некорректный interval/,
  )
  stopParsers()
})
