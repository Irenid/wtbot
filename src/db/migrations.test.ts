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
