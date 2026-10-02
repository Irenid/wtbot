import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  PLAYER_EXTERNAL_SNAPSHOT_STATUSES,
  PLAYER_IDENTITY_MATCH_CONFIDENCES,
  PLAYER_IDENTITY_MATCH_METHODS,
  type NormalizedPlayerExternalCountry,
  type NormalizedPlayerExternalTotal,
  type NormalizedPlayerExternalVehicle,
  type NormalizedPlayerStats,
  type PlayerExternalCountry,
  type PlayerExternalStats,
  type PlayerExternalSnapshot,
  type PlayerExternalSnapshotInput,
  type PlayerExternalSnapshotMeta,
  type PlayerExternalSnapshotStatus,
  type PlayerExternalTotal,
  type PlayerExternalVehicle,
  type PlayerIdentity,
  type PlayerIdentityAlias,
  type PlayerIdentityMatchConfidence,
  type PlayerIdentityMatchMethod,
  type SavePlayerExternalSnapshotResult,
  type SavePlayerIdentityInput,
} from '../player-stats/types.js'
import {
  officialProfileAccount,
  sanitizePlayerAccount,
  statSharkAccount,
  type PlayerAccount,
} from '../player-stats/account.js'
import { CLAN_SEASON_SCHEDULES, stageAt, type ClanSeasonSchedule } from '../clan-season.js'
import { FORUM_SEASON_ID_PREFIX } from '../clan-season-forum.js'

// Общий слой хранения: им пользуются и бот, и сайт, и парсеры.
// SQLite встроен в Node 22.5+ — отдельный сервер БД не нужен.
// Когда проект вырастет — этот модуль можно заменить на Prisma/Postgres,
// не трогая остальной код.

let db: DatabaseSync | null = null
let dbWorkerPath: string | null = null
let insertVoicePresenceStatement: StatementSync | null = null
let deleteVoicePresenceStatement: StatementSync | null = null
let selectVoicePresenceStatement: StatementSync | null = null
let selectPlayerRatingStatement: StatementSync | null = null
let selectPlayerBattleStatsStatement: StatementSync | null = null
let selectPlayerReplayStatsStatement: StatementSync | null = null
let selectPlayerReplayVehiclesStatement: StatementSync | null = null
let selectVoiceDashboardStatement: StatementSync | null = null
let selectVoiceClanTagsStatement: StatementSync | null = null
let selectCommandTotalStatement: StatementSync | null = null
let selectCommandBreakdownStatement: StatementSync | null = null
let selectItemTotalStatement: StatementSync | null = null
let selectItemBreakdownStatement: StatementSync | null = null
let selectLatestItemSummariesStatement: StatementSync | null = null
let selectIngestStatsStatement: StatementSync | null = null
let selectBattlePostSummaryStatement: StatementSync | null = null
let selectDataVersionStatement: StatementSync | null = null
let commandStatsCache: VersionedCache<CommandStats> | null = null
let itemStatsCache: VersionedCache<ItemStats> | null = null
let ingestStatsCache: VersionedCache<IngestStats> | null = null
let lastDataVersion = 0
let lastDataVersionAt = 0
let lastWtPlayerSnapshotCleanupAt = 0
const knownItemExternalIds = new Map<string, Set<string>>()

interface VersionedCache<T> {
  dataVersion: number
  value: T
}

function resetPreparedStatements(): void {
  siteStatements.clear()
  insertVoicePresenceStatement = null
  deleteVoicePresenceStatement = null
  selectVoicePresenceStatement = null
  selectPlayerRatingStatement = null
  selectPlayerBattleStatsStatement = null
  selectPlayerReplayStatsStatement = null
  selectPlayerReplayVehiclesStatement = null
  selectVoiceDashboardStatement = null
  selectVoiceClanTagsStatement = null
  selectCommandTotalStatement = null
  selectCommandBreakdownStatement = null
  selectItemTotalStatement = null
  selectItemBreakdownStatement = null
  selectLatestItemSummariesStatement = null
  selectIngestStatsStatement = null
  selectBattlePostSummaryStatement = null
  selectDataVersionStatement = null
  commandStatsCache = null
  itemStatsCache = null
  ingestStatsCache = null
  lastDataVersion = 0
  lastDataVersionAt = 0
  lastWtPlayerSnapshotCleanupAt = 0
  knownItemExternalIds.clear()
}

function getDb(): DatabaseSync {
  if (!db) throw new Error('БД не инициализирована — сначала вызови initDb()')
  return db
}

const DATA_VERSION_CACHE_MS = 1_000

/** Версия меняется при commit из другого SQLite connection/process. */
function getDataVersion(): number {
  const now = Date.now()
  if (lastDataVersionAt > 0 && now - lastDataVersionAt < DATA_VERSION_CACHE_MS) return lastDataVersion
  selectDataVersionStatement ??= getDb().prepare('PRAGMA data_version')
  const row = selectDataVersionStatement.get() as { data_version: number } | undefined
  lastDataVersion = row?.data_version ?? lastDataVersion
  lastDataVersionAt = now
  return lastDataVersion
}

/**
 * Прогрев горячих страниц: иначе первый просмотр игрока или клана на холодном
 * кэше ОС стоит случайных чтений с диска. Бот выполняет эти запросы в worker
 * (`warm-sqlite`, DB_BACKGROUND_WARMUP_SQL) после открытия Discord и web;
 * синхронно (warmupDbHotPages) — только site-real.
 *
 * ИНВАРИАНТ (verify:site-db): expect 'table' читает листья таблицы — в плане
 * нет COVERING INDEX, иначе прогрев молча холостой; expect 'index' греет
 * конкретный индекс. Новый индекс может сломать 'table'-план.
 */
export const DB_WARMUP_SQL: readonly { sql: string; expect: 'table' | 'index' }[] = [
  // Ограниченный хвост таблиц — актуальные страницы без полного скана.
  { sql: 'SELECT score FROM battle_players ORDER BY rowid DESC LIMIT 2048', expect: 'table' },
  { sql: 'SELECT COUNT(*) FROM battle_players', expect: 'index' },
  // Покрывающий индекс статистики дашборда.
  {
    sql: 'SELECT MAX(duration_sec) FROM battles INDEXED BY idx_battles_metrics',
    expect: 'index',
  },
  {
    sql: 'SELECT rating, seen_at FROM clan_rating_snapshots ORDER BY id DESC LIMIT 2048',
    expect: 'table',
  },
  // Индексы клановых чтений: latest-обход и диапазоны истории.
  {
    sql: 'SELECT COUNT(*) FROM (SELECT clan_tag, nick, MAX(id) FROM clan_rating_snapshots GROUP BY clan_tag, nick)',
    expect: 'index',
  },
  {
    sql: 'SELECT COUNT(*) FROM (SELECT clan_tag, MAX(seen_at) FROM clan_rating_snapshots GROUP BY clan_tag)',
    expect: 'index',
  },
  {
    sql: 'SELECT first_seen_at, match_confidence FROM player_identity_aliases ORDER BY rowid DESC LIMIT 2048',
    expect: 'table',
  },
]

export const DB_BACKGROUND_WARMUP_SQL: readonly string[] = DB_WARMUP_SQL
  .map((statement) => statement.sql)

export function warmupDbHotPages(includeTableScans = true): number {
  const started = process.hrtime.bigint()
  const database = getDb()
  for (const statement of DB_WARMUP_SQL) {
    if (includeTableScans || statement.expect === 'index') database.exec(statement.sql)
  }
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6)
}

export interface InitDbOptions {
  allowCreate?: boolean
}

export interface DbMigration {
  version: number
  apply(database: DatabaseSync): void
}

function dbUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const version = row?.user_version
  if (!Number.isSafeInteger(version) || version === undefined || version < 0) {
    throw new Error(`Некорректный PRAGMA user_version: ${String(version)}`)
  }
  return version
}

function validateMigrations(migrations: readonly DbMigration[]): number {
  let previousVersion = 0
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error('Миграции SQLite должны иметь возрастающие положительные версии')
    }
    previousVersion = migration.version
  }
  return previousVersion
}

function assertSupportedDbVersion(database: DatabaseSync, latestVersion: number): number {
  const currentVersion = dbUserVersion(database)
  if (currentVersion > latestVersion) {
    throw new Error(
      `Версия схемы SQLite ${currentVersion} новее поддерживаемой ${latestVersion}; обновите приложение`,
    )
  }
  return currentVersion
}

export function runDbMigrations(
  database: DatabaseSync,
  migrations: readonly DbMigration[],
): number {
  const latestVersion = validateMigrations(migrations)
  let currentVersion = assertSupportedDbVersion(database, latestVersion)

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    let transactionStarted = false
    try {
      database.exec('BEGIN IMMEDIATE')
      transactionStarted = true
      currentVersion = assertSupportedDbVersion(database, latestVersion)
      if (migration.version <= currentVersion) {
        database.exec('COMMIT')
        transactionStarted = false
        continue
      }
      migration.apply(database)
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
      transactionStarted = false
      currentVersion = migration.version
    } catch (error) {
      if (transactionStarted) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // Исходная ошибка миграции важнее ошибки rollback.
        }
      }
      throw new Error(`Не удалось применить миграцию SQLite v${migration.version}`, { cause: error })
    }
  }

  return currentVersion
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((row) => row.name.toLowerCase()))
}

function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (tableColumns(database, table).has(column.toLowerCase())) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Строка боя без events_blob (с v17). Блоб событий в среднем 140 КБ держал
 * каждую строку на своей листовой странице среди 1,4 млн overflow-страниц:
 * любой проход по боям читал гигабайты, а колонки, добавленные после блоба,
 * читались через всю его overflow-цепочку. Таблица кластеризована по
 * session_id (WITHOUT ROWID): соединение battle_players → battles по ключу —
 * один спуск по дереву вместо индекса и таблицы. Замеры — docs/database.md.
 */
const BATTLES_COLUMNS = [
  'session_id', 'session_hex', 'mission_name', 'level', 'game_mode', 'battle_type', 'environment', 'status',
  'start_time', 'duration_sec', 'end_time_ms', 'team_won', 'game_version', 'player_count', 'kill_count',
  'air_unit_count', 'chat_count', 'mission_settings', 'ingested_at',
] as const

function battlesTableDdl(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      session_id   TEXT PRIMARY KEY,
      session_hex  TEXT NOT NULL,
      mission_name TEXT NOT NULL,
      level        TEXT NOT NULL,
      game_mode    TEXT,
      battle_type  TEXT,
      environment  TEXT,
      status       TEXT,
      start_time   INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL,
      end_time_ms  INTEGER NOT NULL DEFAULT 0,
      team_won     INTEGER NOT NULL DEFAULT 0,
      game_version TEXT,
      player_count INTEGER NOT NULL DEFAULT 0,
      kill_count   INTEGER NOT NULL DEFAULT 0,
      air_unit_count INTEGER,
      chat_count   INTEGER,
      -- путь к файлу миссии из заголовка реплея (для границ карты хитмапа
      -- при перерисовке из БД, когда самого реплея уже нет)
      mission_settings TEXT,
      ingested_at  INTEGER NOT NULL DEFAULT (unixepoch())
    ) WITHOUT ROWID;
  `
}

/**
 * Сжатый JSON полного ReplayEvents (траектории, зоны, урон, чат) — для
 * перерисовки картинок и сцены плеера без реплея. Читается только для одного
 * боя по ключу, поэтому живёт отдельно от battles. Формат определяется по
 * магическим байтам (events-codec.ts): gzip у старых боёв, zstd у новых.
 */
const BATTLE_EVENTS_DDL = `
    CREATE TABLE IF NOT EXISTS battle_events (
      session_id  TEXT PRIMARY KEY,
      events_blob BLOB NOT NULL
    );
`

/** Техника и медали игрока по нациям из профиля warthunder.com. */
const PLAYER_EXTERNAL_COUNTRIES_DDL = `
    CREATE TABLE IF NOT EXISTS player_external_countries (
      snapshot_id    INTEGER NOT NULL REFERENCES player_external_snapshots(id) ON DELETE CASCADE,
      country        TEXT    NOT NULL,
      vehicles       INTEGER,
      elite_vehicles INTEGER,
      medals         INTEGER,
      PRIMARY KEY (snapshot_id, country),
      CHECK (country <> ''),
      CHECK (vehicles IS NULL OR vehicles >= 0),
      CHECK (elite_vehicles IS NULL OR elite_vehicles >= 0),
      CHECK (medals IS NULL OR medals >= 0)
    );
`

const DB_MIGRATIONS: readonly DbMigration[] = [
  {
    version: 1,
    apply(database) {
      for (const [table, column, definition] of [
        ['battles', 'mission_settings', 'TEXT'],
        ['battles', 'game_version', 'TEXT'],
        ['battles', 'player_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['battles', 'kill_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['player_identities', 'canonical_nick_search', "TEXT NOT NULL DEFAULT ''"],
        ['player_identity_aliases', 'nick_search', "TEXT NOT NULL DEFAULT ''"],
        ['clan_rating_snapshots', 'nick_base', "TEXT NOT NULL DEFAULT ''"],
        ['voice_presence', 'wt_nick_base', "TEXT NOT NULL DEFAULT ''"],
        ['battle_players', 'nick_base', "TEXT NOT NULL DEFAULT ''"],
        ['battle_players', 'nick_search', "TEXT NOT NULL DEFAULT ''"],
        ['battle_players', 'slot', 'INTEGER'],
        ['battle_players', 'title', 'TEXT'],
        ['battle_players', 'auto_squad', 'INTEGER'],
        ['battle_chat', 'channel_valid', 'INTEGER NOT NULL DEFAULT 1'],
        ['player_external_totals', 'deaths', 'INTEGER'],
      ] as const) {
        addColumnIfMissing(database, table, column, definition)
      }

      database.exec(`
        UPDATE player_identities
        SET canonical_nick_search = wtbot_casefold(canonical_nick)
        WHERE canonical_nick_search = '';

        UPDATE player_identity_aliases
        SET nick_search = wtbot_casefold(nick)
        WHERE nick_search = '';

        UPDATE battle_players
        SET nick_search = wtbot_casefold(nick)
        WHERE nick_search = '';

        UPDATE clan_rating_snapshots
        SET nick_base = CASE
          WHEN lower(nick) LIKE '%@psn' AND length(nick) > 4 THEN substr(nick, 1, length(nick) - 4)
          WHEN (lower(nick) LIKE '%@live' OR lower(nick) LIKE '%@epic') AND length(nick) > 5
            THEN substr(nick, 1, length(nick) - 5)
          ELSE nick
        END
        WHERE nick_base = '';

        UPDATE voice_presence
        SET wt_nick_base = CASE
          WHEN lower(wt_nick) LIKE '%@psn' AND length(wt_nick) > 4 THEN substr(wt_nick, 1, length(wt_nick) - 4)
          WHEN (lower(wt_nick) LIKE '%@live' OR lower(wt_nick) LIKE '%@epic') AND length(wt_nick) > 5
            THEN substr(wt_nick, 1, length(wt_nick) - 5)
          ELSE wt_nick
        END
        WHERE wt_nick_base = '';

        UPDATE battle_players
        SET nick_base = CASE
          WHEN lower(nick) LIKE '%@psn' AND length(nick) > 4 THEN substr(nick, 1, length(nick) - 4)
          WHEN (lower(nick) LIKE '%@live' OR lower(nick) LIKE '%@epic') AND length(nick) > 5
            THEN substr(nick, 1, length(nick) - 5)
          ELSE nick
        END
        WHERE nick_base = '';

        UPDATE battle_chat
        SET channel_valid = CASE WHEN channel BETWEEN 0 AND 3 THEN 1 ELSE 0 END
        WHERE channel_valid <> CASE WHEN channel BETWEEN 0 AND 3 THEN 1 ELSE 0 END;

        CREATE INDEX IF NOT EXISTS idx_player_identities_nick_search
          ON player_identities (canonical_nick_search);
        CREATE INDEX IF NOT EXISTS idx_player_aliases_nick_search
          ON player_identity_aliases (nick_search, last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_bp_nick_search
          ON battle_players (nick_search, user_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_nick_base
          ON clan_rating_snapshots (nick_base, id DESC);
        CREATE INDEX IF NOT EXISTS idx_voice_nick_base
          ON voice_presence (wt_nick_base);
        CREATE INDEX IF NOT EXISTS idx_bp_nick_base
          ON battle_players (nick_base);
      `)

      const rosterColumns = tableColumns(database, 'clan_roster')
      if (!rosterColumns.has('clan_core')) {
        database.exec(`
          DROP TABLE clan_roster;
          CREATE TABLE clan_roster (
            clan_core       TEXT    NOT NULL,
            nick            TEXT    NOT NULL,
            last_present_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (clan_core, nick)
          );
        `)
      }
    },
  },
  {
    version: 2,
    apply(database) {
      const battleColumns = tableColumns(database, 'battles')
      if (!battleColumns.has('duration_sec')) {
        database.exec('ALTER TABLE battles ADD COLUMN duration_sec INTEGER NOT NULL DEFAULT 0')
      }
      if (!battleColumns.has('session_hex')) {
        database.exec(`
          ALTER TABLE battles ADD COLUMN session_hex TEXT;
          UPDATE battles
          SET session_hex = lower(printf('%016x', CAST(session_id AS INTEGER)))
          WHERE session_hex IS NULL OR session_hex = '';
        `)
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_battles_session_hex
          ON battles (session_hex);
        CREATE INDEX IF NOT EXISTS idx_battles_metrics
          ON battles (duration_sec, player_count, kill_count);
      `)
    },
  },
  {
    version: 3,
    apply(database) {
      addColumnIfMissing(database, 'battles', 'air_unit_count', 'INTEGER')
      addColumnIfMissing(database, 'battles', 'chat_count', 'INTEGER')
    },
  },
  {
    version: 4,
    apply(database) {
      addColumnIfMissing(database, 'announce_state', 'message_id', 'TEXT')
    },
  },
  {
    version: 5,
    apply() {
      // Версия уже могла быть установлена локальным dashboard rollout.
      // Отдельный индекс не нужен: последние записи читаются по INTEGER PK.
    },
  },
  {
    version: 6,
    apply(database) {
      // Бои игры 2.59 до исправления разбирались без событий: пакетный поток
      // стал zstd, а construct ECS получил новый байт. Строки боя и игроков
      // верны (из results-BLK), но убийств, траекторий и победителя нет.
      // Снятие статуса ingest ставит их в очередь повторно, пока части
      // реплеев ещё лежат на CDN; persist заменит строки боя целиком.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'ok'
          AND session_id IN (
            SELECT session_id FROM battles
            WHERE game_version LIKE '2.59.%' AND kill_count = 0
          );
      `)
    },
  },
  {
    version: 7,
    apply(database) {
      // Вторая часть исправления 2.59: сбой одной ECS-сущности (подвесное
      // вооружение нового формата) обрывал весь пакет, и техника игроков из
      // того же пакета терялась — часть боёв после v6 разобрана не полностью.
      // Все бои 2.59, существующие к моменту миграции, разобраны до исправления.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'ok'
          AND session_id IN (SELECT session_id FROM battles WHERE game_version LIKE '2.59.%');
      `)
    },
  },
  {
    version: 8,
    apply(database) {
      // Рейтинг кланов на сайте считался только по снимкам ПКР участников —
      // их нет у кланов, чьи бои бот не рисовал, и лидеры сезона выпадали.
      // Официальная статистика лидерборда и её история это заменяют.
      addColumnIfMissing(database, 'clans', 'rating', 'INTEGER')
      addColumnIfMissing(database, 'clans', 'position', 'INTEGER')
      addColumnIfMissing(database, 'clans', 'members', 'INTEGER')
      addColumnIfMissing(database, 'clans', 'battles', 'INTEGER')
      addColumnIfMissing(database, 'clans', 'wins', 'INTEGER')
      addColumnIfMissing(database, 'clans', 'rating_at', 'INTEGER')
      database.exec(`
        CREATE TABLE IF NOT EXISTS clan_rating_history (
          clan_core   TEXT    NOT NULL,
          captured_at INTEGER NOT NULL,
          rating      INTEGER NOT NULL,
          PRIMARY KEY (clan_core, captured_at)
        ) WITHOUT ROWID;
      `)
    },
  },
  {
    version: 9,
    apply(database) {
      // Legacy-схемы получают колонки боя и игроков пост-миграционным
      // bootstrap: без них чистить нечего.
      const battleColumns = tableColumns(database, 'battles')
      const playerColumns = tableColumns(database, 'battle_players')
      // Сверка с Replay API (2026-09-29). Июльские бои, разобранные лишь на
      // первые ~95 с из 10–13 минут (без победителя), неверны целиком, а части
      // реплеев с CDN уже не скачать: строки боя удаляются, запись реплея
      // остаётся со статусом expired и в очередь не возвращается.
      if (battleColumns.has('duration_sec') && battleColumns.has('team_won')) database.exec(`
        CREATE TEMP TABLE migration_truncated AS
          SELECT b.session_id
          FROM battles b
          JOIN items i ON i.source = 'wt-replays' AND i.external_id = b.session_id
          WHERE b.duration_sec < 120
            AND b.team_won NOT IN (1, 2)
            AND json_extract(i.data, '$.endTime') - json_extract(i.data, '$.startTime') - b.duration_sec >= 60;
        DELETE FROM battle_kills WHERE session_id IN (SELECT session_id FROM migration_truncated);
        DELETE FROM battle_chat WHERE session_id IN (SELECT session_id FROM migration_truncated);
        DELETE FROM battle_players WHERE session_id IN (SELECT session_id FROM migration_truncated);
        DELETE FROM battles WHERE session_id IN (SELECT session_id FROM migration_truncated);
        UPDATE battle_ingest
        SET status = 'expired',
            error = 'реплей разобран не полностью, части ушли с CDN',
            updated_at = unixepoch()
        WHERE session_id IN (SELECT session_id FROM migration_truncated);
        DROP TABLE temp.migration_truncated;
      `)
      // Фантомный бот results-BLK: отрицательный userId, ни одной машины и нет
      // в составе Replay API — давал 17 игроков вместо 16. Бот без машины из
      // официального состава остаётся: сайт игры тоже считает его участником.
      if (playerColumns.has('vehicle') && playerColumns.has('vehicles')) database.exec(`
        CREATE TEMP TABLE migration_phantom AS
          SELECT bp.session_id, bp.user_id
          FROM battle_players bp
          WHERE bp.user_id GLOB '-*' AND bp.vehicle IS NULL AND (bp.vehicles IS NULL OR bp.vehicles = '[]')
            AND NOT EXISTS (
              SELECT 1
              FROM items i, json_each(i.data, '$.players') team, json_each(team.value) listed
              WHERE i.source = 'wt-replays' AND i.external_id = bp.session_id
                AND json_extract(listed.value, '$.userId') = bp.user_id
            );
        DELETE FROM battle_players
        WHERE (session_id, user_id) IN (SELECT session_id, user_id FROM migration_phantom);
        UPDATE battles
        SET player_count = (SELECT COUNT(*) FROM battle_players bp WHERE bp.session_id = battles.session_id)
        WHERE session_id IN (SELECT session_id FROM migration_phantom);
        DROP TABLE temp.migration_phantom;
      `)
    },
  },
  {
    version: 10,
    apply(database) {
      // Полная официальная статистика клана с лидерборда и её история:
      // фраги, смерти, налёт, активность, регион, тип, основание, слоган,
      // награды прошлых сезонов; в истории — бои, победы, фраги и смерти.
      for (const [column, definition] of [
        ['air_kills', 'INTEGER'],
        ['ground_kills', 'INTEGER'],
        ['deaths', 'INTEGER'],
        ['flight_time', 'INTEGER'],
        ['activity', 'INTEGER'],
        ['region', 'TEXT'],
        ['clan_type', 'TEXT'],
        ['founded_at', 'INTEGER'],
        ['slogan', 'TEXT'],
        ['rewards', 'TEXT'],
      ] as const) {
        addColumnIfMissing(database, 'clans', column, definition)
      }
      for (const column of ['battles', 'wins', 'air_kills', 'ground_kills', 'deaths']) {
        addColumnIfMissing(database, 'clan_rating_history', column, 'INTEGER')
      }
    },
  },
  {
    version: 11,
    apply(database) {
      // 404 части сразу делал бой expired, а свежий бой сайт показывает
      // раньше, чем все его части выложены на CDN: с 2026-09-29 так терялось
      // ~2% боёв (их части потом появлялись). Части живут на CDN ~2 недели:
      // снятие статуса возвращает такие бои в очередь, ушедшие снова станут
      // expired с первой же попытки.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'expired'
          AND (error LIKE 'HTTP 404 %' OR error LIKE 'HTTP 410 %')
          AND updated_at > unixepoch() - 14 * 86400
          AND NOT EXISTS (SELECT 1 FROM battles b WHERE b.session_id = battle_ingest.session_id);
      `)
    },
  },
  {
    version: 12,
    apply(database) {
      // Replay API показывает бой раньше, чем сервер дописал реплей, и
      // partsCount записи бывает ранним: без последних частей разбор брал
      // промежуточные итоги (~95 с, без статуса и победителя). Так записались
      // бои, которые v11 вернула в очередь. Ingest теперь ищет недостающие
      // части на CDN и не пишет бой без финальных итогов; снятие статуса
      // переразбирает такие бои, пока их части на CDN, persist заменит строки.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'ok'
          AND session_id IN (
            SELECT session_id FROM battles
            WHERE (status IS NULL OR status = '')
              AND start_time > unixepoch() - 14 * 86400
          );
      `)
    },
  },
  {
    version: 13,
    apply(database) {
      // Первая версия поиска недостающих частей принимала 429 CDN за конец
      // списка: переразбор из v12 видел промежуточные итоги и делал бой
      // expired, хотя хвост реплея лежал на CDN. Поиск теперь повторяет 429,
      // а иную ошибку считает сбоем попытки; снятие статуса — новый переразбор.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'expired'
          AND error LIKE 'в частях реплея только промежуточные итоги%'
          AND session_id IN (
            SELECT session_id FROM battles
            WHERE (status IS NULL OR status = '')
              AND start_time > unixepoch() - 14 * 86400
          );
      `)
    },
  },
  {
    version: 14,
    apply(database) {
      // Бой без исхода (по времени) пишет финальные итоги без статуса, и
      // проверка v12–v13 принимала их за промежуточные: такой бой становился
      // expired, хотя реплей полный. Проверка теперь сравнивает время итогов
      // с длительностью по записи сайта; снятие статуса — новый переразбор.
      database.exec(`
        DELETE FROM battle_ingest
        WHERE status = 'expired'
          AND error LIKE 'в частях реплея только промежуточные итоги%'
          AND updated_at > unixepoch() - 14 * 86400;
      `)
    },
  },
  {
    version: 15,
    apply(database) {
      // Сборщик данных warthunder.com: из лидерборда — номер клана, описание,
      // объявление, условия вступления, приём, тег без украшений и украшение
      // за прошлый сезон; из claninfo — роль, дата вступления и активность
      // участника; из профиля игрока — техника и медали по нациям.
      for (const [column, definition] of [
        ['clan_id', 'INTEGER'],
        ['description', 'TEXT'],
        ['announcement', 'TEXT'],
        ['requirements', 'TEXT'],
        ['status', 'TEXT'],
        ['auto_accept', 'INTEGER'],
        ['plain_tag', 'TEXT'],
        ['regalia', 'TEXT'],
      ] as const) {
        addColumnIfMissing(database, 'clans', column, definition)
      }
      for (const [column, definition] of [
        ['role', 'TEXT'],
        ['joined_at', 'INTEGER'],
        ['activity', 'INTEGER'],
      ] as const) {
        addColumnIfMissing(database, 'clan_roster', column, definition)
      }
      database.exec(PLAYER_EXTERNAL_COUNTRIES_DDL)
    },
  },
  {
    version: 16,
    apply(database) {
      // Сведения об аккаунте (уровень, даты, история кланов и ников, места в
      // рейтингах WT) извлекаются при сохранении снимка. У последних успешных
      // снимков StatShark и официального профиля их достаём из raw_json сразу,
      // чтобы страница игрока не ждала суточного обновления. Сначала id, потом
      // raw_json по одному: таблица не меняется под открытым курсором, а в
      // памяти не больше одного ответа StatShark (до мегабайта).
      addColumnIfMissing(database, 'player_external_snapshots', 'account_json', 'TEXT')
      const latest = database.prepare(`
        SELECT s.id, s.source
        FROM player_external_snapshots s
        WHERE s.status = 'ok'
          AND s.raw_json IS NOT NULL
          AND s.account_json IS NULL
          AND s.source IN ('statshark', 'official-profile')
          AND s.id = (
            SELECT t.id FROM player_external_snapshots t
            WHERE t.identity_id = s.identity_id AND t.source = s.source AND t.status = 'ok'
            ORDER BY t.last_checked_at DESC, t.id DESC
            LIMIT 1
          )
      `).all() as { id: number; source: string }[]
      const readRaw = database.prepare('SELECT raw_json FROM player_external_snapshots WHERE id = ?')
      const update = database.prepare('UPDATE player_external_snapshots SET account_json = ? WHERE id = ?')
      for (const { id, source } of latest) {
        const row = readRaw.get(id) as { raw_json: string } | undefined
        if (row === undefined) continue
        // raw_json проверяется как JSON при записи снимка.
        const document = JSON.parse(row.raw_json) as Record<string, unknown>
        const account = sanitizePlayerAccount(source === 'statshark'
          ? statSharkAccount({ profile: document['profile'], leaderboardHistory: document['leaderboardHistory'] })
          : officialProfileAccount(document))
        if (account !== null) update.run(JSON.stringify(account), id)
      }
    },
  },
  {
    version: 17,
    apply(database) {
      // Блобы событий — 91% базы — в отдельную battle_events, battles —
      // компактная и кластеризованная по session_id (см. battlesTableDdl).
      // Освободившиеся страницы возвращает VACUUM после миграций (initDb).
      database.exec(BATTLE_EVENTS_DDL)
      if (tableColumns(database, 'battles').has('events_blob')) {
        const columns = BATTLES_COLUMNS.join(', ')
        // session_hex добавлялась старой миграцией через ALTER: пустое значение
        // восстанавливается так же, как тогда.
        const source = BATTLES_COLUMNS
          .map((column) => column === 'session_hex'
            ? "COALESCE(NULLIF(session_hex, ''), lower(printf('%016x', CAST(session_id AS INTEGER))))"
            : column)
          .join(', ')
        database.exec(`
          INSERT OR REPLACE INTO battle_events (session_id, events_blob)
            SELECT session_id, events_blob FROM battles WHERE events_blob IS NOT NULL;
          ${battlesTableDdl('battles_compact')}
          INSERT INTO battles_compact (${columns}) SELECT ${source} FROM battles;
          DROP TABLE battles;
          ALTER TABLE battles_compact RENAME TO battles;
        `)
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_battles_start ON battles (start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_battles_session_hex ON battles (session_hex);
        CREATE INDEX IF NOT EXISTS idx_battles_metrics ON battles (duration_sec, player_count, kill_count);
        -- Ни один запрос не читал: префикс idx_bp_clan_session, а поиск по
        -- нику идёт через nick_search (nick COLLATE NOCASE не используется).
        DROP INDEX IF EXISTS idx_bp_clan;
        DROP INDEX IF EXISTS idx_bp_nick;
        DROP INDEX IF EXISTS idx_bp_nick_nocase;
        -- Два почти одинаковых индекса снимков заменяет один покрывающий:
        -- «последний снимок ника в окне» читается из индекса без таблицы.
        DROP INDEX IF EXISTS idx_snapshots_clan_nick;
        DROP INDEX IF EXISTS idx_snapshots_clan_cover;
        CREATE INDEX IF NOT EXISTS idx_snapshots_clan_latest
          ON clan_rating_snapshots (clan_tag, nick, id DESC, rating, seen_at);
      `)
      // Статистика планировщику: до v17 ANALYZE не запускался ни разу.
      database.exec('PRAGMA analysis_limit = 1000; ANALYZE;')
    },
  },
  {
    version: 18,
    apply(database) {
      // Ошибки в данных (аудит 2026-10-02, docs/database.md). Здесь — то, что
      // чинится SQL; поля из блобов событий заполняет и чинит фоновая
      // worker-задача repair-battle-events (db/maintenance.ts).
      database.exec(`
        -- Длительность боя первой версии разбора записана дробной (REAL).
        UPDATE battles SET duration_sec = CAST(ROUND(duration_sec) AS INTEGER)
        WHERE typeof(duration_sec) = 'real';

        -- Остатки прежних версий, о которых код не знает: журнал опроса
        -- кланов июля 2026 и индекс, который не нужен ни одному запросу.
        DROP TABLE IF EXISTS clan_poll_log;
        DROP INDEX IF EXISTS idx_items_updated;

        -- Снимки удалённого источника ThunderInsights: только ошибки запроса,
        -- данных в них нет (внешние ключи не включены — дети вручную).
        DELETE FROM player_external_totals WHERE snapshot_id IN (
          SELECT id FROM player_external_snapshots WHERE source = 'thunderinsights');
        DELETE FROM player_external_vehicles WHERE snapshot_id IN (
          SELECT id FROM player_external_snapshots WHERE source = 'thunderinsights');
        DELETE FROM player_external_countries WHERE snapshot_id IN (
          SELECT id FROM player_external_snapshots WHERE source = 'thunderinsights');
        DELETE FROM player_external_snapshots WHERE source = 'thunderinsights';
        DELETE FROM player_identity_aliases WHERE source = 'thunderinsights';

        -- Бой записан, но повторный разбор после старой миграции не скачал
        -- части: строки прежнего разбора — данные боя, статус ok.
        UPDATE battle_ingest SET status = 'ok', error = NULL
        WHERE status <> 'ok' AND session_id IN (SELECT session_id FROM battles);

        -- Повторный разбор, пока части лежат на CDN (~2 недели): разбор
        -- заново даёт больше, чем починка записанного, — у упавших по
        -- таймауту загрузок (боя в базе нет), у длинных сообщений чата
        -- (прежний разбор потерял их хвост) и у боёв с финальными итогами
        -- без победителя. Без статуса и без победителя — ничья по времени.
        DELETE FROM battle_ingest WHERE session_id IN (
          SELECT g.session_id FROM battle_ingest g
          JOIN items i ON i.source = 'wt-replays' AND i.external_id = g.session_id
          WHERE g.status = 'error'
            AND CAST(json_extract(i.data, '$.startTime') AS INTEGER) >= unixepoch() - 12 * 86400
          UNION
          SELECT b.session_id FROM battles b
          WHERE b.start_time >= unixepoch() - 12 * 86400
            AND ((b.status = 'success' AND b.team_won = 0)
              OR EXISTS (SELECT 1 FROM battle_chat c WHERE c.session_id = b.session_id AND c.channel_valid = 0))
        );
      `)
    },
  },
]

