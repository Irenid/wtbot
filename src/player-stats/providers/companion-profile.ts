import { readResponseBuffer, readResponseJson } from '../../http-response.js'
import {
  CompanionProfileAuthError,
  decodeCompanionProfile,
  type CompanionProfile,
} from '../companion-protobuf.js'
import type {
  PlayerReference,
  PlayerStatsFailureStatus,
  PlayerStatsProvider,
  RawPlayerStats,
} from '../types.js'
import { config } from '../../config.js'

const COMPANION_ORIGIN = 'https://companion-app.warthunder.com'
const SEARCH_URL = `${COMPANION_ORIGIN}/call/`
const PROFILE_MAX_BYTES = 4 * 1024 * 1024
const SEARCH_MAX_BYTES = 512 * 1024
const MAX_SEARCH_RESULTS = 100

export const COMPANION_PROFILE_SOURCE = 'companion-profile'
export const COMPANION_PROFILE_PARSER_VERSION = 'wt-companion-profile-v1'

interface CompanionSearchResponse {
  [userId: string]: string
}

export interface CompanionProfileProviderOptions {
  now?: () => number
  cookie?: string
  fetchSearch?: (nickname: string) => Promise<PlayerReference[]>
  fetchProfile?: (userId: string) => Promise<CompanionProfile>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureStatus(error: unknown): PlayerStatsFailureStatus {
  if (error instanceof CompanionProfileAuthError) return 'private'
  if (error instanceof CompanionHttpError) {
    if (error.status === 404) return 'not_found'
    if (error.status === 401 || error.status === 403 || error.status === 400) return 'private'
    if (error.status === 429) return 'rate_limited'
  }
  return 'error'
}

class CompanionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CompanionHttpError'
  }
}

function positiveUserId(value: string): string {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) throw new Error(`Неверный WT user id: ${value}`)
  return normalized
}

function platformFromNick(nick: string): string | null {
  return nick.match(/@(psn|live|epic)$/i)?.[1]?.toLowerCase() ?? null
}

function parseSearchResponse(value: unknown, requestedNickname: string): PlayerReference[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('companion search: ответ не является JSON-объектом')
  }
  const result: PlayerReference[] = []
  for (const [rawUserId, rawNick] of Object.entries(value as CompanionSearchResponse)) {
    if (result.length >= MAX_SEARCH_RESULTS) {
      throw new Error(`companion search: больше ${MAX_SEARCH_RESULTS} результатов`)
    }
    if (!/^\d+$/.test(rawUserId) || typeof rawNick !== 'string' || rawNick.trim() === '') continue
    const nick = rawNick.trim()
    result.push({
      source: COMPANION_PROFILE_SOURCE,
      sourcePlayerId: rawUserId,
      wtUserId: rawUserId,
      nick,
      platform: platformFromNick(nick),
    })
  }
  if (result.length === 0) {
    throw new Error(`companion search: игрок ${requestedNickname} не найден`)
  }
  return result
}

async function fetchCompanionSearch(nickname: string): Promise<PlayerReference[]> {
  const url = new URL(SEARCH_URL)
  url.search = new URLSearchParams({
    classname: 'eaw_Contacts',
    method: 'jzx_findUsersByNickPrefix',
    count: String(MAX_SEARCH_RESULTS),
    nick: nickname,
    v: '9',
  }).toString()
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'wtbot/companion-profile',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new CompanionHttpError(response.status, `companion search: HTTP ${response.status}`)
  }
  return parseSearchResponse(
    await readResponseJson<unknown>(response, SEARCH_MAX_BYTES, `companion search ${nickname}`),
    nickname,
  )
}

function requireCookie(cookie: string): string {
  const normalized = cookie.trim()
  if (normalized === '') {
    throw new CompanionProfileAuthError(
      'companion profile требует WT_COMPANION_COOKIE сессии официального companion-app',
    )
  }
  return normalized
}

async function fetchCompanionProfile(
  userId: string,
  cookie: string,
): Promise<CompanionProfile> {
  const normalizedUserId = positiveUserId(userId)
  const url = new URL(SEARCH_URL)
  url.search = new URLSearchParams({
    classname: 'eaw_ProfileBin',
    method: 'jzx_getPublicProfileBin',
    bin: 'true',
    userid: normalizedUserId,
    lang: 'en',
    v: '7',
  }).toString()
  const response = await fetch(url, {
    headers: {
      accept: 'application/x-protobuf, application/octet-stream',
      cookie: requireCookie(cookie),
      'user-agent': 'wtbot/companion-profile',
    },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await readResponseBuffer(response, PROFILE_MAX_BYTES, `companion profile ${normalizedUserId}`)
  if (!response.ok) {
    const preview = body.toString('utf8').slice(0, 240)
    throw new CompanionHttpError(
      response.status,
      `companion profile ${normalizedUserId}: HTTP ${response.status}${preview ? ` (${preview})` : ''}`,
    )
  }
  return decodeCompanionProfile(body, normalizedUserId)
}

export class CompanionProfileProvider implements PlayerStatsProvider {
  readonly source = COMPANION_PROFILE_SOURCE
  readonly requiresWtUserId = false

  private readonly now: () => number
  private readonly cookie: string
  private readonly search: (nickname: string) => Promise<PlayerReference[]>
  private readonly loadProfile: (userId: string) => Promise<CompanionProfile>

  constructor(options: CompanionProfileProviderOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.cookie = options.cookie ?? config.companionCookie
    this.search = options.fetchSearch ?? fetchCompanionSearch
    this.loadProfile = options.fetchProfile
      ?? ((userId) => fetchCompanionProfile(userId, this.cookie))
  }

  resolvePlayer(nick: string): Promise<PlayerReference[]> {
    const normalized = nick.trim()
    if (normalized === '') return Promise.reject(new Error('Ник companion-профиля не может быть пустым'))
    return this.search(normalized)
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    if (player.source !== this.source) {
      throw new Error(`PlayerReference источника ${player.source} нельзя передать в ${this.source}`)
    }
    const userId = player.wtUserId ?? player.sourcePlayerId
    const fetchedAt = this.now()
    if (userId === null) {
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status: 'not_found',
        rawJson: null,
        error: 'companion profile требует числовой WT user id',
        normalized: null,
      }
    }
    try {
      const document = await this.loadProfile(positiveUserId(userId))
      return {
        player: {
          source: this.source,
          sourcePlayerId: document.userId,
          wtUserId: document.userId,
          nick: document.nick,
          platform: platformFromNick(document.nick) ?? player.platform,
        },
        fetchedAt,
        sourceUpdatedAt: null,
        status: 'ok',
        rawJson: JSON.stringify(document),
        error: null,
        normalized: document.stats,
      }
    } catch (error) {
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status: failureStatus(error),
        rawJson: null,
        error: errorMessage(error),
        normalized: null,
      }
    }
  }
}
