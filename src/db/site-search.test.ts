import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DB_SCHEMA_VERSION,
  closeDb,
  findKnownPlayerMatches,
  findSimilarSitePlayers,
  getPlayerReplayStats,
  getSiteReplayUserIdsByNick,
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

    // Точный lookup статистики игрока: тот же casefold (COLLATE NOCASE не
    // понимал кириллицу) и индексы вместо скана battle_players.
    const known = (player: string) => findKnownPlayerMatches(player).map((match) => [match.origin, match.wtUserId])
    assert.deepEqual(known('ёжик').filter(([origin]) => origin === 'identity'), [['identity', '701']])
    assert.deepEqual(known('жара').filter(([origin]) => origin === 'alias'), [['alias', '702']])
    assert.deepEqual(known('жукz'), [['replay', '900']])
    assert.deepEqual(known('900'), [['replay', '900']])
  } finally {
    closeDb()
  }
})

test('player search forgives typos, look-alikes, leet, transliteration and the keyboard layout', () => {
  initDb(':memory:')
  try {
    const slot = (userId: string, nick: string) => ({ ...replayPlayer(nick), userId })
    const battle = (sessionId: string, players: ReturnType<typeof slot>[]) => ({
      sessionId,
      sessionHex: sessionId.padStart(16, '0'),
      missionName: 'fixture',
      level: 'fixture',
      gameMode: null,
      battleType: null,
      environment: null,
      status: null,
      startTime: 1,
      durationSec: 600,
      endTimeMs: 600_000,
      teamWon: 1,
      gameVersion: null,
      missionSettings: null,
      players,
      kills: [],
      chat: [],
      eventsBlob: Buffer.from('{}'),
    })
    // Zоroaster holds a Cyrillic о.
    saveBattle(battle('1', [slot('901', 'Zоroaster'), slot('902', 'Pilot_2008'), slot('903', 'PilotOne'), slot('904', 'Pilot_Ace')]))
    saveBattle(battle('2', [slot('904', 'Pilot_Ace')]))
    saveBattle(battle('3', [slot('906', 'Ветерок'), slot('907', 'AKYJIA_N3_NKEN'), slot('908', 'Vad1m')]))
    savePlayerIdentity({ wtUserId: '905', canonicalNick: 'Vovanzmej', platform: null })

    const search = (query: string) => searchSitePlayers(query, 20, findSimilarSitePlayers(query, 20))
      .map((entry) => `${entry.nick}/${entry.origin}`)
    assert.deepEqual(searchSitePlayers('zoroaster'), [])
    assert.deepEqual(search('zoroaster'), ['Zоroaster/replay'])
    assert.deepEqual(search('zoroastr'), ['Zоroaster/replay'])
    assert.deepEqual(search('ящкщфыеук'), ['Zоroaster/replay'])
    // Equal matches: the most battles first.
    assert.deepEqual(search('pilto'), ['Pilot_Ace/replay', 'Pilot_2008/replay', 'PilotOne/replay'])
    // Exact before a prefix before two edits.
    assert.deepEqual(search('pilotone'), ['PilotOne/replay', 'Pilot_Ace/replay'])
    assert.deepEqual(search('pilot'), ['Pilot_Ace/replay', 'Pilot_2008/replay', 'PilotOne/replay'])
    assert.deepEqual(search('vovanzmje'), ['Vovanzmej/identity'])
    // By sound, as a Russian reads it, a letter for a digit.
    assert.deepEqual(search('veterok'), ['Ветерок/replay'])
    assert.deepEqual(search('акула'), ['AKYJIA_N3_NKEN/replay'])
    assert.deepEqual(search('vadim'), ['Vad1m/replay'])
    assert.equal(searchSitePlayers('905', 20, findSimilarSitePlayers('905', 20))[0]?.wtUserId, '905')
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

test('слот coop/Bot с настоящим userId не входит в статистику, ник и поиск игрока', () => {
  initDb(':memory:')
  try {
    const battle = (sessionId: string, startTime: number, nick: string) => ({
      sessionId,
      sessionHex: sessionId.padStart(16, '0'),
      missionName: 'fixture',
      level: 'fixture',
      gameMode: null,
      battleType: null,
      environment: null,
      status: null,
      startTime,
      durationSec: 600,
      endTimeMs: 600_000,
      teamWon: 1,
      gameVersion: null,
      missionSettings: null,
      players: [{ ...replayPlayer(nick), userId: '555' }],
      kills: [],
      chat: [],
      eventsBlob: Buffer.from('{}'),
    })
    saveBattle(battle('1', 100, 'RealNick'))
    // Позже по времени: за слот игрока играл бот, ник в results — coop/Bot.
    saveBattle(battle('2', 200, 'coop/Bot7'))

    assert.equal(getPlayerReplayStats({ userId: '555' }).battles, 1)
    assert.deepEqual(findKnownPlayerMatches('555').map((match) => match.nick), ['RealNick'])
    assert.deepEqual(searchSitePlayers('coop'), [])
    assert.deepEqual(findSimilarSitePlayers('coop'), [])
  } finally {
    closeDb()
  }
})

test('a roster nick links to the single account id of its replays', () => {
  initDb(':memory:')
  try {
    const slot = (userId: string, nick: string) => ({ ...replayPlayer(nick), userId })
    saveBattle({
      sessionId: 'roster-links',
      sessionHex: '00000000000000aa',
      missionName: 'fixture',
      level: 'fixture',
      gameMode: null,
      battleType: null,
      environment: null,
      status: null,
      startTime: 1,
      durationSec: 600,
      endTimeMs: 600_000,
      teamWon: 1,
      gameVersion: null,
      missionSettings: null,
      players: [
        slot('601', 'Ёлка'),
        slot('602', 'Reused'),
        slot('603', 'reused'),
        slot('604', 'Gamer@psn'),
        slot('-5', 'Phantom'),
        slot('605', 'coop/Bot3'),
      ],
      kills: [],
      chat: [],
      eventsBlob: Buffer.from('{}'),
    })
    // 20 nicks cross the 16-slot IN chunk.
    const filler = Array.from({ length: 20 }, (_, index) => `Nobody${index}`)
    const links = getSiteReplayUserIdsByNick(['ЁЛКА', 'Reused', 'Gamer', 'Gamer@psn', 'Phantom', 'coop/Bot3', ...filler])
    // Case-folded exact nick; the key is the caller's spelling.
    assert.deepEqual(links.get('ЁЛКА'), ['601'])
    // Two accounts on one nick: the caller links neither.
    assert.deepEqual(links.get('Reused')?.sort(), ['602', '603'])
    // The platform suffix is part of the nick.
    assert.equal(links.has('Gamer'), false)
    assert.deepEqual(links.get('Gamer@psn'), ['604'])
    // A bot slot's negative id and a coop/Bot slot are no evidence of a player.
    assert.equal(links.has('Phantom'), false)
    assert.equal(links.has('coop/Bot3'), false)
    assert.equal(links.size, 3)
  } finally {
    closeDb()
  }
})
