import { config } from './config.js'
import { closeDb, initDb, warmupDbHotPages } from './db/index.js'
import { startBot, stopBotWork } from './bot/index.js'
import { startVoiceTracker } from './bot/voice-tracker.js'
import { requestPlayerBoardRefresh, startPlayerBoardPublisher } from './bot/player-board.js'
import { buildServer } from './web/index.js'
import { startParsers, stopParsers } from './parsers/index.js'
import { startIngestWorker, stopIngestWorker } from './wrpl/ingest.js'
import { closeWorkerPool } from './workers/pool.js'
import {
  OFFICIAL_PROFILE_PARSER_VERSION,
  OFFICIAL_PROFILE_SOURCE,
} from './player-stats/normalizer.js'
import { OfficialProfileProvider } from './player-stats/providers/official-profile.js'
import { StatSharkProvider } from './player-stats/providers/statshark.js'
import {
  STATSHARK_PARSER_VERSION,
  STATSHARK_SOURCE,
} from './player-stats/statshark-normalizer.js'
import { PlayerStatsService } from './player-stats/service.js'
import { PlayerStatsCoordinator } from './player-stats/comparison.js'
import { closeWtBrowser } from './parsers/sources/wt-browser.js'
import {
  startWtCookieRefresh,
  stopWtCookieRefresh,
  warmupWtTransport,
} from './parsers/sources/wt-request.js'

// Точка входа: main thread владеет Discord, Fastify и SQLite; тяжёлые
// WRPL/zlib/Resvg-задачи уходят в ограниченный пул worker_threads.

// Сторожок event loop: длинная синхронная работа в main thread замораживает
// и Discord, и веб. Порог 500 мс — предупреждение с длительностью, чтобы
// виновник был виден в консоли, а не выглядел как «бот завис».
{
  const WATCHDOG_INTERVAL_MS = 250
  let lastTick = process.hrtime.bigint()
  const watchdog = setInterval(() => {
    const now = process.hrtime.bigint()
    const drift = Number(now - lastTick) / 1e6 - WATCHDOG_INTERVAL_MS
    lastTick = now
    if (drift > 500) {
      console.warn(`[watchdog] event loop был заблокирован ~${Math.round(drift)} мс — синхронная работа в main thread`)
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdog.unref()
}

// 1. База данных
initDb(config.dbPath)
console.log(`[db] SQLite: ${config.dbPath}`)
// Прогрев горячих таблиц до старта Discord: без него первый просмотр каждого
// игрока/клана на сайте упирается в случайные чтения HDD и морозит бота.
console.log(`[db] Горячие страницы прогреты за ${warmupDbHotPages()} мс`)
const officialPlayerStatsService = config.playerStatsEnabled
  ? new PlayerStatsService({
      provider: new OfficialProfileProvider(),
      parserVersion: OFFICIAL_PROFILE_PARSER_VERSION,
    })
  : null
const statSharkPlayerStatsService = config.statSharkPlayerStatsEnabled
  ? new PlayerStatsService({
      provider: new StatSharkProvider(),
      parserVersion: STATSHARK_PARSER_VERSION,
    })
  : null
const playerStatsServices = [
  officialPlayerStatsService,
  statSharkPlayerStatsService,
].filter((service): service is PlayerStatsService => service !== null)
const playerStats = new PlayerStatsCoordinator({
  externalServices: playerStatsServices,
  externalSource: officialPlayerStatsService?.source
    ?? statSharkPlayerStatsService?.source
    ?? OFFICIAL_PROFILE_SOURCE,
})
console.log(
  `[player-stats] Профиль warthunder.com: ${officialPlayerStatsService === null ? 'выключен' : 'включён (lazy)'}`,
)
console.log(
  `[player-stats] ${STATSHARK_SOURCE}: ${statSharkPlayerStatsService === null ? 'выключен' : 'включён (lazy)'}`,
)
console.log(
  `[workers] CPU pool (${config.workerResources.explicitWorkerThreads ? 'ручной' : 'авто'}): ` +
    `${config.workerThreads}/${config.workerResources.availableCpus} потоков` +
    ` · резерв CPU ${config.workerResources.reservedCpus}` +
    ` · резерв интерактива ${config.workerResources.backgroundReserveSlots}` +
    ` · резерв RAM ${config.workerResources.reservedMemoryMb} МБ` +
    ` · ingest ×${config.workerResources.ingestConcurrency}`,
)

// 2. Discord-бот (+трекер голосовых каналов — пишет присутствие в БД)
const client = await startBot()
// Табло запускается до первого voice-снимка: callback трекера сразу
// перерисует его после синхронизации voice_presence.
startPlayerBoardPublisher(client, { playerStats })
const voiceTracker = startVoiceTracker(client, config.voiceChannelIds, {
  onPresenceChange: requestPlayerBoardRefresh,
})

// 3. Веб-дашборд
const app = buildServer({
  getBotStatus: () => ({
    online: client.isReady(),
    tag: client.user?.tag ?? null,
    guilds: client.guilds.cache.size,
    uptimeSec: Math.floor(process.uptime()),
  }),
  refreshVoice: () => voiceTracker.refresh(),
  playerStats,
})
await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`[web] Дашборд: http://localhost:${config.port}`)

// 4. Фоновые парсеры. Дожидаемся прогрева и синхронизации browser-cookies:
// иначе немедленный первый запуск источников обгоняет Edge и видит пустой API.
await warmupWtTransport().catch((error: unknown) => {
  console.warn(`[wt-request] Прогрев браузерного транспорта не удался: ${
    error instanceof Error ? error.message : String(error)
  }`)
})
startWtCookieRefresh()
startParsers()

// 5. Разбор боёв в БД: скачивает файлы реплеев новых боёв, раскладывает
// фраги/очки/технику/победителя/траектории по таблицам (см. wrpl/ingest.ts)
if (config.battleBackgroundEnabled) {
  startIngestWorker(config.workerResources.ingestConcurrency)
} else {
  console.log('[ingest] Фоновая загрузка и разбор боёв отключены')
}

// Аккуратная остановка по Ctrl+C
let shuttingDown = false
const PRODUCER_DRAIN_MS = 10_000
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[core] Получен ${signal} — останавливаюсь...`)
  stopWtCookieRefresh()
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
    playerStats.stop(),
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
  await closeWtBrowser()
  await client.destroy()
  await closeWorkerPool(10_000)
  closeDb()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
