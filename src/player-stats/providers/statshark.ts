import {
  fetchStatSharkBundle,
  StatSharkClientError,
  type StatSharkBundle,
} from '../statshark-client.js'
import {
  normalizeStatSharkBundle,
  STATSHARK_SOURCE,
  StatSharkSchemaError,
} from '../statshark-normalizer.js'
import type {
  PlayerReference,
  PlayerStatsFailureStatus,
  PlayerStatsProvider,
  RawPlayerStats,
} from '../types.js'

type JsonRecord = Record<string, unknown>

export interface StatSharkProviderOptions {
  /** Возвращает Unix-время в секундах. */
  now?: () => number
  /** Browser-загрузка; подменяется fixture-ом в тестах. */
  fetchBundle?: (playerId: string) => Promise<StatSharkBundle>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureStatus(error: unknown): PlayerStatsFailureStatus {
  if (error instanceof StatSharkSchemaError) return 'schema_error'
  if (error instanceof StatSharkClientError) {
    if (error.status === 404) return 'not_found'
    if (error.status === 401 || error.status === 403) return 'private'
    if (error.status === 429) return 'rate_limited'
  }
  return 'error'
}

function platformFromNick(nick: string): string | null {
  const suffix = nick.toLowerCase().match(/@(psn|xbox)$/)?.[1]
  return suffix ?? null
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function collectVehicleIds(bundle: StatSharkBundle): Set<string> {
  const ids = new Set<string>()
  const profile = record(bundle.profile)
  const modes = profile?.['Vehicles']
  if (Array.isArray(modes)) {
    for (const rows of modes) {
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[15] === 'string' && row[15].trim() !== '') {
          ids.add(row[15].trim())
        }
      }
    }
  }

  const history = record(bundle.vehicleHistory)
  if (history !== null) {
    for (const snapshots of Object.values(history)) {
      if (!Array.isArray(snapshots)) continue
      for (const snapshot of snapshots) {
        const diff = record(record(snapshot)?.['diff'])
        if (diff === null) continue
        for (const id of Object.keys(diff)) ids.add(id)
      }
    }
  }
  return ids
}

/**
 * getVehicleinfo — глобальный многомегабайтный словарь. В snapshot кладём
 * только записи машин этого игрока, чтобы не дублировать один справочник для
 * каждого профиля.
 */
function compactBundle(bundle: StatSharkBundle): StatSharkBundle {
  const allVehicleInfo = record(bundle.vehicleInfo) ?? {}
  const vehicleInfo: JsonRecord = {}
  for (const id of collectVehicleIds(bundle)) {
    if (Object.hasOwn(allVehicleInfo, id)) vehicleInfo[id] = allVehicleInfo[id]
  }
  return { ...bundle, vehicleInfo }
}

export class StatSharkProvider implements PlayerStatsProvider {
  readonly source = STATSHARK_SOURCE
  readonly requiresWtUserId = true

  private readonly now: () => number
  private readonly loadBundle: (playerId: string) => Promise<StatSharkBundle>

  constructor(options: StatSharkProviderOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.loadBundle = options.fetchBundle ?? ((playerId) => fetchStatSharkBundle(playerId))
  }

  resolvePlayer(nick: string): Promise<PlayerReference[]> {
    const normalized = nick.trim()
    if (!/^\d+$/.test(normalized)) return Promise.resolve([])
    return Promise.resolve([{
      source: this.source,
      sourcePlayerId: normalized,
      wtUserId: normalized,
      nick: normalized,
      platform: null,
    }])
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    if (player.source !== this.source) {
      throw new Error(`PlayerReference источника ${player.source} нельзя передать в ${this.source}`)
    }
    const id = (player.wtUserId ?? player.sourcePlayerId ?? '').trim()
    if (!/^\d+$/.test(id)) {
      throw new Error('StatShark требует известный числовой WT user id')
    }
    const fetchedAt = this.now()

    let bundle: StatSharkBundle
    try {
      bundle = await this.loadBundle(id)
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

    const compact = compactBundle(bundle)
    const rawJson = JSON.stringify(compact)
    try {
      const normalized = normalizeStatSharkBundle(compact)
      return {
        player: {
          source: this.source,
          sourcePlayerId: normalized.playerId,
          wtUserId: normalized.playerId,
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
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status: failureStatus(error),
        rawJson,
        error: errorMessage(error),
        normalized: null,
      }
    }
  }
}
