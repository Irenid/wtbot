import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DB_SCHEMA_VERSION, closeDb, initDb } from './index.js'

test('initDb не создаёт новую БД без явного разрешения', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-db-startup-'))
  const dbPath = path.join(directory, 'missing.db')
  try {
    assert.throws(() => initDb(dbPath), /WTBOT_ALLOW_NEW_DB=1/)
    initDb(dbPath, { allowCreate: true })
    closeDb()
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('initDb отклоняет неизвестную более новую schema без изменения файла', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-db-newer-'))
  const dbPath = path.join(directory, 'newer.db')
  const newer = new DatabaseSync(dbPath)
  try {
    newer.exec(`
      PRAGMA user_version = ${DB_SCHEMA_VERSION + 1};
      CREATE TABLE sentinel (value TEXT NOT NULL);
      INSERT INTO sentinel VALUES ('untouched');
    `)
  } finally {
    newer.close()
  }

  try {
    assert.throws(() => initDb(dbPath), /новее поддерживаемой/)
    const inspected = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(
        (inspected.prepare('SELECT value FROM sentinel').get() as { value: string }).value,
        'untouched',
      )
      assert.equal(
        inspected
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'command_usage'")
          .get(),
        undefined,
      )
    } finally {
      inspected.close()
    }
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})
