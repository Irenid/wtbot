import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  closeDb,
  getBattlePostSummary,
  initDb,
  saveBattle,
  type BattleInput,
} from './index.js'

function battle(
  sessionId: string,
  summary: Pick<BattleInput, 'airUnitCount' | 'chatCount'>,
): BattleInput {
  return {
    sessionId,
    sessionHex: sessionId.padStart(16, '0'),
    missionName: 'test',
    level: 'test',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime: 1,
    durationSec: 2,
    endTimeMs: 3,
    teamWon: 2,
    gameVersion: null,
    missionSettings: null,
    players: [],
    kills: [],
    chat: [],
    eventsBlob: Buffer.from('test'),
    ...summary,
  }
}

test('battle post summary persists winner, air and chat flags without reading events', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-battle-post-summary-'))
  const dbPath = path.join(root, 'summary.db')
  try {
    initDb(dbPath, { allowCreate: true })
    saveBattle(battle('1', { airUnitCount: 3, chatCount: 4 }))
    assert.deepEqual(getBattlePostSummary('1'), {
      teamWon: 2,
      airUnitCount: 3,
      chatCount: 4,
    })

    saveBattle(battle('2', {}))
    assert.deepEqual(getBattlePostSummary('2'), {
      teamWon: 2,
      airUnitCount: null,
      chatCount: 0,
    })
    assert.equal(getBattlePostSummary('missing'), null)

    closeDb()
    const reader = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const plan = reader
        .prepare(`
          EXPLAIN QUERY PLAN
          SELECT team_won, air_unit_count, chat_count
          FROM battles
          WHERE session_id = ?
        `)
        .all('1') as { detail: string }[]
      assert.ok(plan.some((row) => /\bSEARCH battles\b.*\bINDEX\b/i.test(row.detail)))
      assert.ok(plan.every((row) => !/\bSCAN battles\b/i.test(row.detail)))
    } finally {
      reader.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})