export const DB_SCHEMA_VERSION = validateMigrations(DB_MIGRATIONS)

export function initDb(dbPath: string, options: InitDbOptions = {}): void {
  resetPreparedStatements()
  dbWorkerPath = null
  const isMemoryDatabase = dbPath === ':memory:'
  const resolvedPath = path.resolve(dbPath)
  if (!isMemoryDatabase && !existsSync(resolvedPath) && options.allowCreate !== true) {
    throw new Error(
      `Файл SQLite не найден: ${resolvedPath}. Проверьте DB_PATH или явно задайте WTBOT_ALLOW_NEW_DB=1`,
    )
  }
  if (!isMemoryDatabase) mkdirSync(path.dirname(resolvedPath), { recursive: true })
  const database = new DatabaseSync(dbPath)
  db = database
  try {
    assertSupportedDbVersion(database, DB_SCHEMA_VERSION)
  // Новая база — сразу с auto_vacuum = INCREMENTAL: режим меняется только до
  // первой таблицы, позже — лишь полным VACUUM (минуты на гигабайтах).
  if (pragmaNumber(database, 'page_count') === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL;')
  // WAL: запись не блокирует чтение — сайт отвечает, пока парсеры пишут
  db.exec('PRAGMA journal_mode = WAL;')
  // В WAL коммит с synchronous = NORMAL не ждёт fsync — он идёт при
  // checkpoint. Сбой питания может откатить последние транзакции, но не
  // повредить базу; потерянный бой ingest разберёт заново.
  db.exec('PRAGMA synchronous = NORMAL;')
  // SQLite синхронный и живёт в одном потоке с Discord-ботом: холодное чтение
  // случайных страниц (первый просмотр игрока/клана на сайте) блокировало
  // event loop на секунды. mmap переносит чтение на page cache ОС, большой
  // кэш страниц удерживает рабочий набор, busy_timeout защищает от коротких
  // блокировок при параллельном процессе (backfill/site-real). После выноса
  // блобов (v17) горячие таблицы и индексы — около 0,5 ГиБ: mmap их покрывает.
  db.exec('PRAGMA mmap_size = 1073741824;')
  db.exec('PRAGMA cache_size = -65536;')
  db.exec('PRAGMA busy_timeout = 5000;')
  // После большой транзакции (миграция, VACUUM) WAL-файл не остаётся гигабайтным.
  db.exec('PRAGMA journal_size_limit = 67108864;')
  // PRAGMA optimize (runDbMaintenance, closeDb) анализирует выборку, а не всю таблицу.
  db.exec('PRAGMA analysis_limit = 1000;')
  db.function('wtbot_casefold', { deterministic: true }, (value) =>
    typeof value === 'string' ? normalizePlayerSearchKey(value) : '',
  )
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_usage (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      command  TEXT    NOT NULL,
      guild_id TEXT,
      user_id  TEXT    NOT NULL,
      used_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS parse_results (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      source    TEXT    NOT NULL,
      ok        INTEGER NOT NULL,
      summary   TEXT,
      error     TEXT,
      parsed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_parse_results_source_id
      ON parse_results (source, id DESC);

    -- Собранные парсерами записи (сырые данные конвейера).
    -- UNIQUE(source, external_id) — одна запись источника хранится один раз,
    -- повторный парсинг обновляет её, а не плодит дубликаты.
    CREATE TABLE IF NOT EXISTS items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT    NOT NULL,
      external_id   TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      data          TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_source_updated
      ON items (source, updated_at DESC);

    -- Результаты анализа нейросетью: одна запись анализируется один раз,
    -- результат кэшируется здесь навсегда.
    CREATE TABLE IF NOT EXISTS analyses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL UNIQUE REFERENCES items(id),
      result     TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Словарь кланов с лидерборда сайта: полный тег (с украшениями) → имя
    -- для страницы claninfo и официальная статистика клана на момент
    -- rating_at: рейтинг полковых боёв сезона, место, состав, бои, победы,
    -- фраги, смерти, налёт (минуты), активность, регион, тип, дата основания,
    -- слоган и награды прошлых сезонов (JSON). Обновляет источник wt-clans.
    CREATE TABLE IF NOT EXISTS clans (
      tag          TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      rating       INTEGER,
      position     INTEGER,
      members      INTEGER,
      battles      INTEGER,
      wins         INTEGER,
      rating_at    INTEGER,
      air_kills    INTEGER,
      ground_kills INTEGER,
      deaths       INTEGER,
      flight_time  INTEGER,
      activity     INTEGER,
      region       TEXT,
      clan_type    TEXT,
      founded_at   INTEGER,
      slogan       TEXT,
      rewards      TEXT,
      clan_id      INTEGER,
      description  TEXT,
      announcement TEXT,
      requirements TEXT,
      status       TEXT,
      auto_accept  INTEGER,
      plain_tag    TEXT,
      regalia      TEXT
    );

    -- История официальной статистики по ядру тега (без украшений): строка
    -- пишется только при изменении рейтинга, боёв, побед, фрагов или смертей.
    CREATE TABLE IF NOT EXISTS clan_rating_history (
      clan_core    TEXT    NOT NULL,
      captured_at  INTEGER NOT NULL,
      rating       INTEGER NOT NULL,
      battles      INTEGER,
      wins         INTEGER,
      air_kills    INTEGER,
      ground_kills INTEGER,
      deaths       INTEGER,
      PRIMARY KEY (clan_core, captured_at)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS clan_seasons (
      season_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      starts_at  INTEGER NOT NULL,
      ends_at    INTEGER NOT NULL,
      CHECK (ends_at > starts_at)
    );

    CREATE TABLE IF NOT EXISTS clan_season_stages (
      season_id  TEXT NOT NULL REFERENCES clan_seasons(season_id) ON DELETE CASCADE,
      week       INTEGER NOT NULL,
      starts_at  INTEGER NOT NULL,
      ends_at    INTEGER NOT NULL,
      max_br     REAL NOT NULL,
      PRIMARY KEY (season_id, week),
      CHECK (week > 0 AND ends_at > starts_at AND max_br > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_clan_season_stages_time
      ON clan_season_stages (starts_at, ends_at);

    -- Снимки личного кланового рейтинга (ПКР) участников: новая строка
    -- пишется только когда рейтинг изменился, поэтому два последних снимка
    -- ника дают дельту «за последний бой».
    CREATE TABLE IF NOT EXISTS clan_rating_snapshots (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      clan_tag TEXT    NOT NULL,
      nick     TEXT    NOT NULL,
      nick_base TEXT   NOT NULL,
      rating   INTEGER NOT NULL,
      seen_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- История суммы ПКР клана: диапазон по времени внутри тега без полного обхода.
    CREATE INDEX IF NOT EXISTS idx_snapshots_clan_seen
      ON clan_rating_snapshots (clan_tag, seen_at, id);
    -- Покрывающий индекс рейтингов: последний снимок ника в окне и «последние
    -- 2 снимка на ника» читаются из индекса без обращений к таблице — иначе
    -- холодная страница клана стоила секунды дисковых чтений.
    CREATE INDEX IF NOT EXISTS idx_snapshots_clan_latest
      ON clan_rating_snapshots (clan_tag, nick, id DESC, rating, seen_at);

    -- Текущий состав клана по последнему обходу wt-clans: покинувшие
    -- участники исключаются из сумм, дельт и истории ПКР на сайте.
    -- Ключ — ЯДРО тега (украшения нестабильны и меняются между обходами);
    -- пустой состав ядра = поведение до первого обхода (без фильтра).
    CREATE TABLE IF NOT EXISTS clan_roster (
      clan_core       TEXT    NOT NULL,
      nick            TEXT    NOT NULL,
      last_present_at INTEGER NOT NULL DEFAULT (unixepoch()),
      role            TEXT,
      joined_at       INTEGER,
      activity        INTEGER,
      PRIMARY KEY (clan_core, nick)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_nick
      ON clan_rating_snapshots (nick, id DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_nick_nocase
      ON clan_rating_snapshots (nick COLLATE NOCASE, seen_at DESC);

    -- Стабильная identity игрока отделена от отображаемых ников и provider-ов.
    -- Автоматическое объединение выполняется только по непустому WT user id.
    CREATE TABLE IF NOT EXISTS player_identities (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wt_user_id     TEXT,
      canonical_nick TEXT    NOT NULL,
      platform       TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK (canonical_nick <> ''),
      CHECK (
        wt_user_id IS NULL OR
        (wt_user_id <> '' AND wt_user_id NOT GLOB '*[^0-9]*')
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_player_identities_wt_user
      ON player_identities (wt_user_id)
      WHERE wt_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_player_identities_nick
      ON player_identities (canonical_nick);
    CREATE INDEX IF NOT EXISTS idx_player_identities_nick_nocase
      ON player_identities (canonical_nick COLLATE NOCASE);

    -- Ники и внешние идентификаторы сохраняются как наблюдавшиеся алиасы.
    -- expression-index закрывает особенность SQLite, где NULL в составном
    -- PRIMARY KEY иначе позволил бы несколько одинаковых алиасов.
    CREATE TABLE IF NOT EXISTS player_identity_aliases (
      identity_id     INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      source          TEXT    NOT NULL,
      external_id     TEXT,
      nick            TEXT    NOT NULL,
      nick_base       TEXT    NOT NULL,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      match_method    TEXT    NOT NULL,
      match_confidence TEXT   NOT NULL,
      PRIMARY KEY (identity_id, source, external_id, nick),
      CHECK (source <> '' AND nick <> '' AND nick_base <> ''),
      CHECK (match_method IN ('user_id', 'exact_nick', 'manual')),
      CHECK (match_confidence IN ('high', 'medium', 'low'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_player_aliases_identity_source_key
      ON player_identity_aliases (identity_id, source, ifnull(external_id, ''), nick);
    CREATE INDEX IF NOT EXISTS idx_player_aliases_source_external
      ON player_identity_aliases (source, external_id);
    CREATE INDEX IF NOT EXISTS idx_player_aliases_nick_base
      ON player_identity_aliases (nick_base, source, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_player_aliases_nick_nocase
      ON player_identity_aliases (nick COLLATE NOCASE, last_seen_at DESC);

    -- Raw snapshot хранится независимо от replay-статистики. Неизменившийся
    -- ответ переиспользует строку и двигает только last_checked_at.
    CREATE TABLE IF NOT EXISTS player_external_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id       INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      source            TEXT    NOT NULL,
      source_player_id  TEXT,
      nick              TEXT,
      fetched_at        INTEGER NOT NULL,
      last_checked_at   INTEGER NOT NULL,
      source_updated_at INTEGER,
      status            TEXT    NOT NULL,
      raw_json          TEXT,
      content_hash      TEXT,
      parser_version    TEXT    NOT NULL,
      error             TEXT,
      -- Уровень, даты, история кланов и ников, места в рейтингах WT (account.ts).
      account_json      TEXT,
      CHECK (source <> '' AND parser_version <> ''),
      CHECK (status IN ('ok', 'private', 'not_found', 'rate_limited', 'schema_error', 'error')),
      CHECK (content_hash IS NULL OR length(content_hash) = 64)
    );

    CREATE INDEX IF NOT EXISTS idx_player_snapshots_identity_source_fetched
      ON player_external_snapshots (identity_id, source, fetched_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_player_snapshots_identity_source_checked
      ON player_external_snapshots (identity_id, source, last_checked_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_player_snapshots_source_player
      ON player_external_snapshots (source, source_player_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_player_snapshots_content_hash
      ON player_external_snapshots (content_hash)
      WHERE content_hash IS NOT NULL;

    -- Нормализованные account totals не смешиваются со строками техники:
    -- upstream может считать режимы, победы и категории по-разному.
    CREATE TABLE IF NOT EXISTS player_external_totals (
      snapshot_id     INTEGER NOT NULL REFERENCES player_external_snapshots(id) ON DELETE CASCADE,
      game_type       TEXT,
      mode            TEXT,
      category        TEXT,
      battles         INTEGER,
      victories       INTEGER,
      defeats         INTEGER,
      deaths          INTEGER,
      time_played_sec INTEGER,
      respawns        INTEGER,
      air_kills       INTEGER,
      ground_kills    INTEGER,
      naval_kills     INTEGER,
      CHECK (battles IS NULL OR battles >= 0),
      CHECK (victories IS NULL OR victories >= 0),
      CHECK (defeats IS NULL OR defeats >= 0),
      CHECK (deaths IS NULL OR deaths >= 0),
      CHECK (time_played_sec IS NULL OR time_played_sec >= 0),
      CHECK (respawns IS NULL OR respawns >= 0),
      CHECK (air_kills IS NULL OR air_kills >= 0),
      CHECK (ground_kills IS NULL OR ground_kills >= 0),
      CHECK (naval_kills IS NULL OR naval_kills >= 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_player_external_totals_key
      ON player_external_totals (
        snapshot_id,
        ifnull(game_type, ''),
        ifnull(mode, ''),
        ifnull(category, '')
      );
    CREATE INDEX IF NOT EXISTS idx_player_external_totals_snapshot
      ON player_external_totals (snapshot_id);

    CREATE TABLE IF NOT EXISTS player_external_vehicles (
      snapshot_id     INTEGER NOT NULL REFERENCES player_external_snapshots(id) ON DELETE CASCADE,
      game_type       TEXT,
      mode            TEXT,
      vehicle_id      TEXT    NOT NULL,
      flyouts         INTEGER,
      victories       INTEGER,
      defeats         INTEGER,
      deaths          INTEGER,
      air_kills       INTEGER,
      ground_kills    INTEGER,
      naval_kills     INTEGER,
      time_played_sec INTEGER,
      CHECK (vehicle_id <> ''),
      CHECK (flyouts IS NULL OR flyouts >= 0),
      CHECK (victories IS NULL OR victories >= 0),
      CHECK (defeats IS NULL OR defeats >= 0),
      CHECK (deaths IS NULL OR deaths >= 0),
      CHECK (air_kills IS NULL OR air_kills >= 0),
      CHECK (ground_kills IS NULL OR ground_kills >= 0),
      CHECK (naval_kills IS NULL OR naval_kills >= 0),
      CHECK (time_played_sec IS NULL OR time_played_sec >= 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_player_external_vehicles_key
      ON player_external_vehicles (
        snapshot_id,
        ifnull(game_type, ''),
        ifnull(mode, ''),
        vehicle_id
      );
    CREATE INDEX IF NOT EXISTS idx_player_external_vehicles_snapshot
      ON player_external_vehicles (snapshot_id);

${PLAYER_EXTERNAL_COUNTRIES_DDL}

    -- Кто сейчас сидит в голосовых каналах Discord: пишет бот
    -- (voice-tracker), читает дашборд. Строка удаляется при выходе.
    CREATE TABLE IF NOT EXISTS voice_presence (
      guild_id     TEXT NOT NULL,
      guild_name   TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      display_name TEXT NOT NULL,
      wt_nick      TEXT NOT NULL,
      wt_nick_base TEXT NOT NULL,
      joined_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_voice_wt_nick_nocase
      ON voice_presence (wt_nick COLLATE NOCASE, joined_at DESC);

    -- Служебное состояние бота (например, id последнего
    -- проанонсированного боя) — переживает перезапуски.
    CREATE TABLE IF NOT EXISTS bot_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Одно постоянно обновляемое сообщение со статистикой игроков на guild.
    -- Канал настраивается slash-командой, поэтому конфигурация переживает
    -- перезапуски и не требует перезаписи .env из работающего процесса.
    CREATE TABLE IF NOT EXISTS player_stat_boards (
      guild_id         TEXT PRIMARY KEY,
      channel_id       TEXT    NOT NULL,
      message_id       TEXT    NOT NULL,
      last_content_hash TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK (guild_id <> '' AND channel_id <> '' AND message_id <> ''),
      CHECK (enabled IN (0, 1)),
      CHECK (last_content_hash IS NULL OR length(last_content_hash) = 64)
    );

    CREATE INDEX IF NOT EXISTS idx_player_stat_boards_enabled
      ON player_stat_boards (enabled, guild_id);

    -- Компактная история профиля нужна для дельты за сутки. Список реплеев
    -- сюда намеренно не копируется: он остаётся в текущем items-снимке.
    CREATE TABLE IF NOT EXISTS wt_player_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id  TEXT    NOT NULL,
      nickname     TEXT    NOT NULL,
      data         TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      captured_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK (external_id <> '' AND nickname <> ''),
      CHECK (length(content_hash) = 64)
    );

    CREATE INDEX IF NOT EXISTS idx_wt_player_snapshots_external_time
      ON wt_player_snapshots (external_id, captured_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_wt_player_snapshots_nick_time
      ON wt_player_snapshots (nickname, captured_at DESC, id DESC);

    -- ===== Разобранные бои (ingest пакетного потока .wrpl) =====
    -- Раньше содержимое боя (фраги, очки, техника, победитель, траектории)
    -- жило только в PNG-кэше и разбиралось на лету при нажатии кнопки.
    -- Теперь воркер ingest разбирает каждый бой один раз и раскладывает
    -- его по нормализованным таблицам — это и датасет, и быстрый поиск,
    -- и возможность перерисовать картинки, когда части реплея ушли с CDN.

    -- Один бой: метаданные + победитель + счётчики. session_id совпадает
    -- с items.external_id. События боя — в battle_events.
    ${battlesTableDdl('battles')}
    ${BATTLE_EVENTS_DDL}

    CREATE INDEX IF NOT EXISTS idx_battles_start ON battles (start_time DESC);

    -- Результаты игрока в бою (из results-BLK, с восстановленными никами).
    -- Индекс по нику делает статистику игрока мгновенной вместо LIKE-скана
    -- всех JSON-блобов в items.
    CREATE TABLE IF NOT EXISTS battle_players (
      session_id      TEXT    NOT NULL,
      user_id         TEXT    NOT NULL,
      nick            TEXT    NOT NULL,
      nick_base       TEXT    NOT NULL,
      clan_tag        TEXT    NOT NULL DEFAULT '',
      team            INTEGER NOT NULL,
      kills           INTEGER NOT NULL DEFAULT 0,
      ground_kills    INTEGER NOT NULL DEFAULT 0,
      naval_kills     INTEGER NOT NULL DEFAULT 0,
      ai_kills        INTEGER NOT NULL DEFAULT 0,
      ai_ground_kills INTEGER NOT NULL DEFAULT 0,
      assists         INTEGER NOT NULL DEFAULT 0,
      deaths          INTEGER NOT NULL DEFAULT 0,
      capture_zone    INTEGER NOT NULL DEFAULT 0,
      damage_zone     INTEGER NOT NULL DEFAULT 0,
      score           INTEGER NOT NULL DEFAULT 0,
      award_damage    INTEGER NOT NULL DEFAULT 0,
      team_kills      INTEGER NOT NULL DEFAULT 0,
      squad_id        INTEGER NOT NULL DEFAULT -1,
      vehicle         TEXT,
      vehicles        TEXT    NOT NULL DEFAULT '[]',
      disconnected    INTEGER NOT NULL DEFAULT 0,
      -- Метаданные слота из ECS. NULL означает, что старый реплей их не дал.
      slot            INTEGER,
      title           TEXT,
      -- NULL для старых строк: false и «неизвестно» нельзя смешивать.
      auto_squad      INTEGER,
      PRIMARY KEY (session_id, user_id)
    );

    -- Покрывающий индекс клановых выборок сайта: список сессий клана читается
    -- без table lookup на каждую строку battle_players.
    CREATE INDEX IF NOT EXISTS idx_bp_clan_session ON battle_players (clan_tag, session_id);
    CREATE INDEX IF NOT EXISTS idx_bp_user_id ON battle_players (user_id, session_id);

    -- Убийства с координатами: датасет + перерисовка battle log/хитмапа.
    CREATE TABLE IF NOT EXISTS battle_kills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      time_ms      INTEGER NOT NULL,
      killer_id    TEXT    NOT NULL,
      killer_model TEXT    NOT NULL DEFAULT '',
      victim_id    TEXT    NOT NULL,
      victim_model TEXT    NOT NULL DEFAULT '',
      weapon       TEXT,
      killer_x REAL, killer_y REAL, killer_z REAL,
      victim_x REAL, victim_y REAL, victim_z REAL
    );

    CREATE INDEX IF NOT EXISTS idx_bk_session ON battle_kills (session_id, time_ms);

    -- Чат матча.
    CREATE TABLE IF NOT EXISTS battle_chat (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      time_ms    INTEGER NOT NULL,
      sender     TEXT    NOT NULL,
      channel    INTEGER NOT NULL,
      channel_valid INTEGER NOT NULL DEFAULT 1,
      message    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bchat_session ON battle_chat (session_id, time_ms);

    -- Статус разбора каждого боя: чтобы воркер знал, что уже сделано,
    -- что провалилось (и сколько раз), а что бесполезно повторять
    -- (нет ссылок на части / части ушли с CDN).
    CREATE TABLE IF NOT EXISTS battle_ingest (
      session_id TEXT    PRIMARY KEY,
      status     TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Статус автоанонса по каждому бою (а не одна общая отметка «докуда
    -- дошли»): упавший анонс тогда ретраится, а не теряется навсегда.
    -- ok — отправлен, failed — не удалось (с числом попыток; после лимита
    -- бой пропускается, чтобы битая запись не блокировала очередь).
    CREATE TABLE IF NOT EXISTS announce_state (
      item_id    INTEGER PRIMARY KEY,
      status     TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      message_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  runDbMigrations(db, DB_MIGRATIONS)
  // Post-migration bootstrap: legacy DB могла не иметь player_count/kill_count
  // или session_hex, поэтому эти индексы нельзя создавать в раннем CREATE-блоке.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_battles_session_hex
      ON battles (session_hex);
    CREATE INDEX IF NOT EXISTS idx_battles_metrics
      ON battles (duration_sec, player_count, kill_count);
  `)
  if (!isMemoryDatabase) reclaimFreePages(db)
  // Временные B-деревья ORDER BY/GROUP BY — в памяти. Только после VACUUM:
  // его копия базы — тоже временная и в память не поместилась бы.
  db.exec('PRAGMA temp_store = MEMORY;')
  seedClanSeasons(db)
  seedWtPlayerSnapshots(db)
  dbWorkerPath = isMemoryDatabase ? null : resolvedPath
  } catch (error) {
    resetPreparedStatements()
    try {
      database.close()
    } catch {
      // Исходная ошибка инициализации важнее ошибки закрытия connection.
    }
    db = null
    throw error
  }
}

export function closeDb(): void {
  resetPreparedStatements()
  try {
    // Рекомендация SQLite перед закрытием: обновить статистику таблиц, которые
    // заметно изменились за время работы (выборочно, analysis_limit).
    db?.exec('PRAGMA optimize;')
  } catch (error) {
    console.warn(`[db] PRAGMA optimize при закрытии не выполнен: ${error instanceof Error ? error.message : String(error)}`)
  }
  db?.close()
  db = null
  dbWorkerPath = null
}

export function getDbWorkerPath(): string | null {
  return dbWorkerPath
}

const VACUUM_MIN_FREE_BYTES = 256 * 1024 * 1024
const VACUUM_MIN_FREE_SHARE = 0.2

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row?.[name]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/**
 * Файл базы без auto_vacuum сам не уменьшается: после v17 в нём было ~5,5 ГиБ
 * свободных страниц от прежней battles. VACUUM переписывает базу целиком —
 * минуты на гигабайтах, поэтому только на старте (до Discord и сайта), только
 * при большой доле свободного места и один раз: он же включает
 * auto_vacuum = INCREMENTAL. Дальше свободные страницы возвращает фоновое
 * обслуживание порциями (db/maintenance.ts), а VACUUM на старте не нужен:
 * иначе любой перезапуск после большого освобождения (перевод формата
 * событий) держал бы бота не в сети минуты.
 */
function reclaimFreePages(database: DatabaseSync): void {
  if (pragmaNumber(database, 'auto_vacuum') === 2) return
  const pageSize = pragmaNumber(database, 'page_size')
  const pageCount = pragmaNumber(database, 'page_count')
  const freePages = pragmaNumber(database, 'freelist_count')
  const freeBytes = freePages * pageSize
  if (freeBytes < VACUUM_MIN_FREE_BYTES || freePages < pageCount * VACUUM_MIN_FREE_SHARE) return
  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
  console.log(
    `[db] Свободно ${mib(freeBytes)} МиБ из ${mib(pageCount * pageSize)} МиБ — VACUUM; ` +
      'бот запустится после него (на гигабайтной базе — минуты)',
  )
  const started = performance.now()
  database.exec('PRAGMA auto_vacuum = INCREMENTAL;')
  database.exec('VACUUM;')
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  console.log(
    `[db] VACUUM за ${((performance.now() - started) / 1_000).toFixed(1)} с: ` +
      `${mib(pageCount * pageSize)} → ${mib(pragmaNumber(database, 'page_count') * pageSize)} МиБ`,
  )
}

export interface DbMaintenanceResult {
  /** Страниц возвращено ОС через incremental_vacuum. */
  freedPages: number
  /** Транзакций incremental_vacuum (шагов по VACUUM_STEP_PAGES). */
  steps: number
  /** Свободных страниц осталось в файле. */
  freelistPages: number
  pageSize: number
  /** Таблицы, по которым PRAGMA optimize обновил статистику планировщика. */
  analyzed: string[]
  elapsedMs: number
}

/**
 * Страниц за одну транзакцию incremental_vacuum. Перенос страницы блоба
 * стоит 50–150 мкс, а запись main thread ждёт чужую транзакцию синхронно:
 * порция в 8 192 страницы держала блокировку 1,3 с, и watchdog бота видел
 * такую же паузу event loop (2026-10-02). Шаг в 256 страниц — 13–40 мс.
 */
export const VACUUM_STEP_PAGES = 256
/**
 * Пауза между шагами длиннее интервала busy-ожидания SQLite (до 100 мс):
 * ждущая запись main thread успевает взять блокировку между шагами.
 */
const VACUUM_STEP_PAUSE_MS = 100

/**
 * Обслуживание на отдельном подключении worker-задачи (db/maintenance.ts),
 * а не на main thread. PRAGMA optimize обновляет статистику планировщика по
 * заметно изменившимся таблицам; incremental_vacuum возвращает ОС не больше
 * maxPages свободных страниц короткими транзакциями по VACUUM_STEP_PAGES.
 */
export async function runDbMaintenance(
  database: DatabaseSync,
  options: { maxPages: number; optimize: boolean },
): Promise<DbMaintenanceResult> {
  const started = performance.now()
  let analyzed: string[] = []
  if (options.optimize) {
    database.exec('PRAGMA analysis_limit = 1000;')
    // Свежее подключение ещё не выполняло запросов, а без флага 0x10000
    // PRAGMA optimize смотрит только таблицы из запросов этого подключения.
    // 0x10003 — тот же отбор без выполнения: список таблиц для лога.
    analyzed = (database.prepare('PRAGMA optimize(0x10003)').all() as { optimize?: unknown }[])
      .map((row) => /"main"\."([^"]+)"/.exec(String(row.optimize ?? ''))?.[1] ?? String(row.optimize ?? ''))
    if (analyzed.length > 0) database.exec('PRAGMA optimize(0x10002);')
  }
  let freedPages = 0
  let steps = 0
  if (pragmaNumber(database, 'auto_vacuum') === 2) {
    while (freedPages < options.maxPages) {
      const before = pragmaNumber(database, 'freelist_count')
      if (before === 0) break
      if (steps > 0) await new Promise((resolve) => setTimeout(resolve, VACUUM_STEP_PAUSE_MS))
      const pages = Math.min(VACUUM_STEP_PAGES, Math.floor(options.maxPages) - freedPages, before)
      database.exec(`PRAGMA incremental_vacuum(${pages});`)
      const freed = before - pragmaNumber(database, 'freelist_count')
      steps += 1
      if (freed <= 0) break
      freedPages += freed
    }
  }
  return {
    freedPages,
    steps,
    freelistPages: pragmaNumber(database, 'freelist_count'),
    pageSize: pragmaNumber(database, 'page_size'),
    analyzed,
    elapsedMs: performance.now() - started,
  }
}

// ---------- Статистика команд ----------

export interface CommandStats {
  total: number
  byCommand: { command: string; count: number }[]
}

export function recordCommandUse(command: string, guildId: string | null, userId: string): void {
  getDb()
    .prepare('INSERT INTO command_usage (command, guild_id, user_id) VALUES (?, ?, ?)')
    .run(command, guildId, userId)
  commandStatsCache = null
}

export function getCommandStats(): CommandStats {
  const dataVersion = getDataVersion()
  if (commandStatsCache?.dataVersion === dataVersion) return commandStatsCache.value
  selectCommandTotalStatement ??= getDb().prepare('SELECT COUNT(*) AS count FROM command_usage')
  selectCommandBreakdownStatement ??= getDb().prepare(
    'SELECT command, COUNT(*) AS count FROM command_usage GROUP BY command ORDER BY count DESC',
  )
  const total = selectCommandTotalStatement.get() as { count: number } | undefined
  const byCommand = selectCommandBreakdownStatement.all() as unknown as { command: string; count: number }[]
  const value = { total: total?.count ?? 0, byCommand }
  commandStatsCache = { dataVersion, value }
  return value
}

// ---------- Результаты запусков парсеров ----------

export interface ParseRecord {
  source: string
  ok: boolean
  summary: string | null
  error: string | null
  /** Unix-время в секундах */
  parsedAt: number
}

interface ParseRow {
  source: string
  ok: number
  summary: string | null
  error: string | null
  parsed_at: number
}

function toParseRecord(row: ParseRow): ParseRecord {
  return {
    source: row.source,
    ok: row.ok === 1,
    summary: row.summary,
    error: row.error,
    parsedAt: row.parsed_at,
  }
}

/** Когда в последний раз подрезали историю каждого источника (в памяти) */
const lastParseCleanup = new Map<string, number>()
const PARSE_CLEANUP_INTERVAL_MS = 60 * 60_000

export function recordParseResult(
  source: string,
  ok: boolean,
  summary: string | null,
  error: string | null,
): void {
  recordParseResultInDatabase(getDb(), source, ok, summary, error)
}

export function recordParseResultInDatabase(
  database: DatabaseSync,
  source: string,
  ok: boolean,
  summary: string | null,
  error: string | null,
): void {
  database
    .prepare('INSERT INTO parse_results (source, ok, summary, error) VALUES (?, ?, ?, ?)')
    .run(source, ok ? 1 : 0, summary, error)

  // История не должна расти бесконечно (wt-replays пишет раз в 20 с), но и
  // подрезать её на каждой вставке — 4320 DELETE в сутки на источник — ни к
  // чему. Чистим не чаще раза в час на источник; держим последние 1000 строк.
  const now = Date.now()
  if (now - (lastParseCleanup.get(source) ?? 0) < PARSE_CLEANUP_INTERVAL_MS) return
  lastParseCleanup.set(source, now)
  database
    .prepare(`
      DELETE FROM parse_results
      WHERE source = ? AND id NOT IN (
        SELECT id FROM parse_results WHERE source = ? ORDER BY id DESC LIMIT 1000
      )
    `)
    .run(source, source)
}

/** Последний результат каждого источника — для дашборда и команды /stats */
export function getLatestParsePerSource(): ParseRecord[] {
  const rows = getDb()
    .prepare(`
      SELECT p.source, p.ok, p.summary, p.error, p.parsed_at
      FROM parse_results p
      JOIN (SELECT source, MAX(id) AS max_id FROM parse_results GROUP BY source) last
        ON p.id = last.max_id
      ORDER BY p.source
    `)
    .all() as unknown as ParseRow[]
  return rows.map(toParseRecord)
}

/** История запусков одного источника */
export function getParseHistory(source: string, limit = 50): ParseRecord[] {
  const rows = getDb()
    .prepare(`
      SELECT source, ok, summary, error, parsed_at
      FROM parse_results
      WHERE source = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(source, limit) as unknown as ParseRow[]
  return rows.map(toParseRecord)
}

// ---------- Собранные записи (items) ----------

/** Запись, которую возвращает парсер */
export interface ParsedItem {
  /** Уникальный ид записи на источнике (url, id из API и т.п.) */
  externalId: string
  /** Заголовок — показывается в списках на дашборде */
  title: string
  /** Полные данные записи — сохраняются как JSON, структура любая */
  data: Record<string, unknown>
}

export interface SaveItemsResult {
  /** Новых или обновившихся записей */
  changed: number
  /** Записей без изменений (пропущены по хэшу) */
  unchanged: number
}

interface ItemIdRow {
  id: number
}

interface ItemKeyRow extends ItemIdRow {
  external_id: string
}

const WT_PLAYER_SNAPSHOT_RETENTION_MS = 400 * 24 * 60 * 60_000
const WT_PLAYER_SNAPSHOT_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Оставляет только поля, нужные табло и истории, без массива replay metadata. */
function wtPlayerSnapshotData(data: Record<string, unknown>): Record<string, unknown> | null {
  const profile = data['profile']
  const statistics = data['statistics']
  const replayCount = data['replayCount']
  if (!isRecordValue(profile) || !isRecordValue(statistics)) return null
  if (typeof replayCount !== 'number' || !Number.isFinite(replayCount)) return null
  return { profile, statistics, replayCount }
}

function cleanupWtPlayerSnapshots(database: DatabaseSync): void {
  const now = Date.now()
  if (now - lastWtPlayerSnapshotCleanupAt < WT_PLAYER_SNAPSHOT_CLEANUP_INTERVAL_MS) return
  lastWtPlayerSnapshotCleanupAt = now
  database
    .prepare('DELETE FROM wt_player_snapshots WHERE captured_at < ?')
    .run(Math.floor((now - WT_PLAYER_SNAPSHOT_RETENTION_MS) / 1000))
}

function captureWtPlayerSnapshot(
  database: DatabaseSync,
  externalId: string,
  item: ParsedItem,
  capturedAtOverride?: number,
): void {
  const snapshot = wtPlayerSnapshotData(item.data)
  if (snapshot === null || externalId === '' || item.title === '') return
  cleanupWtPlayerSnapshots(database)

  const data = JSON.stringify(snapshot)
  const hash = createHash('sha256').update(data).digest('hex')
  const latest = database
    .prepare(`
      SELECT content_hash
      FROM wt_player_snapshots
      WHERE external_id = ? OR nickname = ?
      ORDER BY (external_id = ?) DESC, captured_at DESC, id DESC
      LIMIT 1
    `)
    .get(externalId, item.title, externalId) as { content_hash: string } | undefined
  if (latest?.content_hash === hash) return

  database
    .prepare(`
      INSERT INTO wt_player_snapshots (external_id, nickname, data, content_hash, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(externalId, item.title, data, hash, capturedAtOverride ?? Math.floor(Date.now() / 1000))
}

/** Заполняет историю из уже сохранённого items после добавления новой таблицы. */
function seedWtPlayerSnapshots(database: DatabaseSync): void {
  const rows = database
    .prepare(`
      SELECT external_id, title, data, updated_at
      FROM items
      WHERE source = 'wt-players'
    `)
    .all() as unknown as Array<{ external_id: string; title: string; data: string; updated_at: number }>
  for (const row of rows) {
    try {
      const data: unknown = JSON.parse(row.data)
      if (!isRecordValue(data)) continue
      captureWtPlayerSnapshot(
        database,
        row.external_id,
        { externalId: row.external_id, title: row.title, data },
        row.updated_at,
      )
    } catch {
      // Повреждённая старая запись не должна блокировать запуск приложения.
    }
  }
}

function removeWtPlayerDuplicate(database: DatabaseSync, fallbackId: number, stableId: number): void {
  const fallbackAnalysis = database
    .prepare('SELECT 1 AS one FROM analyses WHERE item_id = ?')
    .get(fallbackId)
  const stableAnalysis = database
    .prepare('SELECT 1 AS one FROM analyses WHERE item_id = ?')
    .get(stableId)
  if (fallbackAnalysis !== undefined && stableAnalysis === undefined) {
    database
      .prepare('UPDATE analyses SET item_id = ? WHERE item_id = ?')
      .run(stableId, fallbackId)
  } else if (fallbackAnalysis !== undefined) {
    database.prepare('DELETE FROM analyses WHERE item_id = ?').run(fallbackId)
  }
  database.prepare('DELETE FROM announce_state WHERE item_id = ?').run(fallbackId)
  database.prepare('DELETE FROM items WHERE id = ?').run(fallbackId)
}

function findStableWtPlayer(database: DatabaseSync, item: ParsedItem): ItemKeyRow | undefined {
  if (item.externalId !== item.title || item.title === '') return undefined
  return database
    .prepare(`
      SELECT id, external_id
      FROM items
      WHERE source = ? AND title = ? AND external_id <> ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `)
    .get('wt-players', item.title, item.title) as ItemKeyRow | undefined
}

/**
 * При первом запуске wt-players replay identity может быть ещё недоступен,
 * поэтому source временно сохраняет запись с external_id == title. Когда API
 * позже отдаёт постоянный userId, переносим такую запись на стабильный ключ,
 * чтобы не оставить две карточки одного игрока. Обратный fallback-снимок при
 * временно пустом Replay API также обновляет уже известную stable-запись.
 */
function reconcileWtPlayerFallback(database: DatabaseSync, item: ParsedItem): boolean {
  if (item.externalId === item.title || item.title === '') return false

  const fallback = database
    .prepare('SELECT id FROM items WHERE source = ? AND external_id = ?')
    .get('wt-players', item.title) as ItemIdRow | undefined
  if (fallback === undefined) return false

  const stable = database
    .prepare('SELECT id FROM items WHERE source = ? AND external_id = ?')
    .get('wt-players', item.externalId) as ItemIdRow | undefined
  if (stable === undefined) {
    database
      .prepare('UPDATE items SET external_id = ? WHERE id = ?')
      .run(item.externalId, fallback.id)
    return true
  }
  if (stable.id === fallback.id) return false

  removeWtPlayerDuplicate(database, fallback.id, stable.id)
  return true
}

/**
 * Пакетное сохранение: вся пачка пишется в одной транзакции —
 * тысячи записей за миллисекунды. Неизменившиеся записи пропускаются
 * (сравнение по content_hash), поэтому повторный парсинг почти бесплатен.
 */
export function saveItems(source: string, items: ParsedItem[]): SaveItemsResult {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO items (source, external_id, title, data, content_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source, external_id) DO UPDATE SET
      title = excluded.title,
      data = excluded.data,
      content_hash = excluded.content_hash,
      updated_at = unixepoch()
    WHERE excluded.content_hash <> items.content_hash
  `)

  let changed = 0
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const item of items) {
      const data = JSON.stringify(item.data)
      const hash = createHash('sha256')
        .update(item.title)
        .update('\0')
        .update(data)
        .digest('hex')

      if (source === 'wt-players') {
        const stableFallback = findStableWtPlayer(database, item)
        if (stableFallback !== undefined) {
          const fallback = database
            .prepare('SELECT id FROM items WHERE source = ? AND external_id = ?')
            .get('wt-players', item.title) as ItemIdRow | undefined
          if (fallback !== undefined && fallback.id !== stableFallback.id) {
            removeWtPlayerDuplicate(database, fallback.id, stableFallback.id)
          }
          const result = database
            .prepare(`
              UPDATE items
              SET title = ?, data = ?, content_hash = ?, updated_at = unixepoch()
              WHERE id = ? AND content_hash <> ?
            `)
            .run(item.title, data, hash, stableFallback.id, hash)
          changed += fallback !== undefined || Number(result.changes) > 0 ? 1 : 0
          captureWtPlayerSnapshot(database, stableFallback.external_id, item)
          continue
        }
      }

      const migratedFallback = source === 'wt-players'
        ? reconcileWtPlayerFallback(database, item)
        : false
      const result = stmt.run(source, item.externalId, item.title, data, hash)
      changed += migratedFallback || Number(result.changes) > 0 ? 1 : 0
      if (source === 'wt-players') captureWtPlayerSnapshot(database, item.externalId, item)
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  if (changed > 0) {
    itemStatsCache = null
    ingestStatsCache = null
  }
  const knownIds = knownItemExternalIds.get(source)
  if (knownIds) {
    for (const item of items) knownIds.add(item.externalId)
  }
  return { changed, unchanged: items.length - changed }
}

export function primeKnownItemExternalIds(source: string): number {
  const rows = getDb()
    .prepare('SELECT external_id FROM items WHERE source = ?')
    .all(source) as unknown as Array<{ external_id: string }>
  knownItemExternalIds.set(source, new Set(rows.map((row) => row.external_id)))
  return rows.length
}

/** Есть ли уже запись этого источника с таким externalId (для инкрементального парсинга) */
export function hasItem(source: string, externalId: string): boolean {
  const knownIds = knownItemExternalIds.get(source)
  if (knownIds?.has(externalId)) return true
  const row = getDb()
    .prepare('SELECT 1 AS one FROM items WHERE source = ? AND external_id = ?')
    .get(source, externalId)
  if (row !== undefined) knownIds?.add(externalId)
  return row !== undefined
}

export interface ItemStats {
  total: number
  bySource: { source: string; count: number }[]
}

export function getItemStats(): ItemStats {
  const dataVersion = getDataVersion()
  if (itemStatsCache?.dataVersion === dataVersion) return itemStatsCache.value
  selectItemTotalStatement ??= getDb().prepare('SELECT COUNT(*) AS count FROM items')
  selectItemBreakdownStatement ??= getDb().prepare(
    'SELECT source, COUNT(*) AS count FROM items GROUP BY source ORDER BY count DESC',
  )
  const total = selectItemTotalStatement.get() as { count: number } | undefined
  const bySource = selectItemBreakdownStatement.all() as unknown as { source: string; count: number }[]
  const value = { total: total?.count ?? 0, bySource }
  itemStatsCache = { dataVersion, value }
  return value
}

/** Сохранённая запись вместе с результатом анализа (если он есть) */
export interface StoredItem {
  id: number
  source: string
  externalId: string
  title: string
  data: unknown
  updatedAt: number
  analysis: string | null
}

/** Ingest-item с точным временем первого обнаружения источником. */
export interface PendingBattleItem extends StoredItem {
  firstSeenAt: number
}

interface ItemRow {
  id: number
  source: string
  external_id: string
  title: string
  data: string
  updated_at: number
  analysis: string | null
}

function toStoredItem(row: ItemRow): StoredItem {
  let data: unknown = null
  try {
    data = JSON.parse(row.data)
  } catch {
    data = row.data
  }
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    title: row.title,
    data,
    updatedAt: row.updated_at,
    analysis: row.analysis,
  }
}

/** Одна запись источника по её externalId (например, sessionId реплея) */
export function getItemByExternalId(source: string, externalId: string): StoredItem | null {
  const row = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, a.result AS analysis
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      WHERE i.source = ? AND i.external_id = ?
    `)
    .get(source, externalId) as unknown as ItemRow | undefined
  return row ? toStoredItem(row) : null
}


/** Максимальный id записей источника (0 — записей нет) */
export function getMaxItemId(source: string): number {
  const row = getDb().prepare('SELECT MAX(id) AS m FROM items WHERE source = ?').get(source) as
    | { m: number | null }
    | undefined
  return row?.m ?? 0
}

// ---------- Очередь автоанонса боёв (announce_state) ----------

export type AnnounceStatus = 'pending' | 'ok' | 'failed'

export interface PendingAnnounceItem extends StoredItem {
  announceStatus: AnnounceStatus | null
  announceAttempts: number
  announceMessageId: string | null
}

export type AnnounceQueueOrder = 'newest' | 'oldest'

/** Предварительное сообщение отправлено; после ingest оно будет заменено PNG. */
export function markAnnouncePending(itemId: number, messageId: string): void {
  getDb()
    .prepare(`
      INSERT INTO announce_state (item_id, status, attempts, error, message_id, updated_at)
      VALUES (?, 'pending', 0, NULL, ?, unixepoch())
      ON CONFLICT (item_id) DO UPDATE SET
        status = 'pending',
        attempts = 0,
        error = NULL,
        message_id = excluded.message_id,
        updated_at = unixepoch()
    `)
    .run(itemId, messageId)
}

/** Записывает исход анонса боя; при повторе увеличивает счётчик попыток */
export function markAnnounce(itemId: number, status: AnnounceStatus, error: string | null = null): void {
  getDb()
    .prepare(`
      INSERT INTO announce_state (item_id, status, attempts, error, updated_at)
      VALUES (?, ?, 1, ?, unixepoch())
      ON CONFLICT (item_id) DO UPDATE SET
        status = excluded.status,
        attempts = announce_state.attempts + 1,
        error = excluded.error,
        updated_at = unixepoch()
    `)
    .run(itemId, status, error)
}

/**
 * Бои для автоанонса: новее baseline (первый запуск ставит его на текущий
 * максимум — историю не постим), ещё не отправленные и не исчерпавшие
 * попытки. Новые первыми — live-бой не ждёт завершения большого catch-up.
 */
export function getPendingAnnounce(
  baselineId: number,
  maxAttempts: number,
  limit: number,
  order: AnnounceQueueOrder = 'newest',
): PendingAnnounceItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at,
             NULL AS analysis, a.status AS announce_status,
             COALESCE(a.attempts, 0) AS announce_attempts,
             a.message_id AS announce_message_id
      FROM items i
      LEFT JOIN announce_state a ON a.item_id = i.id
      WHERE i.source = 'wt-replays' AND i.id > ?
        AND (
          a.item_id IS NULL
          OR (a.status IN ('pending', 'failed') AND a.attempts < ?)
        )
      ORDER BY i.id ${order === 'oldest' ? 'ASC' : 'DESC'}
      LIMIT ?
    `)
    .all(baselineId, maxAttempts, limit) as unknown as Array<
      ItemRow & {
        announce_status: AnnounceStatus | null
        announce_attempts: number
        announce_message_id: string | null
      }
    >
  return rows.map((row) => ({
    ...toStoredItem(row),
    announceStatus: row.announce_status,
    announceAttempts: row.announce_attempts,
    announceMessageId: row.announce_message_id,
  }))
}

/**
 * Помечает решёнными (без публикации) ждущие анонса бои, начавшиеся раньше
 * cutoffSec. Трогает только бои без предварительного сообщения в Discord:
 * такое сообщение обычный путь анонса обязан дописать или удалить.
 * Возвращает число пропущенных боёв.
 */
export function skipStaleAnnounce(baselineId: number, maxAttempts: number, cutoffSec: number): number {
  const result = getDb()
    .prepare(`
      INSERT INTO announce_state (item_id, status, attempts, error, updated_at)
      SELECT i.id, 'ok', COALESCE(a.attempts, 0), 'устарел — не анонсирован', unixepoch()
      FROM items i
      LEFT JOIN announce_state a ON a.item_id = i.id
      WHERE i.source = 'wt-replays' AND i.id > ?
        AND json_extract(i.data, '$.startTime') < ?
        AND (
          a.item_id IS NULL
          OR (a.status = 'failed' AND a.attempts < ? AND a.message_id IS NULL)
        )
      ON CONFLICT (item_id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `)
    .run(baselineId, cutoffSec, maxAttempts)
  return Number(result.changes)
}

/**
 * Новое значение baseline: id самого старого ещё не решённого боя минус 1
 * (всё до него уже отправлено или окончательно пропущено), а если решены
 * все — текущий максимум. Так окно сканирования не растёт бесконечно, но
 * ни один ждущий бой не перепрыгивается.
 */
export function nextAnnounceBaseline(currentBaseline: number, maxAttempts: number): number {
  const row = getDb()
    .prepare(`
      SELECT MIN(i.id) AS oldest
      FROM items i
      LEFT JOIN announce_state a ON a.item_id = i.id
      WHERE i.source = 'wt-replays' AND i.id > ?
        AND (
          a.item_id IS NULL
          OR (a.status IN ('pending', 'failed') AND a.attempts < ?)
        )
    `)
    .get(currentBaseline, maxAttempts) as { oldest: number | null } | undefined
  return row?.oldest != null ? row.oldest - 1 : getMaxItemId('wt-replays')
}

// ---------- Служебное состояние бота ----------

export function getBotState(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setBotState(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

export function deleteBotState(key: string): void {
  getDb().prepare('DELETE FROM bot_state WHERE key = ?').run(key)
}

export interface ClanSeasonContext {
  season: {
    id: string
    name: string
    startsAt: number
    endsAt: number
    active: boolean
  } | null
  stages: {
    week: number
    startsAt: number
    endsAt: number
    maxBr: number
  }[]
  currentStage: {
    week: number
    startsAt: number
    endsAt: number
    maxBr: number
  } | null
}

/** Расписание сезона хранится в SQLite, чтобы границы не зависели от часов процесса. */
export function getClanSeasonContext(nowSec = Math.floor(Date.now() / 1_000)): ClanSeasonContext {
  const database = getDb()
  const seasonRow = database.prepare(`
    SELECT season_id, name, starts_at, ends_at
    FROM clan_seasons
    WHERE starts_at <= ?
    ORDER BY starts_at DESC
    LIMIT 1
  `).get(nowSec) as {
    season_id: string
    name: string
    starts_at: number
    ends_at: number
  } | undefined
  if (!seasonRow) return { season: null, stages: [], currentStage: null }

  const stages = database.prepare(`
    SELECT week, starts_at, ends_at, max_br
    FROM clan_season_stages
    WHERE season_id = ?
    ORDER BY week
  `).all(seasonRow.season_id) as unknown as {
    week: number
    starts_at: number
    ends_at: number
    max_br: number
  }[]
  const mappedStages = stages.map((stage) => ({
    week: stage.week,
    startsAt: stage.starts_at,
    endsAt: stage.ends_at,
    maxBr: stage.max_br,
  }))
  const schedule = { stages: mappedStages }
  return {
    season: {
      id: seasonRow.season_id,
      name: seasonRow.name,
      startsAt: seasonRow.starts_at,
      endsAt: seasonRow.ends_at,
      active: nowSec < seasonRow.ends_at,
    },
    stages: mappedStages,
    currentStage: stageAt(schedule, nowSec),
  }
}

function currentClanSeasonStart(): number {
  return getClanSeasonContext().season?.startsAt ?? 0
}

export interface ForumClanSeasonSyncResult {
  inserted: string[]
  updated: string[]
  unchanged: string[]
  /** Прежние версии сезона с форума (сдвинулось начало), которые заменила новая. */
  replaced: string[]
}

/**
 * Записывает сезоны, разобранные с форума (id `forum-…`). Если модераторы
 * сдвинули начало сезона, у него новый id: прежняя forum-запись с пересекающимся
 * интервалом удаляется. Пересечение со встроенным сезоном из кода — ошибка:
 * значит, форум противоречит проверенному расписанию, и молча выбирать нельзя.
 */
export function syncForumClanSeasons(schedules: readonly ClanSeasonSchedule[]): ForumClanSeasonSyncResult {
  const database = getDb()
  const result: ForumClanSeasonSyncResult = { inserted: [], updated: [], unchanged: [], replaced: [] }
  const overlapStmt = database.prepare(`
    SELECT season_id FROM clan_seasons
    WHERE season_id <> ? AND starts_at < ? AND ends_at > ?
  `)
  const seasonRowStmt = database.prepare(`
    SELECT name, starts_at, ends_at FROM clan_seasons WHERE season_id = ?
  `)
  const stageRowsStmt = database.prepare(`
    SELECT week, starts_at, ends_at, max_br FROM clan_season_stages WHERE season_id = ? ORDER BY week
  `)
  const deleteStagesStmt = database.prepare('DELETE FROM clan_season_stages WHERE season_id = ?')
  const deleteSeasonStmt = database.prepare('DELETE FROM clan_seasons WHERE season_id = ?')
  const seasonStmt = database.prepare(`
    INSERT INTO clan_seasons (season_id, name, starts_at, ends_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(season_id) DO UPDATE SET
      name = excluded.name,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at
  `)
  const stageStmt = database.prepare(`
    INSERT INTO clan_season_stages (season_id, week, starts_at, ends_at, max_br)
    VALUES (?, ?, ?, ?, ?)
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const season of schedules) {
      if (!season.id.startsWith(FORUM_SEASON_ID_PREFIX)) {
        throw new Error(`сезон ${season.id}: с форума принимаются только id ${FORUM_SEASON_ID_PREFIX}…`)
      }
      const overlapping = (overlapStmt.all(season.id, season.endsAt, season.startsAt) as { season_id: string }[])
        .map((row) => row.season_id)
      const builtIn = overlapping.filter((id) => !id.startsWith(FORUM_SEASON_ID_PREFIX))
      if (builtIn.length > 0) {
        throw new Error(`сезон ${season.id} с форума пересекается со встроенным сезоном ${builtIn.join(', ')}`)
      }
      for (const id of overlapping) {
        deleteStagesStmt.run(id)
        deleteSeasonStmt.run(id)
        result.replaced.push(id)
      }

      const current = seasonRowStmt.get(season.id) as { name: string; starts_at: number; ends_at: number } | undefined
      const currentStages = stageRowsStmt.all(season.id) as { week: number; starts_at: number; ends_at: number; max_br: number }[]
      const same = current !== undefined
        && current.name === season.name
        && current.starts_at === season.startsAt
        && current.ends_at === season.endsAt
        && currentStages.length === season.stages.length
        && season.stages.every((stage, index) => {
          const row = currentStages[index]!
          return row.week === stage.week && row.starts_at === stage.startsAt
            && row.ends_at === stage.endsAt && row.max_br === stage.maxBr
        })
      if (same) {
        result.unchanged.push(season.id)
        continue
      }
      seasonStmt.run(season.id, season.name, season.startsAt, season.endsAt)
      deleteStagesStmt.run(season.id)
      for (const stage of season.stages) {
        stageStmt.run(season.id, stage.week, stage.startsAt, stage.endsAt, stage.maxBr)
      }
      ;(current === undefined ? result.inserted : result.updated).push(season.id)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return result
}

function seedClanSeasons(database: DatabaseSync): void {
  const seasonStmt = database.prepare(`
    INSERT INTO clan_seasons (season_id, name, starts_at, ends_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(season_id) DO UPDATE SET
      name = excluded.name,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at
  `)
  const stageStmt = database.prepare(`
    INSERT INTO clan_season_stages (season_id, week, starts_at, ends_at, max_br)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(season_id, week) DO UPDATE SET
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      max_br = excluded.max_br
  `)
  // Этапы, убранные из расписания, иначе остались бы в SQLite навсегда:
  // upsert обновляет только существующие недели.
  const pruneStagesStmt = database.prepare(`
    DELETE FROM clan_season_stages WHERE season_id = ? AND week > ?
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const season of CLAN_SEASON_SCHEDULES) {
      seasonStmt.run(season.id, season.name, season.startsAt, season.endsAt)
      for (const stage of season.stages) {
        stageStmt.run(season.id, stage.week, stage.startsAt, stage.endsAt, stage.maxBr)
      }
      pruneStagesStmt.run(season.id, season.stages.length)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export interface PlayerStatBoard {
  guildId: string
  channelId: string
  messageId: string
  lastContentHash: string | null
  enabled: boolean
  updatedAt: number
}

interface PlayerStatBoardRow {
  guild_id: string
  channel_id: string
  message_id: string
  last_content_hash: string | null
  enabled: number
  updated_at: number
}

function toPlayerStatBoard(row: PlayerStatBoardRow): PlayerStatBoard {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    lastContentHash: row.last_content_hash,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }
}

export function getPlayerStatBoard(guildId: string): PlayerStatBoard | null {
  const row = getDb()
    .prepare(`
      SELECT guild_id, channel_id, message_id, last_content_hash, enabled, updated_at
      FROM player_stat_boards
      WHERE guild_id = ?
    `)
    .get(guildId) as PlayerStatBoardRow | undefined
  return row ? toPlayerStatBoard(row) : null
}

export function getEnabledPlayerStatBoards(): PlayerStatBoard[] {
  const rows = getDb()
    .prepare(`
      SELECT guild_id, channel_id, message_id, last_content_hash, enabled, updated_at
      FROM player_stat_boards
      WHERE enabled = 1
      ORDER BY guild_id
    `)
    .all() as unknown as PlayerStatBoardRow[]
  return rows.map(toPlayerStatBoard)
}

export function savePlayerStatBoard(
  guildId: string,
  channelId: string,
  messageId: string,
  contentHash: string,
): void {
  if (guildId === '' || channelId === '' || messageId === '') {
    throw new Error('guildId, channelId и messageId табло не должны быть пустыми')
  }
  getDb()
    .prepare(`
      INSERT INTO player_stat_boards (
        guild_id, channel_id, message_id, last_content_hash, enabled
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        last_content_hash = excluded.last_content_hash,
        enabled = 1,
        updated_at = unixepoch()
    `)
    .run(guildId, channelId, messageId, contentHash)
}

export function updatePlayerStatBoardPublication(
  guildId: string,
  messageId: string,
  contentHash: string,
): void {
  updatePlayerStatBoardPublicationInDatabase(getDb(), guildId, messageId, contentHash)
}

export function updatePlayerStatBoardPublicationInDatabase(
  database: DatabaseSync,
  guildId: string,
  messageId: string,
  contentHash: string,
): void {
  database
    .prepare(`
      UPDATE player_stat_boards
      SET message_id = ?, last_content_hash = ?, updated_at = unixepoch()
      WHERE guild_id = ? AND enabled = 1
    `)
    .run(messageId, contentHash, guildId)
}

export function disablePlayerStatBoard(guildId: string): boolean {
  const result = getDb()
    .prepare(`
      UPDATE player_stat_boards
      SET enabled = 0, updated_at = unixepoch()
      WHERE guild_id = ? AND enabled = 1
    `)
    .run(guildId)
  return Number(result.changes) > 0
}

export function getLatestItems(limit = 20, source?: string): StoredItem[] {
  const sql = `
    SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, a.result AS analysis
    FROM items i
    LEFT JOIN analyses a ON a.item_id = i.id
    ${source ? 'WHERE i.source = ?' : ''}
    ORDER BY i.updated_at DESC, i.id DESC
    LIMIT ?
  `
  const params = source ? [source, limit] : [limit]
  const rows = getDb().prepare(sql).all(...params) as unknown as ItemRow[]
  return rows.map(toStoredItem)
}

export interface ItemSummary {
  id: number
  source: string
  externalId: string
  title: string
  updatedAt: number
  analyzed: boolean
}

export const DASHBOARD_LATEST_ITEMS_SQL = `
  SELECT
    i.id,
    i.source,
    i.external_id,
    i.title,
    i.updated_at,
    EXISTS(SELECT 1 FROM analyses a WHERE a.item_id = i.id) AS analyzed
  FROM items i
  ORDER BY i.id DESC
  LIMIT ?
`

/** Последние записи для дашборда без чтения и JSON-разбора большого items.data. */
export function getLatestItemSummaries(limit = 8): ItemSummary[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Лимит последних записей должен быть целым от 1 до 100')
  }
  selectLatestItemSummariesStatement ??= getDb().prepare(DASHBOARD_LATEST_ITEMS_SQL)
  const rows = selectLatestItemSummariesStatement.all(limit) as unknown as Array<{
    id: number
    source: string
    external_id: string
    title: string
    updated_at: number
    analyzed: number
  }>
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    title: row.title,
    updatedAt: row.updated_at,
    analyzed: row.analyzed === 1,
  }))
}

export interface WtPlayerSnapshot {
  id: number
  externalId: string
  nickname: string
  data: Record<string, unknown>
  capturedAt: number
}

interface WtPlayerSnapshotRow {
  id: number
  external_id: string
  nickname: string
  data: string
  captured_at: number
}

/** Последнее известное состояние не новее указанного Unix-времени. */
export function getWtPlayerSnapshotAtOrBefore(
  externalId: string,
  nickname: string,
  unixTime: number,
): WtPlayerSnapshot | null {
  const row = getDb()
    .prepare(`
      SELECT id, external_id, nickname, data, captured_at
      FROM wt_player_snapshots
      WHERE captured_at <= ? AND (external_id = ? OR nickname = ?)
      ORDER BY (external_id = ?) DESC, captured_at DESC, id DESC
      LIMIT 1
    `)
    .get(unixTime, externalId, nickname, externalId) as WtPlayerSnapshotRow | undefined
  if (row === undefined) return null
  try {
    const data: unknown = JSON.parse(row.data)
    if (!isRecordValue(data)) return null
    return {
      id: row.id,
      externalId: row.external_id,
      nickname: row.nickname,
      data,
      capturedAt: row.captured_at,
    }
  } catch {
    return null
  }
}

// ---------- Анализ нейросетью ----------

/** Записи, которые ещё не анализировались, — очередь для нейросети */
export function getUnanalyzedItems(limit = 10): StoredItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, NULL AS analysis
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      WHERE a.id IS NULL
      ORDER BY i.id DESC
      LIMIT ?
    `)
    .all(limit) as unknown as ItemRow[]
  return rows.map(toStoredItem)
}

export function saveAnalysis(itemId: number, result: string, model: string): void {
  getDb()
    .prepare(`
      INSERT INTO analyses (item_id, result, model)
      VALUES (?, ?, ?)
      ON CONFLICT (item_id) DO UPDATE SET
        result = excluded.result,
        model = excluded.model,
        created_at = unixepoch()
    `)
    .run(itemId, result, model)
}

// ---------- Кланы и личный клановый рейтинг (ПКР) ----------

/** Пакетное обновление словаря «тег → имя клана» (источник wt-clans) */
export function upsertClans(entries: { tag: string; name: string }[]): void {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO clans (tag, name) VALUES (?, ?)
    ON CONFLICT (tag) DO UPDATE SET name = excluded.name, updated_at = unixepoch()
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const e of entries) stmt.run(e.tag, e.name)
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

/** Имя клана по полному тегу (с украшениями) — null, если клана нет в словаре */
export function getClanNameByTag(tag: string): string | null {
  const row = getDb().prepare('SELECT name FROM clans WHERE tag = ?').get(tag) as { name: string } | undefined
  return row?.name ?? null
}

/** Награды клана за прошлые сезоны: [номер сезона, звание вида «place1@historical»]. */
export interface ClanSeasonRewards {
  /** Лучшие результаты (как показывает сайт игры). */
  best: [number, string][]
  /** Все сезоны с наградой: [номер, звания]. */
  log: [number, string[]][]
}

/** Клан из официального лидерборда warthunder.com. */
export interface ClanLeaderboardEntry {
  /** Полный тег с украшениями, как в реплеях. */
  tag: string
  name: string
  /** Рейтинг полковых боёв текущего сезона (dr_era5_hist); null — лидерборд его не дал. */
  rating: number | null
  /** Место в лидерборде, с 1. */
  position: number | null
  members: number | null
  battles: number | null
  wins: number | null
  airKills?: number | null
  groundKills?: number | null
  deaths?: number | null
  /** Налёт сезона, минуты (ftime_hist). */
  flightTime?: number | null
  activity?: number | null
  region?: string | null
  /** normal, battalion — как в лидерборде. */
  clanType?: string | null
  /** Дата основания, Unix-секунды. */
  foundedAt?: number | null
  slogan?: string | null
  rewards?: ClanSeasonRewards | null
  /** Постоянный номер клана на сайте: не меняется вместе с тегом. */
  clanId?: number | null
  /** Описание клана: чистый текст, переносы строк сохранены. */
  description?: string | null
  announcement?: string | null
  requirements?: ClanRequirements | null
  /** open — приём заявок открыт. */
  status?: string | null
  autoAccept?: boolean | null
  /** Тег с обычными символами, без сезонного украшения. */
  plainTag?: string | null
  /** Украшение тега за прошлый сезон (place2, top10…). */
  regalia?: string | null
}

/** Условия вступления в клан (membership_req лидерборда). */
export interface ClanRequirements {
  /** Минимальный ранг техники по веткам; and — все ветки, or — любая. */
  ranks: { mode: 'and' | 'or'; items: { unitType: string; rank: number; count: number }[] } | null
  /** Минимум боёв по режиму: historical — РБ. */
  battles: { difficulty: string; count: number }[]
}

/**
 * Обход официального лидерборда одной транзакцией: словарь «тег → имя» и
 * статистика клана на момент capturedAt (у всех строк обхода он общий — по
 * нему сайт отличает свежий обход от прежних). История по ядру тега
 * пополняется только при изменении рейтинга, боёв, побед, фрагов или
 * смертей — как снимки ПКР. Клан без рейтинга обновляет лишь имя и не
 * затирает прежнюю статистику.
 */
export function saveClanLeaderboard(entries: readonly ClanLeaderboardEntry[], capturedAt: number): void {
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) {
    throw new RangeError('capturedAt лидерборда должен быть положительным Unix-временем')
  }
  const database = getDb()
  const upsertStats = database.prepare(`
    INSERT INTO clans (
      tag, name, rating, position, members, battles, wins, rating_at,
      air_kills, ground_kills, deaths, flight_time, activity, region, clan_type, founded_at, slogan, rewards,
      clan_id, description, announcement, requirements, status, auto_accept, plain_tag, regalia
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tag) DO UPDATE SET
      name = excluded.name,
      rating = excluded.rating,
      position = excluded.position,
      members = excluded.members,
      battles = excluded.battles,
      wins = excluded.wins,
      rating_at = excluded.rating_at,
      air_kills = excluded.air_kills,
      ground_kills = excluded.ground_kills,
      deaths = excluded.deaths,
      flight_time = excluded.flight_time,
      activity = excluded.activity,
      region = excluded.region,
      clan_type = excluded.clan_type,
      founded_at = excluded.founded_at,
      slogan = excluded.slogan,
      rewards = excluded.rewards,
      clan_id = excluded.clan_id,
      description = excluded.description,
      announcement = excluded.announcement,
      requirements = excluded.requirements,
      status = excluded.status,
      auto_accept = excluded.auto_accept,
      plain_tag = excluded.plain_tag,
      regalia = excluded.regalia,
      updated_at = unixepoch()
  `)
  const upsertName = database.prepare(`
    INSERT INTO clans (tag, name) VALUES (?, ?)
    ON CONFLICT (tag) DO UPDATE SET name = excluded.name, updated_at = unixepoch()
  `)
  const lastPoint = database.prepare(`
    SELECT rating, battles, wins, air_kills, ground_kills, deaths FROM clan_rating_history
    WHERE clan_core = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `)
  const insertHistory = database.prepare(`
    INSERT INTO clan_rating_history (clan_core, captured_at, rating, battles, wins, air_kills, ground_kills, deaths)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (clan_core, captured_at) DO UPDATE SET
      rating = excluded.rating,
      battles = excluded.battles,
      wins = excluded.wins,
      air_kills = excluded.air_kills,
      ground_kills = excluded.ground_kills,
      deaths = excluded.deaths
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const entry of entries) {
      if (entry.rating === null) {
        upsertName.run(entry.tag, entry.name)
        continue
      }
      const point = [
        entry.rating,
        entry.battles,
        entry.wins,
        entry.airKills ?? null,
        entry.groundKills ?? null,
        entry.deaths ?? null,
      ] as const
      upsertStats.run(
        entry.tag,
        entry.name,
        entry.rating,
        entry.position,
        entry.members,
        entry.battles,
        entry.wins,
        capturedAt,
        entry.airKills ?? null,
        entry.groundKills ?? null,
        entry.deaths ?? null,
        entry.flightTime ?? null,
        entry.activity ?? null,
        entry.region ?? null,
        entry.clanType ?? null,
        entry.foundedAt ?? null,
        entry.slogan ?? null,
        entry.rewards ? JSON.stringify(entry.rewards) : null,
        entry.clanId ?? null,
        entry.description ?? null,
        entry.announcement ?? null,
        entry.requirements ? JSON.stringify(entry.requirements) : null,
        entry.status ?? null,
        entry.autoAccept === undefined || entry.autoAccept === null ? null : Number(entry.autoAccept),
        entry.plainTag ?? null,
        entry.regalia ?? null,
      )
      const core = clanCoreOf(entry.tag)
      if (!core) continue
      const last = lastPoint.get(core) as
        | { rating: number; battles: number | null; wins: number | null; air_kills: number | null; ground_kills: number | null; deaths: number | null }
        | undefined
      const previous = last
        ? [last.rating, last.battles, last.wins, last.air_kills, last.ground_kills, last.deaths]
        : null
      if (previous === null || previous.some((value, index) => value !== point[index])) {
        insertHistory.run(core, capturedAt, ...point)
      }
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

/** Сезон полковых боёв по данным лидерборда warthunder.com. */
export interface OfficialClanSeason {
  seasonId: number
  startsAt: number
  /** Исключающая граница, Unix-секунды. */
  endsAt: number
}

const OFFICIAL_CLAN_SEASON_KEY = 'wt-clans:season'

export function saveOfficialClanSeason(season: OfficialClanSeason): void {
  setBotState(OFFICIAL_CLAN_SEASON_KEY, JSON.stringify(season))
}

/** Сохранённый официальный сезон; null — лидерборд ещё не обходили или запись битая. */
export function getOfficialClanSeason(): OfficialClanSeason | null {
  const raw = getBotState(OFFICIAL_CLAN_SEASON_KEY)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<OfficialClanSeason>
    const valid = [value.seasonId, value.startsAt, value.endsAt].every((part) => Number.isSafeInteger(part))
    return valid ? { seasonId: value.seasonId!, startsAt: value.startsAt!, endsAt: value.endsAt! } : null
  } catch {
    return null
  }
}

/**
 * Снимок ПКР участников клана: строка добавляется только если рейтинг ника
 * изменился с прошлого снимка (или ника ещё не было) — история не пухнет.
 */
/** Участник клана со страницы claninfo; поля после ПКР необязательны. */
export interface ClanMemberSnapshot {
  nick: string
  rating: number
  activity?: number | null
  role?: string | null
  /** Дата вступления, Unix-секунды. */
  joinedAt?: number | null
}

export function saveClanRatingSnapshots(clanTag: string, ratings: readonly ClanMemberSnapshot[]): void {
  const database = getDb()
  const seasonStart = currentClanSeasonStart()
  const lastStmt = database.prepare(`
    SELECT rating FROM clan_rating_snapshots
    WHERE clan_tag = ? AND nick = ? AND seen_at >= ?
    ORDER BY id DESC LIMIT 1
  `)
  const insertStmt = database.prepare(
    'INSERT INTO clan_rating_snapshots (clan_tag, nick, nick_base, rating) VALUES (?, ?, ?, ?)',
  )
  const presenceStmt = database.prepare(`
    INSERT INTO clan_roster (clan_core, nick, last_present_at, role, joined_at, activity) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (clan_core, nick) DO UPDATE SET
      last_present_at = excluded.last_present_at,
      role = excluded.role,
      joined_at = excluded.joined_at,
      activity = excluded.activity
  `)
  const clanCore = clanCoreOf(clanTag)
  const now = Math.floor(Date.now() / 1_000)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const r of ratings) {
      const last = lastStmt.get(clanTag, r.nick, seasonStart) as { rating: number } | undefined
      if (last === undefined || last.rating !== r.rating) {
        insertStmt.run(clanTag, r.nick, normalizeWtNick(r.nick), r.rating)
      }
      if (clanCore) presenceStmt.run(clanCore, r.nick, now, r.role ?? null, r.joinedAt ?? null, r.activity ?? null)
    }
    // Полный ростер приходит каждым обходом: кого нет в списке — покинул.
    // Ключ — ядро тега, поэтому смена украшений не «воскрешает» ушедших.
    // Пустой список состав не трогает, а неправдоподобное сжатие (меньше
    // половины прежнего состава) не удаляет никого — защита от битого парса.
    if (clanCore && ratings.length > 0) {
      const current = (database
        .prepare('SELECT COUNT(*) AS n FROM clan_roster WHERE clan_core = ?')
        .get(clanCore) as { n: number }).n
      if (current >= 4 && ratings.length < Math.ceil(current / 2)) {
        console.warn(
          `[db] clan_roster ${clanCore}: пришло ${ratings.length} из ${current} участников — уходы не применяю (похоже на неполный парс)`,
        )
      } else {
        database
          .prepare(
            `DELETE FROM clan_roster WHERE clan_core = ? AND nick NOT IN (${ratings.map(() => '?').join(', ')})`,
          )
          .run(clanCore, ...ratings.map((r) => r.nick))
      }
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export interface ClanRating {
  rating: number
  /** Изменение с прошлого снимка; null — истории ещё нет */
  delta: number | null
}

/** Убирает известный платформенный суффикс, не меняя отображаемый ник. */
/** Базовый WT-ник без платформенного суффикса — общий ключ nick_base для всех таблиц. */
export function normalizeWtNick(nick: string): string {
  return nick.replace(/@(psn|live|epic)$/i, '')
}

/** Unicode-стабильный ключ поиска, не меняющий отображаемый ник. */
export function normalizePlayerSearchKey(nick: string): string {
  return nick.normalize('NFKC').toLocaleLowerCase('und')
}

/**
 * Ядро клан-тега: зеркало plainClanTag из wrpl/render-battle (дублируется
 * сознательно — импорт тянул бы в db весь граф рендера). Пустая строка —
 * тег состоит из одних украшений.
 */
function clanCoreOf(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

/**
 * Когда ростер клана последний раз читался со страницы claninfo: каждый обход
 * обновляет last_present_at всем участникам. Ключ — переданный тег; клана без
 * ростера в ответе нет.
 */
export function getClanRosterRefreshedAt(tags: readonly string[]): Map<string, number> {
  const tagsByCore = new Map<string, string[]>()
  for (const tag of tags) {
    const core = clanCoreOf(tag)
    if (!core) continue
    const list = tagsByCore.get(core)
    if (list) list.push(tag)
    else tagsByCore.set(core, [tag])
  }
  const result = new Map<string, number>()
  if (tagsByCore.size === 0) return result
  const rows = getDb().prepare(`
    SELECT clan_core, MAX(last_present_at) AS refreshed_at
    FROM clan_roster
    WHERE clan_core IN (SELECT value FROM json_each(?))
    GROUP BY clan_core
  `).all(JSON.stringify([...tagsByCore.keys()])) as { clan_core: string; refreshed_at: number }[]
  for (const row of rows) {
    for (const tag of tagsByCore.get(row.clan_core) ?? []) result.set(tag, row.refreshed_at)
  }
  return result
}

// ---------- Идентичности игроков и внешние снимки ----------

interface PlayerIdentityRow {
  id: number
  wt_user_id: string | null
  canonical_nick: string
  platform: string | null
  created_at: number
  updated_at: number
}

interface PlayerIdentityAliasRow {
  identity_id: number
  source: string
  external_id: string | null
  nick: string
  nick_base: string
  first_seen_at: number
  last_seen_at: number
  match_method: PlayerIdentityMatchMethod
  match_confidence: PlayerIdentityMatchConfidence
}

export type KnownPlayerMatchOrigin = 'identity' | 'alias' | 'replay' | 'voice' | 'clan'

/** Точное локальное свидетельство, по которому можно безопасно открыть статистику игрока. */
export interface KnownPlayerMatch {
  origin: KnownPlayerMatchOrigin
  source: string
  identityId: number | null
  wtUserId: string | null
  nick: string
  platform: string | null
  seenAt: number
}

interface PlayerExternalSnapshotRow {
  id: number
  identity_id: number
  source: string
  source_player_id: string | null
  nick: string | null
  fetched_at: number
  last_checked_at: number
  source_updated_at: number | null
  status: PlayerExternalSnapshotStatus
  raw_json: string | null
  content_hash: string | null
  parser_version: string
  error: string | null
}

type PlayerExternalSnapshotMetaRow = Omit<PlayerExternalSnapshotRow, 'raw_json'>

interface PlayerExternalTotalRow {
  snapshot_id: number
  game_type: string | null
  mode: string | null
  category: string | null
  battles: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  time_played_sec: number | null
  respawns: number | null
  air_kills: number | null
  ground_kills: number | null
  naval_kills: number | null
}

interface PlayerExternalCountryRow {
  snapshot_id: number
  country: string
  vehicles: number | null
  elite_vehicles: number | null
  medals: number | null
}

interface PlayerExternalVehicleRow {
  snapshot_id: number
  game_type: string | null
  mode: string | null
  vehicle_id: string
  flyouts: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  air_kills: number | null
  ground_kills: number | null
  naval_kills: number | null
  time_played_sec: number | null
}

const playerIdentityMatchMethods = new Set<string>(PLAYER_IDENTITY_MATCH_METHODS)
const playerIdentityMatchConfidences = new Set<string>(PLAYER_IDENTITY_MATCH_CONFIDENCES)
const playerExternalSnapshotStatuses = new Set<string>(PLAYER_EXTERNAL_SNAPSHOT_STATUSES)

function requiredPlayerStatsText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Поле ${field} не может быть пустым`)
  return normalized
}

function optionalPlayerStatsText(value: string | null, field: string): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (!normalized) throw new Error(`Поле ${field} не может быть пустой строкой`)
  return normalized
}

function playerStatsTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Поле ${field} должно быть неотрицательным целым Unix-временем`)
  }
  return value
}

function playerStatsMetric(value: number | null, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Поле ${field} должно быть неотрицательным целым числом или null`)
  }
  return value
}

function playerStatsDimension(value: string | null, field: string): string | null {
  return optionalPlayerStatsText(value, field)
}

function playerStatsIdentityId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('identityId должен быть положительным целым числом')
  }
  return value
}

function normalizedWtUserId(value: string | null): string | null {
  if (value === null) return null
  const normalized = requiredPlayerStatsText(value, 'wtUserId')
  if (!/^\d+$/.test(normalized)) {
    throw new Error('wtUserId должен содержать только цифры')
  }
  return normalized
}

function toPlayerIdentity(row: PlayerIdentityRow): PlayerIdentity {
  return {
    id: row.id,
    wtUserId: row.wt_user_id,
    canonicalNick: row.canonical_nick,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toPlayerIdentityAlias(row: PlayerIdentityAliasRow): PlayerIdentityAlias {
  return {
    identityId: row.identity_id,
    source: row.source,
    externalId: row.external_id,
    nick: row.nick,
    nickBase: row.nick_base,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    matchMethod: row.match_method,
    matchConfidence: row.match_confidence,
  }
}

function toPlayerExternalSnapshot(row: PlayerExternalSnapshotRow): PlayerExternalSnapshot {
  return {
    id: row.id,
    identityId: row.identity_id,
    source: row.source,
    sourcePlayerId: row.source_player_id,
    nick: row.nick,
    fetchedAt: row.fetched_at,
    lastCheckedAt: row.last_checked_at,
    sourceUpdatedAt: row.source_updated_at,
    status: row.status,
    rawJson: row.raw_json,
    contentHash: row.content_hash,
    parserVersion: row.parser_version,
    error: row.error,
  }
}

function toPlayerExternalSnapshotMeta(row: PlayerExternalSnapshotMetaRow): PlayerExternalSnapshotMeta {
  return {
    id: row.id,
    identityId: row.identity_id,
    source: row.source,
    sourcePlayerId: row.source_player_id,
    nick: row.nick,
    fetchedAt: row.fetched_at,
    lastCheckedAt: row.last_checked_at,
    sourceUpdatedAt: row.source_updated_at,
    status: row.status,
    contentHash: row.content_hash,
    parserVersion: row.parser_version,
    error: row.error,
  }
}

function toPlayerExternalTotal(row: PlayerExternalTotalRow): PlayerExternalTotal {
  return {
    snapshotId: row.snapshot_id,
    gameType: row.game_type,
    mode: row.mode,
    category: row.category,
    battles: row.battles,
    victories: row.victories,
    defeats: row.defeats,
    deaths: row.deaths,
    timePlayedSec: row.time_played_sec,
    respawns: row.respawns,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    navalKills: row.naval_kills,
  }
}

function toPlayerExternalCountry(row: PlayerExternalCountryRow): PlayerExternalCountry {
  return {
    snapshotId: row.snapshot_id,
    country: row.country,
    vehicles: row.vehicles,
    eliteVehicles: row.elite_vehicles,
    medals: row.medals,
  }
}

function toPlayerExternalVehicle(row: PlayerExternalVehicleRow): PlayerExternalVehicle {
  return {
    snapshotId: row.snapshot_id,
    gameType: row.game_type,
    mode: row.mode,
    vehicleId: row.vehicle_id,
    flyouts: row.flyouts,
    victories: row.victories,
    defeats: row.defeats,
    deaths: row.deaths,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    navalKills: row.naval_kills,
    timePlayedSec: row.time_played_sec,
  }
}

function selectPlayerIdentityById(database: DatabaseSync, identityId: number): PlayerIdentityRow | undefined {
  return database
    .prepare(`
      SELECT id, wt_user_id, canonical_nick, platform, created_at, updated_at
      FROM player_identities
      WHERE id = ?
    `)
    .get(identityId) as PlayerIdentityRow | undefined
}

function selectPlayerIdentityByWtUserId(database: DatabaseSync, wtUserId: string): PlayerIdentityRow | undefined {
  return database
    .prepare(`
      SELECT id, wt_user_id, canonical_nick, platform, created_at, updated_at
      FROM player_identities
      WHERE wt_user_id = ?
    `)
    .get(wtUserId) as PlayerIdentityRow | undefined
}

export function getPlayerIdentityById(identityId: number): PlayerIdentity | null {
  const row = selectPlayerIdentityById(getDb(), playerStatsIdentityId(identityId))
  return row ? toPlayerIdentity(row) : null
}

export function getPlayerIdentityByWtUserId(wtUserId: string): PlayerIdentity | null {
  const normalized = normalizedWtUserId(wtUserId)
  if (normalized === null) return null
  const row = selectPlayerIdentityByWtUserId(getDb(), normalized)
  return row ? toPlayerIdentity(row) : null
}

/**
 * Создаёт или обновляет identity. Без identityId автоматическое совпадение
 * разрешено только по стабильному wtUserId, но не по нику или nick_base.
 */
export function savePlayerIdentity(input: SavePlayerIdentityInput): PlayerIdentity {
  const requestedIdentityId = input.identityId === undefined ? null : playerStatsIdentityId(input.identityId)
  const wtUserId = normalizedWtUserId(input.wtUserId)
  const canonicalNick = requiredPlayerStatsText(input.canonicalNick, 'canonicalNick')
  const requestedPlatform = input.platform === undefined
    ? undefined
    : optionalPlayerStatsText(input.platform, 'platform')
  const aliases = (input.aliases ?? []).map((alias) => {
    const source = requiredPlayerStatsText(alias.source, 'alias.source')
    const externalId = optionalPlayerStatsText(alias.externalId, 'alias.externalId')
    const nick = requiredPlayerStatsText(alias.nick, 'alias.nick')
    const nickBase = normalizeWtNick(nick).trim()
    if (!nickBase) throw new Error('Базовый ник alias.nick не может быть пустым')
    if (!playerIdentityMatchMethods.has(alias.matchMethod)) {
      throw new Error(`Неизвестный matchMethod: ${alias.matchMethod}`)
    }
    if (!playerIdentityMatchConfidences.has(alias.matchConfidence)) {
      throw new Error(`Неизвестный matchConfidence: ${alias.matchConfidence}`)
    }
    return {
      source,
      externalId,
      nick,
      nickBase,
      seenAt: playerStatsTimestamp(alias.seenAt, 'alias.seenAt'),
      matchMethod: alias.matchMethod,
      matchConfidence: alias.matchConfidence,
    }
  })

  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    let existing = requestedIdentityId === null
      ? undefined
      : selectPlayerIdentityById(database, requestedIdentityId)
    if (requestedIdentityId !== null && existing === undefined) {
      throw new Error(`Identity ${requestedIdentityId} не найдена`)
    }
    if (existing === undefined && wtUserId !== null) {
      existing = selectPlayerIdentityByWtUserId(database, wtUserId)
    }
    if (
      existing !== undefined &&
      existing.wt_user_id !== null &&
      wtUserId !== null &&
      existing.wt_user_id !== wtUserId
    ) {
      throw new Error(`Identity ${existing.id} уже связана с другим wtUserId`)
    }
    if (existing !== undefined && wtUserId !== null) {
      const conflicting = selectPlayerIdentityByWtUserId(database, wtUserId)
      if (conflicting !== undefined && conflicting.id !== existing.id) {
        throw new Error(`wtUserId ${wtUserId} уже связан с identity ${conflicting.id}`)
      }
    }

    let identityId: number
    if (existing === undefined) {
      const result = database
        .prepare(`
          INSERT INTO player_identities (wt_user_id, canonical_nick, canonical_nick_search, platform)
          VALUES (?, ?, ?, ?)
        `)
        .run(wtUserId, canonicalNick, normalizePlayerSearchKey(canonicalNick), requestedPlatform ?? null)
      identityId = Number(result.lastInsertRowid)
    } else {
      identityId = existing.id
      database
        .prepare(`
          UPDATE player_identities
          SET wt_user_id = ?, canonical_nick = ?, canonical_nick_search = ?, platform = ?, updated_at = unixepoch()
          WHERE id = ?
        `)
        .run(
          existing.wt_user_id ?? wtUserId,
          canonicalNick,
          normalizePlayerSearchKey(canonicalNick),
          requestedPlatform === undefined ? existing.platform : requestedPlatform,
          identityId,
        )
    }

    const aliasStatement = database.prepare(`
      INSERT INTO player_identity_aliases (
        identity_id, source, external_id, nick, nick_search, nick_base,
        first_seen_at, last_seen_at, match_method, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        nick_search = excluded.nick_search,
        nick_base = excluded.nick_base,
        first_seen_at = MIN(player_identity_aliases.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(player_identity_aliases.last_seen_at, excluded.last_seen_at),
        match_method = excluded.match_method,
        match_confidence = excluded.match_confidence
    `)
    for (const alias of aliases) {
      aliasStatement.run(
        identityId,
        alias.source,
        alias.externalId,
        alias.nick,
        normalizePlayerSearchKey(alias.nick),
        alias.nickBase,
        alias.seenAt,
        alias.seenAt,
        alias.matchMethod,
        alias.matchConfidence,
      )
    }

    const saved = selectPlayerIdentityById(database, identityId)
    if (saved === undefined) throw new Error(`Не удалось прочитать сохранённую identity ${identityId}`)
    database.exec('COMMIT')
    return toPlayerIdentity(saved)
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function getPlayerIdentityAliases(identityId: number): PlayerIdentityAlias[] {
  const rows = getDb()
    .prepare(`
      SELECT
        identity_id, source, external_id, nick, nick_base,
        first_seen_at, last_seen_at, match_method, match_confidence
      FROM player_identity_aliases
      WHERE identity_id = ?
      ORDER BY first_seen_at, source, nick
    `)
    .all(playerStatsIdentityId(identityId)) as unknown as PlayerIdentityAliasRow[]
  return rows.map(toPlayerIdentityAlias)
}

export function findKnownPlayerMatches(player: string): KnownPlayerMatch[] {
  const query = requiredPlayerStatsText(player, 'player')
  if (query.length > 64) throw new RangeError('Ник или WT user id не может быть длиннее 64 символов')
  const numericQuery = /^\d+$/.test(query) ? query : null
  // Та же нормализация, что у *_search колонок: NFKC + locale-neutral
  // lowercase; COLLATE NOCASE не понимает кириллицу и не использует индексы.
  const searchKey = normalizePlayerSearchKey(query)
  const database = getDb()
  type MatchRow = {
    origin: KnownPlayerMatchOrigin
    source: string
    identity_id: number | null
    wt_user_id: string | null
    nick: string
    platform: string | null
    seen_at: number
  }
  const rows: MatchRow[] = []

  rows.push(...database.prepare(`
    SELECT
      'identity' AS origin,
      'identity' AS source,
      id AS identity_id,
      wt_user_id,
      canonical_nick AS nick,
      platform,
      updated_at AS seen_at
    FROM player_identities
    WHERE (? IS NOT NULL AND wt_user_id = ?)
       OR canonical_nick_search = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 50
  `).all(numericQuery, numericQuery, searchKey) as unknown as MatchRow[])

  rows.push(...database.prepare(`
    SELECT
      'alias' AS origin,
      pia.source AS source,
      pi.id AS identity_id,
      pi.wt_user_id,
      pia.nick,
      pi.platform,
      pia.last_seen_at AS seen_at
    FROM player_identity_aliases pia
    JOIN player_identities pi ON pi.id = pia.identity_id
    WHERE pia.nick_search = ?
    ORDER BY pia.last_seen_at DESC, pi.id DESC
    LIMIT 50
  `).all(searchKey) as unknown as MatchRow[])

  // Реплеи: две индексируемые ветки вместо OR — с OR и COLLATE NOCASE план
  // сканировал весь battle_players (~0,5 с синхронно на каждый lookup).
  rows.push(...(numericQuery !== null
    ? siteStatement('knownPlayerReplayByUserOrNick').all(numericQuery, searchKey)
    : siteStatement('knownPlayerReplayByNick').all(searchKey)) as unknown as MatchRow[])

  rows.push(...database.prepare(`
    SELECT
      'voice' AS origin,
      'voice' AS source,
      NULL AS identity_id,
      NULL AS wt_user_id,
      wt_nick AS nick,
      NULL AS platform,
      MAX(joined_at) AS seen_at
    FROM voice_presence
    WHERE wt_nick = ? COLLATE NOCASE
    GROUP BY wt_nick COLLATE NOCASE
    ORDER BY seen_at DESC
    LIMIT 10
  `).all(query) as unknown as MatchRow[])

  rows.push(...database.prepare(`
    WITH ranked AS (
      SELECT
        nick,
        seen_at,
        ROW_NUMBER() OVER (
          PARTITION BY nick COLLATE NOCASE
          ORDER BY seen_at DESC, id DESC
        ) AS row_number
      FROM clan_rating_snapshots
      WHERE nick = ? COLLATE NOCASE
    )
    SELECT
      'clan' AS origin,
      'wt-clans' AS source,
      NULL AS identity_id,
      NULL AS wt_user_id,
      nick,
      NULL AS platform,
      seen_at
    FROM ranked
    WHERE row_number = 1
    ORDER BY seen_at DESC
    LIMIT 10
  `).all(query) as unknown as MatchRow[])

  return rows
    .sort((left, right) => right.seen_at - left.seen_at)
    .slice(0, 100)
    .map((row) => ({
      origin: row.origin,
      source: row.source,
      identityId: row.identity_id,
      wtUserId: row.wt_user_id,
      nick: row.nick,
      platform: row.platform,
      seenAt: row.seen_at,
    }))
}

function selectPlayerExternalSnapshotById(
  database: DatabaseSync,
  snapshotId: number,
): PlayerExternalSnapshotRow | undefined {
  return database
    .prepare(`
      SELECT
        id, identity_id, source, source_player_id, nick, fetched_at,
        last_checked_at, source_updated_at, status, raw_json, content_hash,
        parser_version, error
      FROM player_external_snapshots
      WHERE id = ?
    `)
    .get(snapshotId) as PlayerExternalSnapshotRow | undefined
}

interface ValidatedPlayerStats {
  totals: NormalizedPlayerExternalTotal[]
  vehicles: NormalizedPlayerExternalVehicle[]
  countries: NormalizedPlayerExternalCountry[]
  account: PlayerAccount | null
}

function validateNormalizedPlayerStats(
  input: NormalizedPlayerStats | null | undefined,
): ValidatedPlayerStats | undefined {
  if (input === null || input === undefined) return undefined
  if (!Array.isArray(input.totals) || !Array.isArray(input.vehicles)) {
    throw new Error('Нормализованный snapshot должен содержать массивы totals и vehicles')
  }
  if (input.countries !== undefined && !Array.isArray(input.countries)) {
    throw new Error('countries нормализованного snapshot должен быть массивом')
  }

  const totalKeys = new Set<string>()
  const totals = input.totals.map((row, index) => {
    const normalized: NormalizedPlayerExternalTotal = {
      gameType: playerStatsDimension(row.gameType, `totals[${index}].gameType`),
      mode: playerStatsDimension(row.mode, `totals[${index}].mode`),
      category: playerStatsDimension(row.category, `totals[${index}].category`),
      battles: playerStatsMetric(row.battles, `totals[${index}].battles`),
      victories: playerStatsMetric(row.victories, `totals[${index}].victories`),
      defeats: playerStatsMetric(row.defeats, `totals[${index}].defeats`),
      deaths: playerStatsMetric(row.deaths, `totals[${index}].deaths`),
      timePlayedSec: playerStatsMetric(row.timePlayedSec, `totals[${index}].timePlayedSec`),
      respawns: playerStatsMetric(row.respawns, `totals[${index}].respawns`),
      airKills: playerStatsMetric(row.airKills, `totals[${index}].airKills`),
      groundKills: playerStatsMetric(row.groundKills, `totals[${index}].groundKills`),
      navalKills: playerStatsMetric(row.navalKills, `totals[${index}].navalKills`),
    }
    const key = JSON.stringify([normalized.gameType, normalized.mode, normalized.category])
    if (totalKeys.has(key)) throw new Error(`Дублирующийся ключ totals[${index}]`)
    totalKeys.add(key)
    return normalized
  })

  const vehicleKeys = new Set<string>()
  const vehicles = input.vehicles.map((row, index) => {
    const normalized: NormalizedPlayerExternalVehicle = {
      gameType: playerStatsDimension(row.gameType, `vehicles[${index}].gameType`),
      mode: playerStatsDimension(row.mode, `vehicles[${index}].mode`),
      vehicleId: requiredPlayerStatsText(row.vehicleId, `vehicles[${index}].vehicleId`),
      flyouts: playerStatsMetric(row.flyouts, `vehicles[${index}].flyouts`),
      victories: playerStatsMetric(row.victories, `vehicles[${index}].victories`),
      defeats: playerStatsMetric(row.defeats, `vehicles[${index}].defeats`),
      deaths: playerStatsMetric(row.deaths, `vehicles[${index}].deaths`),
      airKills: playerStatsMetric(row.airKills, `vehicles[${index}].airKills`),
      groundKills: playerStatsMetric(row.groundKills, `vehicles[${index}].groundKills`),
      navalKills: playerStatsMetric(row.navalKills, `vehicles[${index}].navalKills`),
      timePlayedSec: playerStatsMetric(row.timePlayedSec, `vehicles[${index}].timePlayedSec`),
    }
    const key = JSON.stringify([normalized.gameType, normalized.mode, normalized.vehicleId])
    if (vehicleKeys.has(key)) throw new Error(`Дублирующийся ключ vehicles[${index}]`)
    vehicleKeys.add(key)
    return normalized
  })

  const countryKeys = new Set<string>()
  const countries = (input.countries ?? []).map((row, index) => {
    const normalized: NormalizedPlayerExternalCountry = {
      country: requiredPlayerStatsText(row.country, `countries[${index}].country`),
      vehicles: playerStatsMetric(row.vehicles, `countries[${index}].vehicles`),
      eliteVehicles: playerStatsMetric(row.eliteVehicles, `countries[${index}].eliteVehicles`),
      medals: playerStatsMetric(row.medals, `countries[${index}].medals`),
    }
    if (countryKeys.has(normalized.country)) throw new Error(`Дублирующийся ключ countries[${index}]`)
    countryKeys.add(normalized.country)
    return normalized
  })
  // Сведения об аккаунте мягкие: битая запись отбрасывается, а не роняет snapshot.
  const account = input.account === undefined || input.account === null
    ? null
    : sanitizePlayerAccount(input.account)
  return { totals, vehicles, countries, account }
}

function replacePlayerExternalMetrics(
  database: DatabaseSync,
  snapshotId: number,
  normalized: ValidatedPlayerStats,
): void {
  database.prepare('DELETE FROM player_external_totals WHERE snapshot_id = ?').run(snapshotId)
  database.prepare('DELETE FROM player_external_vehicles WHERE snapshot_id = ?').run(snapshotId)
  database.prepare('DELETE FROM player_external_countries WHERE snapshot_id = ?').run(snapshotId)
  database
    .prepare('UPDATE player_external_snapshots SET account_json = ? WHERE id = ?')
    .run(normalized.account === null ? null : JSON.stringify(normalized.account), snapshotId)

  const insertCountry = database.prepare(`
    INSERT INTO player_external_countries (snapshot_id, country, vehicles, elite_vehicles, medals)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const row of normalized.countries) {
    insertCountry.run(snapshotId, row.country, row.vehicles, row.eliteVehicles, row.medals)
  }

  const insertTotal = database.prepare(`
    INSERT INTO player_external_totals (
      snapshot_id, game_type, mode, category, battles, victories, defeats,
      deaths, time_played_sec, respawns, air_kills, ground_kills, naval_kills
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of normalized.totals) {
    insertTotal.run(
      snapshotId,
      row.gameType,
      row.mode,
      row.category,
      row.battles,
      row.victories,
      row.defeats,
      row.deaths,
      row.timePlayedSec,
      row.respawns,
      row.airKills,
      row.groundKills,
      row.navalKills,
    )
  }

  const insertVehicle = database.prepare(`
    INSERT INTO player_external_vehicles (
      snapshot_id, game_type, mode, vehicle_id, flyouts, victories, defeats,
      deaths, air_kills, ground_kills, naval_kills, time_played_sec
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of normalized.vehicles) {
    insertVehicle.run(
      snapshotId,
      row.gameType,
      row.mode,
      row.vehicleId,
      row.flyouts,
      row.victories,
      row.defeats,
      row.deaths,
      row.airKills,
      row.groundKills,
      row.navalKills,
      row.timePlayedSec,
    )
  }
}

/** Сохраняет raw snapshot или обновляет время проверки идентичного ответа. */
export function savePlayerExternalSnapshot(
  input: PlayerExternalSnapshotInput,
): SavePlayerExternalSnapshotResult {
  const identityId = playerStatsIdentityId(input.identityId)
  const source = requiredPlayerStatsText(input.source, 'source')
  const sourcePlayerId = optionalPlayerStatsText(input.sourcePlayerId, 'sourcePlayerId')
  const nick = optionalPlayerStatsText(input.nick, 'nick')
  const fetchedAt = playerStatsTimestamp(input.fetchedAt, 'fetchedAt')
  const sourceUpdatedAt = input.sourceUpdatedAt === null
    ? null
    : playerStatsTimestamp(input.sourceUpdatedAt, 'sourceUpdatedAt')
  if (!playerExternalSnapshotStatuses.has(input.status)) {
    throw new Error(`Неизвестный status внешнего snapshot: ${input.status}`)
  }
  const parserVersion = requiredPlayerStatsText(input.parserVersion, 'parserVersion')
  const error = optionalPlayerStatsText(input.error, 'error')
  const normalized = validateNormalizedPlayerStats(input.normalized)
  if (input.status === 'ok' && input.rawJson === null) {
    throw new Error('Успешный внешний snapshot должен содержать rawJson')
  }
  if (input.status !== 'ok' && normalized !== undefined) {
    throw new Error('Нормализованные метрики допустимы только для успешного snapshot')
  }
  if (input.rawJson !== null) {
    try {
      JSON.parse(input.rawJson)
    } catch (err) {
      throw new Error('rawJson внешнего snapshot должен быть валидным JSON', { cause: err })
    }
  }
  const contentHash = input.rawJson === null
    ? null
    : createHash('sha256').update(input.rawJson).digest('hex')

  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    if (selectPlayerIdentityById(database, identityId) === undefined) {
      throw new Error(`Identity ${identityId} не найдена`)
    }
    const matching = database
      .prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, raw_json, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ?
          AND source = ?
          AND source_player_id IS ?
          AND nick IS ?
          AND source_updated_at IS ?
          AND status = ?
          AND raw_json IS ?
          AND content_hash IS ?
          AND parser_version = ?
          AND error IS ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(
        identityId,
        source,
        sourcePlayerId,
        nick,
        sourceUpdatedAt,
        input.status,
        input.rawJson,
        contentHash,
        parserVersion,
        error,
      ) as PlayerExternalSnapshotRow | undefined

    let snapshotId: number
    let created: boolean
    if (matching !== undefined) {
      snapshotId = matching.id
      created = false
      database
        .prepare(`
          UPDATE player_external_snapshots
          SET last_checked_at = MAX(last_checked_at, ?)
          WHERE id = ?
        `)
        .run(fetchedAt, snapshotId)
    } else {
      const result = database
        .prepare(`
          INSERT INTO player_external_snapshots (
            identity_id, source, source_player_id, nick, fetched_at,
            last_checked_at, source_updated_at, status, raw_json,
            content_hash, parser_version, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          identityId,
          source,
          sourcePlayerId,
          nick,
          fetchedAt,
          fetchedAt,
          sourceUpdatedAt,
          input.status,
          input.rawJson,
          contentHash,
          parserVersion,
          error,
        )
      snapshotId = Number(result.lastInsertRowid)
      created = true
    }

    if (normalized !== undefined) {
      replacePlayerExternalMetrics(database, snapshotId, normalized)
    }

    const saved = selectPlayerExternalSnapshotById(database, snapshotId)
    if (saved === undefined) throw new Error(`Не удалось прочитать внешний snapshot ${snapshotId}`)
    database.exec('COMMIT')
    return { snapshot: toPlayerExternalSnapshot(saved), created }
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function getLatestPlayerExternalSnapshot(
  identityId: number,
  source?: string,
): PlayerExternalSnapshot | null {
  const normalizedIdentityId = playerStatsIdentityId(identityId)
  const normalizedSource = source === undefined ? undefined : requiredPlayerStatsText(source, 'source')
  const statement = normalizedSource === undefined
    ? getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, raw_json, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ?
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
    : getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, raw_json, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ? AND source = ?
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
  const row = (normalizedSource === undefined
    ? statement.get(normalizedIdentityId)
    : statement.get(normalizedIdentityId, normalizedSource)) as PlayerExternalSnapshotRow | undefined
  return row ? toPlayerExternalSnapshot(row) : null
}

/** Последняя проверка provider-а без чтения потенциально большого raw_json. */
export function getLatestPlayerExternalCheck(
  identityId: number,
  source?: string,
): PlayerExternalSnapshotMeta | null {
  const normalizedIdentityId = playerStatsIdentityId(identityId)
  const normalizedSource = source === undefined ? undefined : requiredPlayerStatsText(source, 'source')
  const statement = normalizedSource === undefined
    ? getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ?
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
    : getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ? AND source = ?
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
  const row = (normalizedSource === undefined
    ? statement.get(normalizedIdentityId)
    : statement.get(normalizedIdentityId, normalizedSource)) as PlayerExternalSnapshotMetaRow | undefined
  return row ? toPlayerExternalSnapshotMeta(row) : null
}

/** Последний успешный snapshot и его нормализованные строки; ошибки его не затирают. */
function loadPlayerExternalStats(row: PlayerExternalSnapshotMetaRow): PlayerExternalStats {
  const totals = getDb()
    .prepare(`
      SELECT
        snapshot_id, game_type, mode, category, battles, victories, defeats,
        deaths, time_played_sec, respawns, air_kills, ground_kills, naval_kills
      FROM player_external_totals
      WHERE snapshot_id = ?
      ORDER BY ifnull(game_type, ''), ifnull(mode, ''), ifnull(category, '')
    `)
    .all(row.id) as unknown as PlayerExternalTotalRow[]
  const vehicles = getDb()
    .prepare(`
      SELECT
        snapshot_id, game_type, mode, vehicle_id, flyouts, victories, defeats,
        deaths, air_kills, ground_kills, naval_kills, time_played_sec
      FROM player_external_vehicles
      WHERE snapshot_id = ?
      ORDER BY ifnull(game_type, ''), ifnull(mode, ''), vehicle_id
    `)
    .all(row.id) as unknown as PlayerExternalVehicleRow[]
  const countries = getDb()
    .prepare(`
      SELECT snapshot_id, country, vehicles, elite_vehicles, medals
      FROM player_external_countries
      WHERE snapshot_id = ?
      ORDER BY rowid
    `)
    .all(row.id) as unknown as PlayerExternalCountryRow[]
  const accountRow = getDb()
    .prepare('SELECT account_json FROM player_external_snapshots WHERE id = ?')
    .get(row.id) as { account_json: string | null } | undefined
  return {
    snapshot: toPlayerExternalSnapshotMeta(row),
    totals: totals.map(toPlayerExternalTotal),
    vehicles: vehicles.map(toPlayerExternalVehicle),
    countries: countries.map(toPlayerExternalCountry),
    account: parseStoredAccount(accountRow?.account_json ?? null),
  }
}

/** account_json пишется только после проверки, но битую строку не показываем. */
function parseStoredAccount(raw: string | null): PlayerAccount | null {
  if (raw === null) return null
  try {
    return sanitizePlayerAccount(JSON.parse(raw))
  } catch {
    return null
  }
}

export function getLatestPlayerExternalStats(
  identityId: number,
  source?: string,
): PlayerExternalStats | null {
  const normalizedIdentityId = playerStatsIdentityId(identityId)
  const normalizedSource = source === undefined ? undefined : requiredPlayerStatsText(source, 'source')
  const statement = normalizedSource === undefined
    ? getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ? AND status = 'ok'
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
    : getDb().prepare(`
        SELECT
          id, identity_id, source, source_player_id, nick, fetched_at,
          last_checked_at, source_updated_at, status, content_hash,
          parser_version, error
        FROM player_external_snapshots
        WHERE identity_id = ? AND source = ? AND status = 'ok'
        ORDER BY last_checked_at DESC, id DESC
        LIMIT 1
      `)
  const row = (normalizedSource === undefined
    ? statement.get(normalizedIdentityId)
    : statement.get(normalizedIdentityId, normalizedSource)) as PlayerExternalSnapshotMetaRow | undefined
  if (row === undefined) return null
  return loadPlayerExternalStats(row)
}

/** Успешные версии без raw JSON, от новой к старой; используются для дельт. */
export function getPlayerExternalStatsHistory(
  identityId: number,
  source: string,
  limit = 2,
  excludeSnapshotId?: number,
): PlayerExternalStats[] {
  const normalizedIdentityId = playerStatsIdentityId(identityId)
  const normalizedSource = requiredPlayerStatsText(source, 'source')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError('Лимит истории внешней статистики должен быть от 1 до 10')
  }
  if (
    excludeSnapshotId !== undefined
    && (!Number.isSafeInteger(excludeSnapshotId) || excludeSnapshotId <= 0)
  ) {
    throw new RangeError('excludeSnapshotId должен быть положительным целым числом')
  }
  const excluded = excludeSnapshotId ?? null
  const rows = getDb()
    .prepare(`
      SELECT
        id, identity_id, source, source_player_id, nick, fetched_at,
        last_checked_at, source_updated_at, status, content_hash,
        parser_version, error
      FROM player_external_snapshots
      WHERE identity_id = ? AND source = ? AND status = 'ok'
        AND (? IS NULL OR id <> ?)
      ORDER BY last_checked_at DESC, id DESC
      LIMIT ?
    `)
    .all(
      normalizedIdentityId,
      normalizedSource,
      excluded,
      excluded,
      limit,
    ) as unknown as PlayerExternalSnapshotMetaRow[]
  return rows.map(loadPlayerExternalStats)
}

// ---------- Голосовые каналы Discord ----------

export interface VoicePresenceEntry {
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  userId: string
  displayName: string
  /** Ник в игре, вытащенный из серверного ника «WTНик (Имя)» */
  wtNick: string
}

export interface VoicePresenceSyncResult {
  updated: number
  removed: number
  unchanged: number
}

const voicePresenceKey = (entry: Pick<VoicePresenceEntry, 'guildId' | 'userId'>): string =>
  `${entry.guildId}\0${entry.userId}`

function sameVoicePresence(a: VoicePresenceRow, b: VoicePresenceEntry): boolean {
  return (
    a.guildName === b.guildName &&
    a.channelId === b.channelId &&
    a.channelName === b.channelName &&
    a.displayName === b.displayName &&
    a.wtNick === b.wtNick
  )
}

/** Полный снимок голосовых каналов: записываются только отличия. */
export function syncVoicePresence(entries: VoicePresenceEntry[]): VoicePresenceSyncResult {
  const next = new Map(entries.map((entry) => [voicePresenceKey(entry), entry]))
  const current = new Map(getVoicePresence().map((entry) => [voicePresenceKey(entry), entry]))
  const changed = [...next].filter(([key, entry]) => {
    const previous = current.get(key)
    return previous === undefined || !sameVoicePresence(previous, entry)
  })
  const removed = [...current].filter(([key]) => !next.has(key))
  const unchanged = next.size - changed.length
  if (changed.length === 0 && removed.length === 0) return { updated: 0, removed: 0, unchanged }

  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const [, entry] of changed) insertVoiceStmt(entry)
    for (const [, entry] of removed) removeVoicePresence(entry.guildId, entry.userId)
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  return { updated: changed.length, removed: removed.length, unchanged }
}

/** Игрок зашёл в канал или перешёл между каналами */
export function upsertVoicePresence(e: VoicePresenceEntry): void {
  insertVoiceStmt(e)
}

function insertVoiceStmt(e: VoicePresenceEntry): void {
  insertVoicePresenceStatement ??= getDb().prepare(`
      INSERT INTO voice_presence (
        guild_id, guild_name, channel_id, channel_name, user_id, display_name, wt_nick, wt_nick_base
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        guild_name = excluded.guild_name,
        channel_name = excluded.channel_name,
        display_name = excluded.display_name,
        wt_nick = excluded.wt_nick,
        wt_nick_base = excluded.wt_nick_base,
        -- время захода сохраняется, если человек остался в том же канале
        joined_at = CASE
          WHEN voice_presence.channel_id <> excluded.channel_id THEN unixepoch()
          ELSE voice_presence.joined_at
        END,
        channel_id = excluded.channel_id
    `)
  insertVoicePresenceStatement.run(
    e.guildId,
    e.guildName,
    e.channelId,
    e.channelName,
    e.userId,
    e.displayName,
    e.wtNick,
    normalizeWtNick(e.wtNick),
  )
}

export function removeVoicePresence(guildId: string, userId: string): void {
  deleteVoicePresenceStatement ??= getDb().prepare(
    'DELETE FROM voice_presence WHERE guild_id = ? AND user_id = ?',
  )
  deleteVoicePresenceStatement.run(guildId, userId)
}

export interface VoicePresenceRow extends VoicePresenceEntry {
  wtNickBase: string
  joinedAt: number
}

/** Кто сейчас в голосовых каналах — для /api/voice */
export function getVoicePresence(): VoicePresenceRow[] {
  selectVoicePresenceStatement ??= getDb().prepare(`
      SELECT
        guild_id, guild_name, channel_id, channel_name, user_id, display_name,
        wt_nick, wt_nick_base, joined_at
      FROM voice_presence
      ORDER BY guild_id, channel_id, joined_at
    `)
  const rows = selectVoicePresenceStatement.all() as unknown as {
    guild_id: string
    guild_name: string
    channel_id: string
    channel_name: string
    user_id: string
    display_name: string
    wt_nick: string
    wt_nick_base: string
    joined_at: number
  }[]
  return rows.map((r) => ({
    guildId: r.guild_id,
    guildName: r.guild_name,
    channelId: r.channel_id,
    channelName: r.channel_name,
    userId: r.user_id,
    displayName: r.display_name,
    wtNick: r.wt_nick,
    wtNickBase: r.wt_nick_base,
    joinedAt: r.joined_at,
  }))
}

export interface VoiceDashboardRow extends VoicePresenceRow {
  clanTag: string | null
  rating: number | null
  delta: number | null
  battles: number
  lastBattleAt: number | null
}

/** Полный snapshot для /api/voice одним подготовленным SQLite-запросом. */
export function getVoiceDashboardRows(): VoiceDashboardRow[] {
  selectVoiceDashboardStatement ??= getDb().prepare(`
    WITH battle_stats AS (
      SELECT bp.nick_base, COUNT(*) AS battles, MAX(b.start_time) AS last_battle_at
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.nick_base IN (SELECT wt_nick_base FROM voice_presence)
        AND b.start_time >= ?
      GROUP BY bp.nick_base
    )
    SELECT
      v.guild_id,
      v.guild_name,
      v.channel_id,
      v.channel_name,
      v.user_id,
      v.display_name,
      v.wt_nick,
      v.wt_nick_base,
      v.joined_at,
      latest.clan_tag,
      latest.rating,
      previous.clan_tag AS previous_clan_tag,
      previous.rating AS previous_rating,
      COALESCE(bs.battles, 0) AS battles,
      bs.last_battle_at
    FROM voice_presence v
    LEFT JOIN clan_rating_snapshots latest ON latest.id = (
      SELECT s.id FROM clan_rating_snapshots s
      WHERE s.nick_base = v.wt_nick_base AND s.seen_at >= ?
      ORDER BY s.id DESC LIMIT 1
    )
    LEFT JOIN clan_rating_snapshots previous ON previous.id = (
      SELECT s.id FROM clan_rating_snapshots s
      WHERE s.nick_base = v.wt_nick_base AND s.seen_at >= ?
      ORDER BY s.id DESC LIMIT 1 OFFSET 1
    )
    LEFT JOIN battle_stats bs ON bs.nick_base = v.wt_nick_base
    ORDER BY v.guild_id, v.channel_id, v.joined_at
  `)
  const seasonStart = currentClanSeasonStart()
  const rows = selectVoiceDashboardStatement.all(seasonStart, seasonStart, seasonStart) as unknown as {
    guild_id: string
    guild_name: string
    channel_id: string
    channel_name: string
    user_id: string
    display_name: string
    wt_nick: string
    wt_nick_base: string
    joined_at: number
    clan_tag: string | null
    rating: number | null
    previous_clan_tag: string | null
    previous_rating: number | null
    battles: number
    last_battle_at: number | null
  }[]
  return rows.map((row) => ({
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    userId: row.user_id,
    displayName: row.display_name,
    wtNick: row.wt_nick,
    wtNickBase: row.wt_nick_base,
    joinedAt: row.joined_at,
    clanTag: row.clan_tag,
    rating: row.rating,
    delta:
      row.rating !== null && row.previous_rating !== null && row.previous_clan_tag === row.clan_tag
        ? row.rating - row.previous_rating
        : null,
    battles: row.battles,
    lastBattleAt: row.last_battle_at,
  }))
}

/** Кланы активных voice-игроков одним индексированным запросом. */
export function getVoiceClanTags(): string[] {
  selectVoiceClanTagsStatement ??= getDb().prepare(`
    SELECT DISTINCT latest.clan_tag AS clan_tag
    FROM (SELECT DISTINCT wt_nick_base FROM voice_presence) active
    JOIN clan_rating_snapshots latest ON latest.id = (
      SELECT s.id FROM clan_rating_snapshots s
      WHERE s.nick_base = active.wt_nick_base
      ORDER BY s.id DESC LIMIT 1
    )
    WHERE latest.clan_tag <> ''
    ORDER BY latest.clan_tag
  `)
  const rows = selectVoiceClanTagsStatement.all() as unknown as { clan_tag: string }[]
  return rows.map((row) => row.clan_tag)
}

/** ПКР игрока по нику: последний снимок любого его клана (+дельта в рамках клана) */
export function getPlayerRating(nick: string): (ClanRating & { clanTag: string }) | null {
  selectPlayerRatingStatement ??= getDb().prepare(`
    SELECT clan_tag, rating FROM clan_rating_snapshots
    WHERE nick_base = ? AND seen_at >= ?
    ORDER BY id DESC LIMIT 2
  `)
  const rows = selectPlayerRatingStatement.all(
    normalizeWtNick(nick),
    currentClanSeasonStart(),
  ) as unknown as {
    clan_tag: string
    rating: number
  }[]
  const last = rows[0]
  if (!last) return null
  const prev = rows[1]
  return {
    clanTag: last.clan_tag,
    rating: last.rating,
    delta: prev && prev.clan_tag === last.clan_tag ? last.rating - prev.rating : null,
  }
}

/**
 * Сколько клановых боёв игрока разобрано и когда был последний.
 * Читает индексированный base nick: платформенный суффикс не вызывает LIKE-скан.
 */
export function getPlayerBattleStats(nick: string): { battles: number; lastBattleAt: number | null } {
  selectPlayerBattleStatsStatement ??= getDb().prepare(`
      SELECT COUNT(*) AS battles, MAX(b.start_time) AS last
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.nick_base = ?
    `)
  const row = selectPlayerBattleStatsStatement.get(normalizeWtNick(nick)) as
    | { battles: number; last: number | null }
    | undefined
  return { battles: row?.battles ?? 0, lastBattleAt: row?.last ?? null }
}

/** Полуоткрытый период [from, to) в Unix-секундах. */
export interface PlayerReplayStatsPeriod {
  from?: number
  to?: number
}

export interface PlayerReplayVehicleStats {
  vehicleId: string
  battles: number
}

export interface PlayerReplayStats {
  battles: number
  wins: number
  losses: number
  unknownResults: number
  winRate: number | null
  airKills: number
  groundKills: number
  navalKills: number
  aiAirKills: number
  aiGroundKills: number
  assists: number
  deaths: number
  score: number
  teamKills: number
  observedBattleTimeSec: number
  firstBattleAt: number | null
  lastBattleAt: number | null
  vehicles: PlayerReplayVehicleStats[]
  /** Число локальных реплеев, на которых основан результат. */
  coverageBattles: number
}

function replayPeriodBoundary(value: number | undefined, name: 'from' | 'to'): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Граница периода ${name} должна быть неотрицательным целым Unix-временем`)
  }
  return value
}

/**
 * Статистика только по локально разобранным реплеям для стабильного WT user id.
 * Ники намеренно не участвуют в сопоставлении: они могут меняться или совпадать.
 */
export function getPlayerReplayStats(
  playerRef: { userId: string },
  period: PlayerReplayStatsPeriod = {},
): PlayerReplayStats {
  const userId = playerRef.userId.trim()
  if (!userId) throw new Error('Для replay-статистики нужен непустой WT user id')

  const from = replayPeriodBoundary(period.from, 'from')
  const to = replayPeriodBoundary(period.to, 'to')
  if (from !== null && to !== null && from > to) {
    throw new RangeError('Начало периода replay-статистики не может быть позже конца')
  }

  selectPlayerReplayStatsStatement ??= getDb().prepare(`
    WITH observed AS (
      SELECT DISTINCT
        b.session_id,
        b.start_time,
        b.duration_sec,
        b.team_won,
        bp.team,
        bp.kills,
        bp.ground_kills,
        bp.naval_kills,
        bp.ai_kills,
        bp.ai_ground_kills,
        bp.assists,
        bp.deaths,
        bp.score,
        bp.team_kills
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.user_id = ?
        AND bp.user_id <> ''
        AND bp.nick NOT GLOB 'coop/Bot*'
        AND (? IS NULL OR b.start_time >= ?)
        AND (? IS NULL OR b.start_time < ?)
    )
    SELECT
      COUNT(*) AS battles,
      COALESCE(SUM(CASE WHEN team_won <> 0 AND team = team_won THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN team_won <> 0 AND team <> team_won THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(CASE WHEN team_won = 0 THEN 1 ELSE 0 END), 0) AS unknown_results,
      CASE
        WHEN COALESCE(SUM(CASE WHEN team_won <> 0 THEN 1 ELSE 0 END), 0) > 0
        THEN CAST(SUM(CASE WHEN team_won <> 0 AND team = team_won THEN 1 ELSE 0 END) AS REAL)
          / SUM(CASE WHEN team_won <> 0 THEN 1 ELSE 0 END)
        ELSE NULL
      END AS win_rate,
      COALESCE(SUM(kills), 0) AS air_kills,
      COALESCE(SUM(ground_kills), 0) AS ground_kills,
      COALESCE(SUM(naval_kills), 0) AS naval_kills,
      COALESCE(SUM(ai_kills), 0) AS ai_air_kills,
      COALESCE(SUM(ai_ground_kills), 0) AS ai_ground_kills,
      COALESCE(SUM(assists), 0) AS assists,
      COALESCE(SUM(deaths), 0) AS deaths,
      COALESCE(SUM(score), 0) AS score,
      COALESCE(SUM(team_kills), 0) AS team_kills,
      COALESCE(SUM(duration_sec), 0) AS observed_battle_time_sec,
      MIN(start_time) AS first_battle_at,
      MAX(start_time) AS last_battle_at
    FROM observed
  `)
  selectPlayerReplayVehiclesStatement ??= getDb().prepare(`
    WITH observed AS (
      SELECT DISTINCT b.session_id, bp.vehicle, bp.vehicles
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.user_id = ?
        AND bp.user_id <> ''
        AND bp.nick NOT GLOB 'coop/Bot*'
        AND (? IS NULL OR b.start_time >= ?)
        AND (? IS NULL OR b.start_time < ?)
    ), vehicle_rows AS (
      SELECT session_id, trim(vehicle) AS vehicle_id
      FROM observed
      WHERE vehicle IS NOT NULL AND trim(vehicle) <> ''
      UNION
      SELECT observed.session_id, trim(CAST(item.value AS TEXT)) AS vehicle_id
      FROM observed
      CROSS JOIN json_each(
        CASE WHEN json_valid(observed.vehicles) THEN observed.vehicles ELSE '[]' END
      ) AS item
      WHERE item.type = 'text' AND trim(CAST(item.value AS TEXT)) <> ''
    )
    SELECT vehicle_id, COUNT(*) AS battles
    FROM vehicle_rows
    GROUP BY vehicle_id
    ORDER BY battles DESC, vehicle_id COLLATE NOCASE, vehicle_id
  `)

  const params = [userId, from, from, to, to] as const
  const row = selectPlayerReplayStatsStatement.get(...params) as {
    battles: number
    wins: number
    losses: number
    unknown_results: number
    win_rate: number | null
    air_kills: number
    ground_kills: number
    naval_kills: number
    ai_air_kills: number
    ai_ground_kills: number
    assists: number
    deaths: number
    score: number
    team_kills: number
    observed_battle_time_sec: number
    first_battle_at: number | null
    last_battle_at: number | null
  }
  const vehicles = selectPlayerReplayVehiclesStatement.all(...params) as unknown as {
    vehicle_id: string
    battles: number
  }[]

  return {
    battles: row.battles,
    wins: row.wins,
    losses: row.losses,
    unknownResults: row.unknown_results,
    winRate: row.win_rate,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    navalKills: row.naval_kills,
    aiAirKills: row.ai_air_kills,
    aiGroundKills: row.ai_ground_kills,
    assists: row.assists,
    deaths: row.deaths,
    score: row.score,
    teamKills: row.team_kills,
    observedBattleTimeSec: row.observed_battle_time_sec,
    firstBattleAt: row.first_battle_at,
    lastBattleAt: row.last_battle_at,
    vehicles: vehicles.map((vehicle) => ({ vehicleId: vehicle.vehicle_id, battles: vehicle.battles })),
    coverageBattles: row.battles,
  }
}

/** Сколько последних боёв периода разбирает аналитика игрока: страница остаётся быстрой и у завсегдатаев. */
export const PLAYER_INSIGHT_MAX_SESSIONS = 500

export interface PlayerInsightClan {
  /** Сырой тег (последний встреченный вариант украшений). */
  clanTag: string
  battles: number
  wins: number
  losses: number
}

export interface PlayerInsightPlayer {
  userId: string
  /** Последний ник, под которым игрок встречался в этих боях. */
  nick: string
  count: number
}

export interface PlayerReplayInsights {
  /** Разобранные бои: последние в периоде, не больше PLAYER_INSIGHT_MAX_SESSIONS. */
  battles: number
  /** true — боёв в периоде больше, разобраны последние. */
  capped: boolean
  maps: { mission: string; battles: number; wins: number; losses: number }[]
  vehicles: { vehicleId: string; battles: number; wins: number; kills: number; deaths: number }[]
  /** За какой клан играл: клан игрока в самом бою. */
  playedFor: PlayerInsightClan[]
  /** Кланы соперников: доминирующий клан вражеской команды (от двух игроков). */
  opponents: PlayerInsightClan[]
  /** Чаще всего в одной команде; count — общие бои, wins — общие победы. */
  teammates: (PlayerInsightPlayer & { wins: number })[]
  weapons: { weapon: string; kills: number }[]
  /** Техника игроков противника, которую он уничтожал чаще всего. */
  victims: { vehicleId: string; kills: number }[]
  /** Техника игроков противника, которая чаще всего уничтожала его. */
  killers: { vehicleId: string; kills: number }[]
  /** Игроки противника, которых он уничтожал чаще всего. */
  preys: PlayerInsightPlayer[]
  /** Игроки противника, которые чаще всего уничтожали его. */
  nemeses: PlayerInsightPlayer[]
  /** Начало разобранных боёв, Unix-секунды: часы активности клиент считает в своём поясе. */
  starts: number[]
}

/** Модель из battle_kills («tankModels/ussr_t_55») → id словаря техники. */
function insightVehicleId(model: string): string {
  return model.startsWith('tankModels/') ? model.slice('tankModels/'.length) : model
}

function topBy<T>(values: Iterable<T>, score: (value: T) => number, limit: number): T[] {
  return [...values].sort((left, right) => score(right) - score(left)).slice(0, limit)
}

function countInto(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/**
 * Разбор локальных реплеев игрока за период: карты, техника, кланы, напарники,
 * оружие и соперники. Три индексированных запроса (бои игрока, все игроки этих
 * боёв, убийства с его участием) и подсчёт в JS; не больше
 * PLAYER_INSIGHT_MAX_SESSIONS последних боёв. На холодном кэше у завсегдатая
 * это ~0,3 с чтений, поэтому сайт зовёт функцию в worker со своим read-only
 * подключением (database); без него — основное подключение (тесты, :memory:).
 */
export function getPlayerReplayInsights(
  userId: string,
  fromTs: number,
  toTs: number,
  database?: DatabaseSync,
): PlayerReplayInsights {
  const id = userId.trim()
  if (!/^\d{1,20}$/.test(id)) throw new Error('Для аналитики игрока нужен числовой WT user id')
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs > toTs) {
    throw new RangeError('Период аналитики игрока задан неверно')
  }
  const statement = (key: 'playerInsightSessions' | 'playerInsightPlayers' | 'playerInsightKills') =>
    database ? database.prepare(SITE_SQL[key]) : siteStatement(key)
  const sessions = statement('playerInsightSessions')
    .all(id, fromTs, toTs, PLAYER_INSIGHT_MAX_SESSIONS + 1) as unknown as {
      session_id: string
      start_time: number
      mission_name: string
      team_won: number
      team: number
      vehicle: string | null
      vehicles: string
    }[]
  const capped = sessions.length > PLAYER_INSIGHT_MAX_SESSIONS
  if (capped) sessions.length = PLAYER_INSIGHT_MAX_SESSIONS

  const mine = new Map<string, { team: number; won: boolean | null }>()
  const maps = new Map<string, { mission: string; battles: number; wins: number; losses: number }>()
  const vehicles = new Map<string, { vehicleId: string; battles: number; wins: number; kills: number; deaths: number }>()
  const vehicleEntry = (vehicleId: string) => {
    let entry = vehicles.get(vehicleId)
    if (!entry) {
      entry = { vehicleId, battles: 0, wins: 0, kills: 0, deaths: 0 }
      vehicles.set(vehicleId, entry)
    }
    return entry
  }
  for (const row of sessions) {
    const won = row.team_won === 0 ? null : row.team === row.team_won
    mine.set(row.session_id, { team: row.team, won })
    const map = maps.get(row.mission_name) ?? { mission: row.mission_name, battles: 0, wins: 0, losses: 0 }
    map.battles += 1
    if (won === true) map.wins += 1
    if (won === false) map.losses += 1
    maps.set(row.mission_name, map)
    // Техника боя: первая машина и весь список из реплея.
    const used = new Set<string>()
    if (row.vehicle !== null && row.vehicle.trim() !== '') used.add(row.vehicle.trim())
    try {
      const list = JSON.parse(row.vehicles) as unknown
      if (Array.isArray(list)) {
        for (const item of list) if (typeof item === 'string' && item.trim() !== '') used.add(item.trim())
      }
    } catch {
      // битый список техники — остаётся первая машина
    }
    for (const vehicleId of used) {
      const entry = vehicleEntry(vehicleId)
      entry.battles += 1
      if (won === true) entry.wins += 1
    }
  }

  const sessionIds = JSON.stringify([...mine.keys()])
  const playerRows = sessions.length === 0
    ? []
    : statement('playerInsightPlayers').all(sessionIds) as unknown as {
      session_id: string
      user_id: string
      nick: string
      clan_tag: string
      team: number
    }[]
  const bySession = new Map<string, typeof playerRows>()
  for (const row of playerRows) {
    const list = bySession.get(row.session_id)
    if (list) list.push(row)
    else bySession.set(row.session_id, [row])
  }

  const nicks = new Map<string, string>()
  const playedFor = new Map<string, PlayerInsightClan>()
  const opponents = new Map<string, PlayerInsightClan>()
  const teammates = new Map<string, { userId: string; count: number; wins: number }>()
  const clanTally = (target: Map<string, PlayerInsightClan>, tag: string, won: boolean | null) => {
    const core = tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    if (core === '') return
    // Бои идут от новых к старым: первый встреченный тег — последний вариант.
    const entry = target.get(core) ?? { clanTag: tag, battles: 0, wins: 0, losses: 0 }
    entry.battles += 1
    if (won === true) entry.wins += 1
    if (won === false) entry.losses += 1
    target.set(core, entry)
  }
  // Порядок сессий — от новых к старым: ник игрока берётся из последнего боя.
  for (const [sessionId, { team, won }] of mine) {
    const rows = bySession.get(sessionId) ?? []
    const enemyClans = new Map<string, { tag: string; players: number }>()
    for (const row of rows) {
      if (!nicks.has(row.user_id)) nicks.set(row.user_id, row.nick)
      if (row.user_id === id) {
        if (row.clan_tag !== '') clanTally(playedFor, row.clan_tag, won)
        continue
      }
      if (row.team === team) {
        const mate = teammates.get(row.user_id) ?? { userId: row.user_id, count: 0, wins: 0 }
        mate.count += 1
        if (won === true) mate.wins += 1
        teammates.set(row.user_id, mate)
      } else if (row.clan_tag !== '') {
        const core = row.clan_tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
        const clan = enemyClans.get(core) ?? { tag: row.clan_tag, players: 0 }
        clan.players += 1
        enemyClans.set(core, clan)
      }
    }
    const dominant = topBy(enemyClans.values(), (clan) => clan.players, 1)[0]
    if (dominant !== undefined && dominant.players >= 2) clanTally(opponents, dominant.tag, won)
  }

  const weapons = new Map<string, number>()
  const victims = new Map<string, number>()
  const killers = new Map<string, number>()
  const preys = new Map<string, number>()
  const nemeses = new Map<string, number>()
  const kills = sessions.length === 0
    ? []
    : statement('playerInsightKills').all(sessionIds, id, id) as unknown as {
      session_id: string
      killer_id: string
      killer_model: string
      victim_id: string
      victim_model: string
      weapon: string | null
    }[]
  for (const kill of kills) {
    const own = mine.get(kill.session_id)
    if (!own) continue
    const sessionPlayers = bySession.get(kill.session_id) ?? []
    // Соперник — игрок другой команды: ИИ, дроны и свои в счёт не идут.
    const enemyTeam = (userId: string) => {
      const row = sessionPlayers.find((player) => player.user_id === userId)
      return row !== undefined && row.team !== own.team
    }
    if (kill.killer_id === id && kill.victim_id !== id) {
      if (kill.killer_model !== '') vehicleEntry(insightVehicleId(kill.killer_model)).kills += 1
      if (kill.weapon) countInto(weapons, kill.weapon)
      if (enemyTeam(kill.victim_id)) {
        if (kill.victim_model !== '') countInto(victims, insightVehicleId(kill.victim_model))
        countInto(preys, kill.victim_id)
      }
    } else if (kill.victim_id === id) {
      if (kill.victim_model !== '') vehicleEntry(insightVehicleId(kill.victim_model)).deaths += 1
      if (enemyTeam(kill.killer_id)) {
        if (kill.killer_model !== '') countInto(killers, insightVehicleId(kill.killer_model))
        countInto(nemeses, kill.killer_id)
      }
    }
  }
  const players = (counts: Map<string, number>, limit: number): PlayerInsightPlayer[] =>
    topBy(counts, ([, count]) => count, limit)
      .map(([userId, count]) => ({ userId, nick: nicks.get(userId) ?? userId, count }))

  return {
    battles: sessions.length,
    capped,
    maps: topBy(maps.values(), (map) => map.battles, 20),
    vehicles: topBy(vehicles.values(), (vehicle) => vehicle.battles * 1_000 + vehicle.kills, 60),
    playedFor: topBy(playedFor.values(), (clan) => clan.battles, 10),
    opponents: topBy(opponents.values(), (clan) => clan.battles, 20),
    teammates: topBy(teammates.values(), (mate) => mate.count, 20)
      .map((mate) => ({ ...mate, nick: nicks.get(mate.userId) ?? mate.userId })),
    weapons: topBy(weapons, ([, count]) => count, 15).map(([weapon, count]) => ({ weapon, kills: count })),
    victims: topBy(victims, ([, count]) => count, 15).map(([vehicleId, count]) => ({ vehicleId, kills: count })),
    killers: topBy(killers, ([, count]) => count, 15).map(([vehicleId, count]) => ({ vehicleId, kills: count })),
    preys: players(preys, 10),
    nemeses: players(nemeses, 10),
    starts: sessions.map((row) => row.start_time),
  }
}

/** Текущий ПКР и дельта по каждому нику клана (по двум последним снимкам) */
export function getClanRatingsWithDelta(clanTag: string): Map<string, ClanRating> {
  // Только последние 2 снимка каждого ника через покрывающий индекс
  // idx_snapshots_clan_cover: полная история клана не читается вообще.
  const rows = getDb()
    .prepare(`
      SELECT nick, rating FROM (
        SELECT nick, rating,
               ROW_NUMBER() OVER (PARTITION BY nick ORDER BY id DESC) AS rn
        FROM clan_rating_snapshots
        WHERE clan_tag = ? AND seen_at >= ?
      )
      WHERE rn <= 2
      ORDER BY nick, rn
    `)
    .all(clanTag, currentClanSeasonStart()) as unknown as { nick: string; rating: number }[]
  const result = new Map<string, ClanRating>()
  for (const row of rows) {
    const existing = result.get(row.nick)
    if (!existing) {
      result.set(row.nick, { rating: row.rating, delta: null })
    } else if (existing.delta === null) {
      // вторая по свежести запись — из неё считается дельта
      existing.delta = existing.rating - row.rating
    }
  }
  return result
}

// ---------- Разобранные бои (ingest) ----------

/** Результат игрока в бою для записи в battle_players */
export interface BattlePlayerInput {
  userId: string
  nick: string
  clanTag: string
  team: number
  kills: number
  groundKills: number
  navalKills: number
  aiKills: number
  aiGroundKills: number
  assists: number
  deaths: number
  captureZone: number
  damageZone: number
  score: number
  awardDamage: number
  teamKills: number
  squadId: number
  /** Первая машина сетапа (null — отключился) */
  vehicle: string | null
  /** Все машины игрока */
  vehicles: string[]
  disconnected: boolean
  slot: number | null
  title: string | null
  autoSquad: boolean | null
}

/** Убийство с координатами для записи в battle_kills */
export interface BattleKillInput {
  timeMs: number
  killerId: string
  killerModel: string
  victimId: string
  victimModel: string
  weapon: string
  killerPos: { x: number; y: number; z: number } | null
  victimPos: { x: number; y: number; z: number } | null
}

/** Сообщение чата для записи в battle_chat */
export interface BattleChatInput {
  timeMs: number
  sender: string
  channel: number
  channelValid?: boolean
  message: string
}

/** Всё, что ingest достаёт из одного боя */
export interface BattleInput {
  sessionId: string
  sessionHex: string
  missionName: string
  level: string
  gameMode: string | null
  battleType: string | null
  environment: string | null
  status: string | null
  startTime: number
  durationSec: number
  endTimeMs: number
  teamWon: number
  gameVersion: string | null
  /** Путь к файлу миссии из заголовка (для границ карты при перерисовке из БД) */
  missionSettings: string | null
  players: BattlePlayerInput[]
  kills: BattleKillInput[]
  chat: BattleChatInput[]
  /** Старые/сторонние producers могут не знать summary; свежий WRPL ingest заполняет поле. */
  airUnitCount?: number
  /** Старые/сторонние producers могут не знать summary; свежий WRPL ingest заполняет поле. */
  chatCount?: number
  /** Блоб полного ReplayEvents (events-codec.ts) — для перерисовки картинок без реплея */
  eventsBlob: Buffer
}

/** Разобран ли уже этот бой (есть строка в battles) */
export function hasBattle(sessionId: string): boolean {
  return getDb().prepare('SELECT 1 FROM battles WHERE session_id = ?').get(sessionId) !== undefined
}

/** Есть ли в разобранном бою хотя бы одно сообщение игрового чата. */
export function hasBattleChat(sessionId: string): boolean {
  return getDb().prepare('SELECT 1 FROM battle_chat WHERE session_id = ? LIMIT 1').get(sessionId) !== undefined
}

/** Клан-теги (сырые, с украшениями) участников боя — для фильтра автоанонса */
export function getBattleClanTags(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT clan_tag FROM battle_players WHERE session_id = ? AND clan_tag <> ''")
    .all(sessionId) as { clan_tag: string }[]
  return rows.map((r) => r.clan_tag)
}

/**
 * Пишет разобранный бой одной транзакцией: сам бой + игроки + убийства +
 * чат. Повторный вызов заменяет данные (сначала удаляет старые строки),
 * поэтому переразбор боя идемпотентен.
 */
function saveBattleRows(database: DatabaseSync, b: BattleInput): void {
    database
      .prepare(`
        INSERT INTO battles (
          session_id, session_hex, mission_name, level, game_mode, battle_type,
          environment, status, start_time, duration_sec, end_time_ms, team_won,
          game_version, player_count, kill_count, air_unit_count, chat_count,
          mission_settings, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT (session_id) DO UPDATE SET
          session_hex = excluded.session_hex,
          mission_name = excluded.mission_name,
          level = excluded.level,
          game_mode = excluded.game_mode,
          battle_type = excluded.battle_type,
          environment = excluded.environment,
          status = excluded.status,
          start_time = excluded.start_time,
          duration_sec = excluded.duration_sec,
          end_time_ms = excluded.end_time_ms,
          team_won = excluded.team_won,
          game_version = excluded.game_version,
          player_count = excluded.player_count,
          kill_count = excluded.kill_count,
          air_unit_count = excluded.air_unit_count,
          chat_count = excluded.chat_count,
          mission_settings = excluded.mission_settings,
          ingested_at = unixepoch()
      `)
      .run(
        b.sessionId, b.sessionHex, b.missionName, b.level, b.gameMode, b.battleType,
        b.environment, b.status, b.startTime, b.durationSec, b.endTimeMs, b.teamWon,
        b.gameVersion, b.players.length, b.kills.length,
        b.airUnitCount ?? null, b.chatCount ?? b.chat.length,
        b.missionSettings,
      )
    database
      .prepare(`
        INSERT INTO battle_events (session_id, events_blob) VALUES (?, ?)
        ON CONFLICT (session_id) DO UPDATE SET events_blob = excluded.events_blob
      `)
      .run(b.sessionId, b.eventsBlob)

    database.prepare('DELETE FROM battle_players WHERE session_id = ?').run(b.sessionId)
    database.prepare('DELETE FROM battle_kills WHERE session_id = ?').run(b.sessionId)
    database.prepare('DELETE FROM battle_chat WHERE session_id = ?').run(b.sessionId)

    const pStmt = database.prepare(`
      INSERT INTO battle_players (
        session_id, user_id, nick, nick_search, nick_base, clan_tag, team, kills, ground_kills, naval_kills,
        ai_kills, ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
        award_damage, team_kills, squad_id, vehicle, vehicles, disconnected, slot, title, auto_squad
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const p of b.players) {
      pStmt.run(
        b.sessionId, p.userId, p.nick, normalizePlayerSearchKey(p.nick), normalizeWtNick(p.nick), p.clanTag, p.team, p.kills,
        p.groundKills, p.navalKills,
        p.aiKills, p.aiGroundKills, p.assists, p.deaths, p.captureZone, p.damageZone, p.score,
        p.awardDamage, p.teamKills, p.squadId, p.vehicle, JSON.stringify(p.vehicles), p.disconnected ? 1 : 0,
        p.slot, p.title, p.autoSquad === null ? null : (p.autoSquad ? 1 : 0),
      )
    }

    insertBattleKillRows(database, b.sessionId, b.kills)
    insertBattleChatRows(database, b.sessionId, b.chat)
}

function insertBattleKillRows(database: DatabaseSync, sessionId: string, kills: readonly BattleKillInput[]): void {
  const kStmt = database.prepare(`
    INSERT INTO battle_kills (
      session_id, time_ms, killer_id, killer_model, victim_id, victim_model, weapon,
      killer_x, killer_y, killer_z, victim_x, victim_y, victim_z
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const k of kills) {
    kStmt.run(
      sessionId, k.timeMs, k.killerId, k.killerModel, k.victimId, k.victimModel, k.weapon,
      k.killerPos?.x ?? null, k.killerPos?.y ?? null, k.killerPos?.z ?? null,
      k.victimPos?.x ?? null, k.victimPos?.y ?? null, k.victimPos?.z ?? null,
    )
  }
}

function insertBattleChatRows(database: DatabaseSync, sessionId: string, chat: readonly BattleChatInput[]): void {
  const cStmt = database.prepare(
    'INSERT INTO battle_chat (session_id, time_ms, sender, channel, channel_valid, message) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const m of chat) {
    const valid = m.channelValid ?? isValidBattleChatChannel(m.channel)
    cStmt.run(sessionId, m.timeMs, m.sender, m.channel, valid ? 1 : 0, m.message)
  }
}

/**
 * Починка записанного боя (worker-задача repair-battle-events): заменяет
 * блоб событий, только если он не изменился с чтения (ingest мог
 * переразобрать бой), и вместе с ним — строки убийств и чата и счётчики боя.
 * Вызывать внутри транзакции записи. false — блоб уже другой, ничего не
 * записано.
 */
export function replaceRepairedBattleEvents(
  database: DatabaseSync,
  input: {
    sessionId: string
    previousBlob: Uint8Array
    eventsBlob: Uint8Array
    kills: readonly BattleKillInput[]
    chat: readonly BattleChatInput[]
    airUnitCount: number
  },
): boolean {
  const updated = database
    .prepare('UPDATE battle_events SET events_blob = ? WHERE session_id = ? AND events_blob = ?')
    .run(input.eventsBlob, input.sessionId, input.previousBlob)
  if (Number(updated.changes) === 0) return false
  database.prepare('DELETE FROM battle_kills WHERE session_id = ?').run(input.sessionId)
  database.prepare('DELETE FROM battle_chat WHERE session_id = ?').run(input.sessionId)
  insertBattleKillRows(database, input.sessionId, input.kills)
  insertBattleChatRows(database, input.sessionId, input.chat)
  database
    .prepare('UPDATE battles SET kill_count = ?, chat_count = ?, air_unit_count = ? WHERE session_id = ?')
    .run(input.kills.length, input.chat.length, input.airUnitCount, input.sessionId)
  return true
}

/**
 * Заполняет пустые производные поля боя из его событий (бои первых версий
 * разбора): air_unit_count и chat_count боя, slot и title игроков. Только
 * NULL — значения нового разбора не трогаются. Возвращает число строк.
 */
export function fillMissingBattleFields(
  database: DatabaseSync,
  input: {
    sessionId: string
    airUnitCount: number
    chatCount: number
    slots: readonly { userId: string; slot: number; title: string | null }[]
  },
): number {
  let rows = Number(database
    .prepare(`
      UPDATE battles SET air_unit_count = COALESCE(air_unit_count, ?), chat_count = COALESCE(chat_count, ?)
      WHERE session_id = ? AND (air_unit_count IS NULL OR chat_count IS NULL)
    `)
    .run(input.airUnitCount, input.chatCount, input.sessionId).changes)
  const slotStmt = database.prepare(`
    UPDATE battle_players SET slot = COALESCE(slot, ?), title = COALESCE(title, ?)
    WHERE session_id = ? AND user_id = ? AND (slot IS NULL OR title IS NULL)
  `)
  for (const player of input.slots) {
    rows += Number(slotStmt.run(player.slot, player.title, input.sessionId, player.userId).changes)
  }
  return rows
}

function runImmediateTransaction(database: DatabaseSync, work: () => void): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    work()
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function saveBattle(b: BattleInput): void {
  const database = getDb()
  runImmediateTransaction(database, () => saveBattleRows(database, b))
  ingestStatsCache = null
}

/** Номер победившей команды из разобранного боя (null — бой не разобран) */
export function getBattleWinner(sessionId: string): number | null {
  const teamWon = getBattlePostSummary(sessionId)?.teamWon ?? 0
  return teamWon === 0 ? null : teamWon
}

export interface BattlePostSummary {
  teamWon: number
  airUnitCount: number | null
  chatCount: number | null
}

/** Маленькая PK-read model без чтения events_blob и дочерних таблиц. */
export function getBattlePostSummary(sessionId: string): BattlePostSummary | null {
  selectBattlePostSummaryStatement ??= getDb().prepare(`
    SELECT team_won, air_unit_count, chat_count
    FROM battles
    WHERE session_id = ?
  `)
  const row = selectBattlePostSummaryStatement.get(sessionId) as {
      team_won: number
      air_unit_count: number | null
      chat_count: number | null
    } | undefined
  return row
    ? {
        teamWon: row.team_won,
        airUnitCount: row.air_unit_count,
        chatCount: row.chat_count,
      }
    : null
}

/** Ноль в team_won означает, что победитель неизвестен. */
export function isKnownBattleWinner(teamWon: number): boolean {
  return Number.isFinite(teamWon) && teamWon !== 0
}

/** Допустимые значения канала чата: 0..3. */
export function isValidBattleChatChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= 0 && channel <= 3
}

/** Сжатый blob событий боя (по десятичному id или hex) — null, если боя нет */
export function getBattleEventsBlob(sessionId: string): Buffer | null {
  const row = getDb()
    .prepare(`
      SELECT e.events_blob
      FROM battles b
      JOIN battle_events e ON e.session_id = b.session_id
      WHERE b.session_id = ? OR b.session_hex = ?
    `)
    .get(sessionId, sessionId.toLowerCase()) as { events_blob: Uint8Array | null } | undefined
  return row?.events_blob ? Buffer.from(row.events_blob) : null
}

/** Строка боя из battles (для перерисовки картинок из БД) */
export interface BattleRow {
  session_id: string
  session_hex: string
  mission_name: string
  level: string
  game_mode: string | null
  battle_type: string | null
  environment: string | null
  status: string | null
  start_time: number
  duration_sec: number
  end_time_ms: number
  /** 0 означает «победитель неизвестен»; это не номер проигравшей команды. */
  team_won: number
  winner_known: number
  game_version: string | null
  player_count: number
  kill_count: number
  air_unit_count: number | null
  chat_count: number | null
  mission_settings: string | null
}

/** Строка игрока из battle_players (для перерисовки) */
export interface BattlePlayerRow {
  user_id: string
  nick: string
  clan_tag: string
  team: number
  kills: number
  ground_kills: number
  naval_kills: number
  ai_kills: number
  ai_ground_kills: number
  assists: number
  deaths: number
  capture_zone: number
  damage_zone: number
  score: number
  award_damage: number
  team_kills: number
  squad_id: number
  vehicle: string | null
  vehicles: string
  disconnected: number
  slot: number | null
  title: string | null
  auto_squad: number | null
}

export interface BattleForRender {
  battle: BattleRow
  players: BattlePlayerRow[]
  eventsBlob: Buffer | null
}

export interface BattleSummaryForRender {
  battle: BattleRow
  players: BattlePlayerRow[]
}

/** Таблица результатов без большого events_blob — для /battle и анонсов. */
export function getBattleSummaryForRender(sessionId: string): BattleSummaryForRender | null {
  const battle = getDb()
    .prepare(`
      SELECT session_id, session_hex, mission_name, level, game_mode, battle_type,
             environment, status, start_time, duration_sec, end_time_ms, team_won,
             CASE WHEN team_won <> 0 THEN 1 ELSE 0 END AS winner_known,
             game_version, player_count, kill_count, mission_settings
      FROM battles WHERE session_id = ? OR session_hex = ?
    `)
    .get(sessionId, sessionId.toLowerCase()) as BattleRow | undefined
  if (!battle) return null

  const players = getDb()
    .prepare(`
      SELECT user_id, nick, clan_tag, team, kills, ground_kills, naval_kills, ai_kills,
             ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
             award_damage, team_kills, squad_id, vehicle, vehicles, disconnected,
             slot, title, auto_squad
      FROM battle_players WHERE session_id = ?
    `)
    .all(battle.session_id) as unknown as BattlePlayerRow[]
  return { battle, players }
}

/** Уникальные id оружия нужны main thread для подготовки иконок ГСН. */
export function getBattleWeaponIds(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT weapon FROM battle_kills WHERE session_id = ? AND weapon <> ''")
    .all(sessionId) as { weapon: string }[]
  return rows.map((row) => row.weapon)
}

/**
 * Всё, что нужно, чтобы перерисовать картинки боя из БД без реплея:
 * строка battles, игроки и blob событий. null — бой не разобран.
 */
export function getBattleForRender(sessionId: string): BattleForRender | null {
  const battle = getDb()
    .prepare(`
      SELECT session_id, session_hex, mission_name, level, game_mode, battle_type,
             environment, status, start_time, duration_sec, end_time_ms, team_won,
             CASE WHEN team_won <> 0 THEN 1 ELSE 0 END AS winner_known,
             game_version, player_count, kill_count, mission_settings,
             (SELECT e.events_blob FROM battle_events e WHERE e.session_id = battles.session_id) AS events_blob
      FROM battles WHERE session_id = ? OR session_hex = ?
    `)
    .get(sessionId, sessionId.toLowerCase()) as (BattleRow & { events_blob: Uint8Array | null }) | undefined
  if (!battle) return null

  const players = getDb()
    .prepare(`
      SELECT user_id, nick, clan_tag, team, kills, ground_kills, naval_kills, ai_kills,
             ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
             award_damage, team_kills, squad_id, vehicle, vehicles, disconnected,
             slot, title, auto_squad
      FROM battle_players WHERE session_id = ?
    `)
    .all(battle.session_id) as unknown as BattlePlayerRow[]

  const { events_blob, ...row } = battle
  return { battle: row, players, eventsBlob: events_blob ? Buffer.from(events_blob) : null }
}

// ---------- Очередь разбора боёв (battle_ingest) ----------

export type BattleIngestStatus = 'ok' | 'error' | 'no_parts' | 'expired'

/** Единый terminal threshold для ingest, API backlog и автоанонса. */
export const BATTLE_INGEST_MAX_ATTEMPTS = 3

function markBattleIngestRow(
  database: DatabaseSync,
  sessionId: string,
  status: BattleIngestStatus,
  error: string | null,
): void {
  // Повторный разбор уже записанного боя (миграция, ручной перезапуск) не
  // удался окончательно — части ушли с CDN. Строки прежнего разбора остаются
  // лучшими данными: статус ok, причина — в error. error (с повторами) не
  // трогается: следующая попытка может пройти.
  if (
    (status === 'expired' || status === 'no_parts') &&
    database.prepare('SELECT 1 FROM battles WHERE session_id = ?').get(sessionId) !== undefined
  ) {
    error = `повторный разбор не удался, оставлен прежний: ${error ?? status}`
    status = 'ok'
  }
  database
    .prepare(`
      INSERT INTO battle_ingest (session_id, status, attempts, error, updated_at)
      VALUES (?, ?, 1, ?, unixepoch())
      ON CONFLICT (session_id) DO UPDATE SET
        status = excluded.status,
        attempts = battle_ingest.attempts + 1,
        error = excluded.error,
        updated_at = unixepoch()
    `)
    .run(sessionId, status, error)
}

/** Записывает исход разбора боя; при повторе увеличивает счётчик попыток */
export function markBattleIngest(sessionId: string, status: BattleIngestStatus, error: string | null = null): void {
  markBattleIngestRow(getDb(), sessionId, status, error)
  ingestStatsCache = null
}

/**
 * Атомарная запись успешного ingest для отдельного SQLite connection.
 * CPU worker использует её, чтобы fsync/checkpoint не блокировали event loop.
 */
export function saveIngestedBattle(
  database: DatabaseSync,
  b: BattleInput,
  sessionId: string,
): void {
  runImmediateTransaction(database, () => {
    saveBattleRows(database, b)
    markBattleIngestRow(database, sessionId, 'ok', null)
  })
  ingestStatsCache = null
}

/** Статус разбора боя (null — ещё не брались) — для решения автоанонса «ждать или пропустить» */
export function getBattleIngestState(sessionId: string): { status: BattleIngestStatus; attempts: number } | null {
  const row = getDb()
    .prepare('SELECT status, attempts FROM battle_ingest WHERE session_id = ?')
    .get(sessionId) as { status: BattleIngestStatus; attempts: number } | undefined
  return row ?? null
}

/**
 * Записи wt-replays, которые ещё надо разобрать: не разобранные успешно,
 * не помеченные бесполезными (нет частей / части ушли с CDN) и не
 * исчерпавшие лимит попыток. Новые (большой id) первыми — их части ещё
 * живы на CDN.
 */
export type PendingBattleOrder = 'newest' | 'oldest'

export function getPendingBattleItems(
  maxAttempts: number,
  limit: number,
  order: PendingBattleOrder = 'newest',
): PendingBattleItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at,
             i.first_seen_at, NULL AS analysis
      FROM items i
      LEFT JOIN battle_ingest bi ON bi.session_id = i.external_id
      WHERE i.source = 'wt-replays'
        AND (
          bi.session_id IS NULL
          OR (bi.status = 'error' AND bi.attempts < ?)
        )
      ORDER BY i.id ${order === 'oldest' ? 'ASC' : 'DESC'}
      LIMIT ?
    `)
    .all(maxAttempts, limit) as unknown as Array<ItemRow & { first_seen_at: number }>
  return rows.map((row) => ({ ...toStoredItem(row), firstSeenAt: row.first_seen_at }))
}

/** Сводка разбора для дашборда: сколько боёв разобрано, в очереди, провалено */
export interface IngestStats {
  ingested: number
  /** Точное число записей, которые getPendingBattleItems() ещё может выбрать. */
  pending: number
  failed: number
  players: number
  kills: number
}

export function getIngestStats(): IngestStats {
  const dataVersion = getDataVersion()
  if (ingestStatsCache?.dataVersion === dataVersion) return ingestStatsCache.value
  // battle_ingest создаётся исключительно для wt-replays items. Поэтому точная
  // очередь = все replay items - любое terminal/nonterminal state + retryable
  // errors. Это эквивалентно LEFT JOIN selection, но не делает 23k point lookup
  // и остаётся <10 мс p95 на production DB.
  selectIngestStatsStatement ??= getDb().prepare(`
    WITH ingest_state AS (
      SELECT
        COUNT(*) AS states,
        COALESCE(SUM(CASE WHEN status IN ('error', 'expired', 'no_parts') THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'error' AND attempts < ? THEN 1 ELSE 0 END), 0) AS retryable
      FROM battle_ingest
    ),
    item_state AS (
      SELECT COUNT(*) AS total
      FROM items
      WHERE source = 'wt-replays'
    ),
    battle_totals AS (
      SELECT
        COUNT(*) AS ingested,
        COALESCE(SUM(player_count), 0) AS players,
        COALESCE(SUM(kill_count), 0) AS kills
      FROM battles INDEXED BY idx_battles_metrics
    )
    SELECT
      battle_totals.ingested,
      item_state.total - ingest_state.states + ingest_state.retryable AS pending,
      ingest_state.failed,
      battle_totals.players,
      battle_totals.kills
    FROM ingest_state, item_state, battle_totals
  `)
  const row = selectIngestStatsStatement.get(BATTLE_INGEST_MAX_ATTEMPTS) as {
    ingested: number
    pending: number
    failed: number
    players: number
    kills: number
  }
  const value = {
    ingested: row.ingested,
    pending: Math.max(0, row.pending),
    failed: row.failed,
    players: row.players,
    kills: row.kills,
  }
  ingestStatsCache = { dataVersion, value }
  return value
}

export interface AnnounceStats {
  baselineId: number
  pending: number
  unattempted: number
  retrying: number
  sent: number
  failed: number
}

/** Сводка отдельной очереди Discord-анонсов, не смешивать с ingest.pending. */
export function getAnnounceStats(maxAttempts = 3): AnnounceStats {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new RangeError('Лимит попыток автоанонса должен быть целым от 1 до 100')
  }
  const row = getDb().prepare(`
    WITH baseline AS (
      SELECT CAST(COALESCE((SELECT value FROM bot_state WHERE key = 'battles:lastAnnouncedId'), '0') AS INTEGER) AS id
    )
    SELECT
      baseline.id AS baseline_id,
      COALESCE(SUM(CASE WHEN i.id > baseline.id
        AND (a.item_id IS NULL OR (a.status IN ('pending', 'failed') AND a.attempts < ?))
        THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN i.id > baseline.id AND a.item_id IS NULL THEN 1 ELSE 0 END), 0) AS unattempted,
      COALESCE(SUM(CASE WHEN i.id > baseline.id
        AND a.status IN ('pending', 'failed') AND a.attempts < ?
        THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN i.id > baseline.id AND a.status = 'ok' THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN i.id > baseline.id
        AND a.status = 'failed' AND a.attempts >= ?
        THEN 1 ELSE 0 END), 0) AS failed
    FROM items i
    CROSS JOIN baseline
    LEFT JOIN announce_state a ON a.item_id = i.id
    WHERE i.source = 'wt-replays'
  `).get(maxAttempts, maxAttempts, maxAttempts) as {
    baseline_id: number
    pending: number
    unattempted: number
    retrying: number
    sent: number
    failed: number
  }
  return {
    baselineId: row.baseline_id,
    pending: row.pending,
    unattempted: row.unattempted,
    retrying: row.retrying,
    sent: row.sent,
    failed: row.failed,
  }
}

// ---------- Read-модель сайта (страницы игроков, кланов и боёв) ----------
//
// Все запросы ниже строго read-only и рассчитаны на синхронный SQLite в main
// thread: каждый обязан ходить по индексу (см. smoke с EXPLAIN QUERY PLAN),
// SCAN battles/battle_players недопустим. SQL вынесен в SITE_SQL, чтобы smoke
// мог прогнать планы тех же самых текстов, которые реально подготавливаются.

/** Фиксированное число слотов IN (...): statement готовится один раз. */
const SITE_IN_SLOTS = 8
const SITE_ALIAS_IN_SLOTS = 16
/** Значение-заглушка для пустых слотов IN: не встречается ни в никах, ни в тегах. */
const SITE_IN_FILLER = '\u0000'

const siteInSlots = (count: number): string => Array.from({ length: count }, () => '?').join(', ')

// Слот с ником coop/Bot… и настоящим userId сыграл бот (0 очков, 0 фрагов):
// в личную статистику, поиск и определение ника игрока он не входит.
export const SITE_SQL = {
  searchIdentitiesByNick: `
    SELECT id, wt_user_id, canonical_nick, platform, updated_at
    FROM player_identities
    WHERE canonical_nick_search >= ? AND canonical_nick_search < ?
    ORDER BY canonical_nick_search, canonical_nick
    LIMIT ?
  `,
  searchIdentityByWtUserId: `
    SELECT id, wt_user_id, canonical_nick, platform, updated_at
    FROM player_identities
    WHERE wt_user_id = ?
  `,
  searchAliasesByNick: `
    SELECT a.identity_id, a.nick, a.last_seen_at, i.wt_user_id, i.platform
    FROM player_identity_aliases a
    JOIN player_identities i ON i.id = a.identity_id
    WHERE a.nick_search >= ? AND a.nick_search < ?
    ORDER BY a.nick_search, a.last_seen_at DESC
    LIMIT ?
  `,
  knownPlayerReplayByNick: `
    WITH matched AS (
      SELECT user_id, nick, session_id FROM battle_players WHERE nick_search = ? AND nick NOT GLOB 'coop/Bot*'
    ),
    ranked AS (
      SELECT
        m.user_id,
        m.nick,
        b.start_time,
        ROW_NUMBER() OVER (
          PARTITION BY m.user_id
          ORDER BY b.start_time DESC, b.session_id DESC
        ) AS row_number
      FROM matched m
      JOIN battles b ON b.session_id = m.session_id
      WHERE m.user_id <> ''
    )
    SELECT
      'replay' AS origin,
      'wrpl' AS source,
      NULL AS identity_id,
      CASE WHEN user_id NOT GLOB '*[^0-9]*' THEN user_id ELSE NULL END AS wt_user_id,
      nick,
      NULL AS platform,
      start_time AS seen_at
    FROM ranked
    WHERE row_number = 1
    ORDER BY start_time DESC, user_id
    LIMIT 50
  `,
  knownPlayerReplayByUserOrNick: `
    WITH matched AS (
      SELECT user_id, nick, session_id FROM battle_players WHERE user_id = ? AND nick NOT GLOB 'coop/Bot*'
      UNION
      SELECT user_id, nick, session_id FROM battle_players WHERE nick_search = ? AND nick NOT GLOB 'coop/Bot*'
    ),
    ranked AS (
      SELECT
        m.user_id,
        m.nick,
        b.start_time,
        ROW_NUMBER() OVER (
          PARTITION BY m.user_id
          ORDER BY b.start_time DESC, b.session_id DESC
        ) AS row_number
      FROM matched m
      JOIN battles b ON b.session_id = m.session_id
      WHERE m.user_id <> ''
    )
    SELECT
      'replay' AS origin,
      'wrpl' AS source,
      NULL AS identity_id,
      CASE WHEN user_id NOT GLOB '*[^0-9]*' THEN user_id ELSE NULL END AS wt_user_id,
      nick,
      NULL AS platform,
      start_time AS seen_at
    FROM ranked
    WHERE row_number = 1
    ORDER BY start_time DESC, user_id
    LIMIT 50
  `,
  searchReplayNicks: `
    SELECT nick, user_id
    FROM battle_players
    WHERE nick_search >= ? AND nick_search < ?
      AND user_id <> ''
      AND nick NOT GLOB 'coop/Bot*'
    GROUP BY user_id, nick_search, nick
    LIMIT ?
  `,
  ratingHistoryByNicks: `
    SELECT nick, clan_tag, rating, seen_at
    FROM clan_rating_snapshots
    WHERE nick IN (${siteInSlots(SITE_IN_SLOTS)}) AND seen_at >= ?
    ORDER BY id
    LIMIT ?
  `,
  externalAggregateHistory: `
    SELECT
      s.id AS snapshot_id, s.last_checked_at, s.fetched_at, s.source_updated_at,
      t.battles, t.victories, t.defeats, t.deaths, t.time_played_sec,
      t.air_kills, t.ground_kills, t.naval_kills
    FROM player_external_snapshots s
    JOIN player_external_totals t ON t.snapshot_id = s.id
      AND t.game_type IS NULL AND t.mode IS NULL AND t.category IS NULL
    WHERE s.identity_id = ? AND s.source = ? AND s.status = 'ok'
    ORDER BY s.last_checked_at, s.id
    LIMIT ?
  `,
  activityByDay: `
    SELECT
      date(b.start_time, 'unixepoch') AS day,
      COUNT(*) AS battles,
      COALESCE(SUM(CASE WHEN b.team_won <> 0 AND bp.team = b.team_won THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN b.team_won = 0 THEN 1 ELSE 0 END), 0) AS unknown_results
    FROM battle_players bp
    JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.user_id = ? AND bp.user_id <> '' AND bp.nick NOT GLOB 'coop/Bot*' AND b.start_time >= ?
    GROUP BY day
    ORDER BY day
  `,
  // Последний снимок ника в окне. При единственном MAX() «голые» колонки
  // SQLite берёт из строки с максимумом — один проход по покрывающему
  // idx_snapshots_clan_latest без обратного соединения по id (28 тыс.
  // обращений к таблице на каждую перестройку снимка кланов).
  clanLatestMembers: `
    SELECT clan_tag, nick, rating, seen_at, MAX(id) AS max_id
    FROM clan_rating_snapshots
    WHERE seen_at >= ?
    GROUP BY clan_tag, nick
  `,
  clanRosterAll: `
    SELECT clan_core, nick, last_present_at FROM clan_roster
  `,
  clanRosterDetails: `
    SELECT nick, role, joined_at, activity FROM clan_roster WHERE clan_core = ?
  `,
  clanProfile: `
    SELECT clan_id, description, announcement, requirements, status, auto_accept, plain_tag, regalia
    FROM clans
    WHERE tag = ?
  `,
  firstBattleAt: `
    SELECT MIN(start_time) AS first_battle_at
    FROM battles
  `,
  clanBattleTeams: `
    SELECT
      b.session_id, b.start_time, b.team_won, bp.team,
      COUNT(*) AS players,
      COALESCE(SUM(bp.score), 0) AS score,
      COALESCE(SUM(bp.kills + bp.ground_kills + bp.naval_kills), 0) AS kills,
      COALESCE(SUM(bp.deaths), 0) AS deaths
    FROM battle_players bp
    JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.clan_tag IN (${siteInSlots(SITE_IN_SLOTS)})
      AND b.start_time >= ? AND b.start_time < ?
    GROUP BY b.session_id, bp.team
    ORDER BY b.start_time DESC
    LIMIT ?
  `,
  battlesRecent: `
    SELECT session_id, session_hex, mission_name, game_mode, start_time,
           duration_sec, team_won, player_count, kill_count
    FROM battles
    WHERE (? IS NULL OR start_time >= ?) AND (? IS NULL OR start_time < ?)
    ORDER BY start_time DESC
    LIMIT ?
  `,
  battlesByUser: `
    SELECT
      b.session_id, b.session_hex, b.mission_name, b.game_mode, b.start_time,
      b.duration_sec, b.team_won, b.player_count, b.kill_count,
      bp.team, bp.score, bp.kills + bp.ground_kills + bp.naval_kills AS frags,
      bp.deaths, bp.vehicle
    FROM battle_players bp
    JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.user_id = ? AND bp.user_id <> '' AND bp.nick NOT GLOB 'coop/Bot*'
      AND (? IS NULL OR b.start_time >= ?) AND (? IS NULL OR b.start_time < ?)
    ORDER BY b.start_time DESC
    LIMIT ?
  `,
  battlesByClan: `
    SELECT DISTINCT
      b.session_id, b.session_hex, b.mission_name, b.game_mode, b.start_time,
      b.duration_sec, b.team_won, b.player_count, b.kill_count
    FROM battle_players bp
    JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.clan_tag IN (${siteInSlots(SITE_IN_SLOTS)})
      AND (? IS NULL OR b.start_time >= ?) AND (? IS NULL OR b.start_time < ?)
    ORDER BY b.start_time DESC
    LIMIT ?
  `,
  battleById: `
    SELECT session_id, session_hex, mission_name, level, game_mode, battle_type,
           environment, status, start_time, duration_sec, end_time_ms, team_won,
           CASE WHEN team_won <> 0 THEN 1 ELSE 0 END AS winner_known,
           game_version, player_count, kill_count, mission_settings
    FROM battles
    WHERE session_id = ?
  `,
  battleBySessionOrHex: `
    SELECT session_id
    FROM battles
    WHERE session_id = ? OR session_hex = ?
  `,
  battlePlayersBySession: `
    SELECT user_id, nick, clan_tag, team, kills, ground_kills, naval_kills, ai_kills,
           ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
           award_damage, team_kills, squad_id, vehicle, vehicles, disconnected,
           slot, title, auto_squad
    FROM battle_players
    WHERE session_id = ?
  `,
  aliasIdentitiesByNickBase: `
    SELECT a.nick_base, a.identity_id, i.wt_user_id, i.canonical_nick, i.platform
    FROM player_identity_aliases a
    JOIN player_identities i ON i.id = a.identity_id
    WHERE a.nick_base IN (${siteInSlots(SITE_ALIAS_IN_SLOTS)})
  `,
  replayNickByUserId: `
    SELECT nick FROM battle_players
    WHERE user_id = ? AND user_id <> '' AND nick NOT GLOB 'coop/Bot*'
    ORDER BY rowid DESC
    LIMIT 1
  `,
  eventsBlobById: `
    SELECT events_blob FROM battle_events
    WHERE session_id = ?
  `,
  siteBattleCounts: `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN start_time >= ? THEN 1 ELSE 0 END), 0) AS recent,
           MAX(start_time) AS last_start
    FROM battles
    WHERE start_time >= 0
  `,
  siteReplayPlayerCount: `
    SELECT COUNT(*) AS players FROM (
      SELECT DISTINCT user_id FROM battle_players WHERE user_id <> ''
    )
  `,
  siteBattlesByDayAll: `
    SELECT date(start_time, 'unixepoch') AS day, COUNT(*) AS battles
    FROM battles
    WHERE start_time >= ?
    GROUP BY day
    ORDER BY day
  `,
  clanRatingEvents: `
    SELECT s.clan_tag, s.nick, s.rating, s.seen_at
    FROM clan_rating_snapshots s
    WHERE s.clan_tag IN (${siteInSlots(SITE_IN_SLOTS)}) AND s.seen_at >= ?
      AND (EXISTS (SELECT 1 FROM clan_roster r WHERE r.clan_core = ? AND r.nick = s.nick)
        OR NOT EXISTS (SELECT 1 FROM clan_roster r2 WHERE r2.clan_core = ?))
    ORDER BY s.seen_at, s.id
    LIMIT ?
  `,
  // Фильтр ростера зависит только от ника — его можно применить до
  // группировки; значения берутся из строки с MAX(id), как в clanLatestMembers.
  clanRatingBaseline: `
    SELECT s.clan_tag, s.nick, s.rating, MAX(s.id) AS max_id
    FROM clan_rating_snapshots s
    WHERE s.clan_tag IN (${siteInSlots(SITE_IN_SLOTS)}) AND s.seen_at >= ? AND s.seen_at <= ?
      AND (EXISTS (SELECT 1 FROM clan_roster r WHERE r.clan_core = ? AND r.nick = s.nick)
       OR NOT EXISTS (SELECT 1 FROM clan_roster r2 WHERE r2.clan_core = ?))
    GROUP BY s.clan_tag, s.nick
  `,
  clanBaselineSumsAll: `
    SELECT clan_tag, nick, rating, MAX(id) AS max_id
    FROM clan_rating_snapshots
    WHERE seen_at >= ? AND seen_at <= ?
    GROUP BY clan_tag, nick
  `,
  clanDictionary: `
    SELECT
      tag, name, rating, position, members, battles, wins, rating_at,
      air_kills, ground_kills, deaths, flight_time, activity, region, clan_type, founded_at, slogan, rewards
    FROM clans
  `,
  clanOfficialRatingAt: `
    SELECT captured_at, rating
    FROM clan_rating_history
    WHERE clan_core = ? AND captured_at >= ? AND captured_at <= ?
    ORDER BY captured_at DESC
    LIMIT 1
  `,
  clanOfficialRatingEvents: `
    SELECT captured_at, rating, battles, wins
    FROM clan_rating_history
    WHERE clan_core = ? AND captured_at > ? AND captured_at <= ?
    ORDER BY captured_at
    LIMIT ?
  `,
  battleTeamClans: `
    SELECT team, clan_tag, COUNT(*) AS players
    FROM battle_players
    WHERE session_id = ?
    GROUP BY team, clan_tag
  `,
  battleTeamClansBatch: `
    SELECT session_id, team, clan_tag, COUNT(*) AS players
    FROM battle_players
    WHERE session_id IN (SELECT value FROM json_each(?))
    GROUP BY session_id, team, clan_tag
  `,
  // Аналитика игрока: CROSS JOIN фиксирует порядок — сначала бои игрока по
  // idx_bp_user_id, а не все бои периода по idx_battles_start.
  playerInsightSessions: `
    SELECT b.session_id, b.start_time, b.mission_name, b.team_won, bp.team, bp.vehicle, bp.vehicles
    FROM battle_players bp
    CROSS JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.user_id = ? AND bp.nick NOT GLOB 'coop/Bot*'
      AND b.start_time >= ? AND b.start_time < ?
    ORDER BY b.start_time DESC
    LIMIT ?
  `,
  playerInsightPlayers: `
    SELECT session_id, user_id, nick, clan_tag, team
    FROM battle_players
    WHERE session_id IN (SELECT value FROM json_each(?))
      AND user_id <> '' AND nick NOT GLOB 'coop/Bot*'
  `,
  playerInsightKills: `
    SELECT session_id, killer_id, killer_model, victim_id, victim_model, weapon
    FROM battle_kills
    WHERE session_id IN (SELECT value FROM json_each(?))
      AND (killer_id = ? OR victim_id = ?)
  `,
} as const

const siteStatements = new Map<keyof typeof SITE_SQL, StatementSync>()

function siteStatement(key: keyof typeof SITE_SQL): StatementSync {
  let statement = siteStatements.get(key)
  if (!statement) {
    statement = getDb().prepare(SITE_SQL[key])
    siteStatements.set(key, statement)
  }
  return statement
}

function padSiteList(values: readonly string[], slots: number): string[] {
  if (values.length > slots) {
    throw new RangeError(`Список для IN(...) не может быть длиннее ${slots}`)
  }
  const padded = [...values]
  while (padded.length < slots) padded.push(SITE_IN_FILLER)
  return padded
}

/** Верхняя граница префиксного поиска: последний код-пойнт увеличен на единицу. */
function sitePrefixUpperBound(prefix: string): string {
  const codePoints = [...prefix]
  const last = codePoints.pop()
  if (last === undefined) throw new RangeError('Префикс поиска не может быть пустым')
  const next = (last.codePointAt(0) ?? 0) + 1
  return codePoints.join('') + String.fromCodePoint(next)
}

function siteSearchQueryText(query: string): string {
  const normalized = query.trim()
  if (normalized.length < 2 || normalized.length > 64) {
    throw new RangeError('Поисковый запрос должен быть длиной от 2 до 64 символов')
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError('Поисковый запрос не может содержать управляющие символы')
  }
  return normalized
}

function siteLimit(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} должен быть целым от 1 до ${max}`)
  }
  return value
}

export type SitePlayerSearchOrigin = 'identity' | 'alias' | 'replay'

export interface SitePlayerSearchResult {
  identityId: number | null
  wtUserId: string | null
  nick: string
  platform: string | null
  origin: SitePlayerSearchOrigin
  lastSeenAt: number | null
}

/**
 * Префиксный поиск игроков для страницы поиска сайта. Только чтение:
 * identity не создаются и внешние источники не опрашиваются.
 */
export function searchSitePlayers(query: string, limit = 20): SitePlayerSearchResult[] {
  const normalized = siteSearchQueryText(query)
  const normalizedLimit = siteLimit(limit, 50, 'Лимит поиска игроков')
  const lower = normalizePlayerSearchKey(normalized)
  const upper = sitePrefixUpperBound(lower)

  const results: SitePlayerSearchResult[] = []
  const seenIdentityIds = new Set<number>()
  const seenReplayKeys = new Set<string>()

  if (/^[0-9]{1,20}$/.test(normalized)) {
    const row = siteStatement('searchIdentityByWtUserId').get(normalized) as
      | { id: number; wt_user_id: string | null; canonical_nick: string; platform: string | null; updated_at: number }
      | undefined
    if (row) {
      seenIdentityIds.add(row.id)
      results.push({
        identityId: row.id,
        wtUserId: row.wt_user_id,
        nick: row.canonical_nick,
        platform: row.platform,
        origin: 'identity',
        lastSeenAt: row.updated_at,
      })
    }
  }

  const identityRows = siteStatement('searchIdentitiesByNick')
    .all(lower, upper, normalizedLimit) as unknown as {
      id: number
      wt_user_id: string | null
      canonical_nick: string
      platform: string | null
      updated_at: number
    }[]
  for (const row of identityRows) {
    if (seenIdentityIds.has(row.id)) continue
    seenIdentityIds.add(row.id)
    results.push({
      identityId: row.id,
      wtUserId: row.wt_user_id,
      nick: row.canonical_nick,
      platform: row.platform,
      origin: 'identity',
      lastSeenAt: row.updated_at,
    })
  }

  const aliasRows = siteStatement('searchAliasesByNick')
    .all(lower, upper, normalizedLimit) as unknown as {
      identity_id: number
      nick: string
      last_seen_at: number
      wt_user_id: string | null
      platform: string | null
    }[]
  for (const row of aliasRows) {
    if (seenIdentityIds.has(row.identity_id)) continue
    seenIdentityIds.add(row.identity_id)
    results.push({
      identityId: row.identity_id,
      wtUserId: row.wt_user_id,
      nick: row.nick,
      platform: row.platform,
      origin: 'alias',
      lastSeenAt: row.last_seen_at,
    })
  }

  const replayRows = siteStatement('searchReplayNicks')
    .all(lower, upper, normalizedLimit) as unknown as { nick: string; user_id: string }[]
  const knownWtUserIds = new Set(results.map((entry) => entry.wtUserId).filter(Boolean))
  for (const row of replayRows) {
    if (knownWtUserIds.has(row.user_id)) continue
    const key = `${row.user_id}:${normalizePlayerSearchKey(row.nick)}`
    if (seenReplayKeys.has(key)) continue
    seenReplayKeys.add(key)
    results.push({
      identityId: null,
      wtUserId: row.user_id,
      nick: row.nick,
      platform: null,
      origin: 'replay',
      lastSeenAt: null,
    })
  }

  const queryLower = normalizePlayerSearchKey(normalized)
  const originRank: Record<SitePlayerSearchOrigin, number> = { identity: 0, alias: 1, replay: 2 }
  results.sort((a, b) => {
    const exactA = normalizePlayerSearchKey(a.nick) === queryLower ? 0 : 1
    const exactB = normalizePlayerSearchKey(b.nick) === queryLower ? 0 : 1
    if (exactA !== exactB) return exactA - exactB
    if (originRank[a.origin] !== originRank[b.origin]) return originRank[a.origin] - originRank[b.origin]
    return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
  })
  return results.slice(0, normalizedLimit)
}

export interface SiteRatingHistoryPoint {
  nick: string
  clanTag: string
  rating: number
  seenAt: number
}

/**
 * История ПКР по точным никам алиасов identity. Именно по `nick`, не по
 * `nick_base`: base склеивает ПК-игрока и консольного «Foo@psn».
 */
export function getSiteRatingHistory(
  nicks: readonly string[],
  limit = 1000,
): SiteRatingHistoryPoint[] {
  const filtered = [...new Set(nicks.map((nick) => nick.trim()).filter(Boolean))]
  if (filtered.length === 0) return []
  const normalizedLimit = siteLimit(limit, 2000, 'Лимит истории ПКР')
  const rows = siteStatement('ratingHistoryByNicks')
    .all(
      ...padSiteList(filtered.slice(0, SITE_IN_SLOTS), SITE_IN_SLOTS),
      currentClanSeasonStart(),
      normalizedLimit,
    ) as unknown as {
      nick: string
      clan_tag: string
      rating: number
      seen_at: number
    }[]
  return rows.map((row) => ({
    nick: row.nick,
    clanTag: row.clan_tag,
    rating: row.rating,
    seenAt: row.seen_at,
  }))
}

export interface SiteExternalHistoryPoint {
  snapshotId: number
  checkedAt: number
  fetchedAt: number
  sourceUpdatedAt: number | null
  battles: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  timePlayedSec: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

/** Агрегатная строка каждого ok-снимка источника: временной ряд для графиков. */
export function getSiteExternalAggregateHistory(
  identityId: number,
  source: string,
  limit = 400,
): SiteExternalHistoryPoint[] {
  if (!Number.isSafeInteger(identityId) || identityId <= 0) {
    throw new RangeError('identityId должен быть положительным целым числом')
  }
  const normalizedSource = source.trim()
  if (!normalizedSource) throw new RangeError('source не может быть пустым')
  const normalizedLimit = siteLimit(limit, 1000, 'Лимит истории снимков')
  const rows = siteStatement('externalAggregateHistory')
    .all(identityId, normalizedSource, normalizedLimit) as unknown as {
      snapshot_id: number
      last_checked_at: number
      fetched_at: number
      source_updated_at: number | null
      battles: number | null
      victories: number | null
      defeats: number | null
      deaths: number | null
      time_played_sec: number | null
      air_kills: number | null
      ground_kills: number | null
      naval_kills: number | null
    }[]
  return rows.map((row) => ({
    snapshotId: row.snapshot_id,
    checkedAt: row.last_checked_at,
    fetchedAt: row.fetched_at,
    sourceUpdatedAt: row.source_updated_at,
    battles: row.battles,
    victories: row.victories,
    defeats: row.defeats,
    deaths: row.deaths,
    timePlayedSec: row.time_played_sec,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    navalKills: row.naval_kills,
  }))
}

export interface SiteActivityPoint {
  day: string
  battles: number
  wins: number
  unknownResults: number
}

/** Бои по дням для графика активности; читает покрывающий idx_bp_user_id. */
export function getSiteActivityByDay(userId: string, fromTs: number): SiteActivityPoint[] {
  const normalized = userId.trim()
  if (!normalized) throw new RangeError('Для активности нужен непустой WT user id')
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new RangeError('fromTs должен быть неотрицательным Unix-временем')
  }
  const rows = siteStatement('activityByDay').all(normalized, fromTs) as unknown as {
    day: string
    battles: number
    wins: number
    unknown_results: number
  }[]
  return rows.map((row) => ({
    day: row.day,
    battles: row.battles,
    wins: row.wins,
    unknownResults: row.unknown_results,
  }))
}

export interface SiteBattleCounts {
  total: number
  recent: number
  lastStartAt: number | null
}

/** Счётчики боёв для плиток главной: всего, за период, время последнего. */
export function getSiteBattleCounts(sinceTs: number): SiteBattleCounts {
  if (!Number.isSafeInteger(sinceTs) || sinceTs < 0) {
    throw new RangeError('sinceTs должен быть неотрицательным Unix-временем')
  }
  const row = siteStatement('siteBattleCounts').get(sinceTs) as unknown as {
    total: number
    recent: number
    last_start: number | null
  }
  return { total: row.total, recent: row.recent, lastStartAt: row.last_start }
}

/** Число уникальных игроков в локальных реплеях (покрывающий idx_bp_user_id). */
export function getSiteReplayPlayerCount(): number {
  const row = siteStatement('siteReplayPlayerCount').get() as unknown as { players: number }
  return row.players
}

/** Бои по дням без фильтра по игроку — для графика активности на главной. */
export function getSiteBattlesByDay(fromTs: number): { day: string; battles: number }[] {
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new RangeError('fromTs должен быть неотрицательным Unix-временем')
  }
  return siteStatement('siteBattlesByDayAll').all(fromTs) as unknown as { day: string; battles: number }[]
}

export interface SiteClanMemberLatest {
  clanTag: string
  nick: string
  rating: number
  seenAt: number
}

/**
 * Последний снимок ПКР каждого (клан, ник). Группировка по «ядру» тега
 * выполняется вызывающим кодом: украшения тега нестабильны и живут в TS.
 */
export function getSiteClanLatestMembers(): SiteClanMemberLatest[] {
  const seasonStart = currentClanSeasonStart()
  const rows = siteStatement('clanLatestMembers').all(seasonStart) as unknown as {
    clan_tag: string
    nick: string
    rating: number
    seen_at: number
  }[]
  return rows.map((row) => ({
    clanTag: row.clan_tag,
    nick: row.nick,
    rating: row.rating,
    seenAt: row.seen_at,
  }))
}

export interface SiteClanRatingEvent {
  clanTag: string
  nick: string
  rating: number
  seenAt: number
}

/**
 * Change-point события ПКР участников клана с fromTs; truncated — упёрлись в
 * лимит. clanCore фильтрует по текущему составу (пустой ростер = без фильтра).
 */
export function getSiteClanRatingEvents(
  rawTags: readonly string[],
  clanCore: string,
  fromTs: number,
  limit = 20_000,
): { events: SiteClanRatingEvent[]; truncated: boolean } {
  const filtered = [...new Set(rawTags.filter((tag) => tag !== ''))]
  if (filtered.length === 0 || !clanCore) return { events: [], truncated: false }
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new RangeError('fromTs должен быть неотрицательным Unix-временем')
  }
  const normalizedLimit = siteLimit(limit, 20_000, 'Лимит событий ПКР клана')
  const rows = siteStatement('clanRatingEvents')
    .all(
      ...padSiteList(filtered.slice(0, SITE_IN_SLOTS), SITE_IN_SLOTS),
      fromTs,
      clanCore,
      clanCore,
      normalizedLimit,
    ) as unknown as { clan_tag: string; nick: string; rating: number; seen_at: number }[]
  return {
    events: rows.map((row) => ({
      clanTag: row.clan_tag,
      nick: row.nick,
      rating: row.rating,
      seenAt: row.seen_at,
    })),
    truncated: rows.length === normalizedLimit,
  }
}

/** Последнее ПКР каждого ника текущего состава на момент atTs (базис графика). */
export function getSiteClanRatingBaseline(
  rawTags: readonly string[],
  clanCore: string,
  atTs: number,
): { clanTag: string; nick: string; rating: number }[] {
  const filtered = [...new Set(rawTags.filter((tag) => tag !== ''))]
  if (filtered.length === 0 || !clanCore) return []
  if (!Number.isSafeInteger(atTs) || atTs < 0) {
    throw new RangeError('atTs должен быть неотрицательным Unix-временем')
  }
  const seasonStart = currentClanSeasonStart()
  const rows = siteStatement('clanRatingBaseline')
    .all(
      ...padSiteList(filtered.slice(0, SITE_IN_SLOTS), SITE_IN_SLOTS),
      seasonStart,
      atTs,
      clanCore,
      clanCore,
    ) as unknown as {
      clan_tag: string
      nick: string
      rating: number
    }[]
  return rows.map((row) => ({ clanTag: row.clan_tag, nick: row.nick, rating: row.rating }))
}

/** Полный ростер всех кланов для фильтрации и отсечения устаревших участников. */
export interface SiteClanRosterDetails {
  role: string | null
  /** Дата вступления, Unix-секунды. */
  joinedAt: number | null
  activity: number | null
}

/** Роль, дата вступления и активность участников клана со страницы claninfo. */
export function getSiteClanRosterDetails(clanCore: string): Map<string, SiteClanRosterDetails> {
  const rows = siteStatement('clanRosterDetails').all(clanCore) as unknown as {
    nick: string
    role: string | null
    joined_at: number | null
    activity: number | null
  }[]
  return new Map(rows.map((row) => [row.nick, { role: row.role, joinedAt: row.joined_at, activity: row.activity }]))
}

/** Описание, условия вступления и прочий профиль клана из лидерборда. */
export interface SiteClanProfile {
  clanId: number | null
  description: string | null
  announcement: string | null
  requirements: ClanRequirements | null
  status: string | null
  autoAccept: boolean | null
  plainTag: string | null
  regalia: string | null
}

export function getSiteClanProfile(tag: string): SiteClanProfile | null {
  const row = siteStatement('clanProfile').get(tag) as {
    clan_id: number | null
    description: string | null
    announcement: string | null
    requirements: string | null
    status: string | null
    auto_accept: number | null
    plain_tag: string | null
    regalia: string | null
  } | undefined
  if (row === undefined) return null
  let requirements: ClanRequirements | null = null
  if (row.requirements !== null) {
    try {
      requirements = JSON.parse(row.requirements) as ClanRequirements
    } catch {
      requirements = null
    }
  }
  return {
    clanId: row.clan_id,
    description: row.description,
    announcement: row.announcement,
    requirements,
    status: row.status,
    autoAccept: row.auto_accept === null ? null : row.auto_accept !== 0,
    plainTag: row.plain_tag,
    regalia: row.regalia,
  }
}

/** Начало собранных боёв: с этого момента в базе есть реплеи. null — боёв нет. */
export function getSiteFirstBattleAt(): number | null {
  const row = siteStatement('firstBattleAt').get() as { first_battle_at: number | null } | undefined
  return row?.first_battle_at ?? null
}

export function getSiteClanRosterAll(): { clanCore: string; nick: string; lastPresentAt: number }[] {
  const rows = siteStatement('clanRosterAll').all() as unknown as {
    clan_core: string
    nick: string
    last_present_at: number
  }[]
  return rows.map((row) => ({
    clanCore: row.clan_core,
    nick: row.nick,
    lastPresentAt: row.last_present_at,
  }))
}

/** ПКР каждого (клан, ник) на момент atTs — базис честных дельт «за 30 дн.». */
export function getSiteClanBaselineRatings(atTs: number): { clanTag: string; nick: string; rating: number }[] {
  if (!Number.isSafeInteger(atTs) || atTs < 0) {
    throw new RangeError('atTs должен быть неотрицательным Unix-временем')
  }
  const seasonStart = currentClanSeasonStart()
  const rows = siteStatement('clanBaselineSumsAll').all(seasonStart, atTs) as unknown as {
    clan_tag: string
    nick: string
    rating: number
  }[]
  return rows.map((row) => ({ clanTag: row.clan_tag, nick: row.nick, rating: row.rating }))
}

export interface SiteClanDictionaryRow {
  tag: string
  name: string
  /** Официальный рейтинг сезона на момент ratingAt; null — только имя. */
  rating: number | null
  position: number | null
  members: number | null
  battles: number | null
  wins: number | null
  ratingAt: number | null
  airKills: number | null
  groundKills: number | null
  deaths: number | null
  flightTime: number | null
  activity: number | null
  region: string | null
  clanType: string | null
  foundedAt: number | null
  slogan: string | null
  rewards: ClanSeasonRewards | null
}

/** Награды из JSON колонки rewards; битая запись — null, а не ошибка страницы. */
function parseClanRewards(raw: string | null): ClanSeasonRewards | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<ClanSeasonRewards>
    return Array.isArray(value.best) && Array.isArray(value.log) ? { best: value.best, log: value.log } : null
  } catch {
    return null
  }
}

/**
 * Весь словарь кланов с официальной статистикой (~тысяча строк). Сезон и
 * группировка по ядру тега — у вызывающего кода: старые варианты украшений
 * без свежего рейтинга всё равно нужны как теги для выборки боёв.
 */
export function getSiteClanDictionary(): SiteClanDictionaryRow[] {
  const rows = siteStatement('clanDictionary').all() as unknown as {
    tag: string
    name: string
    rating: number | null
    position: number | null
    members: number | null
    battles: number | null
    wins: number | null
    rating_at: number | null
    air_kills: number | null
    ground_kills: number | null
    deaths: number | null
    flight_time: number | null
    activity: number | null
    region: string | null
    clan_type: string | null
    founded_at: number | null
    slogan: string | null
    rewards: string | null
  }[]
  return rows.map((row) => ({
    tag: row.tag,
    name: row.name,
    rating: row.rating,
    position: row.position,
    members: row.members,
    battles: row.battles,
    wins: row.wins,
    ratingAt: row.rating_at,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    deaths: row.deaths,
    flightTime: row.flight_time,
    activity: row.activity,
    region: row.region,
    clanType: row.clan_type,
    foundedAt: row.founded_at,
    slogan: row.slogan,
    rewards: parseClanRewards(row.rewards),
  }))
}

/** Официальный рейтинг клана на момент atTs: последнее изменение в [fromTs, atTs] или null. */
export function getSiteClanOfficialRatingAt(
  clanCore: string,
  fromTs: number,
  atTs: number,
): { capturedAt: number; rating: number } | null {
  if (!clanCore) return null
  if (!Number.isSafeInteger(fromTs) || fromTs < 0 || !Number.isSafeInteger(atTs) || atTs < 0) {
    throw new RangeError('Границы истории рейтинга клана должны быть неотрицательным Unix-временем')
  }
  const row = siteStatement('clanOfficialRatingAt').get(clanCore, fromTs, atTs) as
    | { captured_at: number; rating: number }
    | undefined
  return row ? { capturedAt: row.captured_at, rating: row.rating } : null
}

/** Изменения официальной статистики клана в (fromTs, toTs]; truncated — упёрлись в лимит. */
export function getSiteClanOfficialRatingEvents(
  clanCore: string,
  fromTs: number,
  toTs: number,
  limit = 10_000,
): {
  events: { capturedAt: number; rating: number; battles: number | null; wins: number | null }[]
  truncated: boolean
} {
  if (!clanCore) return { events: [], truncated: false }
  if (!Number.isSafeInteger(fromTs) || fromTs < 0 || !Number.isSafeInteger(toTs) || toTs < 0) {
    throw new RangeError('Границы истории рейтинга клана должны быть неотрицательным Unix-временем')
  }
  const normalizedLimit = siteLimit(limit, 10_000, 'Лимит истории рейтинга клана')
  const rows = siteStatement('clanOfficialRatingEvents').all(clanCore, fromTs, toTs, normalizedLimit) as unknown as {
    captured_at: number
    rating: number
    battles: number | null
    wins: number | null
  }[]
  return {
    events: rows.map((row) => ({ capturedAt: row.captured_at, rating: row.rating, battles: row.battles, wins: row.wins })),
    truncated: rows.length === normalizedLimit,
  }
}

export interface SiteBattleTeamClanRow {
  team: number
  clanTag: string
  players: number
}

/** Клановые теги по командам одной сессии — подписи «X против Y» в ленте. */
export function getSiteBattleTeamClans(sessionId: string): SiteBattleTeamClanRow[] {
  const normalized = sessionId.trim()
  if (!normalized) throw new RangeError('Нужен непустой session id')
  const rows = siteStatement('battleTeamClans').all(normalized) as unknown as {
    team: number
    clan_tag: string
    players: number
  }[]
  return rows.map((row) => ({ team: row.team, clanTag: row.clan_tag, players: row.players }))
}

/** Клановые теги по командам нескольких сессий одним индексным запросом. */
export function getSiteBattleTeamClansBatch(
  sessionIds: readonly string[],
): Map<string, SiteBattleTeamClanRow[]> {
  if (sessionIds.length === 0) return new Map()
  if (sessionIds.length > 100) throw new RangeError('За один запрос разрешено не более 100 session id')
  const normalized = [...new Set(sessionIds.map((sessionId) => sessionId.trim()))]
  if (normalized.some((sessionId) => sessionId === '')) throw new RangeError('Нужны непустые session id')
  const rows = siteStatement('battleTeamClansBatch').all(JSON.stringify(normalized)) as unknown as {
    session_id: string
    team: number
    clan_tag: string
    players: number
  }[]
  const grouped = new Map<string, SiteBattleTeamClanRow[]>()
  for (const row of rows) {
    const sessionRows = grouped.get(row.session_id) ?? []
    sessionRows.push({ team: row.team, clanTag: row.clan_tag, players: row.players })
    grouped.set(row.session_id, sessionRows)
  }
  return grouped
}

export interface SiteClanBattleTeamRow {
  sessionId: string
  startTime: number
  teamWon: number
  team: number
  players: number
  score: number
  kills: number
  deaths: number
}

/** Строки «сессия × команда» для агрегатов клана за период [from, to). */
export function getSiteClanBattleTeams(
  rawTags: readonly string[],
  fromTs: number,
  toTs: number,
  limit = 2000,
): SiteClanBattleTeamRow[] {
  const filtered = [...new Set(rawTags.filter((tag) => tag !== ''))]
  if (filtered.length === 0) return []
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs < 0 || toTs <= fromTs) {
    throw new RangeError('Период агрегатов клана должен быть корректным [from, to)')
  }
  const normalizedLimit = siteLimit(limit, 5000, 'Лимит строк агрегатов клана')
  const rows = siteStatement('clanBattleTeams')
    .all(
      ...padSiteList(filtered.slice(0, SITE_IN_SLOTS), SITE_IN_SLOTS),
      fromTs,
      toTs,
      normalizedLimit,
    ) as unknown as {
      session_id: string
      start_time: number
      team_won: number
      team: number
      players: number
      score: number
      kills: number
      deaths: number
    }[]
  return rows.map((row) => ({
    sessionId: row.session_id,
    startTime: row.start_time,
    teamWon: row.team_won,
    team: row.team,
    players: row.players,
    score: row.score,
    kills: row.kills,
    deaths: row.deaths,
  }))
}

export interface SiteBattleListRow {
  sessionId: string
  sessionHex: string
  missionName: string
  gameMode: string | null
  startTime: number
  durationSec: number
  teamWon: number
  playerCount: number
  killCount: number
  /** Заполнены только при фильтре по игроку: его команда и результат. */
  team: number | null
  score: number | null
  frags: number | null
  deaths: number | null
  vehicle: string | null
}

export interface SiteBattleListFilter {
  userId?: string | undefined
  clanTags?: readonly string[] | undefined
  from?: number | undefined
  to?: number | undefined
  limit?: number | undefined
}

/** Лента боёв: общая, по игроку (с его результатом) или по клану. */
export function listSiteBattles(filter: SiteBattleListFilter = {}): SiteBattleListRow[] {
  const from = replayPeriodBoundary(filter.from, 'from')
  const to = replayPeriodBoundary(filter.to, 'to')
  if (from !== null && to !== null && from > to) {
    throw new RangeError('Начало периода ленты боёв не может быть позже конца')
  }
  const limit = siteLimit(filter.limit ?? 25, 100, 'Лимит ленты боёв')

  if (filter.userId !== undefined) {
    const userId = filter.userId.trim()
    if (!userId) throw new RangeError('Для ленты боёв игрока нужен непустой WT user id')
    const rows = siteStatement('battlesByUser')
      .all(userId, from, from, to, to, limit) as unknown as (SiteBattleRawRow & {
        team: number
        score: number
        frags: number
        deaths: number
        vehicle: string | null
      })[]
    return rows.map((row) => ({
      ...toSiteBattleListRow(row),
      team: row.team,
      score: row.score,
      frags: row.frags,
      deaths: row.deaths,
      vehicle: row.vehicle,
    }))
  }

  if (filter.clanTags !== undefined && filter.clanTags.length > 0) {
    const filtered = [...new Set(filter.clanTags.filter((tag) => tag !== ''))]
    if (filtered.length === 0) return []
    const rows = siteStatement('battlesByClan')
      .all(
        ...padSiteList(filtered.slice(0, SITE_IN_SLOTS), SITE_IN_SLOTS),
        from,
        from,
        to,
        to,
        limit,
      ) as unknown as SiteBattleRawRow[]
    return rows.map(toSiteBattleListRow)
  }

  const rows = siteStatement('battlesRecent').all(from, from, to, to, limit) as unknown as SiteBattleRawRow[]
  return rows.map(toSiteBattleListRow)
}

interface SiteBattleRawRow {
  session_id: string
  session_hex: string
  mission_name: string
  game_mode: string | null
  start_time: number
  duration_sec: number
  team_won: number
  player_count: number
  kill_count: number
}

function toSiteBattleListRow(row: SiteBattleRawRow): SiteBattleListRow {
  return {
    sessionId: row.session_id,
    sessionHex: row.session_hex,
    missionName: row.mission_name,
    gameMode: row.game_mode,
    startTime: row.start_time,
    durationSec: row.duration_sec,
    teamWon: row.team_won,
    playerCount: row.player_count,
    killCount: row.kill_count,
    team: null,
    score: null,
    frags: null,
    deaths: null,
    vehicle: null,
  }
}

/**
 * Ключ боя из URL: decimal session_id либо 16-символьный hex. Hex резолвится
 * в decimal здесь, чтобы запрос шёл строго по PRIMARY KEY —
 * `OR session_hex = ?` вырождается в SCAN battles (см. AGENTS.md).
 */
export function resolveSiteSessionId(key: string): string | null {
  const normalized = key.trim().toLowerCase()
  if (/^[0-9]{1,20}$/.test(normalized)) return normalized
  if (/^[0-9a-f]{16}$/.test(normalized)) return BigInt(`0x${normalized}`).toString(10)
  return null
}

/** Скорборд боя строго по PRIMARY KEY (без OR session_hex). */
export function getSiteBattleSummary(sessionId: string): BattleSummaryForRender | null {
  const battle = siteStatement('battleById').get(sessionId) as BattleRow | undefined
  if (!battle) return null
  const players = siteStatement('battlePlayersBySession')
    .all(battle.session_id) as unknown as BattlePlayerRow[]
  return { battle, players }
}

/** events_blob строго по PRIMARY KEY: hex резолвится заранее (см. resolveSiteSessionId). */
export function getSiteBattleEventsBlob(sessionId: string): Buffer | null {
  const row = siteStatement('eventsBlobById').get(sessionId) as { events_blob: Uint8Array | null } | undefined
  return row?.events_blob ? Buffer.from(row.events_blob) : null
}

/** Последний наблюдавшийся ник игрока в локальных реплеях (для replay-only профилей). */
export function getSiteReplayNick(userId: string): string | null {
  const normalized = userId.trim()
  if (!normalized) return null
  const row = siteStatement('replayNickByUserId').get(normalized) as { nick: string } | undefined
  return row?.nick ?? null
}

/** Только для оффлайн-smoke: план запроса read-модели без его выполнения. */
export function explainSiteQueryPlan(sql: string): { detail: string }[] {
  const rows = getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[]
  return rows.map((row) => ({ detail: row.detail }))
}

export interface SiteAliasIdentityRow {
  nickBase: string
  identityId: number
  wtUserId: string | null
  canonicalNick: string
  platform: string | null
}

/**
 * Read-only связка «ник ростера → identity» через наблюдавшиеся алиасы.
 * Правило коллизий применяет вызывающий код: несколько identity на один
 * nick_base — не линковать (автоматический merge по нику запрещён).
 */
export function getSiteAliasIdentities(nickBases: readonly string[]): SiteAliasIdentityRow[] {
  const filtered = [...new Set(nickBases.map((nick) => nick.trim()).filter(Boolean))]
  const results: SiteAliasIdentityRow[] = []
  for (let offset = 0; offset < filtered.length; offset += SITE_ALIAS_IN_SLOTS) {
    const chunk = filtered.slice(offset, offset + SITE_ALIAS_IN_SLOTS)
    const rows = siteStatement('aliasIdentitiesByNickBase')
      .all(...padSiteList(chunk, SITE_ALIAS_IN_SLOTS)) as unknown as {
        nick_base: string
        identity_id: number
        wt_user_id: string | null
        canonical_nick: string
        platform: string | null
      }[]
    for (const row of rows) {
      results.push({
        nickBase: row.nick_base,
        identityId: row.identity_id,
        wtUserId: row.wt_user_id,
        canonicalNick: row.canonical_nick,
        platform: row.platform,
      })
    }
  }
  return results
}
