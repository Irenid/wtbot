import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { closeDb, initDb } from '../db/index.js'
import { closeWorkerPool, runWorkerTask } from '../workers/pool.js'
import { RANK_TIER_LATEST, RANK_TIER_PSR, buildClanSnapshot, findClanGroup, type ClanSnapshot } from './clan-snapshot.js'

/** The parts that depend on the clock, not on the data. */
function comparable(snapshot: ClanSnapshot): ClanSnapshot {
  return { ...snapshot, builtAt: 0, baselineAt: 0, live: snapshot.live && { ...snapshot.live, at: 0 } }
}

test('the worker builds the same squadron snapshot as the main thread, references and all', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-clan-snapshot-'))
  const dbPath = path.join(directory, 'wtbot.db')
  const nowSec = Math.floor(Date.now() / 1_000)
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const clan = database.prepare(`
      INSERT INTO clans (tag, name, rating, position, members, battles, wins, rating_at, clan_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    clan.run('=ONE=', 'Squadron One', 2_400, 1, 3, 60, 40, nowSec - 120, 101)
    clan.run('-TWO-', 'Squadron Two', 1_900, 2, 2, 45, 20, nowSec - 120, 102)
    const snapshot = database.prepare(`
      INSERT INTO clan_rating_snapshots (clan_tag, nick, nick_base, rating, seen_at) VALUES (?, ?, ?, ?, ?)
    `)
    snapshot.run('=ONE=', 'Alpha', 'Alpha', 1_600, nowSec - 600)
    snapshot.run('=ONE=', 'Bravo', 'Bravo', 1_200, nowSec - 500)
    snapshot.run('=ONE=', 'Gone', 'Gone', 900, nowSec - 400)
    snapshot.run('-TWO-', 'Delta', 'Delta', 1_400, nowSec - 300)
    // A squadron without leaderboard data: rated by its members' PSR.
    snapshot.run('^PSR^', 'Echo', 'Echo', 700, nowSec - 200)
    const roster = database.prepare('INSERT INTO clan_roster (clan_core, nick, last_present_at) VALUES (?, ?, ?)')
    roster.run('one', 'Alpha', nowSec - 60)
    roster.run('one', 'Bravo', nowSec - 60)
    database.close()

    initDb(dbPath)
    const onMain = buildClanSnapshot()
    closeDb()
    const { snapshot: inWorker, elapsedMs } = await runWorkerTask({ kind: 'build-clan-snapshot', input: { dbPath } })
    assert.ok(elapsedMs >= 0)

    assert.deepEqual(comparable(inWorker), comparable(onMain))
    assert.deepEqual(inWorker.ranked.map((group) => [group.coreTag, group.rankTier]), [
      ['one', RANK_TIER_LATEST],
      ['two', RANK_TIER_LATEST],
      ['psr', RANK_TIER_PSR],
    ])
    // The roster leaves out the member who left (the latest seen first); the official rating rates the squadron.
    const one = findClanGroup(inWorker, 'one')
    assert.deepEqual(one?.members.map((member) => member.nick), ['Bravo', 'Alpha'])
    assert.equal(one?.totalRating, 2_400)
    // Structured clone keeps one object per squadron across the maps and lists.
    for (const row of inWorker.rows) {
      assert.equal(row.group, inWorker.groups.get(row.coreTag))
      assert.equal(row, inWorker.rowByCore.get(row.coreTag))
    }
    assert.equal(inWorker.ranked[0], inWorker.groups.get('one'))
  } finally {
    closeDb()
    await closeWorkerPool()
    rmSync(directory, { recursive: true, force: true })
  }
})
