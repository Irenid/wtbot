import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { closeDb, initDb, type BattleInput } from '../db/index.js'
import { closeWorkerPool, runWorkerTask, transferableBuffer } from './pool.js'

test('persist-ingested-battle writes battle and ingest state outside the main connection', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-persist-battle-'))
  const dbPath = path.join(directory, 'wtbot.db')
  let poolClosed = false

  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()

    const compressed = gzipSync(Buffer.from('{"events":[]}'))
    const expectedBlob = Buffer.from(compressed)
    const eventsBlob = transferableBuffer(compressed)
    const battle: Omit<BattleInput, 'eventsBlob'> & { eventsBlob: ArrayBuffer } = {
      sessionId: 'worker-persist-session',
      sessionHex: '0000000000000001',
      missionName: 'Worker persist test',
      level: 'levels/test.bin',
      gameMode: 'realistic',
      battleType: 'Domination',
      environment: 'day',
      status: 'ok',
      startTime: 1_700_000_000,
      durationSec: 60,
      endTimeMs: 60_000,
      teamWon: 1,
      gameVersion: 'test',
      missionSettings: null,
      players: [],
      kills: [],
      chat: [],
      eventsBlob,
    }

    const timing = await runWorkerTask(
      {
        kind: 'persist-ingested-battle',
        input: { dbPath, sessionId: battle.sessionId, battle },
      },
      { priority: 'normal', transferList: [eventsBlob] },
    )
    assert.ok(timing.sqliteMs >= 0)
    assert.ok(timing.transactionMs >= 0)
    assert.ok(timing.checkpointMs >= 0)
    assert.equal(timing.checkpointed, false)
    assert.ok(timing.committedAtMs > 0)

    const checkpoint = await runWorkerTask(
      {
        kind: 'checkpoint-ingest-database',
        input: { dbPath },
      },
      { priority: 'normal' },
    )
    assert.ok(checkpoint.checkpointMs >= 0)

    await closeWorkerPool()
    poolClosed = true

    const database = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const stored = database
        .prepare('SELECT mission_name, events_blob FROM battles WHERE session_id = ?')
        .get(battle.sessionId) as { mission_name: string; events_blob: Uint8Array } | undefined
      assert.equal(stored?.mission_name, battle.missionName)
      assert.deepEqual(Buffer.from(stored?.events_blob ?? []), expectedBlob)

      const ingest = database
        .prepare('SELECT status, attempts FROM battle_ingest WHERE session_id = ?')
        .get(battle.sessionId) as { status: string; attempts: number } | undefined
      assert.equal(ingest?.status, 'ok')
      assert.equal(ingest?.attempts, 1)
    } finally {
      database.close()
    }
  } finally {
    closeDb()
    if (!poolClosed) await closeWorkerPool()
    rmSync(directory, { recursive: true, force: true })
  }
})
