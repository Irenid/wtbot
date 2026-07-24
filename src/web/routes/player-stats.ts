import type { FastifyPluginAsync } from 'fastify'
import type { PlayerStatsLookupInput } from '../../player-stats/comparison.js'
import type { WebDeps } from '../types.js'

const RATE_WINDOW_MS = 60_000
const PER_IP_LIMIT = 20
const GLOBAL_LIMIT = 60
const MAX_IP_BUCKETS = 2_048

interface RateBucket {
  startedAt: number
  count: number
}

function currentBucket(
  buckets: Map<string, RateBucket>,
  key: string,
  now: number,
): RateBucket {
  const current = buckets.get(key)
  if (current !== undefined && now - current.startedAt < RATE_WINDOW_MS) return current
  const fresh = { startedAt: now, count: 0 }
  buckets.set(key, fresh)
  return fresh
}

function cleanupBuckets(buckets: Map<string, RateBucket>, now: number): void {
  if (buckets.size <= MAX_IP_BUCKETS) return
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) buckets.delete(key)
  }
  while (buckets.size > MAX_IP_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

export const playerStatsRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  const ipBuckets = new Map<string, RateBucket>()
  const globalBuckets = new Map<string, RateBucket>()

  app.post<{ Body: PlayerStatsLookupInput }>('/api/player-stats', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['player'],
        properties: {
          player: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: '^[^\\u0000-\\u001f\\u007f]+$',
          },
          from: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
          to: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
        },
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const player = request.body.player.trim()
    if (player === '') {
      return reply.code(400).send({ ok: false, code: 'INVALID_PLAYER', error: 'Укажите ник или WT user id' })
    }
    if (
      request.body.from !== undefined
      && request.body.to !== undefined
      && request.body.from > request.body.to
    ) {
      return reply.code(400).send({ ok: false, code: 'INVALID_PERIOD', error: 'from не может быть позже to' })
    }

    const now = Date.now()
    cleanupBuckets(ipBuckets, now)
    const ipBucket = currentBucket(ipBuckets, request.ip, now)
    const globalBucket = currentBucket(globalBuckets, 'global', now)
    if (ipBucket.count >= PER_IP_LIMIT || globalBucket.count >= GLOBAL_LIMIT) {
      const retryAt = Math.max(
        ipBucket.count >= PER_IP_LIMIT ? ipBucket.startedAt + RATE_WINDOW_MS : now,
        globalBucket.count >= GLOBAL_LIMIT ? globalBucket.startedAt + RATE_WINDOW_MS : now,
      )
      const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1_000))
      return reply
        .header('Retry-After', String(retryAfterSec))
        .code(429)
        .send({
          ok: false,
          code: 'RATE_LIMITED',
          error: 'Слишком много запросов статистики',
          retryAfterSec,
        })
    }
    ipBucket.count += 1
    globalBucket.count += 1

    const input: PlayerStatsLookupInput = { player }
    if (request.body.from !== undefined) input.from = request.body.from
    if (request.body.to !== undefined) input.to = request.body.to
    const result = deps.playerStats.lookup(input)
    if (result.status === 'not_found') {
      return reply.code(404).send({
        ok: false,
        code: 'PLAYER_NOT_FOUND',
        error: 'Игрок не найден в локальных реплеях, voice-снимке, рейтингах или identity',
      })
    }
    if (result.status === 'ambiguous') {
      return reply.code(409).send({
        ok: false,
        code: 'AMBIGUOUS_PLAYER',
        error: 'Ник соответствует нескольким WT user id; укажите стабильный id',
        candidates: result.candidates,
      })
    }
    return { ok: true, stats: result.stats }
  })
}
