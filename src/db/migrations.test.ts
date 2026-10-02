import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  DB_SCHEMA_VERSION,
  closeDb,
  initDb,
  runDbMigrations,
  type DbMigration,
} from './index.js'

function userVersion(database: DatabaseSync): number {
  return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined
}

test('initDb ставит schema version и повторный запуск идемпотентен', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-clean-'))
  const dbPath = path.join(root, 'clean.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()

    const created = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(created), DB_SCHEMA_VERSION)
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battle_players') WHERE name = 'nick_search'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battles') WHERE name = 'air_unit_count'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('battles') WHERE name = 'chat_count'")
          .get() !== undefined,
        true,
      )
      assert.equal(
        created
          .prepare("SELECT 1 FROM pragma_table_info('announce_state') WHERE name = 'message_id'")
          .get() !== undefined,
        true,
      )
    } finally {
      created.close()
    }

    initDb(dbPath)
    closeDb()

    const reopened = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(reopened), DB_SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('migration runner фиксирует только полностью выполненные версии', () => {
  const database = new DatabaseSync(':memory:')
  const migrations: readonly DbMigration[] = [
    {
      version: 1,
      apply(db) {
        db.exec('CREATE TABLE stable_marker (value INTEGER NOT NULL)')
      },
    },
    {
      version: 2,
      apply(db) {
        db.exec('CREATE TABLE rolled_back_marker (value INTEGER NOT NULL)')
        throw new Error('ожидаемая ошибка migration fixture')
      },
    },
  ]
  try {
    assert.throws(() => runDbMigrations(database, migrations), /миграцию SQLite v2/)
    assert.equal(userVersion(database), 1)
    assert.equal(tableExists(database, 'stable_marker'), true)
    assert.equal(tableExists(database, 'rolled_back_marker'), false)
  } finally {
    database.close()
  }
})

test('migration runner отклоняет более новую неизвестную schema version', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA user_version = 3')
    assert.throws(
      () => runDbMigrations(database, [{ version: 1, apply() {} }]),
      /новее поддерживаемой 1/,
    )
    assert.equal(userVersion(database), 3)
  } finally {
    database.close()
  }
})

