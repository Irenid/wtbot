import { config } from './config.js'
import { closeDb, initDb } from './db/index.js'
import { startBot, stopBotWork } from './bot/index.js'
import { startVoiceTracker } from './bot/voice-tracker.js'
import { buildServer } from './web/index.js'
import { startParsers, stopParsers } from './parsers/index.js'
import { startIngestWorker, stopIngestWorker } from './wrpl/ingest.js'
import { closeWorkerPool } from './workers/pool.js'

// Точка входа: main thread владеет Discord, Fastify и SQLite; тяжёлые
// WRPL/zlib/Resvg-задачи уходят в ограниченный пул worker_threads.

// 1. База данных
initDb(config.dbPath)
console.log(`[db] SQLite: ${config.dbPath}`)
console.log(`[workers] CPU pool: ${config.workerThreads} поток(а)`)

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
const PRODUCER_DRAIN_MS = 10_000
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[core] Получен ${signal} — останавливаюсь...`)
  stopParsers()
  const ingestStopped = stopIngestWorker()
  // Все вызовы сначала запрещают новую работу. Общий deadline важен: один
  // voice refresh может последовательно ждать несколько сетевых timeout, а
  // Fastify.close — тот же незавершённый request. После дедлайна process всё
  // равно безопасно закрывает client/pool/DB; кэши публикуются атомарно.
  const producerDrain = Promise.allSettled([
    app.close(),
    stopBotWork(PRODUCER_DRAIN_MS),
    voiceTracker.stop(),
    ingestStopped,
  ])
  let drainTimer: NodeJS.Timeout | undefined
  const drained = await Promise.race([
    producerDrain.then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') console.warn('[core] ошибка остановки producer:', result.reason)
      }
      return true
    }),
    new Promise<boolean>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), PRODUCER_DRAIN_MS)
    }),
  ])
  if (drainTimer) clearTimeout(drainTimer)
  if (!drained) console.warn(`[core] producers не завершились за ${PRODUCER_DRAIN_MS} мс — продолжаю shutdown`)
  await client.destroy()
  await closeWorkerPool(10_000)
  closeDb()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
