import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { closeDb, initDb, runDbMaintenance } from '../db/index.js'
import { compressEventsJson, inflateEventsBlob, isZstdEventsBlob } from '../wrpl/events-codec.js'
import { closeWorkerPool, runWorkerTask } from './pool.js'

const eventsJson = (id: number) => Buffer.from(JSON.stringify({ teamWon: id % 2, kills: Array.from({ length: 50 }, (_, i) => ({ time: i, id })) }), 'utf8')

test('фоновый перевод блобов событий в zstd идёт пачками по ключу и не трогает zstd', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-recompress-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const insert = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    insert.run('1', gzipSync(eventsJson(1)))
    insert.run('2', compressEventsJson(eventsJson(2)))
    insert.run('3', gzipSync(eventsJson(3)))
    database.close()

    const first = await runWorkerTask({ kind: 'recompress-events-blobs', input: { dbPath, afterSessionId: '', limit: 2 } })
    assert.equal(first.scanned, 2)
    assert.equal(first.converted, 1, 'zstd-блоб боя 2 не пересжимается')
    assert.equal(first.lastSessionId, '2')
    const second = await runWorkerTask({ kind: 'recompress-events-blobs', input: { dbPath, afterSessionId: '2', limit: 2 } })
    assert.deepEqual([second.scanned, second.converted, second.lastSessionId], [1, 1, '3'])
    const done = await runWorkerTask({ kind: 'recompress-events-blobs', input: { dbPath, afterSessionId: '3', limit: 2 } })
    assert.equal(done.lastSessionId, null, 'конец таблицы')

    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      for (const row of check.prepare('SELECT session_id, events_blob FROM battle_events').all() as { session_id: string; events_blob: Uint8Array }[]) {
        assert.ok(isZstdEventsBlob(row.events_blob), `бой ${row.session_id} в zstd`)
        assert.deepEqual(inflateEventsBlob(row.events_blob), eventsJson(Number(row.session_id)))
      }
    } finally {
      check.close()
    }
  } finally {
    await closeWorkerPool()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('обслуживание возвращает свободные страницы порциями при auto_vacuum = INCREMENTAL', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-maintenance-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    database.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;')
    const insert = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    for (let i = 0; i < 20; i += 1) insert.run(String(i), Buffer.alloc(64 * 1024, i))
    database.exec('DELETE FROM battle_events')
    const free = (database.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    database.close()
    assert.ok(free > 100, 'после удаления есть свободные страницы')

    initDb(dbPath)
    const firstPortion = runDbMaintenance(100)
    assert.equal(firstPortion.freedPages, 100, 'не больше порции за вызов')
    const rest = runDbMaintenance(1_000_000)
    assert.equal(rest.freedPages, free - 100)
    assert.equal(runDbMaintenance().freedPages, 0)
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})
