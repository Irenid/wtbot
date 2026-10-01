import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PART_UPLOAD_GRACE_MS,
  ReplayPartWaitList,
  hasFinalReplayResults,
  shouldContinueIngestImmediately,
} from './ingest-scheduler.js'

const MINUTE = 60_000

test('ingest scheduler drains immediately only after a full batch made progress', () => {
  assert.equal(shouldContinueIngestImmediately(7, 14, ['ok'], false), false)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['ok', 'expired'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['error'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['deferred', 'cancelled'], false), false)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['deferred', 'ok'], false), true)
  assert.equal(shouldContinueIngestImmediately(14, 14, ['ok'], true), false)
})

test('404 части свежего боя откладывает повтор с растущей паузой, не дольше окна выкладки', () => {
  const waitList = new ReplayPartWaitList()
  const endMs = 1_000 * MINUTE
  const seenMs = endMs + 20_000
  let now = seenMs + 5_000

  assert.equal(waitList.defer('fresh', endMs, seenMs, now), MINUTE)
  assert.equal(waitList.isWaiting('fresh', now), true)
  assert.equal(waitList.waitingCount(now), 1)
  now += MINUTE
  assert.equal(waitList.isWaiting('fresh', now), false, 'после паузы бой снова берётся в работу')
  assert.equal(waitList.waitingCount(now), 0)
  assert.equal(waitList.defer('fresh', endMs, seenMs, now), 2 * MINUTE)
  now += 2 * MINUTE
  assert.equal(waitList.defer('fresh', endMs, seenMs, now), 3 * MINUTE)
  now += 3 * MINUTE
  assert.equal(waitList.defer('fresh', endMs, seenMs, now), 3 * MINUTE, 'пауза не растёт дальше трёх минут')

  assert.equal(waitList.defer('fresh', endMs, seenMs, endMs + PART_UPLOAD_GRACE_MS), null)
  assert.equal(waitList.isWaiting('fresh', endMs + PART_UPLOAD_GRACE_MS), false)
})

test('404 части старого боя — части ушли с CDN, ожидания нет', () => {
  const waitList = new ReplayPartWaitList()
  const now = 10_000 * MINUTE
  // Бой из бэклога: закончился три часа назад, бот увидел его только сейчас.
  assert.equal(waitList.defer('backlog', now - 180 * MINUTE, now - 1_000, now), null)
  // Конец боя неизвестен или позже показа — окно считается от первого показа.
  assert.equal(waitList.defer('no-end', null, now - 2 * PART_UPLOAD_GRACE_MS, now), null)
  assert.equal(waitList.defer('future-end', now + 600 * MINUTE, now - 2 * PART_UPLOAD_GRACE_MS, now), null)
  assert.equal(waitList.defer('future-end-fresh', now + 600 * MINUTE, now - MINUTE, now), MINUTE)
})

test('ожидающие бои с прошедшим окном выкладки удаляются из списка', () => {
  const waitList = new ReplayPartWaitList()
  const now = 10_000 * MINUTE
  waitList.defer('a', now - 59 * MINUTE, now - 59 * MINUTE, now)
  waitList.defer('b', now, now, now)
  assert.equal(waitList.waitingCount(now), 2)
  assert.equal(waitList.waitingCount(now + 30_000), 2)
  // Окно «a» закончилось: запись удаляется, повтор после неё — уже expired.
  assert.equal(waitList.waitingCount(now + 61_000), 0)
  assert.equal(waitList.defer('a', now - 59 * MINUTE, now - 59 * MINUTE, now + 61_000), null)
  assert.equal(waitList.defer('b', now, now, now + 61_000), 2 * MINUTE, 'у «b» счёт повторов сохранился')
})

test('итоги без статуса финальные, только если их время не меньше длительности по записи сайта', () => {
  assert.equal(hasFinalReplayResults({ status: 'success', timePlayed: 95 }, 600), true)
  // Промежуточные итоги из части 0001 устаревшей записи.
  assert.equal(hasFinalReplayResults({ status: '', timePlayed: 95 }, 617), false)
  // Бой без исхода по времени: финальные итоги без статуса.
  assert.equal(hasFinalReplayResults({ status: '', timePlayed: 1_513 }, 1_509), true)
  assert.equal(hasFinalReplayResults({ status: '', timePlayed: 1_500 }, 1_509), true)
  assert.equal(hasFinalReplayResults({ status: '', timePlayed: 1_513 }, null), false)
})
