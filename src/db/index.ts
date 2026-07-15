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
  `)
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

export function recordParseResult(
  source: string,
  ok: boolean,
  summary: string | null,
  error: string | null,
): void {
  getDb()
    .prepare('INSERT INTO parse_results (source, ok, summary, error) VALUES (?, ?, ?, ?)')
    .run(source, ok ? 1 : 0, summary, error)
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


