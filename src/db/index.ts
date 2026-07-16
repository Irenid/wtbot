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
  // при частых интервалах (wt-replays раз в 20 с) история не должна
  // расти бесконечно — держим последние 1000 запусков на источник
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

/** Записи источника новее заданного id, старые первыми (для автоанонса) */
export function getItemsAfter(source: string, afterId: number, limit = 10): StoredItem[] {
  const rows = getDb()
    .prepare(`
      SELECT i.id, i.source, i.external_id, i.title, i.data, i.updated_at, a.result AS analysis
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      WHERE i.source = ? AND i.id > ?
      ORDER BY i.id ASC
      LIMIT ?
    `)
    .all(source, afterId, limit) as unknown as ItemRow[]
  return rows.map(toStoredItem)
}

/** Максимальный id записей источника (0 — записей нет) */
export function getMaxItemId(source: string): number {
  const row = getDb().prepare('SELECT MAX(id) AS m FROM items WHERE source = ?').get(source) as
    | { m: number | null }
    | undefined
  return row?.m ?? 0
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

/** Сколько клановых боёв игрока есть в собранных реплеях и когда был последний */
export function getPlayerBattleStats(nick: string): { battles: number; lastBattleAt: number | null } {
  const esc = escapeLike(nick)
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS battles, MAX(json_extract(data, '$.startTime')) AS last
      FROM items
      WHERE source = 'wt-replays'
        AND (data LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')
    `)
    .get(`%"name":"${esc}"%`, `%"name":"${esc}@%`) as { battles: number; last: number | null } | undefined
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


