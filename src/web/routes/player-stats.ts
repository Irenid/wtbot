import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { PlayerStatsLookupInput } from '../../player-stats/comparison.js'
import type { WebDeps } from '../types.js'

const RATE_WINDOW_MS = 60_000
const MAX_IP_BUCKETS = 2_048
/** A refresh queues up to three external sources per player. */
const STATS_PER_IP_LIMIT = 20
const STATS_GLOBAL_LIMIT = 60
/** An id lookup asks the companion host and maybe the shared warthunder.com queue. */
const ID_PER_IP_LIMIT = 10
const ID_GLOBAL_LIMIT = 30
/** How long POST /api/player-id waits before answering `pending`; the lookup goes on and stores its id. */
const ID_LOOKUP_WAIT_MS = 15_000
const ID_BUSY_RETRY_SEC = 10

const NICK_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
} as const

interface RateBucket {
  startedAt: number
  count: number
}

interface RateLimit {
  perIp: number
  global: number
  ipBuckets: Map<string, RateBucket>
  globalBuckets: Map<string, RateBucket>
}

function rateLimit(perIp: number, global: number): RateLimit {
  return { perIp, global, ipBuckets: new Map(), globalBuckets: new Map() }
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

/** Counts the request; when the IP or the global window is full, answers 429 instead and returns false. */
function passRateLimit(limit: RateLimit, ip: string, reply: FastifyReply, error: string): boolean {
  const now = Date.now()
  cleanupBuckets(limit.ipBuckets, now)
  const ipBucket = currentBucket(limit.ipBuckets, ip, now)
  const globalBucket = currentBucket(limit.globalBuckets, 'global', now)
  if (ipBucket.count < limit.perIp && globalBucket.count < limit.global) {
    ipBucket.count += 1
    globalBucket.count += 1
    return true
  }
  const retryAt = Math.max(
    ipBucket.count >= limit.perIp ? ipBucket.startedAt + RATE_WINDOW_MS : now,
    globalBucket.count >= limit.global ? globalBucket.startedAt + RATE_WINDOW_MS : now,
  )
  const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1_000))
  void reply
    .header('Retry-After', String(retryAfterSec))
    .code(429)
    .send({ ok: false, code: 'RATE_LIMITED', error, retryAfterSec })
  return false
}

export const playerStatsRoutes: FastifyPluginAsync<{ deps: WebDeps }> = async (app, { deps }) => {
  const statsLimit = rateLimit(STATS_PER_IP_LIMIT, STATS_GLOBAL_LIMIT)
  const idLimit = rateLimit(ID_PER_IP_LIMIT, ID_GLOBAL_LIMIT)

  app.post<{ Body: PlayerStatsLookupInput }>('/api/player-stats', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['player'],
        properties: {
          player: NICK_SCHEMA,
          from: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
          to: { type: 'integer', minimum: 0, maximum: 4_102_444_800 },
        },
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const player = request.body.player.trim()
    if (player === '') {
      return reply.code(400).send({ ok: false, code: 'INVALID_PLAYER', error: 'Enter a nickname or a WT user id' })
    }
    if (
      request.body.from !== undefined
      && request.body.to !== undefined
      && request.body.from > request.body.to
    ) {
      return reply.code(400).send({ ok: false, code: 'INVALID_PERIOD', error: 'from cannot be later than to' })
    }
    if (!passRateLimit(statsLimit, request.ip, reply, 'Too many player statistics requests')) return reply

    const input: PlayerStatsLookupInput = { player }
    if (request.body.from !== undefined) input.from = request.body.from
    if (request.body.to !== undefined) input.to = request.body.to
    const result = deps.playerStats.lookup(input)
    if (result.status === 'not_found') {
      return reply.code(404).send({
        ok: false,
        code: 'PLAYER_NOT_FOUND',
        error: 'Player not found in local replays, the voice snapshot, ratings or identities',
      })
    }
    if (result.status === 'ambiguous') {
      return reply.code(409).send({
        ok: false,
        code: 'AMBIGUOUS_PLAYER',
        error: 'The nickname matches several WT user ids; give the stable id',
        candidates: result.candidates,
      })
    }
    return { ok: true, stats: result.stats }
  })

  /**
   * WT user id of a nick known locally without one (a squadron member never seen
   * in replays). `found` is stored, so the roster links the id from then on.
   */
  app.post<{ Body: { nick: string } }>('/api/player-id', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['nick'],
        properties: { nick: NICK_SCHEMA },
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const lookup = deps.playerIdLookup
    if (!lookup) {
      return reply.code(503).send({ ok: false, code: 'DISABLED', error: 'WT user id lookup is disabled' })
    }
    const nick = request.body.nick.trim()
    if (nick === '') {
      return reply.code(400).send({ ok: false, code: 'INVALID_PLAYER', error: 'Enter a nickname' })
    }
    if (!passRateLimit(idLimit, request.ip, reply, 'Too many WT user id lookups')) return reply

    let timer: NodeJS.Timeout | undefined
    const result = await Promise.race([
      lookup.resolve(nick),
      new Promise<null>((resolve) => { timer = setTimeout(resolve, ID_LOOKUP_WAIT_MS, null) }),
    ]).finally(() => clearTimeout(timer))
    if (result === null) return reply.code(202).send({ ok: true, status: 'pending', wtUserId: null })
    switch (result.status) {
      case 'found':
        return { ok: true, status: 'found', wtUserId: result.wtUserId }
      case 'not_found':
      case 'ambiguous':
        return { ok: true, status: result.status, wtUserId: null }
      case 'unknown_player':
        return reply.code(404).send({ ok: false, code: 'PLAYER_NOT_FOUND', error: 'Player not found in local data' })
      case 'busy':
        return reply
          .header('Retry-After', String(ID_BUSY_RETRY_SEC))
          .code(503)
          .send({ ok: false, code: 'BUSY', error: 'Too many WT user id lookups queued', retryAfterSec: ID_BUSY_RETRY_SEC })
      case 'error':
        return reply.code(502).send({ ok: false, code: 'LOOKUP_FAILED', error: 'No WT user id source answered; try again later' })
    }
  })
}
