import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { gzipSync } from 'node:zlib'
import { closeDb, initDb } from '../db/index.js'
import { compressEventsJson, encodeEventsJson, inflateEventsBlob, isColumnarEventsBlob, isZstdEventsBlob } from '../wrpl/events-codec.js'
import { closeWorkerPool, runWorkerTask } from './pool.js'

/** JSON событий с траекторией (id чётный) или без неё (нечётный). */
const eventsJson = (id: number) => JSON.stringify({
  teamWon: id % 2,
  kills: Array.from({ length: 50 }, (_, i) => ({ time: i, id })),
  units: id % 2 === 0
    ? [{ userId: String(id), model: 'm', path: Array.from({ length: 400 }, (_, i) => ({ t: i * 250, x: id + i, y: 7, z: -i * 2 })) }]
    : [],
})

// Пул общий для обоих тестов файла: после closeWorkerPool он не перезапускается.
after(async () => {
  await closeWorkerPool()
})

function pragma(database: DatabaseSync, name: string): number {
  return Number(Object.values(database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0])
}

test('фоновый перевод блобов: колоночный формат пачками по ключу, без потерь и с возвратом места', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-recompress-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    assert.equal(pragma(database, 'auto_vacuum'), 2, 'новая база сразу с auto_vacuum = INCREMENTAL')
    const insert = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    insert.run('1', gzipSync(Buffer.from(eventsJson(1))))
    insert.run('2', compressEventsJson(Buffer.from(eventsJson(2))))
    insert.run('3', compressEventsJson(Buffer.from(eventsJson(3))))
    insert.run('4', encodeEventsJson(eventsJson(4)))
    insert.run('6', gzipSync(Buffer.from(eventsJson(6))))
    database.close()
    const input = (afterSessionId: string) => ({ dbPath, afterSessionId, limit: 2, vacuumPages: 4_096 })

    const first = await runWorkerTask({ kind: 'recompress-events-blobs', input: input('') })
    assert.deepEqual(
      [first.scanned, first.converted, first.kept, first.lastSessionId],
      [2, 2, 0, '2'],
      'gzip без траекторий → zstd-JSON, zstd-JSON с траекторией → колонки',
    )
    assert.ok(first.bytesAfter < first.bytesBefore)
    const second = await runWorkerTask({ kind: 'recompress-events-blobs', input: input('2') })
    assert.deepEqual(
      [second.scanned, second.converted, second.kept, second.lastSessionId],
      [2, 0, 1, '4'],
      'zstd-JSON без траекторий остаётся, колоночный не трогается',
    )
    const third = await runWorkerTask({ kind: 'recompress-events-blobs', input: input('4') })
    assert.deepEqual([third.scanned, third.converted, third.lastSessionId], [1, 1, '6'])
    const done = await runWorkerTask({ kind: 'recompress-events-blobs', input: input('6') })
    assert.equal(done.lastSessionId, null, 'конец таблицы')

    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      for (const row of check.prepare('SELECT session_id, events_blob FROM battle_events').all() as { session_id: string; events_blob: Uint8Array }[]) {
        const id = Number(row.session_id)
        if (id % 2 === 0) assert.ok(isColumnarEventsBlob(row.events_blob), `бой ${id} в колоночном формате`)
        else assert.ok(isZstdEventsBlob(row.events_blob), `бой ${id} в zstd-JSON`)
        assert.equal(inflateEventsBlob(row.events_blob).toString('utf8'), eventsJson(id), `бой ${id} без потерь`)
      }
    } finally {
      check.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('обслуживание в worker возвращает свободные страницы порциями и обновляет статистику', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-maintenance-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const insert = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    for (let i = 0; i < 20; i += 1) insert.run(String(i), Buffer.alloc(64 * 1024, i))
    database.exec('DELETE FROM battle_events')
    // Устаревшая статистика: ANALYZE на 20 строках, затем рост в 1000 раз.
    database.exec('CREATE TABLE stale (a INTEGER); CREATE INDEX stale_a ON stale (a);')
    const stale = database.prepare('INSERT INTO stale (a) VALUES (?)')
    for (let i = 0; i < 20; i += 1) stale.run(i)
    database.exec('ANALYZE stale')
    database.exec('BEGIN')
    for (let i = 0; i < 20_000; i += 1) stale.run(i)
    database.exec('COMMIT')
    const free = pragma(database, 'freelist_count')
    database.close()
    assert.ok(free > 100, 'после удаления есть свободные страницы')

    const task = (maxPages: number, optimize: boolean) =>
      runWorkerTask({ kind: 'db-maintenance', input: { dbPath, maxPages, optimize } })
    const firstPortion = await task(100, true)
    assert.equal(firstPortion.freedPages, 100, 'не больше порции за вызов')
    // ANALYZE мог занять страницу из свободных — остаток не строго free - 100.
    assert.ok(firstPortion.freelistPages > 0 && firstPortion.freelistPages <= free - 100)
    assert.ok(firstPortion.analyzed.includes('stale'), `свежее подключение видит устаревшую статистику: ${firstPortion.analyzed.join(', ')}`)
    const rest = await task(1_000_000, false)
    assert.deepEqual([rest.freedPages, rest.freelistPages, rest.analyzed], [firstPortion.freelistPages, 0, []])
    assert.equal((await task(1_000, true)).freedPages, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
