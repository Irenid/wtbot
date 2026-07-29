import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DB_SCHEMA_VERSION,
  closeDb,
  initDb,
  saveBattle,
  savePlayerIdentity,
  searchSitePlayers,
} from './index.js'

function replayPlayer(nick: string) {
  return {
    userId: '900',
    nick,
    clanTag: '',
    team: 1,
    kills: 0,
    groundKills: 0,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 0,
    deaths: 0,
    captureZone: 0,
    damageZone: 0,
    score: 0,
    awardDamage: 0,
    teamKills: 0,
    squadId: -1,
    vehicle: null,
    vehicles: [],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

test('поиск игроков использует Unicode casefold для identity, alias и replay', () => {
  initDb(':memory:')
  try {
    savePlayerIdentity({
      wtUserId: '701',
      canonicalNick: 'ЁЖИК',
      platform: null,
      aliases: [{
        source: 'fixture',
        externalId: '701',
        nick: 'ЁЖИК',
        seenAt: 1,
        matchMethod: 'user_id',
        matchConfidence: 'high',
      }],
    })
    savePlayerIdentity({
      wtUserId: '702',
      canonicalNick: 'Canonical',
      platform: null,
      aliases: [{
        source: 'fixture',
        externalId: '702',
        nick: 'ЖАРА',
        seenAt: 1,
        matchMethod: 'exact_nick',
        matchConfidence: 'medium',
      }],
    })
    savePlayerIdentity({
      wtUserId: '703',
      canonicalNick: 'BlitzZ',
      platform: null,
    })
    saveBattle({
      sessionId: 'unicode-search-session',
      sessionHex: '0000000000000001',
      missionName: 'fixture',
      level: 'fixture',
      gameMode: null,
      battleType: null,
      environment: null,
      status: null,
      startTime: 1,
      durationSec: 0,
      endTimeMs: 0,
      teamWon: 0,
      gameVersion: null,
      missionSettings: null,
      players: [replayPlayer('ЖУКZ')],
      kills: [],
      chat: [],
      eventsBlob: Buffer.from('{}'),
    })

    const identity = searchSitePlayers('ёж')
    assert.equal(identity[0]?.wtUserId, '701')
    assert.equal(identity[0]?.origin, 'identity')

    const alias = searchSitePlayers('жар')
    assert.equal(alias[0]?.wtUserId, '702')
    assert.equal(alias[0]?.origin, 'alias')

    const replay = searchSitePlayers('жук')
    assert.equal(replay[0]?.wtUserId, '900')
    assert.equal(replay[0]?.origin, 'replay')

    const ascii = searchSitePlayers('blitz')
    assert.equal(ascii[0]?.wtUserId, '703')
    assert.equal(ascii[0]?.nick, 'BlitzZ')
  } finally {
    closeDb()
  }
})

test('initDb дозаполняет search keys в legacy SQLite schema', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-search-migration-'))
  const dbPath = path.join(root, 'legacy.db')
  const legacy = new DatabaseSync(dbPath)
  try {
    legacy.exec(`
      CREATE TABLE player_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wt_user_id TEXT,
        canonical_nick TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE player_identity_aliases (
        identity_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT,
        nick TEXT NOT NULL,
        nick_base TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        match_method TEXT NOT NULL,
        match_confidence TEXT NOT NULL,
        PRIMARY KEY (identity_id, source, external_id, nick)
      );
      CREATE TABLE battle_players (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nick TEXT NOT NULL,
        nick_base TEXT NOT NULL,
        clan_tag TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, user_id)
      );
      INSERT INTO player_identities (wt_user_id, canonical_nick) VALUES ('801', 'СтарыйЁж');
      INSERT INTO player_identity_aliases
        (identity_id, source, external_id, nick, nick_base, first_seen_at, last_seen_at, match_method, match_confidence)
        VALUES (1, 'fixture', '801', 'СтарыйЁж', 'СтарыйЁж', 1, 1, 'user_id', 'high');
      INSERT INTO battle_players (session_id, user_id, nick, nick_base)
        VALUES ('legacy', '802', 'СтарыйЖук', 'СтарыйЖук');
    `)
  } finally {
    legacy.close()
  }

  try {
    initDb(dbPath, { allowCreate: false })
    assert.equal(searchSitePlayers('старыйёж')[0]?.wtUserId, '801')
    assert.equal(searchSitePlayers('старыйжук')[0]?.wtUserId, '802')
    closeDb()

    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
      assert.equal(row.user_version, DB_SCHEMA_VERSION)
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})
