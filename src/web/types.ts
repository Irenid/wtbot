import type {
  PlayerStatsLookupInput,
  PlayerStatsLookupResult,
} from '../player-stats/comparison.js'
import type { WtUserIdLookupResult } from '../player-stats/id-lookup.js'

export interface BotStatus {
  online: boolean
  tag: string | null
  guilds: number
  uptimeSec: number
}

export interface RuntimeStats {
  process: {
    pid: number
    node: string
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    cpuPercent: number
  }
  eventLoop: {
    currentLagMs: number
    maxLagMs: number
  }
  resources: {
    availableCpus: number
    totalMemoryMb: number
    freeMemoryMb: number
    reservedMemoryMb: number
    workerThreads: number
    backgroundReserveSlots: number
    ingestConcurrency: number
    replayProcessByteBudgetMb: number
  }
  workers: {
    configured: number
    reserve: number
    live: number
    ready: number
    starting: number
    busy: number
    queued: number
    running: number
    queuedBytes: number
    runningBytes: number
    maxQueued: number
    maxRunning: number
    submitted: number
    completed: number
    succeeded: number
    failed: number
    rejected: number
    queueMsAvg: number | null
    queueMsMax: number
    executionMsAvg: number | null
    executionMsMax: number
    workloads: {
      kind: string
      priority: string
      queued: number
      running: number
      completed: number
      failed: number
      rejected: number
      queueMsMax: number
      executionMsMax: number
    }[]
  }
  ingest: {
    enabled: boolean
    battlesPerMinute: number
    backlog: {
      pending: number | null
      selected: number
      limit: number
      saturated: boolean
      oldestAgeMs: number | null
    }
    outcomes: Record<string, number>
    stages: Record<string, {
      queued: number
      active: number
      queuedBytes: number
      activeBytes: number
      completed: number
      cancelled: number
      waitP95Ms: number | null
      activeP95Ms: number | null
    }>
    replay: {
      completed: number
      succeeded: number
      failed: number
      aborted: number
      bytes: number
      cacheHits: number
      networkParts: number
      retries: number
      httpErrors: number
      rateLimited429: number
      server5xx: number
      downloadP95Ms: number | null
    }
    sqlite: {
      commits: number
      checkpoints: number
      queueP95Ms: number | null
      transactionP95Ms: number | null
      checkpointP95Ms: number | null
    }
    admission: {
      enabled: boolean
      currentConcurrency: number
      maxConcurrency: number
      reason: string
      increases: number
      decreases: number
    } | null
    processBudget: {
      limitBytes: number
      usedBytes: number
      availableBytes: number
      queuedCount: number
      queuedBytes: number
      highWaterUsedBytes: number
      timedOut: number
      waitMsMax: number
    }
    fetchAdmission: {
      enabled: boolean
      currentIntervalMs: number
      rateLimitEvents: number
      increases: number
      decreases: number
    }
  }
  playerStats: {
    source: string
    requests: number
    queued: number
    started: number
    succeeded: number
    failed: number
    skippedFresh: number
    skippedBackoff: number
  }[]
}

/** Зависимости веб-модуля: сайт не знает про discord.js напрямую, только про этот интерфейс */
export interface WebDeps {
  getBotStatus(): BotStatus
  /** O(1) снимок процесса, worker pool и ingest без чтения SQLite. */
  getRuntimeStats?(): RuntimeStats
  /** Пересканировать голосовые каналы и освежить ПКР — кнопка «Обновить» на дашборде */
  refreshVoice(): Promise<{ players: number; clans: number }>
  playerStats: {
    lookup(input: PlayerStatsLookupInput): PlayerStatsLookupResult
  }
  /** WT user id of a nick-only profile (src/player-stats/id-lookup.ts); absent or null: lookups are off. */
  playerIdLookup?: {
    resolve(nick: string): Promise<WtUserIdLookupResult>
  } | null
}
