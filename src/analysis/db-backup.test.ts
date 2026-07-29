import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
