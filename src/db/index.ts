import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// Общий слой хранения: им пользуются и бот, и сайт, и парсеры.
// SQLite встроен в Node 22.5+ — отдельный сервер БД не нужен.
// Когда проект вырастет — этот модуль можно заменить на Prisma/Postgres,
// не трогая остальной код.

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!db) throw new Error('БД не инициализирована — сначала вызови initDb()')
  return db
}

export function initDb(dbPath: string): void {
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
      rating   INTEGER NOT NULL,
      seen_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_clan_nick
      ON clan_rating_snapshots (clan_tag, nick, id DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshots_nick
      ON clan_rating_snapshots (nick, id DESC);

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
      joined_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (guild_id, user_id)
    );

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
      PRIMARY KEY (session_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bp_nick ON battle_players (nick);
    CREATE INDEX IF NOT EXISTS idx_bp_clan ON battle_players (clan_tag);

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
  for (const sql of ['ALTER TABLE battles ADD COLUMN mission_settings TEXT']) {
    try {
      db.exec(sql)
    } catch {
      // колонка уже есть — так и надо
    }
  }
}

export function closeDb(): void {
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
}

export function getCommandStats(): CommandStats {
  const total = getDb()
    .prepare('SELECT COUNT(*) AS count FROM command_usage')
    .get() as { count: number } | undefined
  const byCommand = getDb()
    .prepare('SELECT command, COUNT(*) AS count FROM command_usage GROUP BY command ORDER BY count DESC')
    .all() as unknown as { command: string; count: number }[]
  return { total: total?.count ?? 0, byCommand }
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
  const total = getDb()
    .prepare('SELECT COUNT(*) AS count FROM items')
    .get() as { count: number } | undefined
  const bySource = getDb()
    .prepare('SELECT source, COUNT(*) AS count FROM items GROUP BY source ORDER BY count DESC')
    .all() as unknown as { source: string; count: number }[]
  return { total: total?.count ?? 0, bySource }
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
    'INSERT INTO clan_rating_snapshots (clan_tag, nick, rating) VALUES (?, ?, ?)',
  )
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const r of ratings) {
      const last = lastStmt.get(clanTag, r.nick) as { rating: number } | undefined
      if (last === undefined || last.rating !== r.rating) insertStmt.run(clanTag, r.nick, r.rating)
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

/** Полный снимок голосовых каналов при старте бота — заменяет всё содержимое */
export function syncVoicePresence(entries: VoicePresenceEntry[]): void {
  const database = getDb()
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('DELETE FROM voice_presence')
    for (const e of entries) insertVoiceStmt(e)
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

/** Игрок зашёл в канал или перешёл между каналами */
export function upsertVoicePresence(e: VoicePresenceEntry): void {
  insertVoiceStmt(e)
}

function insertVoiceStmt(e: VoicePresenceEntry): void {
  getDb()
    .prepare(`
      INSERT INTO voice_presence (guild_id, guild_name, channel_id, channel_name, user_id, display_name, wt_nick)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        guild_name = excluded.guild_name,
        channel_name = excluded.channel_name,
        display_name = excluded.display_name,
        wt_nick = excluded.wt_nick,
        -- время захода сохраняется, если человек остался в том же канале
        joined_at = CASE
          WHEN voice_presence.channel_id <> excluded.channel_id THEN unixepoch()
          ELSE voice_presence.joined_at
        END,
        channel_id = excluded.channel_id
    `)
    .run(e.guildId, e.guildName, e.channelId, e.channelName, e.userId, e.displayName, e.wtNick)
}

export function removeVoicePresence(guildId: string, userId: string): void {
  getDb().prepare('DELETE FROM voice_presence WHERE guild_id = ? AND user_id = ?').run(guildId, userId)
}

export interface VoicePresenceRow extends VoicePresenceEntry {
  joinedAt: number
}

/** Кто сейчас в голосовых каналах — для /api/voice */
export function getVoicePresence(): VoicePresenceRow[] {
  const rows = getDb()
    .prepare(`
      SELECT guild_id, guild_name, channel_id, channel_name, user_id, display_name, wt_nick, joined_at
      FROM voice_presence
      ORDER BY guild_id, channel_id, joined_at
    `)
    .all() as unknown as {
    guild_id: string
    guild_name: string
    channel_id: string
    channel_name: string
    user_id: string
    display_name: string
    wt_nick: string
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
    joinedAt: r.joined_at,
  }))
}

