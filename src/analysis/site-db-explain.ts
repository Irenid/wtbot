// Проверка планов запросов read-модели сайта: каждый SQL из SITE_SQL обязан
// ходить по индексу. SCAN больших таблиц (battles, battle_players) — ошибка.
// Запуск: npm run verify:site-db (оффлайн, SQLite :memory:).
import assert from 'node:assert/strict'
import { initDb, closeDb, DB_WARMUP_SQL, SITE_SQL, explainSiteQueryPlan } from '../db/index.js'

// Таблицы, полный скан которых блокирует event loop (см. AGENTS.md).
const BIG_TABLES = new Set([
  'battles',
  'battle_players',
  'battle_kills',
  'battle_chat',
  'clan_rating_snapshots',
  'clan_rating_history',
  'player_external_snapshots',
  'player_identity_aliases',
  'player_identities',
])

const ALLOWED_BIG_SCANS: Readonly<Record<string, readonly string[]>> = {
  clanLatestMembers: ['SCAN clan_rating_snapshots USING COVERING INDEX idx_snapshots_clan_latest'],
  battlesRecent: ['SCAN battles USING INDEX idx_battles_start'],
  siteReplayPlayerCount: ['SCAN battle_players USING COVERING INDEX idx_bp_user_id'],
  clanBaselineSumsAll: ['SCAN clan_rating_snapshots USING COVERING INDEX idx_snapshots_clan_latest'],
}

function allowedScan(key: string, detail: string): boolean {
  return ALLOWED_BIG_SCANS[key]?.includes(detail) ?? false
}

function main(): void {
  initDb(':memory:')
  const failures: string[] = []
  for (const [key, sql] of Object.entries(SITE_SQL)) {
    const rows = explainSiteQueryPlan(sql)
    const plan = rows.map((row) => row.detail).join('\n  ')
    for (const row of rows) {
      const scanMatch = /^SCAN (\S+)/.exec(row.detail)
      if (!scanMatch) continue
      const table = scanMatch[1]!
      if (BIG_TABLES.has(table) && !allowedScan(key, row.detail)) {
        failures.push(`${key}: недопустимый скан «${row.detail}»`)
      }
    }
    console.log(`[site-db-explain] ${key}:\n  ${plan}`)
  }
  // Инвариант прогрева: 'table'-запросы обязаны читать листья таблицы (иначе
  // новый покрывающий индекс молча выхолащивает прогрев), 'index' — индекс.
  for (const statement of DB_WARMUP_SQL) {
    const plan = explainSiteQueryPlan(statement.sql).map((row) => row.detail).join('\n  ')
    const covering = plan.includes('USING COVERING INDEX')
    if (statement.expect === 'table' && covering) {
      failures.push(`warmup «${statement.sql}»: ожидался скан таблицы, но план покрыт индексом:\n  ${plan}`)
    }
    if (statement.expect === 'index' && !covering) {
      failures.push(`warmup «${statement.sql}»: ожидался прогрев индекса, но план:\n  ${plan}`)
    }
    console.log(`[site-db-explain] warmup(${statement.expect}): ${statement.sql}\n  ${plan}`)
  }
  closeDb()
  assert.equal(failures.length, 0, `Запросы со сканом больших таблиц:\n${failures.join('\n')}`)
  console.log('[site-db-explain] OK: все запросы SITE_SQL ходят по индексам, прогрев соответствует ожиданиям')
}

main()
