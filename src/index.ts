import { config } from './config.js'
import {
  closeDb,
  DB_BACKGROUND_WARMUP_SQL,
  initDb,
  warmupDbHotPages,
} from './db/index.js'
import { startBot, stopBotWork } from './bot/index.js'
import { startVoiceTracker } from './bot/voice-tracker.js'
import { requestPlayerBoardRefresh, startPlayerBoardPublisher } from './bot/player-board.js'
import { buildServer } from './web/index.js'
import { startParsers, stopParsers } from './parsers/index.js'
import { startIngestWorker, stopIngestWorker } from './wrpl/ingest.js'
import { closeWorkerPool, runWorkerTask } from './workers/pool.js'
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

let app: ReturnType<typeof buildServer> | null = null
let client: Awaited<ReturnType<typeof startBot>> | null = null
let voiceTracker: ReturnType<typeof startVoiceTracker> | null = null
let playerStats: PlayerStatsCoordinator | null = null
let shuttingDown = false
let requestedExitCode = 0
const PRODUCER_DRAIN_MS = 10_000

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[core] необработанный rejection, запускаю аварийный shutdown:', reason)
  requestShutdown('unhandledRejection', 1)
})
process.on('uncaughtException', (error: unknown) => {
  console.error('[core] необработанное исключение, запускаю аварийный shutdown:', error)
  requestShutdown('uncaughtException', 1)
})

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
initDb(config.dbPath, { allowCreate: config.allowNewDb })
console.log(`[db] SQLite: ${config.dbPath}`)
// До readiness читаем только компактные индексы. Полные проходы таблиц уходят
// в background worker после открытия web и не блокируют Discord/Fastify.
console.log(`[db] Горячие индексы прогреты за ${warmupDbHotPages(false)} мс`)
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
playerStats = new PlayerStatsCoordinator({
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
const startedClient = await startBot()
client = startedClient
// Табло запускается до первого voice-снимка: callback трекера сразу
// перерисует его после синхронизации voice_presence.
startPlayerBoardPublisher(startedClient, { playerStats })
const startedVoiceTracker = startVoiceTracker(startedClient, config.voiceChannelIds, {
  onPresenceChange: requestPlayerBoardRefresh,
})
voiceTracker = startedVoiceTracker

// 3. Веб-дашборд
app = buildServer(
  {
    getBotStatus: () => ({
      online: startedClient.isReady(),
      tag: startedClient.user?.tag ?? null,
      guilds: startedClient.guilds.cache.size,
      uptimeSec: Math.floor(process.uptime()),
    }),
    refreshVoice: () => startedVoiceTracker.refresh(),
    playerStats,
  },
  undefined,
  { host: config.webHost, token: config.webToken },
)
await app.listen({ port: config.port, host: config.webHost })
console.log(`[web] Дашборд: http://${config.webHost}:${config.port}`)
void runWorkerTask(
  {
    kind: 'warm-sqlite',
    input: { dbPath: config.dbPath, statements: [...DB_BACKGROUND_WARMUP_SQL] },
  },
  { priority: 'background', timeoutMs: 180_000 },
).then((result) => {
  console.log(`[db] Фоновый прогрев ${result.statements} таблиц завершён за ${Math.round(result.elapsedMs)} мс`)
}).catch((error: unknown) => {
  console.warn(`[db] Фоновый прогрев таблиц не завершён: ${
    error instanceof Error ? error.message : String(error)
  }`)
})

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
  startIngestWorker(config.workerResources.ingestConcurrency, config.dbPath)
} else {
  console.log('[ingest] Фоновая загрузка и разбор боёв отключены')
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  requestedExitCode = Math.max(requestedExitCode, exitCode)
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
    app?.close() ?? Promise.resolve(),
    stopBotWork(PRODUCER_DRAIN_MS),
    voiceTracker?.stop() ?? Promise.resolve(),
    playerStats?.stop() ?? Promise.resolve(),
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
  if (client) await client.destroy()
  await closeWorkerPool(10_000)
  closeDb()
  process.exit(requestedExitCode)
}

function requestShutdown(signal: string, exitCode = 0): void {
  void shutdown(signal, exitCode).catch((error: unknown) => {
    console.error(`[core] shutdown после ${signal} завершился ошибкой:`, error)
    process.exit(1)
  })
}