test('migration runner не проглатывает блокировку конкурентного writer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-lock-'))
  const dbPath = path.join(root, 'locked.db')
  const blocker = new DatabaseSync(dbPath)
  const contender = new DatabaseSync(dbPath)
  try {
    contender.exec('PRAGMA busy_timeout = 25')
    blocker.exec('BEGIN IMMEDIATE')
    assert.throws(
      () =>
        runDbMigrations(contender, [
          {
            version: 1,
            apply(db) {
              db.exec('CREATE TABLE must_not_exist (value INTEGER NOT NULL)')
            },
          },
        ]),
      /миграцию SQLite v1/,
    )
    assert.equal(userVersion(contender), 0)
    blocker.exec('ROLLBACK')
    assert.equal(tableExists(contender, 'must_not_exist'), false)
  } finally {
    try {
      blocker.exec('ROLLBACK')
    } catch {
      // Transaction уже завершена.
    }
    contender.close()
    blocker.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграции v6–v7 ставят в очередь бои 2.59, разобранные до исправления', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v6-'))
  const dbPath = path.join(root, 'v6.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec, game_version, kill_count)
      VALUES (?, ?, 'm', 'l', 1, 1, ?, ?)
    `)
    const ingest = database.prepare(`INSERT INTO battle_ingest (session_id, status, attempts) VALUES (?, ?, 1)`)
    battle.run('1', '01', '2.59.0.28', 0); ingest.run('1', 'ok')
    battle.run('2', '02', '2.59.0.28', 7); ingest.run('2', 'ok')
    battle.run('3', '03', '2.57.1.60', 0); ingest.run('3', 'ok')
    battle.run('4', '04', '2.59.0.28', 0); ingest.run('4', 'expired')
    database.exec('PRAGMA user_version = 5')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      // 1 и 2 (2.59, ok) — в очередь; 3 (2.57) и 4 (expired) не трогаются.
      assert.deepEqual(left, ['3', '4'])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v8 добавляет в словарь кланов официальную статистику лидерборда', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v8-'))
  const dbPath = path.join(root, 'v8.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    // Схема v7: словарь только «тег → имя», истории рейтинга нет.
    const database = new DatabaseSync(dbPath)
    database.exec(`
      DROP TABLE clan_rating_history;
      ALTER TABLE clans DROP COLUMN rating;
      ALTER TABLE clans DROP COLUMN position;
      ALTER TABLE clans DROP COLUMN members;
      ALTER TABLE clans DROP COLUMN battles;
      ALTER TABLE clans DROP COLUMN wins;
      ALTER TABLE clans DROP COLUMN rating_at;
      INSERT INTO clans (tag, name) VALUES ('[AVR]', 'AVANGARD');
      PRAGMA user_version = 7;
    `)
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const columns = (migrated.prepare("SELECT name FROM pragma_table_info('clans')").all() as { name: string }[])
        .map((row) => row.name)
      for (const column of ['rating', 'position', 'members', 'battles', 'wins', 'rating_at']) {
        assert.ok(columns.includes(column), `в clans нет колонки ${column}`)
      }
      assert.equal(tableExists(migrated, 'clan_rating_history'), true)
      assert.deepEqual(
        { ...(migrated.prepare('SELECT tag, name, rating, rating_at FROM clans').get() as object) },
        { tag: '[AVR]', name: 'AVANGARD', rating: null, rating_at: null },
      )
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v9 удаляет обрезанные бои и фантомных ботов вне состава Replay API', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v9-'))
  const dbPath = path.join(root, 'v9.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const item = database.prepare(`
      INSERT INTO items (source, external_id, title, data, content_hash) VALUES ('wt-replays', ?, 't', ?, ?)
    `)
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec, team_won, player_count)
      VALUES (?, ?, 'm', 'l', 1000, ?, ?, ?)
    `)
    const player = database.prepare(`
      INSERT INTO battle_players (session_id, user_id, nick, nick_base, nick_search, team, vehicle, vehicles, disconnected)
      VALUES (?, ?, ?, ?3, lower(?3), 1, ?, ?, ?)
    `)
    const ingest = database.prepare(`INSERT INTO battle_ingest (session_id, status, attempts) VALUES (?, 'ok', 1)`)
    const roster = (ids: string[]) => JSON.stringify({ startTime: 1000, endTime: 1700, players: { team_1: ids.map((userId) => ({ userId, name: userId, fakeName: '' })), team_2: [] } })
    // 1 — разобран на 95 с из 700 без победителя: удаляется целиком.
    item.run('1', roster(['501']), 'h1'); battle.run('1', '01', 95, 0, 1); ingest.run('1')
    player.run('1', '501', 'Pilot', 'tank', '["tank"]', 0)
    // 2 — полный бой: фантом -10 вне состава удаляется, бот -11 из состава остаётся.
    item.run('2', roster(['501', '-11']), 'h2'); battle.run('2', '02', 695, 1, 3); ingest.run('2')
    player.run('2', '501', 'Pilot', 'tank', '["tank"]', 0)
    player.run('2', '-10', 'coop/Bot1', null, '[]', 1)
    player.run('2', '-11', 'coop/Bot2', null, '[]', 1)
    database.exec('PRAGMA user_version = 8')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM battles WHERE session_id = '1'").get()?.['n'], 0)
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM battle_players WHERE session_id = '1'").get()?.['n'], 0)
      assert.equal(migrated.prepare("SELECT status FROM battle_ingest WHERE session_id = '1'").get()?.['status'], 'expired')
      const left = (migrated.prepare("SELECT user_id FROM battle_players WHERE session_id = '2' ORDER BY user_id").all() as { user_id: string }[])
        .map((row) => row.user_id)
      assert.deepEqual(left, ['-11', '501'])
      assert.equal(migrated.prepare("SELECT player_count FROM battles WHERE session_id = '2'").get()?.['player_count'], 2)
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v11 возвращает в очередь свежие бои, ставшие expired из-за 404 части', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v11-'))
  const dbPath = path.join(root, 'v11.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const ingest = database.prepare(`
      INSERT INTO battle_ingest (session_id, status, attempts, error, updated_at)
      VALUES (?, ?, 1, ?, unixepoch() - ?)
    `)
    const part404 = 'HTTP 404 при скачивании wt-game-replays.warthunder.com/0a/0001.wrpl'
    ingest.run('1', 'expired', part404, 3_600)
    ingest.run('2', 'expired', 'HTTP 410 при скачивании wt-game-replays.warthunder.com/0b/0002.wrpl', 86_400)
    // Старше двух недель: части уже ушли с CDN.
    ingest.run('3', 'expired', part404, 20 * 86_400)
    ingest.run('4', 'expired', 'реплей разобран не полностью, части ушли с CDN', 3_600)
    ingest.run('5', 'expired', part404, 3_600)
    ingest.run('6', 'ok', null, 3_600)
    database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec)
      VALUES ('5', '05', 'm', 'l', 1, 1)
    `).run()
    database.exec('PRAGMA user_version = 10')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      // 1 и 2 — в очередь; 3 (старый), 4 (другая причина), 5 (бой есть) и 6 (ok) не трогаются.
      assert.deepEqual(left, ['3', '4', '5', '6'])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v12 переразбирает свежие бои, записанные без финальных итогов', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v12-'))
  const dbPath = path.join(root, 'v12.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, status, start_time, duration_sec)
      VALUES (?, ?, 'm', 'l', ?, unixepoch() - ?, ?)
    `)
    const ingest = database.prepare(`INSERT INTO battle_ingest (session_id, status, attempts) VALUES (?, ?, 1)`)
    battle.run('1', '01', null, 86_400, 95); ingest.run('1', 'ok')
    battle.run('2', '02', '', 3_600, 96); ingest.run('2', 'ok')
    // Финальные итоги есть — бой верен.
    battle.run('3', '03', 'success', 3_600, 600); ingest.run('3', 'ok')
    // Старше двух недель: частей на CDN уже нет, переразбирать нечем.
    battle.run('4', '04', null, 20 * 86_400, 95); ingest.run('4', 'ok')
    database.exec('PRAGMA user_version = 11')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      // 1 и 2 — в очередь; 3 (итоги есть) и 4 (старый) не трогаются.
      assert.deepEqual(left, ['3', '4'])
      // Строки боя остаются до переразбора: persist заменит их целиком.
      assert.equal((migrated.prepare('SELECT COUNT(*) AS n FROM battles').get() as { n: number }).n, 4)
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v13 возвращает в очередь бои, ошибочно ставшие expired без финальных итогов', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v13-'))
  const dbPath = path.join(root, 'v13.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, status, start_time, duration_sec)
      VALUES (?, ?, 'm', 'l', ?, unixepoch() - ?, 95)
    `)
    const ingest = database.prepare(`
      INSERT INTO battle_ingest (session_id, status, attempts, error, updated_at)
      VALUES (?, ?, 1, ?, unixepoch() - ?)
    `)
    const incomplete = 'в частях реплея только промежуточные итоги боя (95 с)'
    battle.run('1', '01', null, 86_400); ingest.run('1', 'expired', incomplete, 3_600)
    // Другая причина expired, ok-бой и бой старше двух недель не трогаются.
    battle.run('2', '02', null, 86_400); ingest.run('2', 'expired', 'HTTP 404 при скачивании cdn/0a/0001.wrpl', 3_600)
    battle.run('3', '03', 'success', 86_400); ingest.run('3', 'ok', null, 3_600)
    battle.run('4', '04', null, 20 * 86_400); ingest.run('4', 'expired', incomplete, 19 * 86_400)
    database.exec('PRAGMA user_version = 12')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      assert.deepEqual(left, ['2', '3', '4'])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v14 переразбирает бои без исхода, отброшенные как недописанные', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v14-'))
  const dbPath = path.join(root, 'v14.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const ingest = database.prepare(`
      INSERT INTO battle_ingest (session_id, status, attempts, error, updated_at)
      VALUES (?, ?, 1, ?, unixepoch() - ?)
    `)
    const incomplete = 'в частях реплея только промежуточные итоги боя (1513 с)'
    ingest.run('1', 'expired', incomplete, 3_600)
    // Давно отброшенный, другая причина и ok не трогаются.
    ingest.run('2', 'expired', incomplete, 20 * 86_400)
    ingest.run('3', 'expired', 'HTTP 404 при скачивании cdn/0a/0001.wrpl', 3_600)
    ingest.run('4', 'ok', null, 3_600)
    database.exec('PRAGMA user_version = 13')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const left = (migrated.prepare('SELECT session_id FROM battle_ingest ORDER BY session_id').all() as { session_id: string }[])
        .map((row) => row.session_id)
      assert.deepEqual(left, ['2', '3', '4'])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v15 добавляет поля сборщика: профиль клана, детали ростера и нации игрока', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v15-'))
  const dbPath = path.join(root, 'v15.db')
  const clanColumns = ['clan_id', 'description', 'announcement', 'requirements', 'status', 'auto_accept', 'plain_tag', 'regalia']
  const rosterColumns = ['role', 'joined_at', 'activity']
  const columns = (database: DatabaseSync, table: string) =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name)
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    // Схема v14: без новых колонок и без таблицы наций.
    const database = new DatabaseSync(dbPath)
    for (const column of clanColumns) database.exec(`ALTER TABLE clans DROP COLUMN ${column}`)
    for (const column of rosterColumns) database.exec(`ALTER TABLE clan_roster DROP COLUMN ${column}`)
    database.exec('DROP TABLE player_external_countries')
    database.exec("INSERT INTO clan_roster (clan_core, nick, last_present_at) VALUES ('avr', 'One', 1)")
    database.exec('PRAGMA user_version = 14')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      for (const column of clanColumns) assert.ok(columns(migrated, 'clans').includes(column), column)
      for (const column of rosterColumns) assert.ok(columns(migrated, 'clan_roster').includes(column), column)
      assert.deepEqual(columns(migrated, 'player_external_countries'), [
        'snapshot_id', 'country', 'vehicles', 'elite_vehicles', 'medals',
      ])
      assert.deepEqual(migrated.prepare('SELECT nick, role FROM clan_roster').all().map((row) => ({ ...row })), [
        { nick: 'One', role: null },
      ])
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v16 достаёт сведения об аккаунте из сохранённых снимков', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v16-'))
  const dbPath = path.join(root, 'v16.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    database.exec('ALTER TABLE player_external_snapshots DROP COLUMN account_json')
    database.exec("INSERT INTO player_identities (id, wt_user_id, canonical_nick, canonical_nick_search) VALUES (1, '501', 'Pilot', 'pilot')")
    const snapshot = database.prepare(`
      INSERT INTO player_external_snapshots (
        identity_id, source, source_player_id, nick, fetched_at, last_checked_at, status, raw_json, parser_version
      ) VALUES (1, ?, '501', 'Pilot', ?, ?, 'ok', ?, 'old')
    `)
    const statShark = {
      profile: {
        Basics: { level: 100, title: 'The Old Guard' },
        Misc: {
          registerDay: 1_373_452_206,
          lastDayOnline: 1_790_650_800,
          SquadronHistory: [{ ClanID: 1_095_692, ClanTag: '═CH68║', Date: '2026-03-10 02:16:21' }],
          NameHistory: [{ IGN: 'Pilot', Date: '2026-03-10 02:16:21' }],
        },
        Profile: {
          Leaderboard: {
            historical: { value_total: { each_player_victories: { value_total: 22_259, idx: 3_777 } } },
            air_arcade: true,
          },
        },
      },
    }
    // Старый снимок и свежий: заполняется только последний успешный.
    snapshot.run('statshark', 100, 100, JSON.stringify({ profile: { Basics: { level: 1 } } }))
    snapshot.run('statshark', 200, 200, JSON.stringify(statShark))
    snapshot.run('official-profile', 200, 200, JSON.stringify({ nick: 'Pilot', level: 99, registrationDate: '10.07.2013', sections: [] }))
    database.exec('PRAGMA user_version = 15')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = migrated
        .prepare('SELECT source, fetched_at, account_json FROM player_external_snapshots ORDER BY id')
        .all() as { source: string; fetched_at: number; account_json: string | null }[]
      assert.equal(rows[0]?.account_json, null, 'старый снимок не трогаем')
      const account = JSON.parse(rows[1]?.account_json ?? 'null') as Record<string, unknown>
      assert.equal(account['level'], 100)
      assert.equal(account['registeredAt'], 1_373_452_206)
      assert.deepEqual(account['squadrons'], [{ clanId: 1_095_692, tag: '═CH68║', seenAt: 1_773_108_981 }])
      assert.deepEqual(account['ranks'], [{ mode: 'historical', metric: 'victories', value: 22_259, place: 3_778 }])
      const official = JSON.parse(rows[2]?.account_json ?? 'null') as Record<string, unknown>
      assert.equal(official['level'], 99)
      assert.equal(official['registeredAt'], 1_373_414_400)
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('миграция v17 выносит блобы событий из battles и чистит индексы', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-migration-v17-'))
  const dbPath = path.join(root, 'v17.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    // Раскладка боевой базы до v17: блоб в середине строки (старые колонки
    // добавлялись через ALTER после него), rowid-таблица и прежние индексы.
    const database = new DatabaseSync(dbPath)
    database.exec(`
      DROP TABLE battles;
      DROP TABLE battle_events;
      CREATE TABLE battles (
        session_id TEXT PRIMARY KEY, session_hex TEXT NOT NULL, mission_name TEXT NOT NULL, level TEXT NOT NULL,
        game_mode TEXT, battle_type TEXT, environment TEXT, status TEXT, start_time INTEGER NOT NULL,
        duration_sec INTEGER NOT NULL, end_time_ms INTEGER NOT NULL DEFAULT 0, team_won INTEGER NOT NULL DEFAULT 0,
        game_version TEXT, player_count INTEGER NOT NULL DEFAULT 0, kill_count INTEGER NOT NULL DEFAULT 0,
        events_blob BLOB, ingested_at INTEGER NOT NULL DEFAULT (unixepoch()),
        mission_settings TEXT, air_unit_count INTEGER, chat_count INTEGER
      );
      CREATE INDEX idx_battles_start ON battles (start_time DESC);
      CREATE INDEX idx_bp_nick ON battle_players (nick);
      CREATE INDEX idx_bp_nick_nocase ON battle_players (nick COLLATE NOCASE, user_id);
      CREATE INDEX idx_bp_clan ON battle_players (clan_tag);
      DROP INDEX idx_snapshots_clan_latest;
      CREATE INDEX idx_snapshots_clan_nick ON clan_rating_snapshots (clan_tag, nick, id DESC);
      CREATE INDEX idx_snapshots_clan_cover ON clan_rating_snapshots (clan_tag, nick, id DESC, rating);
      INSERT INTO battles (
        session_id, session_hex, mission_name, level, start_time, duration_sec, team_won, kill_count,
        events_blob, ingested_at, mission_settings, air_unit_count, chat_count
      ) VALUES
        ('100', '', 'm1', 'l1', 1000, 600, 1, 7, x'1f8b0102', 5, 'levels/a.blk', 3, 2),
        ('200', 'c8', 'm2', 'l2', 2000, 700, 2, 0, NULL, 6, NULL, NULL, NULL);
    `)
    database.exec('PRAGMA user_version = 16')
    database.close()

    initDb(dbPath)
    closeDb()
    const migrated = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(userVersion(migrated), DB_SCHEMA_VERSION)
      const columns = (migrated.prepare('PRAGMA table_info(battles)').all() as { name: string }[]).map((row) => row.name)
      assert.ok(!columns.includes('events_blob'), 'events_blob ушёл из battles')
      const ddl = (migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'battles'").get() as { sql: string }).sql
      assert.match(ddl, /WITHOUT ROWID/)
      assert.deepEqual(
        migrated.prepare('SELECT session_id, session_hex, kill_count, ingested_at, mission_settings, air_unit_count, chat_count FROM battles ORDER BY session_id').all().map((row) => ({ ...row })),
        [
          { session_id: '100', session_hex: '0000000000000064', kill_count: 7, ingested_at: 5, mission_settings: 'levels/a.blk', air_unit_count: 3, chat_count: 2 },
          { session_id: '200', session_hex: 'c8', kill_count: 0, ingested_at: 6, mission_settings: null, air_unit_count: null, chat_count: null },
        ],
      )
      const events = migrated.prepare('SELECT session_id, hex(events_blob) AS blob FROM battle_events').all().map((row) => ({ ...row }))
      assert.deepEqual(events, [{ session_id: '100', blob: '1F8B0102' }], 'бой без блоба в battle_events не попадает')
      const indexes = new Set((migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((row) => row.name))
      for (const name of ['idx_battles_start', 'idx_battles_session_hex', 'idx_battles_metrics', 'idx_snapshots_clan_latest']) {
        assert.ok(indexes.has(name), `${name} создан`)
      }
      for (const name of ['idx_bp_clan', 'idx_bp_nick', 'idx_bp_nick_nocase', 'idx_snapshots_clan_nick', 'idx_snapshots_clan_cover']) {
        assert.ok(!indexes.has(name), `${name} удалён`)
      }
      assert.ok(tableExists(migrated, 'sqlite_stat1'), 'ANALYZE собрал статистику')
    } finally {
      migrated.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})
