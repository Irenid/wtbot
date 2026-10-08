import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, initDb } from '../db/index.js'
import { closeWorkerPool, runWorkerTask } from './pool.js'

test('typo-tolerant player search runs in a worker on its own connection', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-search-player-nicks-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    // Zоroaster holds a Cyrillic о; coop/Bot slots never reach the index.
    database.exec(`
      INSERT INTO battles (
        session_id, session_hex, mission_name, level, start_time, duration_sec, end_time_ms
      ) VALUES
        ('1', '0000000000000001', 'test', 'test', 1000, 60, 1060000),
        ('2', '0000000000000002', 'test', 'test', 2000, 60, 2060000);
      INSERT INTO battle_players (
        session_id, user_id, nick, nick_base, nick_search, clan_tag, team
      ) VALUES
        ('1', '101', 'Zоroaster', 'Zоroaster', 'zоroaster', '', 1),
        ('2', '101', 'Zоroaster', 'Zоroaster', 'zоroaster', '', 1),
        ('1', '102', 'coop/Bot7', 'coop/Bot7', 'coop/bot7', '', 2);
    `)
    database.close()

    const result = await runWorkerTask({
      kind: 'search-player-nicks',
      input: { dbPath, query: 'zoroastr', limit: 5 },
    }, { priority: 'interactive' })
    assert.deepEqual(result.players, [{
      identityId: null,
      wtUserId: '101',
      nick: 'Zоroaster',
      platform: null,
      origin: 'replay',
      lastSeenAt: null,
      battles: 2,
    }])
    assert.ok(result.elapsedMs >= 0)

    const bots = await runWorkerTask({ kind: 'search-player-nicks', input: { dbPath, query: 'coop', limit: 5 } })
    assert.deepEqual(bots.players, [])
  } finally {
    closeDb()
    await closeWorkerPool()
    rmSync(directory, { recursive: true, force: true })
  }
})
