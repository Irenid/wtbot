import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { gzipSync } from 'node:zlib'
import { closeDb, initDb, replaceRepairedBattleEvents, VACUUM_STEP_PAGES } from '../db/index.js'
import {
  compressEventsJson,
  decodeEventsPayload,
  encodeEventsJson,
  isColumnarEventsBlob,
  isZstdEventsBlob,
} from '../wrpl/events-codec.js'
import { closeWorkerPool, runWorkerTask } from './pool.js'

// Пул общий для тестов файла: после closeWorkerPool он не перезапускается.
after(async () => {
  await closeWorkerPool()
})

function pragma(database: DatabaseSync, name: string): number {
  return Number(Object.values(database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0])
}

/** Бот −13 в беззнаковом виде прежнего разбора. */
const BOT = '18446744073709551603'

/** События боя в том виде, в каком их записывал прежний разбор. */
function legacyEvents() {
  const kill = {
    time: 5_000, killerId: '1', killerModel: 'f_16', killerPos: { t: 5_000, x: 1.2, y: 2, z: 3 },
    victimId: BOT, victimModel: 'tankModels/t', victimPos: null, weapon: 'bomb',
  }
  return {
    teamWon: 1,
    players: [
      { slot: 0, userId: '1', name: 'Pilot', clanTag: '=T=', title: 'title_ace', team: 1 },
      { slot: 1, userId: BOT, name: 'coop/Bot1', clanTag: '', title: '', team: 2 },
    ],
    // Та же зенитка дважды в одну миллисекунду — повтор события.
    kills: [kill, { ...kill }, { ...kill, time: 6_000, killerId: BOT, victimId: '1', killerPos: null }],
    damage: [{ time: 1, variant: 'critical', offenderId: BOT, offenderModel: 't', victimId: '1', victimModel: 'f_16', fire: false }],
    chat: [
      { time: 100, sender: 'Hachiro3906', message: 'gg', channel: 1, channelValid: true },
      // Старший байт длины-varint в начале, канал прочитан из середины текста.
      { time: 200, sender: 'Pilot', message: '\u0001длинное сообщение', channel: 102, channelValid: false },
    ],
    units: [
      { userId: '1', model: 'f_16', source: 'air', path: [{ t: 1.4, x: 10.6, y: 5, z: -3.2 }, { t: 1_000, x: 20, y: 5, z: -3 }] },
      { userId: BOT, model: 'tankModels/t', source: 'ground', path: [{ t: 0, x: 0, y: 0, z: 0 }] },
    ],
    zones: [],
    endTime: 600_000,
  }
}

const canonicalEvents = {
  teamWon: 2, players: [{ slot: 0, userId: '5', name: 'Done', clanTag: '', title: 't', team: 1 }], kills: [], damage: [], chat: [],
  units: [{ userId: '5', model: 'm', source: 'ground', path: [{ t: 0, x: 1, y: 2, z: 3 }, { t: 9, x: 4, y: 5, z: 6 }] }],
  zones: [], endTime: 1_000,
}
const noTrajectories = { teamWon: 1, players: [], kills: [], damage: [], chat: [], units: [], zones: [], endTime: 900 }

