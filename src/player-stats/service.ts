import {
  getLatestPlayerExternalCheck,
  getLatestPlayerExternalStats,
  getPlayerIdentityById,
  getPlayerIdentityByWtUserId,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
} from '../db/index.js'
import { PLAYER_EXTERNAL_SNAPSHOT_STATUSES, PLAYER_STATS_TTL_SECONDS } from './types.js'
import {
  PlayerStatsProviderFailure,
  type PlayerExternalStats,
  type PlayerIdentity,
  type PlayerReference,
  type PlayerStatsCacheResult,
  type PlayerStatsProvider,
  type PlayerStatsServiceMetrics,
  type RawPlayerStats,
} from './types.js'

const DEFAULT_TTL_SECONDS = PLAYER_STATS_TTL_SECONDS
const DEFAULT_RETRY_BASE_SECONDS = 5 * 60
const DEFAULT_RETRY_MAX_SECONDS = 6 * 60 * 60

export interface PlayerStatsServiceOptions {
  provider: PlayerStatsProvider
  parserVersion: string
  ttlSeconds?: number
  retryBaseSeconds?: number
  retryMaxSeconds?: number
  /** Возвращает Unix-время в секундах. */
  now?: () => number
}

interface PendingJob {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

function positiveSeconds(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} должен быть положительным целым числом`)
  }
  return value
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'Неизвестная ошибка provider-а').slice(0, 2_000)
}

function emptyMetrics(): PlayerStatsServiceMetrics {
  return {
    requests: 0,
    queued: 0,
    skippedFresh: 0,
    skippedBackoff: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    byStatus: Object.fromEntries(
      PLAYER_EXTERNAL_SNAPSHOT_STATUSES.map((status) => [status, 0]),
    ) as PlayerStatsServiceMetrics['byStatus'],
  }
}

/**
 * Ленивая однослотовая очередь provider-а. request() всегда читает SQLite
 * синхронно и только планирует refresh, поэтому внешний сервис не блокирует web/ingest.
 */
export class PlayerStatsService {
  private readonly provider: PlayerStatsProvider
  private readonly parserVersion: string
  private readonly ttlSeconds: number
  private readonly retryBaseSeconds: number
  private readonly retryMaxSeconds: number
  private readonly now: () => number
  private readonly queue: number[] = []
  private readonly jobs = new Map<number, PendingJob>()
  private readonly failureCounts = new Map<number, number>()
  private readonly nextRetryByIdentity = new Map<number, number>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly metrics = emptyMetrics()
  private draining = false
  private drainScheduled = false
  private activeIdentityId: number | null = null
  private accepting = true
  private stopPromise: Promise<void> | null = null

  constructor(options: PlayerStatsServiceOptions) {
    this.provider = options.provider
    this.parserVersion = options.parserVersion.trim()
    if (this.parserVersion === '') throw new Error('parserVersion не может быть пустым')
    this.ttlSeconds = positiveSeconds(options.ttlSeconds, DEFAULT_TTL_SECONDS, 'ttlSeconds')
    this.retryBaseSeconds = positiveSeconds(
      options.retryBaseSeconds,
      DEFAULT_RETRY_BASE_SECONDS,
      'retryBaseSeconds',
    )
    this.retryMaxSeconds = positiveSeconds(
      options.retryMaxSeconds,
      DEFAULT_RETRY_MAX_SECONDS,
      'retryMaxSeconds',
    )
    if (this.retryMaxSeconds < this.retryBaseSeconds) {
      throw new RangeError('retryMaxSeconds не может быть меньше retryBaseSeconds')
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  get source(): string {
    return this.provider.source
  }

  request(identityId: number): PlayerStatsCacheResult {
    this.metrics.requests += 1
    const identity = getPlayerIdentityById(identityId)
    if (identity === null) throw new Error(`Identity ${identityId} не найдена`)
    const now = this.currentTime()
    const stats = getLatestPlayerExternalStats(identity.id, this.provider.source)
    const lastCheck = getLatestPlayerExternalCheck(identity.id, this.provider.source)
    const active = this.jobs.get(identity.id)
    let refreshQueued = active !== undefined

    const canResolve = identity.wtUserId !== null || this.provider.requiresWtUserId !== true
    if (active === undefined && this.accepting && canResolve) {
      if (lastCheck?.status === 'ok' && now - lastCheck.lastCheckedAt < this.ttlSeconds) {
        this.metrics.skippedFresh += 1
      } else {
        const nextRetryAt = this.nextRetryAt(identity.id, lastCheck)
        if (nextRetryAt !== null && now < nextRetryAt) {
          this.metrics.skippedBackoff += 1
        } else {
          const job = this.enqueue(identity.id)
          void job.promise.catch(() => undefined)
          refreshQueued = true
        }
      }
    }

    const latestSuccessfulCheck = stats?.snapshot.lastCheckedAt ?? null
    const stale = stats !== null && (
      lastCheck?.status !== 'ok'
      || lastCheck.id !== stats.snapshot.id
      || latestSuccessfulCheck === null
      || now - latestSuccessfulCheck >= this.ttlSeconds
    )
    return {
      stats,
      stale,
      refreshQueued,
      lastCheck,
      nextRetryAt: this.nextRetryAt(identity.id, lastCheck),
    }
  }

  /** Явный refresh для CLI/tests; всё равно дедуплицируется общей очередью. */
  async refreshNow(identityId: number): Promise<PlayerExternalStats | null> {
    if (!this.accepting) throw new Error('Сервис статистики игроков уже останавливается')
    const identity = getPlayerIdentityById(identityId)
    if (identity === null) throw new Error(`Identity ${identityId} не найдена`)
    await this.enqueue(identity.id).promise
    return getLatestPlayerExternalStats(identity.id, this.provider.source)
  }

  async waitForIdle(): Promise<void> {
    if (!this.draining && !this.drainScheduled && this.queue.length === 0 && this.jobs.size === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    this.accepting = false

    const cancelled = this.queue.splice(0)
    for (const identityId of cancelled) {
      if (identityId === this.activeIdentityId) continue
      const job = this.jobs.get(identityId)
      job?.resolve()
      this.jobs.delete(identityId)
    }

    this.stopPromise = (async () => {
      let closeError: unknown
      try {
        await this.provider.close?.()
      } catch (error) {
        closeError = error
      }
      await this.waitForIdle()
      if (closeError !== undefined) throw closeError
    })()
    return this.stopPromise
  }

  getMetrics(): PlayerStatsServiceMetrics {
    return {
      ...this.metrics,
      byStatus: { ...this.metrics.byStatus },
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('PlayerStatsService now() должен возвращать Unix-время в секундах')
    }
    return value
  }

  private nextRetryAt(
    identityId: number,
    lastCheck: ReturnType<typeof getLatestPlayerExternalCheck>,
  ): number | null {
    const inMemory = this.nextRetryByIdentity.get(identityId)
    if (inMemory !== undefined) return inMemory
    if (lastCheck !== null && lastCheck.status !== 'ok') {
      const delay = lastCheck.status === 'private' || lastCheck.status === 'not_found'
        ? this.ttlSeconds
        : this.retryBaseSeconds
      return lastCheck.lastCheckedAt + delay
    }
    return null
  }

  private enqueue(identityId: number): PendingJob {
    if (!this.accepting) throw new Error('Сервис статистики игроков уже останавливается')
    const existing = this.jobs.get(identityId)
    if (existing !== undefined) return existing

    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((resolveJob, rejectJob) => {
      resolve = resolveJob
      reject = rejectJob
    })
    const job = { promise, resolve, reject }
    this.jobs.set(identityId, job)
    this.queue.push(identityId)
    this.metrics.queued += 1
    this.scheduleDrain()
    return job
  }

  private scheduleDrain(): void {
    if (this.draining || this.drainScheduled) return
    this.drainScheduled = true
    setImmediate(() => {
      this.drainScheduled = false
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const identityId = this.queue.shift()
        if (identityId === undefined) break
        const job = this.jobs.get(identityId)
        if (job === undefined) continue
        this.activeIdentityId = identityId
        this.metrics.started += 1
        try {
          const status = await this.runRefresh(identityId)
          this.metrics.byStatus[status] += 1
          if (status === 'ok') this.metrics.succeeded += 1
          else this.metrics.failed += 1
          job.resolve()
        } catch (error) {
          this.metrics.failed += 1
          this.metrics.byStatus.error += 1
          job.reject(error)
        } finally {
          this.activeIdentityId = null
          this.jobs.delete(identityId)
        }
      }
    } finally {
      this.draining = false
      if (this.queue.length > 0) this.scheduleDrain()
      else if (this.jobs.size === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  private async runRefresh(identityId: number): Promise<RawPlayerStats['status']> {
    const identity = getPlayerIdentityById(identityId)
    if (identity === null) throw new Error(`Identity ${identityId} исчезла до refresh`)
    let result: RawPlayerStats
    try {
      const reference = await this.resolveReference(identity)
      result = await this.provider.fetchPlayerStats(reference)
    } catch (error) {
      result = this.failureResult(identity, error)
    }

    if (result.player.source !== this.provider.source) {
      result = {
        ...result,
        status: 'schema_error',
        error: 'Provider вернул PlayerReference другого source',
        normalized: null,
      }
    }
    if (result.status === 'ok' && (result.rawJson === null || result.normalized === null)) {
      result = {
        ...result,
        status: 'schema_error',
        error: 'Успешный ответ provider-а не содержит rawJson или normalized metrics',
        normalized: null,
      }
    }
    if (result.status !== 'ok' && result.normalized !== null) {
      result = {
        ...result,
        status: 'schema_error',
        error: 'Неуспешный ответ provider-а содержит normalized metrics',
        normalized: null,
      }
    }
    if (result.status !== 'ok' && (result.error === null || result.error.trim() === '')) {
      result = { ...result, error: `Provider вернул статус ${result.status} без описания ошибки` }
    }

    if (result.status === 'ok') {
      try {
        this.updateIdentity(identity, result)
      } catch (error) {
        result = {
          ...result,
          status: 'schema_error',
          error: `Не удалось связать identity с ответом provider-а: ${errorMessage(error)}`,
          normalized: null,
        }
      }
    }
    savePlayerExternalSnapshot({
      identityId,
      source: this.provider.source,
      sourcePlayerId: result.player.sourcePlayerId,
      nick: result.player.nick || null,
      fetchedAt: result.fetchedAt,
      sourceUpdatedAt: result.sourceUpdatedAt,
      status: result.status,
      rawJson: result.rawJson,
      parserVersion: this.parserVersion,
      error: result.error,
      normalized: result.normalized,
    })

    if (result.status === 'ok') {
      this.failureCounts.delete(identityId)
      this.nextRetryByIdentity.delete(identityId)
    } else {
      const failures = (this.failureCounts.get(identityId) ?? 0) + 1
      this.failureCounts.set(identityId, failures)
      const delay = result.status === 'private' || result.status === 'not_found'
        ? this.ttlSeconds
        : Math.min(
            this.retryMaxSeconds,
            this.retryBaseSeconds * (2 ** Math.min(failures - 1, 30)),
          )
      this.nextRetryByIdentity.set(identityId, this.currentTime() + delay)
    }
    return result.status
  }

  private async resolveReference(identity: PlayerIdentity): Promise<PlayerReference> {
    if (identity.wtUserId !== null) {
      return {
        source: this.provider.source,
        sourcePlayerId: identity.wtUserId,
        wtUserId: identity.wtUserId,
        nick: identity.canonicalNick,
        platform: identity.platform,
      }
    }

    const candidates = await this.provider.resolvePlayer(identity.canonicalNick)
    const expectedNick = identity.canonicalNick.toLowerCase()
    const exact = candidates.filter((candidate) => candidate.nick.toLowerCase() === expectedNick)
    if (exact.length === 0) {
      throw new PlayerStatsProviderFailure('not_found', 'Точное совпадение ника не найдено')
    }
    if (exact.length > 1) {
      throw new PlayerStatsProviderFailure('error', 'Ник неоднозначен; автоматическое связывание отменено')
    }
    const reference = exact[0]!
    if (reference.source !== this.provider.source) {
      throw new PlayerStatsProviderFailure('schema_error', 'Provider вернул PlayerReference другого source')
    }
    if (reference.wtUserId !== null) {
      const existing = getPlayerIdentityByWtUserId(reference.wtUserId)
      if (existing !== null && existing.id !== identity.id) {
        throw new PlayerStatsProviderFailure(
          'error',
          `wt_user_id ${reference.wtUserId} уже принадлежит другой identity`,
        )
      }
    }
    return reference
  }

  private updateIdentity(identity: PlayerIdentity, result: RawPlayerStats): void {
    const wtUserId = result.player.wtUserId
    if (identity.wtUserId !== null && wtUserId !== null && identity.wtUserId !== wtUserId) {
      throw new Error('Provider вернул wt_user_id, не совпадающий с identity')
    }
    if (wtUserId !== null) {
      const existing = getPlayerIdentityByWtUserId(wtUserId)
      if (existing !== null && existing.id !== identity.id) {
        throw new Error(`wt_user_id ${wtUserId} уже принадлежит другой identity`)
      }
    }
    savePlayerIdentity({
      identityId: identity.id,
      wtUserId: identity.wtUserId ?? wtUserId,
      canonicalNick: result.player.nick,
      platform: result.player.platform ?? identity.platform,
      aliases: [{
        source: this.provider.source,
        externalId: result.player.sourcePlayerId,
        nick: result.player.nick,
        seenAt: result.fetchedAt,
        matchMethod: wtUserId === null ? 'exact_nick' : 'user_id',
        matchConfidence: wtUserId === null ? 'medium' : 'high',
      }],
    })
  }

  private failureResult(identity: PlayerIdentity, error: unknown): RawPlayerStats {
    const failure = error instanceof PlayerStatsProviderFailure
      ? error
      : new PlayerStatsProviderFailure('error', errorMessage(error), null, { cause: error })
    return {
      player: {
        source: this.provider.source,
        sourcePlayerId: identity.wtUserId,
        wtUserId: identity.wtUserId,
        nick: identity.canonicalNick,
        platform: identity.platform,
      },
      fetchedAt: this.currentTime(),
      sourceUpdatedAt: null,
      status: failure.status,
      rawJson: failure.rawJson,
      error: failure.message,
      normalized: null,
    }
  }
}
