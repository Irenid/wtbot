import { config, requireDiscordToken } from './config.js'
import path from 'node:path'
import {
  closeDb,
  DB_BACKGROUND_WARMUP_SQL,
  initDb,
} from './db/index.js'
import { startBot, stopBotWork } from './bot/index.js'
import { startVoiceTracker } from './bot/voice-tracker.js'
import { requestPlayerBoardRefresh, startPlayerBoardPublisher } from './bot/player-board.js'
import { buildServer } from './web/index.js'
import type { RuntimeStats } from './web/types.js'
import { startParsers, stopParsers } from './parsers/index.js'
import { getIngestTelemetrySnapshot, startIngestWorker, stopIngestWorker } from './wrpl/ingest.js'
import { configureReplayFetchAdmission } from './wrpl/replay-cache.js'
import { configureReplayProcessBudget } from './wrpl/replay-events.js'
import { configureReplayUrlPolicy } from './wrpl/replay-url-policy.js'
import { closeWorkerPool, runWorkerTask, workerPoolSnapshot } from './workers/pool.js'
import {
  OFFICIAL_PROFILE_PARSER_VERSION,
  OFFICIAL_PROFILE_SOURCE,
} from './player-stats/normalizer.js'
import { OfficialProfileProvider } from './player-stats/providers/official-profile.js'
import {
  COMPANION_PROFILE_PARSER_VERSION,
  COMPANION_PROFILE_SOURCE,
  CompanionProfileProvider,
} from './player-stats/providers/companion-profile.js'
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
import {
  acquireRecoverableFileLock,
  type OwnedFileLock,
} from './recoverable-file-lock.js'

// Точка входа: main thread владеет Discord, Fastify и SQLite; тяжёлые
// WRPL/zlib/Resvg-задачи уходят в ограниченный пул worker_threads.

let app: ReturnType<typeof buildServer> | null = null
let client: Awaited<ReturnType<typeof startBot>> | null = null
let voiceTracker: ReturnType<typeof startVoiceTracker> | null = null
let playerStats: PlayerStatsCoordinator | null = null
let shuttingDown = false
let requestedExitCode = 0
let eventLoopCurrentLagMs = 0
let eventLoopMaxLagMs = 0
let previousCpuUsage = process.cpuUsage()
let previousCpuSampleAt = performance.now()
let instanceLock: OwnedFileLock | null = null
const PRODUCER_DRAIN_MS = 10_000

// Без Discord-токена основной процесс бесполезен: проверяем до lock, SQLite и сети.
requireDiscordToken()

try {
  instanceLock = await acquireRecoverableFileLock({
    lockFile: `${path.resolve(config.dbPath)}.process.lock`,
    timeoutMs: 350,
    staleMs: 2_000,
    retryMinMs: 25,
    retryMaxMs: 50,
    onRecovered: (_lockFile, owner) => {
      console.warn(`[core] Восстановлен stale process lock${owner ? ` PID ${owner.pid}` : ''}`)
    },
  })
} catch {
  console.error('[core] Другой экземпляр wtbot уже запущен для этой SQLite; повторный старт отменён')
  process.exit(1)
}

configureReplayProcessBudget({
  exactReservations: config.replayExactReservationEnabled,
})
configureReplayFetchAdmission(config.ingestAdaptiveAdmissionEnabled)
configureReplayUrlPolicy({ allowedHosts: config.replayHosts })

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
    const drift = Math.max(0, Number(now - lastTick) / 1e6 - WATCHDOG_INTERVAL_MS)
    lastTick = now
    eventLoopCurrentLagMs = drift
    eventLoopMaxLagMs = Math.max(eventLoopMaxLagMs, drift)
    if (drift > 500) {
      console.warn(`[watchdog] event loop был заблокирован ~${Math.round(drift)} мс — синхронная работа в main thread`)
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdog.unref()
}

// 1. База данных
initDb(config.dbPath, { allowCreate: config.allowNewDb })
console.log(`[db] SQLite: ${config.dbPath}`)
console.log('[db] Прогрев страниц отложен до открытия Discord и web')
const officialPlayerStatsService = config.playerStatsEnabled
  ? new PlayerStatsService({
      provider: new OfficialProfileProvider(),
      parserVersion: OFFICIAL_PROFILE_PARSER_VERSION,
    })
  : null
