import {
  findKnownPlayerMatches,
  getPlayerIdentityById,
  getPlayerIdentityByWtUserId,
  normalizePlayerSearchKey,
  savePlayerIdentity,
  type KnownPlayerMatch,
} from '../db/index.js'
import { findReplayAccounts } from '../parsers/sources/wt-player.js'
import { platformFromNick } from './comparison.js'
import { COMPANION_PROFILE_SOURCE, searchCompanionNicks } from './providers/companion-profile.js'
import type { PlayerIdentity } from './types.js'

/** An account a source lists for a nick. */
export interface WtAccountCandidate {
  wtUserId: string
  nick: string
}

/** An external source mapping a nick to WT accounts. */
export interface WtUserIdLookupStep {
  /** `player_identity_aliases.source` of a link this step finds. */
  readonly source: string
  /** Minimum pause between two calls, ms: a shared queue or host this step must not crowd. */
  readonly minIntervalMs: number
  /** Accounts for the nick, other nicks allowed (the resolver keeps exact ones); throws when the request fails. */
  find(nick: string): Promise<WtAccountCandidate[]>
}

export type WtUserIdLookupResult =
  /** One account, stored as identity + alias: the roster and the nick page link it from now on. */
  | { status: 'found'; wtUserId: string }
  /** No source that answered lists the nick (renamed, or a prefix list that omitted it). */
  | { status: 'not_found' }
  /** Several accounts on the nick, in local data or in one source. */
  | { status: 'ambiguous' }
  /** The nick is not in local data: arbitrary input never reaches an external source. */
  | { status: 'unknown_player' }
  /** MAX_PENDING nicks already wait. */
  | { status: 'busy' }
  /** Every source failed, or the resolver is stopping. */
  | { status: 'error'; error: string }

