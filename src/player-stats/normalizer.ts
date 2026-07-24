import type {
  NormalizedPlayerExternalVehicle,
  NormalizedPlayerStats,
} from './types.js'

export const THUNDERINSIGHTS_PARSER_VERSION = 'thunderinsights-v1'

const MAX_PROFILE_ROWS = 20
const MAX_UNIT_ROWS = 10_000

export class PlayerStatsSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlayerStatsSchemaError'
  }
}

export interface NormalizedThunderInsightsPayload {
  sourcePlayerId: string
  nick: string
  sourceUpdatedAt: number | null
  stats: NormalizedPlayerStats
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlayerStatsSchemaError(`${label} должен быть JSON-объектом`)
  }
  return value as Record<string, unknown>
}

function requiredText(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlayerStatsSchemaError(`${label}.${field} должен быть непустой строкой`)
  }
  return value.trim()
}

function optionalText(record: Record<string, unknown>, field: string, label: string): string | null {
  const value = record[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlayerStatsSchemaError(`${label}.${field} должен быть строкой или null`)
  }
  return value.trim()
}

function nullableMetric(record: Record<string, unknown>, field: string, label: string): number | null {
  const value = record[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PlayerStatsSchemaError(`${label}.${field} должен быть неотрицательным целым числом`)
  }
  return value
}

function userId(record: Record<string, unknown>, label: string): string {
  const value = record['userid']
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PlayerStatsSchemaError(`${label}.userid должен быть положительным целым числом`)
  }
  return String(value)
}

function sourceUpdatedAt(record: Record<string, unknown>, label: string): number | null {
  const value = record['last_update']
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    const timestamp = value
    return timestamp >= 10_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlayerStatsSchemaError(`${label}.last_update должен быть датой, Unix-временем или null`)
  }
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) {
    throw new PlayerStatsSchemaError(`${label}.last_update содержит некорректную дату`)
  }
  return Math.floor(timestampMs / 1_000)
}

function sameVehicle(
  left: NormalizedPlayerExternalVehicle,
  right: NormalizedPlayerExternalVehicle,
): boolean {
  return left.flyouts === right.flyouts
    && left.victories === right.victories
    && left.defeats === right.defeats
    && left.deaths === right.deaths
    && left.airKills === right.airKills
    && left.groundKills === right.groundKills
    && left.navalKills === right.navalKills
    && left.timePlayedSec === right.timePlayedSec
}

/**
 * Преобразует два документированных ответа ThunderInsights в стабильную DB-модель.
 * Account totals здесь намеренно пусты: текущий публичный контракт отдаёт unit rows,
 * а суммирование машин не эквивалентно статистике аккаунта.
 */
export function normalizeThunderInsightsPayload(
  profilePayload: unknown,
  unitsPayload: unknown,
  expectedUserId?: string,
): NormalizedThunderInsightsPayload {
  if (!Array.isArray(profilePayload) || profilePayload.length === 0) {
    throw new PlayerStatsSchemaError('ThunderInsights profile должен быть непустым массивом')
  }
  if (profilePayload.length > MAX_PROFILE_ROWS) {
    throw new PlayerStatsSchemaError(`ThunderInsights profile содержит больше ${MAX_PROFILE_ROWS} строк`)
  }
  const profiles = profilePayload.map((value, index) => {
    const record = objectValue(value, `profile[${index}]`)
    return {
      record,
      sourcePlayerId: userId(record, `profile[${index}]`),
      nick: requiredText(record, 'nick', `profile[${index}]`),
    }
  })
  const selected = expectedUserId === undefined
    ? profiles[0]
    : profiles.find((profile) => profile.sourcePlayerId === expectedUserId)
  if (selected === undefined) {
    throw new PlayerStatsSchemaError(`ThunderInsights profile не содержит userid ${expectedUserId}`)
  }

  if (!Array.isArray(unitsPayload)) {
    throw new PlayerStatsSchemaError('ThunderInsights units должен быть массивом')
  }
  if (unitsPayload.length > MAX_UNIT_ROWS) {
    throw new PlayerStatsSchemaError(`ThunderInsights units содержит больше ${MAX_UNIT_ROWS} строк`)
  }

  const vehiclesByKey = new Map<string, NormalizedPlayerExternalVehicle>()
  for (let index = 0; index < unitsPayload.length; index += 1) {
    const label = `units[${index}]`
    const record = objectValue(unitsPayload[index], label)
    const row: NormalizedPlayerExternalVehicle = {
      gameType: optionalText(record, 'type', label),
      mode: optionalText(record, 'gamemode', label),
      vehicleId: requiredText(record, 'name', label),
      flyouts: nullableMetric(record, 'spawns', label),
      victories: nullableMetric(record, 'victories', label),
      defeats: nullableMetric(record, 'defeats', label),
      deaths: nullableMetric(record, 'deaths', label),
      airKills: nullableMetric(record, 'air_kills', label),
      groundKills: nullableMetric(record, 'ground_kills', label),
      navalKills: nullableMetric(record, 'naval_kills', label),
      timePlayedSec: null,
    }
    const key = JSON.stringify([row.gameType, row.mode, row.vehicleId])
    const previous = vehiclesByKey.get(key)
    if (previous !== undefined && !sameVehicle(previous, row)) {
      throw new PlayerStatsSchemaError(`${label} конфликтует с другой строкой той же техники`)
    }
    vehiclesByKey.set(key, previous ?? row)
  }

  return {
    sourcePlayerId: selected.sourcePlayerId,
    nick: selected.nick,
    sourceUpdatedAt: sourceUpdatedAt(selected.record, 'profile'),
    stats: {
      totals: [],
      vehicles: [...vehiclesByKey.values()],
    },
  }
}