const companionProfilePlayerStatsService = config.companionProfilePlayerStatsEnabled
  ? new PlayerStatsService({
      provider: new CompanionProfileProvider(),
      parserVersion: COMPANION_PROFILE_PARSER_VERSION,
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
  companionProfilePlayerStatsService,
  statSharkPlayerStatsService,
].filter((service): service is PlayerStatsService => service !== null)
const playerStatsCoordinator = new PlayerStatsCoordinator({
  externalServices: playerStatsServices,
  externalSource: officialPlayerStatsService?.source
    ?? companionProfilePlayerStatsService?.source
    ?? statSharkPlayerStatsService?.source
    ?? OFFICIAL_PROFILE_SOURCE,
})
playerStats = playerStatsCoordinator
console.log(
  `[player-stats] Профиль warthunder.com: ${officialPlayerStatsService === null ? 'выключен' : 'включён (lazy)'}`,
)
console.log(
  `[player-stats] ${COMPANION_PROFILE_SOURCE}: ` +
    `${companionProfilePlayerStatsService === null ? 'выключен' : 'включён (lazy)'}`,
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

function getRuntimeStats(): RuntimeStats {
  const sampledAt = performance.now()
  const cpuDelta = process.cpuUsage(previousCpuUsage)
  const elapsedMs = Math.max(1, sampledAt - previousCpuSampleAt)
  previousCpuUsage = process.cpuUsage()
  previousCpuSampleAt = sampledAt

  const memory = process.memoryUsage()
  const workers = workerPoolSnapshot()
  const ingest = getIngestTelemetrySnapshot()
  const stages = Object.fromEntries(
    Object.entries(ingest.stages).map(([name, stage]) => [name, {
      queued: stage.currentQueued,
      active: stage.currentActive,
      queuedBytes: stage.currentQueuedBytes,
      activeBytes: stage.currentActiveBytes,
      completed: stage.completed,
      cancelled: stage.cancelled,
      waitP95Ms: stage.waitMs.p95Ms,
      activeP95Ms: stage.activeMs.p95Ms,
    }]),
  ) as RuntimeStats['ingest']['stages']
  const plan = config.workerResources
  const cumulative = workers.cumulative

  return {
    process: {
      pid: process.pid,
      node: process.version,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      cpuPercent: (cpuDelta.user + cpuDelta.system) / (elapsedMs * 1_000) * 100,
    },
    eventLoop: {
      currentLagMs: eventLoopCurrentLagMs,
      maxLagMs: eventLoopMaxLagMs,
    },
    resources: {
      availableCpus: plan.availableCpus,
      totalMemoryMb: plan.totalMemoryMb,
      freeMemoryMb: plan.freeMemoryMb,
      reservedMemoryMb: plan.reservedMemoryMb,
      workerThreads: plan.workerThreads,
      backgroundReserveSlots: plan.backgroundReserveSlots,
      ingestConcurrency: plan.ingestConcurrency,
      replayProcessByteBudgetMb: plan.replayProcessByteBudgetMb,
    },
    workers: {
      configured: workers.configuredWorkers,
      reserve: workers.backgroundReserveSlots,
      live: workers.workers.live,
      ready: workers.workers.ready,
      starting: workers.workers.starting,
      busy: workers.workers.busy,
      queued: workers.current.queued,
      running: workers.current.running,
      queuedBytes: workers.current.queuedInputTransferBytes,
      runningBytes: workers.current.runningInputTransferBytes,
      maxQueued: workers.highWater.queued,
      maxRunning: workers.highWater.running,
      submitted: cumulative.submitted,
      completed: cumulative.completed,
      succeeded: cumulative.succeeded,
      failed: cumulative.failed,
      rejected: cumulative.rejected,
      queueMsAvg: cumulative.completed > 0 ? cumulative.queueMsTotal / cumulative.completed : null,
      queueMsMax: cumulative.queueMsMax,
      executionMsAvg: cumulative.executionSamples > 0
        ? cumulative.executionMsTotal / cumulative.executionSamples
        : null,
      executionMsMax: cumulative.executionMsMax,
      workloads: workers.workloads.map((workload) => ({
        kind: workload.kind,
        priority: workload.priority,
        queued: workload.queued,
        running: workload.running,
        completed: workload.completed,
        failed: workload.failed,
        rejected: workload.rejected,
        queueMsMax: workload.queueMsMax,
        executionMsMax: workload.executionMsMax,
      })),
    },
    ingest: {
      enabled: config.battleBackgroundEnabled,
      battlesPerMinute: ingest.battlesPerMinute,
      backlog: {
        pending: ingest.backlog.pendingCount,
        selected: ingest.backlog.selectedCount,
        limit: ingest.backlog.selectionLimit,
        saturated: ingest.backlog.saturated,
        oldestAgeMs: ingest.backlog.oldestAgeMs ?? ingest.backlog.oldestAgeLowerBoundMs,
      },
      outcomes: ingest.outcomes,
      stages,
      replay: {
        completed: ingest.replay.completed,
        succeeded: ingest.replay.succeeded,
        failed: ingest.replay.failed,
        aborted: ingest.replay.aborted,
        bytes: ingest.replay.bytes,
        cacheHits: ingest.replay.cacheHits,
        networkParts: ingest.replay.networkParts,
        retries: ingest.replay.retries,
        httpErrors: ingest.replay.httpErrors,
        rateLimited429: ingest.replay.status.rateLimited429,
        server5xx: ingest.replay.status.server5xx,
        downloadP95Ms: ingest.replay.downloadMs.p95Ms,
      },
      sqlite: {
        commits: ingest.sqlite.commits,
        checkpoints: ingest.sqlite.checkpoints,
        queueP95Ms: ingest.sqlite.queueMs.p95Ms,
        transactionP95Ms: ingest.sqlite.transactionMs.p95Ms,
        checkpointP95Ms: ingest.sqlite.checkpointMs.p95Ms,
      },
      admission: ingest.admission === null
        ? null
        : {
            enabled: ingest.admission.enabled,
            currentConcurrency: ingest.admission.currentConcurrency,
            maxConcurrency: ingest.admission.maxConcurrency,
            reason: ingest.admission.reason,
            increases: ingest.admission.increases,
            decreases: ingest.admission.decreases,
          },
      processBudget: {
        limitBytes: ingest.replayProcessByteBudget.limitBytes,
        usedBytes: ingest.replayProcessByteBudget.usedBytes,
        availableBytes: ingest.replayProcessByteBudget.availableBytes,
        queuedCount: ingest.replayProcessByteBudget.queuedCount,
        queuedBytes: ingest.replayProcessByteBudget.queuedBytes,
        highWaterUsedBytes: ingest.replayProcessByteBudget.highWaterUsedBytes,
        timedOut: ingest.replayProcessByteBudget.timedOut,
        waitMsMax: ingest.replayProcessByteBudget.waitMs.max,
      },
      fetchAdmission: {
        enabled: ingest.replayFetchAdmission.enabled,
        currentIntervalMs: ingest.replayFetchAdmission.currentIntervalMs,
        rateLimitEvents: ingest.replayFetchAdmission.rateLimitEvents,
        increases: ingest.replayFetchAdmission.increases,
        decreases: ingest.replayFetchAdmission.decreases,
      },
    },
    playerStats: playerStatsServices.map((service) => ({
      source: service.source,
      ...service.getMetrics(),
    })),
  }
}

/**
 * Этапы запуска с ожиданием сети. Сигнал может прийти во время любого await:
 * тогда shutdown уже идёт, и следующие этапы не стартуют — иначе парсеры,
 * ingest и трекеры начали бы писать в закрывающиеся SQLite и worker pool.
 */
async function startServices(): Promise<void> {
  // 2. Discord-бот (+трекер голосовых каналов — пишет присутствие в БД)
  const startedClient = await startBot()
  if (shuttingDown) {
    // shutdown мог уже пройти шаг закрытия Discord: этот клиент закрываем сами.
    await startedClient.destroy()
    return
  }
  client = startedClient
  // Табло запускается до первого voice-снимка: callback трекера сразу
  // перерисует его после синхронизации voice_presence.
  startPlayerBoardPublisher(startedClient, { playerStats: playerStatsCoordinator })
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
      getRuntimeStats,
      refreshVoice: () => startedVoiceTracker.refresh(),
      playerStats: playerStatsCoordinator,
    },
    undefined,
    { host: config.webHost, token: config.webToken },
  )
  await app.listen({ port: config.port, host: config.webHost })
  if (shuttingDown) return
  console.log(`[web] Дашборд: http://${config.webHost}:${config.port}`)
  void runWorkerTask(
    {
      kind: 'warm-sqlite',
      input: { dbPath: config.dbPath, statements: [...DB_BACKGROUND_WARMUP_SQL] },
    },
    { priority: 'background', timeoutMs: 180_000 },
  ).then((result) => {
    console.log(`[db] Фоновый прогрев ${result.statements} запросов завершён за ${Math.round(result.elapsedMs)} мс`)
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
  if (shuttingDown) return
  startWtCookieRefresh()
  startParsers()

  // 5. Разбор боёв в БД: скачивает файлы реплеев новых боёв, раскладывает
  // фраги/очки/технику/победителя/траектории по таблицам (см. wrpl/ingest.ts)
  if (config.battleBackgroundEnabled) {
    startIngestWorker(
      config.workerResources.ingestConcurrency,
      config.dbPath,
      config.ingestAdaptiveAdmissionEnabled,
      config.ingestPipelineEnabled,
    )
  } else {
    console.log('[ingest] Фоновая загрузка и разбор боёв отключены')
  }
}

await startServices().catch((error: unknown) => {
  // Раньше ошибка запуска (например, неверный Discord token) роняла процесс
  // без shutdown; теперь SQLite закрывается и process lock освобождается штатно.
  console.error('[core] запуск не удался, останавливаюсь:', error)
  requestShutdown('startup-error', 1)
})

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  requestedExitCode = Math.max(requestedExitCode, exitCode)
  if (shuttingDown) return
  shuttingDown = true
  const shutdownStarted = performance.now()
  console.log(`\n[core] Получен ${signal} — останавливаюсь...`)
  stopWtCookieRefresh()
  const parsersStopped = stopParsers()
  const ingestStopped = stopIngestWorker()
  // Все вызовы сначала запрещают новую работу. Общий deadline важен: один
  // voice refresh может последовательно ждать несколько сетевых timeout, а
  // Fastify.close — тот же незавершённый request. После дедлайна process всё
  // равно безопасно закрывает client/pool/DB; кэши публикуются атомарно.
  const producerDrain = Promise.allSettled([
    parsersStopped,
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
  console.log(
    `[core:shutdown] producers ${drained ? 'drained' : 'deadline'} за ` +
      `${Math.round(performance.now() - shutdownStarted)} мс`,
  )
  const browserStarted = performance.now()
  await closeWtBrowser()
  console.log(`[core:shutdown] browser закрыт за ${Math.round(performance.now() - browserStarted)} мс`)
  const discordStarted = performance.now()
  if (client) await client.destroy()
  console.log(`[core:shutdown] Discord закрыт за ${Math.round(performance.now() - discordStarted)} мс`)
  const poolStarted = performance.now()
  await closeWorkerPool(10_000)
  console.log(`[core:shutdown] CPU pool закрыт за ${Math.round(performance.now() - poolStarted)} мс`)
  const dbStarted = performance.now()
  closeDb()
  if (instanceLock) {
    await instanceLock.release().catch((error: unknown) => {
      console.warn(`[core] process lock не освобождён: ${error instanceof Error ? error.message : String(error)}`)
    })
    instanceLock = null
  }
  console.log(
    `[core:shutdown] SQLite закрыта за ${Math.round(performance.now() - dbStarted)} мс; ` +
      `весь shutdown ${Math.round(performance.now() - shutdownStarted)} мс`,
  )
  process.exit(requestedExitCode)
}

export function requestShutdown(signal: string, exitCode = 0): void {
  void shutdown(signal, exitCode).catch((error: unknown) => {
    console.error(`[core] shutdown после ${signal} завершился ошибкой:`, error)
    process.exit(1)
  })
}
