import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  DB_SCHEMA_VERSION,
  closeDb,
  initDb,
  runDbMigrations,
  type DbMigration,
} from './index.js'

function userVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined
}

test('initDb ставит schema version и повторный запуск идемпотентен', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-clean-'))
  const dbPath = path.join(root, 'clean.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()

    const created = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(created), DB_SCHEMA_VERSION)
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battle_players') WHERE name = 'nick_search'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battles') WHERE name = 'air_unit_count'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battles') WHERE name = 'chat_count'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('announce_state') WHERE name = 'message_id'")
          .get() !== undefined,
        true,
      )
    } finally {
      created.close()
    }

    initDb(dbPath)
    closeDb()

    const reopened = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(reopened), DB_SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('migration runner фиксирует только полностью выполненные версии', () => {
  const database = new DatabaseSync(':memory:')
  const migrations: readonly DbMigration[] = [
    {
      version: 1,
      apply(db) {
        db.exec('CREATE TABLE stable_marker (value INTEGER NOT NULL)')
      },
    },
    {
      version: 2,
      apply(db) {
        db.exec('CREATE TABLE rolled_back_marker (value INTEGER NOT NULL)')
        throw new Error('ожидаемая ошибка migration fixture')
      },
    },
  ]
  try {
    assert.throws(() => runDbMigrations(database, migrations), /миграцию SQLite v2/)
    assert.equal(userVersion(database), 1)
    assert.equal(tableExists(database, 'stable_marker'), true)
    assert.equal(tableExists(database, 'rolled_back_marker'), false)
  } finally {
    database.close()
  }
})

test('migration runner отклоняет более новую неизвестную schema version', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA user_version = 3')
    assert.throws(
      () => runDbMigrations(database, [{ version: 1, apply() {} }]),
      /новее поддерживаемой 1/,
    )
    assert.equal(userVersion(database), 3)
  } finally {
    database.close()
  }
})

test('migration runner не проглатывает блокировку конкурентного writer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-lock-'))
  const dbPath = path.join(root, 'locked.db')
  const blocker = new DatabaseSync(dbPath)
  const contender = new DatabaseSync(dbPath)
  try {
    contender.exec('PRAGMA busy_timeout = 25')
    blocker.exec('BEGIN IMMEDIATE')
    assert.throws(
      () =>
        runDbMigrations(contender, [
          {
            version: 1,
            apply(db) {
              db.exec('CREATE TABLE must_not_exist (value INTEGER NOT NULL)')
            },
          },
        ]),
      /миграцию SQLite v1/,
    )
    assert.equal(userVersion(contender), 0)
    blocker.exec('ROLLBACK')
    assert.equal(tableExists(contender, 'must_not_exist'), false)
  } finally {
    try {
      blocker.exec('ROLLBACK')
    } catch {
      // Transaction уже завершена.
    }
    contender.close()
    blocker.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграции v6–v7 ставят в очередь бои 2.59, разобранные до исправления', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v6-'))
  const dbPath = path.join(root, 'v6.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec, game_version, kill_count)
      VALUES (?, ?, 'm', 'l', 1, 1, ?, ?)
    `)
    const ingest = database.prepare(`INSERT INTO battle_ingest (session_id, status, attempts) VALUES (?, ?, 1)`)
    battle.run('1', '01', '2.59.0.28', 0); ingest.run('1', 'ok')
    battle.run('2', '02', '2.59.0.28', 7); ingest.run('2', 'ok')
    battle.run('3', '03', '2.57.1.60', 0); ingest.run('3', 'ok')
    battle.run('4', '04', '2.59.0.28', 0); ingest.run('4', 'expired')
    database.exec('PRAGMA user_version = 5')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      // 1 и 2 (2.59, ok) — в очередь; 3 (2.57) и 4 (expired) не трогаются.
      assert.deepEqual(left, ['3', '4'])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})
