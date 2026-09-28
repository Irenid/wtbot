import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BACKUP_LOCK_FILE, createSqliteBackup } from './db-backup.js'

function createFixture(root: string): string {
  const sourcePath = path.join(root, 'source.db')
  const db = new DatabaseSync(sourcePath)
  try {
    db.exec("CREATE TABLE smoke (value TEXT NOT NULL); INSERT INTO smoke VALUES ('ok');")
  } finally {
    db.close()
  }
  return sourcePath
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

test('SQLite backup проверяет копию и ротирует старые файлы', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-db-backup-'))
  try {
    const sourcePath = createFixture(root)
    const outputDir = path.join(root, 'backups')
    const availableBytes = () => 1024n * 1024n * 1024n
    createSqliteBackup({
      sourcePath,
      outputDir,
      keep: 2,
      now: new Date('2026-01-01T00:00:00Z'),
      availableBytes,
    })
    createSqliteBackup({
      sourcePath,
      outputDir,
      keep: 2,
      now: new Date('2026-01-02T00:00:00Z'),
      availableBytes,
    })
    const latestPath = createSqliteBackup({
      sourcePath,
      outputDir,
      keep: 2,
      now: new Date('2026-01-03T00:00:00Z'),
      availableBytes,
    })

    assert.deepEqual(
      readdirSync(outputDir).filter((name) => name.endsWith('.db')).sort(),
      ['wtbot-20260102T000000Z.db', 'wtbot-20260103T000000Z.db'],
    )
    const backup = new DatabaseSync(latestPath, { readOnly: true })
    try {
      const row = backup.prepare('SELECT value FROM smoke').get() as { value: string }
      assert.equal(row.value, 'ok')
    } finally {
      backup.close()
    }
    assert.equal(readdirSync(outputDir).includes(BACKUP_LOCK_FILE), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SQLite backup отклоняет нехватку места и параллельный lock', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-db-backup-'))
  try {
    const sourcePath = createFixture(root)
    const outputDir = path.join(root, 'backups')
    assert.throws(
      () => createSqliteBackup({ sourcePath, outputDir, availableBytes: () => 0n }),
      /Недостаточно свободного места/,
    )
    assert.deepEqual(readdirSync(outputDir), [])

    mkdirSync(outputDir, { recursive: true })
    writeFileSync(path.join(outputDir, BACKUP_LOCK_FILE), '{"pid":1}', 'utf8')
    assert.throws(
      () => createSqliteBackup({ sourcePath, outputDir, availableBytes: () => 1024n ** 3n }),
      /уже выполняется/,
    )
    assert.equal(readdirSync(outputDir).includes(BACKUP_LOCK_FILE), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SQLite backup при совпадении имени не удаляет и не меняет прошлую копию', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-db-backup-'))
  try {
    const sourcePath = createFixture(root)
    const outputDir = path.join(root, 'backups')
    const availableBytes = () => 1024n ** 3n
    const now = new Date('2026-01-01T00:00:00Z')
    const existingPath = createSqliteBackup({ sourcePath, outputDir, now, availableBytes })
    const hashBefore = sha256(existingPath)

    assert.throws(
      () => createSqliteBackup({ sourcePath, outputDir, now, availableBytes }),
      /уже существует/,
    )
    assert.equal(sha256(existingPath), hashBefore)
    // Ни временной копии, ни lock после отказа.
    assert.deepEqual(readdirSync(outputDir), [path.basename(existingPath)])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SQLite backup убирает остатки прерванных запусков и публикует только итоговый файл', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-db-backup-'))
  try {
    const sourcePath = createFixture(root)
    const outputDir = path.join(root, 'backups')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(path.join(outputDir, '.wtbot-backup-20250101T000000Z-crashed.tmp'), 'partial', 'utf8')
    const backupPath = createSqliteBackup({
      sourcePath,
      outputDir,
      now: new Date('2026-01-05T00:00:00Z'),
      availableBytes: () => 1024n ** 3n,
    })
    assert.deepEqual(readdirSync(outputDir), ['wtbot-20260105T000000Z.db'])
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    try {
      const row = backup.prepare('PRAGMA quick_check').get() as { quick_check: string }
      assert.equal(row.quick_check, 'ok')
    } finally {
      backup.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
