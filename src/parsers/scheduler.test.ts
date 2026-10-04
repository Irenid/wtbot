import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { closeDb, getLatestItems, getParseHistory, initDb } from '../db/index.js'
import { runParserNow, startParsers, stopParsers } from './index.js'
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
    await stopParsers()
    const stoppedAt = attempts
    await delay(40)
    assert.equal(maxActive, 1)
    assert.equal(attempts, stoppedAt)
  } finally {
    await stopParsers()
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
  void stopParsers()
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function pendingSource(name: string): {
  source: ParserSource
  started: () => boolean
  signal: () => AbortSignal | null
  finish: () => void
} {
  const gate = deferred<void>()
  let startedRuns = 0
  let lastSignal: AbortSignal | null = null
  return {
    source: {
      name,
      intervalMs: 60_000,
      async run(signal) {
        const runNumber = ++startedRuns
        lastSignal = signal
        // Ждёт только первый запуск; следующие завершаются сразу.
        if (runNumber === 1) await gate.promise
        return {
          summary: `запуск ${runNumber}`,
          items: [{ externalId: `${name}-run${runNumber}`, title: 'late', data: {} }],
        }
      },
    },
    started: () => startedRuns > 0,
    signal: () => lastSignal,
    finish: () => gate.resolve(),
  }
}

test('stopParsers дожидается активного запуска и не сохраняет его результат', async () => {
  initDb(':memory:')
  const fixture = pendingSource('drain-test')
  try {
    startParsers([fixture.source])
    await waitFor(fixture.started)
    let drained = false
    const stopped = stopParsers().then(() => { drained = true })
    assert.equal(fixture.signal()?.aborted, true)
    await delay(20)
    assert.equal(drained, false, 'stop не должен завершаться раньше активного запуска')
    fixture.finish()
    await stopped
    assert.equal(drained, true)
    assert.equal(getLatestItems(10, 'drain-test').length, 0, 'результат после stop не сохраняется')
    assert.equal(getParseHistory('drain-test').length, 0)
  } finally {
    await stopParsers()
    closeDb()
  }
})

test('запуск, завершившийся после stop и закрытия БД, не обращается к SQLite', async () => {
  initDb(':memory:')
  const fixture = pendingSource('closed-db-test')
  const rejections: unknown[] = []
  const errors: unknown[][] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  const originalError = console.error
  process.on('unhandledRejection', onRejection)
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    startParsers([fixture.source])
    await waitFor(fixture.started)
    const stopped = stopParsers()
    closeDb()
    fixture.finish()
    await stopped
    await delay(10)
    assert.deepEqual(rejections, [])
    // Раньше поздний результат шёл в saveItems/recordParseResult и падал на
    // «БД не инициализирована».
    assert.deepEqual(errors, [])
  } finally {
    console.error = originalError
    process.off('unhandledRejection', onRejection)
    await stopParsers()
  }
})

test('перезапуск планировщика не сохраняет результат запуска прошлого поколения', async () => {
  initDb(':memory:')
  const fixture = pendingSource('restart-test')
  try {
    startParsers([fixture.source])
    await waitFor(fixture.started)
    startParsers([fixture.source])
    fixture.finish()
    await waitFor(() => getLatestItems(10, 'restart-test').length > 0)
    // Сохранён только запуск нового поколения; поздний результат старого — нет.
    assert.deepEqual(
      getLatestItems(10, 'restart-test').map((item) => item.externalId),
      ['restart-test-run2'],
    )
  } finally {
    await stopParsers()
    closeDb()
  }
})

test('runParserNow runs a source outside its interval, after an active run and never beside it', async () => {
  initDb(':memory:')
  const gate = deferred<void>()
  let runs = 0
  let active = 0
  let maxActive = 0
  let failNext = false
  const source: ParserSource = {
    name: 'run-now-test',
    intervalMs: 60_000,
    async run() {
      runs++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (runs === 1) await gate.promise
        if (failNext) throw new Error('expected fixture failure')
        return { summary: `run ${runs}` }
      } finally {
        active--
      }
    },
  }
  const originalError = console.error
  console.error = () => undefined

  try {
    startParsers([source])
    await waitFor(() => runs === 1)
    // Two callers during the scheduled run share one extra run after it.
    const first = runParserNow('run-now-test')
    const second = runParserNow('run-now-test')
    await delay(10)
    assert.equal(runs, 1)
    gate.resolve()
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(runs, 2)
    // An idle source runs at once instead of after its 60 s interval.
    assert.equal(await runParserNow('run-now-test'), true)
    assert.equal(runs, 3)
    failNext = true
    assert.equal(await runParserNow('run-now-test'), false)
    assert.equal(getParseHistory('run-now-test')[0]?.ok, false)
    assert.equal(maxActive, 1)
    assert.equal(await runParserNow('unknown-source'), false)
    await stopParsers()
    assert.equal(await runParserNow('run-now-test'), false)
    assert.equal(runs, 4)
  } finally {
    console.error = originalError
    await stopParsers()
    closeDb()
  }
})
