import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
    const database = new DatabaseSync(dbPath)
    database.exec(`
      INSERT INTO battles (
        session_id, session_hex, mission_name, level, start_time, duration_sec, end_time_ms
      ) VALUES ('1', '0000000000000001', 'test', 'test', 1000, 60, 1060000);
      INSERT INTO battle_players (
        session_id, user_id, nick, nick_base, clan_tag, team
      ) VALUES
        ('1', '101', 'PilotOne', 'PilotOne', '=ONE=', 1),
        ('1', '102', 'PilotTwo', 'PilotTwo', '=TWO=', 2);
      INSERT INTO clan_rating_snapshots (clan_tag, nick, nick_base, rating, seen_at)
      VALUES
        ('=ONE=', 'PilotOne', 'PilotOne', 1000, 900),
        ('-ONE-', 'PilotOne', 'PilotOne', 1010, 950),
        ('=TWO=', 'PilotTwo', 'PilotTwo', 900, 950);
    `)
    database.close()

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

    const stats = await runWorkerTask({
      kind: 'read-site-dashboard-stats',
      input: { dbPath, sinceTs: 900 },
    })
    assert.equal(stats.players, 2)
    assert.equal(stats.battlesTotal, 1)
    assert.equal(stats.battlesRecent, 1)
    assert.equal(stats.lastBattleAt, 1000)
    assert.deepEqual(stats.byDay, [{ day: '1970-01-01', battles: 1 }])
    assert.ok(stats.elapsedMs >= 0)

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