/** ПКР игрока по нику: последний снимок любого его клана (+дельта в рамках клана) */
export function getPlayerRating(nick: string): (ClanRating & { clanTag: string }) | null {
  const stmt = getDb().prepare(`
    SELECT clan_tag, rating FROM clan_rating_snapshots
    WHERE nick = ?
    ORDER BY id DESC LIMIT 2
  `)
  let rows = stmt.all(nick) as unknown as { clan_tag: string; rating: number }[]
  if (rows.length === 0) {
    // консольные игроки на странице клана могут быть с суффиксом ника (@psn/@live)
    rows = getDb()
      .prepare(`
        SELECT clan_tag, rating FROM clan_rating_snapshots
        WHERE nick LIKE ? ESCAPE '\\'
        ORDER BY id DESC LIMIT 2
      `)
      .all(escapeLike(nick) + '@%') as unknown as { clan_tag: string; rating: number }[]
  }
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
 * Читает из battle_players по индексу idx_bp_nick — мгновенно и не зависит
 * от размера базы (раньше был LIKE-скан всех JSON-блобов в items).
 * Консольный ник на клановой странице бывает с суффиксом (@psn/@live),
 * поэтому ловим и «ник», и «ник@…».
 */
export function getPlayerBattleStats(nick: string): { battles: number; lastBattleAt: number | null } {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS battles, MAX(b.start_time) AS last
      FROM battle_players bp
      JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.nick = ? OR bp.nick LIKE ? ESCAPE '\\'
    `)
    .get(nick, escapeLike(nick) + '@%') as { battles: number; last: number | null } | undefined
  return { battles: row?.battles ?? 0, lastBattleAt: row?.last ?? null }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch)
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
        session_id, user_id, nick, clan_tag, team, kills, ground_kills, naval_kills,
        ai_kills, ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
        award_damage, team_kills, squad_id, vehicle, vehicles, disconnected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const p of b.players) {
      pStmt.run(
        b.sessionId, p.userId, p.nick, p.clanTag, p.team, p.kills, p.groundKills, p.navalKills,
        p.aiKills, p.aiGroundKills, p.assists, p.deaths, p.captureZone, p.damageZone, p.score,
        p.awardDamage, p.teamKills, p.squadId, p.vehicle, JSON.stringify(p.vehicles), p.disconnected ? 1 : 0,
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
      'INSERT INTO battle_chat (session_id, time_ms, sender, channel, message) VALUES (?, ?, ?, ?, ?)',
    )
    for (const m of b.chat) cStmt.run(b.sessionId, m.timeMs, m.sender, m.channel, m.message)

    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

/** Номер победившей команды из разобранного боя (null — бой не разобран) */
export function getBattleWinner(sessionId: string): number | null {
  const row = getDb().prepare('SELECT team_won FROM battles WHERE session_id = ?').get(sessionId) as
    | { team_won: number }
    | undefined
  return row ? row.team_won : null
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
  team_won: number
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
  vehicles: string
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
             mission_settings
      FROM battles WHERE session_id = ? OR session_hex = ?
    `)
    .get(sessionId, sessionId.toLowerCase()) as BattleRow | undefined
  if (!battle) return null

  const players = getDb()
    .prepare(`
      SELECT user_id, nick, clan_tag, team, kills, ground_kills, naval_kills, ai_kills,
             ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
             award_damage, team_kills, squad_id, vehicles
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
             mission_settings, events_blob
      FROM battles WHERE session_id = ? OR session_hex = ?
    `)
    .get(sessionId, sessionId.toLowerCase()) as (BattleRow & { events_blob: Uint8Array | null }) | undefined
  if (!battle) return null

  const players = getDb()
    .prepare(`
      SELECT user_id, nick, clan_tag, team, kills, ground_kills, naval_kills, ai_kills,
             ai_ground_kills, assists, deaths, capture_zone, damage_zone, score,
             award_damage, team_kills, squad_id, vehicles
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
export function getPendingBattleItems(maxAttempts: number, limit: number): StoredItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, NULL AS analysis
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
    .all(maxAttempts, limit) as unknown as ItemRow[]
  return rows.map(toStoredItem)
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
  const db2 = getDb()
  const ingested = (db2.prepare('SELECT COUNT(*) AS c FROM battles').get() as { c: number }).c
  const total = (db2.prepare("SELECT COUNT(*) AS c FROM items WHERE source = 'wt-replays'").get() as { c: number }).c
  const failed = (
    db2
      .prepare("SELECT COUNT(*) AS c FROM battle_ingest WHERE status IN ('error', 'expired', 'no_parts')")
      .get() as { c: number }
  ).c
  const skipped = (
    db2.prepare("SELECT COUNT(*) AS c FROM battle_ingest WHERE status IN ('expired', 'no_parts')").get() as {
      c: number
    }
  ).c
  const players = (db2.prepare('SELECT COUNT(*) AS c FROM battle_players').get() as { c: number }).c
  const kills = (db2.prepare('SELECT COUNT(*) AS c FROM battle_kills').get() as { c: number }).c
  return { ingested, pending: Math.max(0, total - ingested - skipped), failed, players, kills }
}


