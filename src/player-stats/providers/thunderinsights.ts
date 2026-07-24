import { readResponseText } from '../../http-response.js'
import {
  normalizeThunderInsightsPayload,
  PlayerStatsSchemaError,
} from '../normalizer.js'
import {
  PlayerStatsProviderFailure,
  type PlayerReference,
  type PlayerStatsFailureStatus,
  type PlayerStatsProvider,
  type RawPlayerStats,
} from '../types.js'

const DEFAULT_BASE_URL = 'https://api.thunderinsights.dk/v1'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_SEARCH_MAX_BYTES = 512 * 1024
const DEFAULT_PROFILE_MAX_BYTES = 512 * 1024
const DEFAULT_UNITS_MAX_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 20

export type PlayerStatsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ThunderInsightsProviderOptions {
  baseUrl?: string
  timeoutMs?: number
  searchMaxBytes?: number
  profileMaxBytes?: number
  unitsMaxBytes?: number
  fetchImpl?: PlayerStatsFetch
  /** Возвращает Unix-время в секундах. */
  now?: () => number
}

interface JsonDocument {
  value: unknown
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} должен быть положительным целым числом`)
  }
  return value
}

function normalizedBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('ThunderInsights baseUrl должен использовать HTTP(S)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ThunderInsights baseUrl не должен содержать credentials, query или fragment')
  }
  return url.toString().replace(/\/$/, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function storedErrorJson(endpoint: string, raw: string): string | null {
  if (raw === '') return null
  let body: unknown
  try {
    body = JSON.parse(raw) as unknown
  } catch {
    body = raw
  }
  return JSON.stringify({ endpoint, body })
}

function statusForHttp(status: number): PlayerStatsFailureStatus | null {
  if (status === 401 || status === 403) return 'private'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  return null
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlayerStatsProviderFailure('schema_error', `${label} должен быть JSON-объектом`)
  }
  return value as Record<string, unknown>
}

function searchReferences(payload: unknown): PlayerReference[] {
  if (!Array.isArray(payload)) {
    throw new PlayerStatsProviderFailure('schema_error', 'ThunderInsights search должен вернуть массив')
  }
  if (payload.length > MAX_SEARCH_RESULTS) {
    throw new PlayerStatsProviderFailure(
      'schema_error',
      `ThunderInsights search вернул больше ${MAX_SEARCH_RESULTS} строк`,
    )
  }
  const references = new Map<string, PlayerReference>()
  for (let index = 0; index < payload.length; index += 1) {
    const row = objectValue(payload[index], `search[${index}]`)
    const id = row['userid']
    const nick = row['nick']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new PlayerStatsProviderFailure(
        'schema_error',
        `search[${index}].userid должен быть положительным целым числом`,
      )
    }
    if (typeof nick !== 'string' || nick.trim() === '') {
      throw new PlayerStatsProviderFailure(
        'schema_error',
        `search[${index}].nick должен быть непустой строкой`,
      )
    }
    const sourcePlayerId = String(id)
    references.set(sourcePlayerId, {
      source: 'thunderinsights',
      sourcePlayerId,
      wtUserId: sourcePlayerId,
      nick: nick.trim(),
      platform: platformFromNick(nick),
    })
  }
  return [...references.values()]
}

function platformFromNick(nick: string): string | null {
  return nick.match(/@(psn|live|epic)$/i)?.[1]?.toLowerCase() ?? null
}

export class ThunderInsightsProvider implements PlayerStatsProvider {
  readonly source = 'thunderinsights'

  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly searchMaxBytes: number
  private readonly profileMaxBytes: number
  private readonly unitsMaxBytes: number
  private readonly fetchImpl: PlayerStatsFetch
  private readonly now: () => number
  private readonly shutdownController = new AbortController()

  constructor(options: ThunderInsightsProviderOptions = {}) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl)
    this.timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.searchMaxBytes = positiveLimit(
      options.searchMaxBytes,
      DEFAULT_SEARCH_MAX_BYTES,
      'searchMaxBytes',
    )
    this.profileMaxBytes = positiveLimit(
      options.profileMaxBytes,
      DEFAULT_PROFILE_MAX_BYTES,
      'profileMaxBytes',
    )
    this.unitsMaxBytes = positiveLimit(options.unitsMaxBytes, DEFAULT_UNITS_MAX_BYTES, 'unitsMaxBytes')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  close(): void {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error('ThunderInsights provider остановлен'))
    }
  }

  async resolvePlayer(nick: string): Promise<PlayerReference[]> {
    const normalizedNick = nick.trim()
    if (normalizedNick === '') throw new Error('Ник для ThunderInsights resolve не может быть пустым')
    const url = new URL(`${this.baseUrl}/users/direct/search/`)
    url.searchParams.set('nick', normalizedNick)
    url.searchParams.set('limit', '10')
    try {
      const document = await this.requestJson(url, this.searchMaxBytes, 'ThunderInsights search')
      return searchReferences(document.value)
    } catch (error) {
      if (error instanceof PlayerStatsProviderFailure && error.status === 'not_found') return []
      throw error
    }
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    if (player.source !== this.source) {
      throw new Error(`PlayerReference источника ${player.source} нельзя передать в ${this.source}`)
    }
    const sourcePlayerId = player.wtUserId ?? player.sourcePlayerId
    if (sourcePlayerId === null || !/^\d+$/.test(sourcePlayerId.trim())) {
      throw new Error('ThunderInsights требует числовой wt_user_id')
    }
    const normalizedSourcePlayerId = sourcePlayerId.trim()
    const fetchedAt = this.now()

    let profile: JsonDocument
    try {
      profile = await this.requestJson(
        new URL(`${this.baseUrl}/users/stats/${encodeURIComponent(normalizedSourcePlayerId)}`),
        this.profileMaxBytes,
        'ThunderInsights profile',
      )
    } catch (error) {
      return this.failureResult(player, fetchedAt, error)
    }

    let units: JsonDocument
    try {
      units = await this.requestJson(
        new URL(`${this.baseUrl}/users/stats/${encodeURIComponent(normalizedSourcePlayerId)}/units/`),
        this.unitsMaxBytes,
        'ThunderInsights units',
      )
    } catch (error) {
      return this.failureResult(player, fetchedAt, error, profile.value)
    }

    const rawJson = JSON.stringify({ profile: profile.value, units: units.value })
    try {
      const normalized = normalizeThunderInsightsPayload(profile.value, units.value, normalizedSourcePlayerId)
      return {
        player: {
          source: this.source,
          sourcePlayerId: normalized.sourcePlayerId,
          wtUserId: normalized.sourcePlayerId,
          nick: normalized.nick,
          platform: platformFromNick(normalized.nick) ?? player.platform,
        },
        fetchedAt,
        sourceUpdatedAt: normalized.sourceUpdatedAt,
        status: 'ok',
        rawJson,
        error: null,
        normalized: normalized.stats,
      }
    } catch (error) {
      const status = error instanceof PlayerStatsSchemaError ? 'schema_error' : 'error'
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status,
        rawJson,
        error: errorMessage(error),
        normalized: null,
      }
    }
  }

  private failureResult(
    player: PlayerReference,
    fetchedAt: number,
    error: unknown,
    profilePayload?: unknown,
  ): RawPlayerStats {
    const failure = error instanceof PlayerStatsProviderFailure
      ? error
      : new PlayerStatsProviderFailure('error', errorMessage(error), null, { cause: error })
    const rawJson = profilePayload === undefined
      ? failure.rawJson
      : JSON.stringify({ profile: profilePayload, failure: failure.rawJson })
    return {
      player,
      fetchedAt,
      sourceUpdatedAt: null,
      status: failure.status,
      rawJson,
      error: failure.message,
      normalized: null,
    }
  }

  private async requestJson(url: URL, maxBytes: number, label: string): Promise<JsonDocument> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'wtbot/player-stats',
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(this.timeoutMs),
          this.shutdownController.signal,
        ]),
      })
    } catch (error) {
      throw new PlayerStatsProviderFailure(
        'error',
        `${label}: запрос не выполнен (${errorMessage(error)})`,
        null,
        { cause: error },
      )
    }

    const mappedStatus = statusForHttp(response.status)
    let raw: string
    try {
      raw = await readResponseText(response, maxBytes, label)
    } catch (error) {
      throw new PlayerStatsProviderFailure(
        mappedStatus ?? 'schema_error',
        `${label}: ответ не прошёл ограничение размера (${errorMessage(error)})`,
        null,
        { cause: error },
      )
    }
    const errorRaw = storedErrorJson(url.pathname, raw)
    if (mappedStatus !== null) {
      throw new PlayerStatsProviderFailure(
        mappedStatus,
        `${label}: HTTP ${response.status}`,
        errorRaw,
      )
    }
    if (!response.ok) {
      throw new PlayerStatsProviderFailure('error', `${label}: HTTP ${response.status}`, errorRaw)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('json')) {
      throw new PlayerStatsProviderFailure(
        'schema_error',
        `${label}: ожидался JSON Content-Type`,
        errorRaw,
      )
    }
    try {
      return { value: JSON.parse(raw) as unknown }
    } catch (error) {
      throw new PlayerStatsProviderFailure(
        'schema_error',
        `${label}: некорректный JSON`,
        errorRaw,
        { cause: error },
      )
    }
  }
}