export interface WtUserIdResolverOptions {
  steps: readonly WtUserIdLookupStep[]
  /** Milliseconds. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** Rosters refresh daily (5 leaders) or rarely: a nick no source lists stays so for hours. */
const NOT_FOUND_TTL_MS = 12 * 3_600_000
const ERROR_TTL_MS = 5 * 60_000
const MAX_OUTCOMES = 4_096
/** Distinct nicks queued or running; more answer `busy` instead of growing the queue. */
const MAX_PENDING = 32
const ACCOUNT_ID = /^[1-9]\d*$/
/** The companion host is not the warthunder.com queue; one request a second is its only pacing. */
const COMPANION_INTERVAL_MS = 1_000
/** The Replay API shares the warthunder.com queue (1.5 s spacing) with wt-replays: at most 6 a minute here. */
const REPLAY_API_INTERVAL_MS = 10_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Matches of exactly this nick: a numeric nick also matches a WT user id. */
function exactMatches(query: string): KnownPlayerMatch[] {
  const key = normalizePlayerSearchKey(query)
  return findKnownPlayerMatches(query).filter((match) => normalizePlayerSearchKey(match.nick) === key)
}

/** The nick's single identity without an id (voice, a squadron rating, an earlier lookup), else null. */
function nickOnlyIdentity(matches: readonly KnownPlayerMatch[]): PlayerIdentity | null {
  const identities = [...new Set(matches.flatMap((match) => (match.identityId === null ? [] : [match.identityId])))]
    .map((identityId) => getPlayerIdentityById(identityId))
    .filter((identity): identity is PlayerIdentity => identity !== null && identity.wtUserId === null)
  return identities.length === 1 ? identities[0] ?? null : null
}

/**
 * The answer of local data, or null for a known nick without an id. The rule of
 * the nick page (resolveNickTarget in src/web/routes/site.ts): one id links. A
 * nick-only identity of the nick takes that id, as in resolveKnownPlayer, so
 * /players/id/:id moves to the id with its snapshots.
 */
function localResult(query: string): WtUserIdLookupResult | null {
  const matches = exactMatches(query)
  if (matches.length === 0) return { status: 'unknown_player' }
  const ids = new Set(matches.flatMap((match) =>
    match.wtUserId !== null && ACCOUNT_ID.test(match.wtUserId) ? [match.wtUserId] : []))
  if (ids.size > 1) return { status: 'ambiguous' }
  const [wtUserId] = ids
  if (wtUserId === undefined) return null
  const nickOnly = getPlayerIdentityByWtUserId(wtUserId) === null ? nickOnlyIdentity(matches) : null
  if (nickOnly !== null) {
    savePlayerIdentity({ identityId: nickOnly.id, wtUserId, canonicalNick: nickOnly.canonicalNick })
  }
  return { status: 'found', wtUserId }
}

/**
 * Stores the account as aliases (the roster links by their exact nick_base, the
 * nick page by nick_search): the source's spelling and the local ones. Adopts the
 * nick's single nick-only identity, as resolveKnownPlayer does; an identity of
 * the id keeps its canonical nick.
 */
function linkAccount(query: string, account: WtAccountCandidate, source: string, seenAt: number): PlayerIdentity {
  const matches = exactMatches(query)
  const existing = getPlayerIdentityByWtUserId(account.wtUserId) ?? nickOnlyIdentity(matches)
  const nicks = new Set([account.nick, ...matches.map((match) => match.nick)])
  return savePlayerIdentity({
    ...(existing === null ? {} : { identityId: existing.id }),
    wtUserId: account.wtUserId,
    canonicalNick: existing?.canonicalNick ?? account.nick,
    platform: existing?.platform ?? platformFromNick(account.nick),
    aliases: [...nicks].map((nick) => ({
      source,
      externalId: account.wtUserId,
      nick,
      seenAt,
      // A roster nick days old may belong to another account after a rename.
      matchMethod: 'exact_nick' as const,
      matchConfidence: 'medium' as const,
    })),
  })
}

/**
 * WT user id of a nick known only by name (a squadron member never seen in
 * replays): local data first, then the steps in order until one lists exactly
 * one account. Lookups run one at a time, one per nick; outcomes other than
 * `found` are cached in memory (a found id lives in SQLite).
 */
export class WtUserIdResolver {
  private readonly steps: readonly WtUserIdLookupStep[]
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (message: string) => void
  private readonly pending = new Map<string, Promise<WtUserIdLookupResult>>()
  private readonly outcomes = new Map<string, { result: WtUserIdLookupResult; expiresAt: number }>()
  private readonly lastCallAt = new Map<WtUserIdLookupStep, number>()
  private tail: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(options: WtUserIdResolverOptions) {
    this.steps = options.steps
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = options.log ?? ((message) => console.log(message))
  }

  /** Never rejects. */
  resolve(nick: string): Promise<WtUserIdLookupResult> {
    try {
      const query = nick.trim()
      if (query === '' || query.length > 64) return Promise.resolve({ status: 'unknown_player' })
      if (this.stopped) return Promise.resolve({ status: 'error', error: 'stopping' })
      const local = localResult(query)
      if (local !== null) return Promise.resolve(local)
      const key = normalizePlayerSearchKey(query)
      const outcome = this.outcomes.get(key)
      if (outcome !== undefined && outcome.expiresAt > this.now()) return Promise.resolve(outcome.result)
      const running = this.pending.get(key)
      if (running !== undefined) return running
      if (this.pending.size >= MAX_PENDING) return Promise.resolve({ status: 'busy' })
      // Serialized: one external lookup at a time keeps every source's pacing simple.
      const run = this.tail
        .then(() => this.lookup(query, key))
        .finally(() => this.pending.delete(key))
      this.pending.set(key, run)
      this.tail = run.then(() => undefined, () => undefined)
      return run
    } catch (error) {
      return Promise.resolve({ status: 'error', error: errorMessage(error) })
    }
  }

