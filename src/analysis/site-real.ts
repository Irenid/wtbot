// Сайт на реальной БД без бота, парсеров и внешних запросов: только чтение
// data/wtbot.db (или DB_PATH) + Fastify. Для просмотра живых данных локально.
// Запуск: npx tsx src/analysis/site-real.ts  → http://127.0.0.1:3210/app
// Бот может работать параллельно: БД в WAL-режиме, сайт-роуты read-only.
import { closeDb, initDb, warmupDbHotPages } from '../db/index.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { buildServer } from '../web/index.js'

const PORT = Number(process.env['SITE_PORT'] ?? 3210)
const DB_PATH = process.env['DB_PATH'] ?? 'data/wtbot.db'

async function main(): Promise<void> {
  initDb(DB_PATH)
  console.log(`[site-real] Горячие страницы прогреты за ${warmupDbHotPages()} мс`)
  const app = buildServer({
    // Бот в этом процессе не запущен — статус честно офлайновый.
    getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: Math.floor(process.uptime()) }),
    refreshVoice: async () => ({ players: 0, clans: 0 }),
    // Внешние источники не опрашиваются: показываются только кэшированные снимки.
    playerStats: new PlayerStatsCoordinator({ externalService: null, externalSource: 'site-real' }),
  })
  await app.listen({ host: '127.0.0.1', port: PORT })
  console.log(`[site-real] Сайт на ${DB_PATH}: http://127.0.0.1:${PORT}/app (Ctrl+C для выхода)`)
  const shutdown = async (): Promise<void> => {
    await app.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

await main()