test('починка записанных боёв: события в каноническом виде, пустые поля из событий, без лишних записей', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-repair-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    assert.equal(pragma(database, 'auto_vacuum'), 2, 'новая база сразу с auto_vacuum = INCREMENTAL')
    const legacy = legacyEvents()
    const battle = database.prepare(`
      INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec, player_count, kill_count, air_unit_count, chat_count)
      VALUES (?, ?, 'm', 'l', 1, 600, ?, ?, ?, ?)
    `)
    battle.run('101', '65', 2, 3, null, null)
    battle.run('102', '66', 1, 0, 0, 0)
    battle.run('103', '67', 0, 0, null, null)
    const blob = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    blob.run('101', gzipSync(Buffer.from(JSON.stringify(legacy))))
    const canonicalBlob = encodeEventsJson(JSON.stringify(canonicalEvents))
    blob.run('102', canonicalBlob)
    const zstdBlob = compressEventsJson(Buffer.from(JSON.stringify(noTrajectories)))
    blob.run('103', zstdBlob)
    const player = database.prepare(`
      INSERT INTO battle_players (session_id, user_id, nick, nick_base, team, slot, title) VALUES (?, ?, ?, ?3, ?, ?, ?)
    `)
    player.run('101', '1', 'Pilot', 1, null, null)
    player.run('101', '-13', 'coop/Bot1', 2, null, null)
    player.run('102', '5', 'Done', 1, 0, 't')
    for (const kill of legacy.kills) {
      database.prepare('INSERT INTO battle_kills (session_id, time_ms, killer_id, victim_id) VALUES (?, ?, ?, ?)')
        .run('101', kill.time, kill.killerId, kill.victimId)
    }
    for (const message of legacy.chat) {
      database.prepare('INSERT INTO battle_chat (session_id, time_ms, sender, channel, channel_valid, message) VALUES (?, ?, ?, ?, ?, ?)')
        .run('101', message.time, message.sender, message.channel, message.channelValid ? 1 : 0, message.message)
    }
    database.prepare(`INSERT INTO items (source, external_id, title, data, content_hash) VALUES ('wt-replays', '101', 't', ?, 'h')`)
      .run(JSON.stringify({ players: {
        team_1: [{ userId: '1', name: 'Pilot', fakeName: 'Hachiro3906' }],
        team_2: [{ userId: '-13', name: 'coop/Bot1', fakeName: '' }],
      } }))
    database.close()

    const input = (afterSessionId: string) => ({ dbPath, afterSessionId, limit: 10, vacuumPages: 4_096 })
    const result = await runWorkerTask({ kind: 'repair-battle-events', input: input('') })
    assert.deepEqual(
      [result.scanned, result.rewritten, result.changedMeanwhile, result.filledRows, result.lastSessionId],
      [3, 1, 0, 3, '103'],
      'переписан только бой прежнего разбора; slot и title двух игроков и счётчики боя без событий',
    )
    assert.equal(result.repairs.chatNames, 1)
    assert.equal(result.repairs.duplicateKills, 1)
    assert.equal(result.repairs.brokenChat, 1)
    assert.ok(result.repairs.signedIds >= 5, `id ботов: ${result.repairs.signedIds}`)
    assert.ok(result.repairs.roundedValues >= 3, `дробные значения: ${result.repairs.roundedValues}`)
    const done = await runWorkerTask({ kind: 'repair-battle-events', input: input('103') })
    assert.equal(done.lastSessionId, null, 'конец таблицы')

    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const blobOf = (id: string) => (check.prepare('SELECT events_blob FROM battle_events WHERE session_id = ?').get(id) as { events_blob: Uint8Array }).events_blob
      const repaired = blobOf('101')
      assert.ok(isColumnarEventsBlob(repaired), 'gzip прежнего разбора → колоночный')
      const events = decodeEventsPayload(repaired) as ReturnType<typeof legacyEvents>
      assert.deepEqual(events.players.map((p) => p.userId), ['1', '-13'])
      assert.deepEqual(events.units.map((u) => u.userId), ['1', '-13'])
      assert.deepEqual(events.kills.map((k) => [k.killerId, k.victimId]), [['1', '-13'], ['-13', '1']], 'дубль удалён, id знаковые')
      assert.equal(events.damage[0]!.offenderId, '-13')
      assert.deepEqual(events.chat.map((m) => [m.sender, m.message]), [['Pilot', 'gg'], ['Pilot', 'длинное сообщение']])
      assert.deepEqual(events.units[0]!.path[0], { t: 1, x: 11, y: 5, z: -3 })
      assert.deepEqual(events.kills[0]!.killerPos, { t: 5_000, x: 1, y: 2, z: 3 })
      assert.deepEqual(
        check.prepare('SELECT killer_id, victim_id, killer_x FROM battle_kills WHERE session_id = ? ORDER BY time_ms').all('101').map((r) => ({ ...r })),
        [{ killer_id: '1', victim_id: '-13', killer_x: 1 }, { killer_id: '-13', victim_id: '1', killer_x: null }],
      )
      assert.deepEqual(
        check.prepare('SELECT sender, message, channel_valid FROM battle_chat WHERE session_id = ? ORDER BY time_ms').all('101').map((r) => ({ ...r })),
        [{ sender: 'Pilot', message: 'gg', channel_valid: 1 }, { sender: 'Pilot', message: 'длинное сообщение', channel_valid: 0 }],
      )
      assert.deepEqual(
        check.prepare('SELECT session_id, kill_count, chat_count, air_unit_count FROM battles ORDER BY session_id').all().map((r) => ({ ...r })),
        [
          { session_id: '101', kill_count: 2, chat_count: 2, air_unit_count: 1 },
          { session_id: '102', kill_count: 0, chat_count: 0, air_unit_count: 0 },
          { session_id: '103', kill_count: 0, chat_count: 0, air_unit_count: 0 },
        ],
      )
      assert.deepEqual(
        check.prepare('SELECT user_id, slot, title FROM battle_players ORDER BY session_id, user_id').all().map((r) => ({ ...r })),
        [
          { user_id: '-13', slot: 1, title: null },
          { user_id: '1', slot: 0, title: 'title_ace' },
          { user_id: '5', slot: 0, title: 't' },
        ],
      )
      assert.deepEqual(Buffer.from(blobOf('102')), canonicalBlob, 'канонический бой не переписан')
      assert.ok(isZstdEventsBlob(blobOf('103')), 'zstd-JSON без траекторий остаётся')
      assert.deepEqual(Buffer.from(blobOf('103')), zstdBlob)
    } finally {
      check.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('починка не перезаписывает бой, который ingest переразобрал после чтения', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-repair-guard-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    try {
      database.prepare(`INSERT INTO battles (session_id, session_hex, mission_name, level, start_time, duration_sec, kill_count) VALUES ('7', '07', 'm', 'l', 1, 1, 1)`).run()
      database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)').run('7', Buffer.from('новый'))
      database.prepare(`INSERT INTO battle_kills (session_id, time_ms, killer_id, victim_id) VALUES ('7', 1, 'a', 'b')`).run()
      const replaced = replaceRepairedBattleEvents(database, {
        sessionId: '7', previousBlob: Buffer.from('прежний'), eventsBlob: Buffer.from('починенный'),
        kills: [], chat: [], airUnitCount: 0,
      })
      assert.equal(replaced, false)
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM battle_kills WHERE session_id = '7'").get() as { n: number }).n, 1)
      assert.deepEqual(
        Buffer.from((database.prepare("SELECT events_blob FROM battle_events WHERE session_id = '7'").get() as { events_blob: Uint8Array }).events_blob),
        Buffer.from('новый'),
      )
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('обслуживание в worker возвращает свободные страницы порциями и обновляет статистику', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-maintenance-'))
  const dbPath = path.join(directory, 'wtbot.db')
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    const database = new DatabaseSync(dbPath)
    const insert = database.prepare('INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)')
    for (let i = 0; i < 40; i += 1) insert.run(String(i), Buffer.alloc(64 * 1024, i))
    database.exec('DELETE FROM battle_events')
    // Устаревшая статистика: ANALYZE на 20 строках, затем рост в 1000 раз.
    database.exec('CREATE TABLE stale (a INTEGER); CREATE INDEX stale_a ON stale (a);')
    const stale = database.prepare('INSERT INTO stale (a) VALUES (?)')
    for (let i = 0; i < 20; i += 1) stale.run(i)
    database.exec('ANALYZE stale')
    database.exec('BEGIN')
    for (let i = 0; i < 20_000; i += 1) stale.run(i)
    database.exec('COMMIT')
    const free = pragma(database, 'freelist_count')
    database.close()
    assert.ok(free > 100, 'после удаления есть свободные страницы')

    const task = (maxPages: number, optimize: boolean) =>
      runWorkerTask({ kind: 'db-maintenance', input: { dbPath, maxPages, optimize } })
    const firstPortion = await task(100, true)
    assert.equal(firstPortion.freedPages, 100, 'не больше порции за вызов')
    // ANALYZE мог занять страницу из свободных — остаток не строго free - 100.
    assert.ok(firstPortion.freelistPages > 0 && firstPortion.freelistPages <= free - 100)
    assert.ok(firstPortion.analyzed.includes('stale'), `свежее подключение видит устаревшую статистику: ${firstPortion.analyzed.join(', ')}`)
    const rest = await task(1_000_000, false)
    assert.deepEqual([rest.freedPages, rest.freelistPages, rest.analyzed], [firstPortion.freelistPages, 0, []])
    assert.ok(firstPortion.freelistPages > VACUUM_STEP_PAGES, 'порция больше одного шага')
    assert.equal(rest.steps, Math.ceil(firstPortion.freelistPages / VACUUM_STEP_PAGES), 'короткими транзакциями по шагу')
    assert.equal((await task(1_000, true)).freedPages, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