  /** Refuses new lookups, ends queued ones without a request, waits for the running one. */
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.pending.values()])
  }

  private async lookup(query: string, key: string): Promise<WtUserIdLookupResult> {
    if (this.stopped) return { status: 'error', error: 'stopping' }
    let result: WtUserIdLookupResult
    try {
      // An ingest or the previous lookup may have linked the nick while this one waited.
      const local = localResult(query)
      if (local !== null) return local
      result = await this.lookupExternally(query, key)
    } catch (error) {
      // A failed write too: cached, so a broken database does not repeat the requests.
      result = { status: 'error', error: errorMessage(error) }
      this.log(`[player-id] ${query}: ${result.error}`)
    }
    if (result.status !== 'found') this.remember(key, result)
    return result
  }

  private async lookupExternally(query: string, key: string): Promise<WtUserIdLookupResult> {
    const errors: string[] = []
    let answered = false
    // Sequential: the next source is asked only when this one has no answer.
    for (const step of this.steps) {
      const wait = (this.lastCallAt.get(step) ?? -Infinity) + step.minIntervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
      if (this.stopped) break
      let candidates: WtAccountCandidate[]
      try {
        candidates = await step.find(query)
      } catch (error) {
        errors.push(`${step.source}: ${errorMessage(error)}`)
        continue
      } finally {
        this.lastCallAt.set(step, this.now())
      }
      answered = true
      const accounts = new Map<string, string>()
      for (const candidate of candidates) {
        const nick = candidate.nick.trim()
        if (ACCOUNT_ID.test(candidate.wtUserId) && normalizePlayerSearchKey(nick) === key) {
          accounts.set(candidate.wtUserId, nick)
        }
      }
      if (accounts.size > 1) {
        this.log(`[player-id] ${query}: ${accounts.size} accounts in ${step.source}, no link`)
        return { status: 'ambiguous' }
      }
      const [account] = accounts
      if (account === undefined) continue
      const [wtUserId, nick] = account
      linkAccount(query, { wtUserId, nick }, step.source, Math.floor(this.now() / 1_000))
      this.log(`[player-id] ${query}: WT user id ${wtUserId} (${step.source})`)
      return { status: 'found', wtUserId }
    }
    if (answered) {
      this.log(`[player-id] ${query}: no account${errors.length > 0 ? `; failed: ${errors.join('; ')}` : ''}`)
      return { status: 'not_found' }
    }
    const error = errors.length > 0 ? errors.join('; ') : 'no source answered'
    this.log(`[player-id] ${query}: lookup failed: ${error}`)
    return { status: 'error', error }
  }

  private remember(key: string, result: WtUserIdLookupResult): void {
    const ttlMs = result.status === 'error' ? ERROR_TTL_MS : NOT_FOUND_TTL_MS
    this.outcomes.delete(key)
    this.outcomes.set(key, { result, expiresAt: this.now() + ttlMs })
    for (const oldest of this.outcomes.keys()) {
      if (this.outcomes.size <= MAX_OUTCOMES) break
      this.outcomes.delete(oldest)
    }
  }
}

/**
 * The public companion-app nick search (any account, a prefix list of 100),
 * then the Replay API by name (random battles of the last page, WT_COOKIE).
 */
export function defaultWtUserIdLookupSteps(withReplayApi: boolean): WtUserIdLookupStep[] {
  const steps: WtUserIdLookupStep[] = [{
    source: COMPANION_PROFILE_SOURCE,
    minIntervalMs: COMPANION_INTERVAL_MS,
    find: async (nick) => (await searchCompanionNicks(nick)).flatMap((reference) => {
      const wtUserId = reference.wtUserId ?? reference.sourcePlayerId
      return wtUserId === null ? [] : [{ wtUserId, nick: reference.nick }]
    }),
  }]
  if (withReplayApi) {
    steps.push({
      source: 'wt-players',
      minIntervalMs: REPLAY_API_INTERVAL_MS,
      find: async (nick) => (await findReplayAccounts(nick))
        .map((account) => ({ wtUserId: account.userId, nick: account.name })),
    })
  }
  return steps
}
