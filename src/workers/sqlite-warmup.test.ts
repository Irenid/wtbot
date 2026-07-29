import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, initDb } from '../db/index.js'
import { closeWorkerPool, runWorkerTask } from './pool.js'

test('SQLite table warmup runs in a worker and rejects mutating SQL', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-sqlite-warmup-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()

    const result = await runWorkerTask({
      kind: 'warm-sqlite',
      input: {
        dbPath,
        statements: [
          'SELECT MAX(score) FROM battle_players',
          'SELECT MAX(duration_sec) FROM battles',
        ],
      },
    })
    assert.equal(result.statements, 2)
    assert.ok(result.elapsedMs >= 0)

    await assert.rejects(
      runWorkerTask({
        kind: 'warm-sqlite',
        input: { dbPath, statements: ['DELETE FROM battles'] },
      }),
      /разрешает только SELECT/,
    )
  } finally {
    closeDb()
    await closeWorkerPool()
    rmSync(directory, { recursive: true, force: true })
  }
})
