import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  PLAYER_EXTERNAL_SNAPSHOT_STATUSES,
  PLAYER_IDENTITY_MATCH_CONFIDENCES,
  PLAYER_IDENTITY_MATCH_METHODS,
  type NormalizedPlayerExternalTotal,
  type NormalizedPlayerExternalVehicle,
  type NormalizedPlayerStats,
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

// Общий слой хранения: им пользуются и бот, и сайт, и парсеры.
// SQLite встроен в Node 22.5+ — отдельный сервер БД не нужен.
// Когда проект вырастет — этот модуль можно заменить на Prisma/Postgres,
// не трогая остальной код.

let db: DatabaseSync | null = null
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
let selectIngestStatsStatement: StatementSync | null = null
let selectDataVersionStatement: StatementSync | null = null
let commandStatsCache: VersionedCache<CommandStats> | null = null
let itemStatsCache: VersionedCache<ItemStats> | null = null
let ingestStatsCache: VersionedCache<IngestStats> | null = null
let lastDataVersion = 0
let lastDataVersionAt = 0

interface VersionedCache<T> {
  dataVersion: number
  value: T
}

function resetPreparedStatements(): void {
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
  selectIngestStatsStatement = null
  selectDataVersionStatement = null
  commandStatsCache = null
  itemStatsCache = null
  ingestStatsCache = null
  lastDataVersion = 0
  lastDataVersionAt = 0
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

export function initDb(dbPath: string): void {
  resetPreparedStatements()
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  db = new DatabaseSync(dbPath)
  // WAL: запись не блокирует чтение — сайт отвечает, пока парсеры пишут
  db.exec('PRAGMA journal_mode = WAL;')
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
    -- для страницы claninfo. Обновляет источник wt-clans.
    CREATE TABLE IF NOT EXISTS clans (
      tag        TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

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

    CREATE INDEX IF NOT EXISTS idx_snapshots_clan_nick
      ON clan_rating_snapshots (clan_tag, nick, id DESC);

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
      time_played_sec INTEGER,
      respawns        INTEGER,
      air_kills       INTEGER,
      ground_kills    INTEGER,
      naval_kills     INTEGER,
      CHECK (battles IS NULL OR battles >= 0),
      CHECK (victories IS NULL OR victories >= 0),
      CHECK (defeats IS NULL OR defeats >= 0),
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

    -- ===== Разобранные бои (ingest пакетного потока .wrpl) =====
    -- Раньше содержимое боя (фраги, очки, техника, победитель, траектории)
    -- жило только в PNG-кэше и разбиралось на лету при нажатии кнопки.
    -- Теперь воркер ingest разбирает каждый бой один раз и раскладывает
    -- его по нормализованным таблицам — это и датасет, и быстрый поиск,
    -- и возможность перерисовать картинки, когда части реплея ушли с CDN.

    -- Один бой: метаданные + победитель + счётчики. session_id совпадает
    -- с items.external_id. events_blob — gzip(JSON) полного ReplayEvents
    -- (траектории, зоны, урон) для перерисовки хитмапов без реплея.
    CREATE TABLE IF NOT EXISTS battles (
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
      -- путь к файлу миссии из заголовка реплея (для границ карты хитмапа
      -- при перерисовке из БД, когда самого реплея уже нет)
      mission_settings TEXT,
      events_blob  BLOB,
      ingested_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

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

    CREATE INDEX IF NOT EXISTS idx_bp_nick ON battle_players (nick);
    CREATE INDEX IF NOT EXISTS idx_bp_nick_nocase ON battle_players (nick COLLATE NOCASE, user_id);
    CREATE INDEX IF NOT EXISTS idx_bp_clan ON battle_players (clan_tag);
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
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  // Миграции для баз, созданных прошлой версией схемы: ADD COLUMN на уже
  // существующей таблице бросает ошибку «duplicate column» — глушим её.
  for (const sql of [
    'ALTER TABLE battles ADD COLUMN mission_settings TEXT',
    'ALTER TABLE battles ADD COLUMN game_version TEXT',
    'ALTER TABLE battles ADD COLUMN player_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE battles ADD COLUMN kill_count INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE clan_rating_snapshots ADD COLUMN nick_base TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE voice_presence ADD COLUMN wt_nick_base TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE battle_players ADD COLUMN nick_base TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE battle_players ADD COLUMN slot INTEGER',
    'ALTER TABLE battle_players ADD COLUMN title TEXT',
    'ALTER TABLE battle_players ADD COLUMN auto_squad INTEGER',
    'ALTER TABLE battle_chat ADD COLUMN channel_valid INTEGER NOT NULL DEFAULT 1',
  ]) {
    try {
      db.exec(sql)
    } catch {
      // колонка уже есть — так и надо
    }
  }

  // Старые строки нормализуются один раз. Исходный ник остаётся в прежней
  // колонке, а индексированный base используется только для сопоставления.
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_snapshots_nick_base
      ON clan_rating_snapshots (nick_base, id DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_nick_base
      ON voice_presence (wt_nick_base);
    CREATE INDEX IF NOT EXISTS idx_bp_nick_base
      ON battle_players (nick_base);
  `)
}

export function closeDb(): void {
  resetPreparedStatements()
  db?.close()
  db = null
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
  getDb()
    .prepare('INSERT INTO parse_results (source, ok, summary, error) VALUES (?, ?, ?, ?)')
    .run(source, ok ? 1 : 0, summary, error)

  // История не должна расти бесконечно (wt-replays пишет раз в 20 с), но и
  // подрезать её на каждой вставке — 4320 DELETE в сутки на источник — ни к
  // чему. Чистим не чаще раза в час на источник; держим последние 1000 строк.
  const now = Date.now()
  if (now - (lastParseCleanup.get(source) ?? 0) < PARSE_CLEANUP_INTERVAL_MS) return
  lastParseCleanup.set(source, now)
  getDb()
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
      const result = stmt.run(source, item.externalId, item.title, data, hash)
      changed += Number(result.changes)
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
  return { changed, unchanged: items.length - changed }
}

/** Есть ли уже запись этого источника с таким externalId (для инкрементального парсинга) */
export function hasItem(source: string, externalId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS one FROM items WHERE source = ? AND external_id = ?')
    .get(source, externalId)
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

export type AnnounceStatus = 'ok' | 'failed'

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
 * попытки. Старые первыми — постим в хронологическом порядке.
 */
export function getPendingAnnounce(baselineId: number, maxAttempts: number, limit: number): StoredItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, NULL AS analysis
      FROM items i
      LEFT JOIN announce_state a ON a.item_id = i.id
      WHERE i.source = 'wt-replays' AND i.id > ?
        AND (a.item_id IS NULL OR (a.status = 'failed' AND a.attempts < ?))
      ORDER BY i.id ASC
      LIMIT ?
    `)
    .all(baselineId, maxAttempts, limit) as unknown as ItemRow[]
  return rows.map(toStoredItem)
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
        AND (a.item_id IS NULL OR (a.status = 'failed' AND a.attempts < ?))
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

/** Размер словаря кланов и время последнего обновления (для пропуска лишних обходов) */
export function getClansStats(): { count: number; newestAt: number } {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS newest FROM clans')
    .get() as { count: number; newest: number } | undefined
  return { count: row?.count ?? 0, newestAt: row?.newest ?? 0 }
}

/**
 * Снимок ПКР участников клана: строка добавляется только если рейтинг ника
 * изменился с прошлого снимка (или ника ещё не было) — история не пухнет.
 */
export function saveClanRatingSnapshots(clanTag: string, ratings: { nick: string; rating: number }[]): void {
  const database = getDb()
  const lastStmt = database.prepare(`
    SELECT rating FROM clan_rating_snapshots
    WHERE clan_tag = ? AND nick = ?
    ORDER BY id DESC LIMIT 1
  `)
  const insertStmt = database.prepare(
    'INSERT INTO clan_rating_snapshots (clan_tag, nick, nick_base, rating) VALUES (?, ?, ?, ?)',
  )
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const r of ratings) {
      const last = lastStmt.get(clanTag, r.nick) as { rating: number } | undefined
      if (last === undefined || last.rating !== r.rating) {
        insertStmt.run(clanTag, r.nick, normalizeWtNick(r.nick), r.rating)
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
function normalizeWtNick(nick: string): string {
  return nick.replace(/@(psn|live|epic)$/i, '')
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
  time_played_sec: number | null
  respawns: number | null
  air_kills: number | null
  ground_kills: number | null
  naval_kills: number | null
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
    timePlayedSec: row.time_played_sec,
    respawns: row.respawns,
    airKills: row.air_kills,
    groundKills: row.ground_kills,
    navalKills: row.naval_kills,
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
          INSERT INTO player_identities (wt_user_id, canonical_nick, platform)
          VALUES (?, ?, ?)
        `)
        .run(wtUserId, canonicalNick, requestedPlatform ?? null)
      identityId = Number(result.lastInsertRowid)
    } else {
      identityId = existing.id
      database
        .prepare(`
          UPDATE player_identities
          SET wt_user_id = ?, canonical_nick = ?, platform = ?, updated_at = unixepoch()
          WHERE id = ?
        `)
        .run(
          existing.wt_user_id ?? wtUserId,
          canonicalNick,
          requestedPlatform === undefined ? existing.platform : requestedPlatform,
          identityId,
        )
    }

    const aliasStatement = database.prepare(`
      INSERT INTO player_identity_aliases (
        identity_id, source, external_id, nick, nick_base,
        first_seen_at, last_seen_at, match_method, match_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
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
       OR canonical_nick = ? COLLATE NOCASE
    ORDER BY updated_at DESC, id DESC
    LIMIT 50
  `).all(numericQuery, numericQuery, query) as unknown as MatchRow[])

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
    WHERE pia.nick = ? COLLATE NOCASE
    ORDER BY pia.last_seen_at DESC, pi.id DESC
    LIMIT 50
  `).all(query) as unknown as MatchRow[])

  rows.push(...database.prepare(`
    WITH ranked AS (
      SELECT
        bp.user_id,
        bp.nick,
        b.start_time,
        ROW_NUMBER() OVER (
          PARTITION BY bp.user_id
          ORDER BY b.start_time DESC, b.session_id DESC
        ) AS row_number
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.user_id <> ''
        AND ((? IS NOT NULL AND bp.user_id = ?) OR bp.nick = ? COLLATE NOCASE)
    )
    SELECT
      'replay' AS origin,
      'wrpl' AS source,
      NULL AS identity_id,
      CASE
        WHEN user_id NOT GLOB '*[^0-9]*' THEN user_id
        ELSE NULL
      END AS wt_user_id,
      nick,
      NULL AS platform,
      start_time AS seen_at
    FROM ranked
    WHERE row_number = 1
    ORDER BY start_time DESC, user_id
    LIMIT 50
  `).all(numericQuery, numericQuery, query) as unknown as MatchRow[])

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

function validateNormalizedPlayerStats(
  input: NormalizedPlayerStats | null | undefined,
): { totals: NormalizedPlayerExternalTotal[]; vehicles: NormalizedPlayerExternalVehicle[] } | undefined {
  if (input === null || input === undefined) return undefined
  if (!Array.isArray(input.totals) || !Array.isArray(input.vehicles)) {
    throw new Error('Нормализованный snapshot должен содержать массивы totals и vehicles')
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
  return { totals, vehicles }
}

function replacePlayerExternalMetrics(
  database: DatabaseSync,
  snapshotId: number,
  normalized: { totals: NormalizedPlayerExternalTotal[]; vehicles: NormalizedPlayerExternalVehicle[] },
): void {
  database.prepare('DELETE FROM player_external_totals WHERE snapshot_id = ?').run(snapshotId)
  database.prepare('DELETE FROM player_external_vehicles WHERE snapshot_id = ?').run(snapshotId)

  const insertTotal = database.prepare(`
    INSERT INTO player_external_totals (
      snapshot_id, game_type, mode, category, battles, victories, defeats,
      time_played_sec, respawns, air_kills, ground_kills, naval_kills
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        time_played_sec, respawns, air_kills, ground_kills, naval_kills
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
  return {
    snapshot: toPlayerExternalSnapshotMeta(row),
    totals: totals.map(toPlayerExternalTotal),
    vehicles: vehicles.map(toPlayerExternalVehicle),
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
      WHERE s.nick_base = v.wt_nick_base
      ORDER BY s.id DESC LIMIT 1
    )
    LEFT JOIN clan_rating_snapshots previous ON previous.id = (
      SELECT s.id FROM clan_rating_snapshots s
      WHERE s.nick_base = v.wt_nick_base
      ORDER BY s.id DESC LIMIT 1 OFFSET 1
    )
    LEFT JOIN battle_stats bs ON bs.nick_base = v.wt_nick_base
    ORDER BY v.guild_id, v.channel_id, v.joined_at
  `)
  const rows = selectVoiceDashboardStatement.all() as unknown as {
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
    WHERE nick_base = ?
    ORDER BY id DESC LIMIT 2
  `)
  const rows = selectPlayerRatingStatement.all(normalizeWtNick(nick)) as unknown as {
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

/** Текущий ПКР и дельта по каждому нику клана (по двум последним снимкам) */
export function getClanRatingsWithDelta(clanTag: string): Map<string, ClanRating> {
  const rows = getDb()
    .prepare(`
      SELECT nick, rating FROM clan_rating_snapshots
      WHERE clan_tag = ?
      ORDER BY id DESC
    `)
    .all(clanTag) as unknown as { nick: string; rating: number }[]
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
  /** gzip(JSON) полного ReplayEvents — для перерисовки картинок без реплея */
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
export function saveBattle(b: BattleInput): void {
  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    database
      .prepare(`
        INSERT INTO battles (
          session_id, session_hex, mission_name, level, game_mode, battle_type,
          environment, status, start_time, duration_sec, end_time_ms, team_won,
          game_version, player_count, kill_count, mission_settings, events_blob, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
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
          mission_settings = excluded.mission_settings,
          events_blob = excluded.events_blob,
          ingested_at = unixepoch()
      `)
      .run(
        b.sessionId, b.sessionHex, b.missionName, b.level, b.gameMode, b.battleType,
        b.environment, b.status, b.startTime, b.durationSec, b.endTimeMs, b.teamWon,
        b.gameVersion, b.players.length, b.kills.length, b.missionSettings, b.eventsBlob,
      )

    database.prepare('DELETE FROM battle_players WHERE session_id = ?').run(b.sessionId)
    database.prepare('DELETE FROM battle_kills WHERE session_id = ?').run(b.sessionId)
    database.prepare('DELETE FROM battle_chat WHERE session_id = ?').run(b.sessionId)

    const pStmt = database.prepare(`
      INSERT INTO battle_players (
        session_id, user_id, nick, nick_base, clan_tag, team, kills, ground_kills, naval_kills,
        ai_kills, ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
        award_damage, team_kills, squad_id, vehicle, vehicles, disconnected, slot, title, auto_squad
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const p of b.players) {
      pStmt.run(
        b.sessionId, p.userId, p.nick, normalizeWtNick(p.nick), p.clanTag, p.team, p.kills,
        p.groundKills, p.navalKills,
        p.aiKills, p.aiGroundKills, p.assists, p.deaths, p.captureZone, p.damageZone, p.score,
        p.awardDamage, p.teamKills, p.squadId, p.vehicle, JSON.stringify(p.vehicles), p.disconnected ? 1 : 0,
        p.slot, p.title, p.autoSquad === null ? null : (p.autoSquad ? 1 : 0),
      )
    }

    const kStmt = database.prepare(`
      INSERT INTO battle_kills (
        session_id, time_ms, killer_id, killer_model, victim_id, victim_model, weapon,
        killer_x, killer_y, killer_z, victim_x, victim_y, victim_z
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const k of b.kills) {
      kStmt.run(
        b.sessionId, k.timeMs, k.killerId, k.killerModel, k.victimId, k.victimModel, k.weapon,
        k.killerPos?.x ?? null, k.killerPos?.y ?? null, k.killerPos?.z ?? null,
        k.victimPos?.x ?? null, k.victimPos?.y ?? null, k.victimPos?.z ?? null,
      )
    }

    const cStmt = database.prepare(
      'INSERT INTO battle_chat (session_id, time_ms, sender, channel, channel_valid, message) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const m of b.chat) {
      const valid = m.channelValid ?? isValidBattleChatChannel(m.channel)
      cStmt.run(b.sessionId, m.timeMs, m.sender, m.channel, valid ? 1 : 0, m.message)
    }

    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  ingestStatsCache = null
}

/** Номер победившей команды из разобранного боя (null — бой не разобран) */
export function getBattleWinner(sessionId: string): number | null {
  const row = getDb().prepare('SELECT NULLIF(team_won, 0) AS team_won FROM battles WHERE session_id = ?').get(sessionId) as
    | { team_won: number | null }
    | undefined
  return row?.team_won ?? null
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
    .prepare('SELECT events_blob FROM battles WHERE session_id = ? OR session_hex = ?')
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
             game_version, player_count, kill_count, mission_settings, events_blob
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

/** Записывает исход разбора боя; при повторе увеличивает счётчик попыток */
export function markBattleIngest(sessionId: string, status: BattleIngestStatus, error: string | null = null): void {
  getDb()
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
export function getPendingBattleItems(maxAttempts: number, limit: number): PendingBattleItem[] {
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
      ORDER BY i.id DESC
      LIMIT ?
    `)
    .all(maxAttempts, limit) as unknown as Array<ItemRow & { first_seen_at: number }>
  return rows.map((row) => ({ ...toStoredItem(row), firstSeenAt: row.first_seen_at }))
}

/** Сводка разбора для дашборда: сколько боёв разобрано, в очереди, провалено */
export interface IngestStats {
  ingested: number
  pending: number
  failed: number
  players: number
  kills: number
}

export function getIngestStats(): IngestStats {
  const dataVersion = getDataVersion()
  if (ingestStatsCache?.dataVersion === dataVersion) return ingestStatsCache.value
  selectIngestStatsStatement ??= getDb().prepare(`
    WITH ingest_state AS (
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('error', 'expired', 'no_parts') THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status IN ('expired', 'no_parts') THEN 1 ELSE 0 END), 0) AS skipped
      FROM battle_ingest
    )
    SELECT
      (SELECT COUNT(*) FROM battles) AS ingested,
      (SELECT COUNT(*) FROM items WHERE source = 'wt-replays') AS total,
      ingest_state.failed,
      ingest_state.skipped,
      (SELECT COUNT(*) FROM battle_players) AS players,
      (SELECT COUNT(*) FROM battle_kills) AS kills
    FROM ingest_state
  `)
  const row = selectIngestStatsStatement.get() as {
    ingested: number
    total: number
    failed: number
    skipped: number
    players: number
    kills: number
  }
  const value = {
    ingested: row.ingested,
    pending: Math.max(0, row.total - row.ingested - row.skipped),
    failed: row.failed,
    players: row.players,
    kills: row.kills,
  }
  ingestStatsCache = { dataVersion, value }
  return value
}


