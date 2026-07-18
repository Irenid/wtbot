import { config } from './config.js'
import { closeDb, initDb } from './db/index.js'
import { startBot } from './bot/index.js'
import { startVoiceTracker } from './bot/voice-tracker.js'
import { buildServer } from './web/index.js'
import { startParsers, stopParsers } from './parsers/index.js'
import { startIngestWorker, stopIngestWorker } from './wrpl/ingest.js'

// Точка входа: один процесс поднимает три модуля — бота, сайт и парсеры.
// Общаются они не напрямую, а через общую БД (src/db) и явные интерфейсы,
// поэтому при необходимости их легко разнести на отдельные процессы.

// 1. База данных
initDb(config.dbPath)
console.log(`[db] SQLite: ${config.dbPath}`)

// 2. Discord-бот (+трекер голосовых каналов — пишет присутствие в БД)
const client = await startBot()
const voiceTracker = startVoiceTracker(client, config.voiceChannelIds)

// 3. Веб-дашборд
const app = buildServer({
  getBotStatus: () => ({
    online: client.isReady(),
    tag: client.user?.tag ?? null,
    guilds: client.guilds.cache.size,
    uptimeSec: Math.floor(process.uptime()),
  }),
  refreshVoice: () => voiceTracker.refresh(),
})
await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`[web] Дашборд: http://localhost:${config.port}`)

// 4. Фоновые парсеры
startParsers()

// 5. Разбор боёв в БД: скачивает файлы реплеев новых боёв, раскладывает
// фраги/очки/технику/победителя/траектории по таблицам (см. wrpl/ingest.ts)
startIngestWorker()

// Аккуратная остановка по Ctrl+C
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[core] Получен ${signal} — останавливаюсь...`)
  stopParsers()
  stopIngestWorker()
  await app.close()
  await client.destroy()
  closeDb()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
