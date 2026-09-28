import type { StatSharkBundle } from './statshark-client.js'
import type {
  NormalizedPlayerExternalTotal,
  NormalizedPlayerExternalVehicle,
  NormalizedPlayerStats,
} from './types.js'

export const STATSHARK_SOURCE = 'statshark'
/** v2: сводные бои и победы считаются по режимам, где известны оба числа. */
export const STATSHARK_PARSER_VERSION = 'statshark-v2'

const MODE_NAMES = ['arcade', 'realistic', 'simulator'] as const
const PROFILE_MODE_KEYS = ['arcade', 'rb', 'sim'] as const
const LEADERBOARD_MODE_KEYS = ['arcade', 'historical', 'simulation'] as const

type JsonRecord = Record<string, unknown>

export interface NormalizedStatSharkBundle {
  playerId: string
  nick: string
  sourceUpdatedAt: number | null
  stats: NormalizedPlayerStats
}

export class StatSharkSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StatSharkSchemaError'
  }
}

function record(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StatSharkSchemaError(`StatShark: ${field} должен быть объектом`)
  }
  return value as JsonRecord
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function playerId(value: unknown, field: string): string {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (!/^\d+$/.test(normalized)) {
    throw new StatSharkSchemaError(`StatShark: ${field} должен содержать числовой id`)
  }
  return normalized
}

function requiredText(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized === '') throw new StatSharkSchemaError(`StatShark: ${field} пуст`)
  return normalized
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

function metric(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StatSharkSchemaError(`StatShark: ${field} должен быть неотрицательным целым числом`)
  }
  return parsed
}

function sum(values: readonly (number | null)[]): number | null {
  return values.every((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

function defeats(battles: number | null, victories: number | null, field: string): number | null {
  if (battles === null || victories === null) return null
  if (victories > battles) {
    throw new StatSharkSchemaError(`StatShark: ${field} содержит побед больше, чем боёв`)
  }
  return battles - victories
}

function leaderboardMetric(
  profile: JsonRecord,
  mode: string,
  name: string,
): number | null {
  const leaderboard = optionalRecord(profile['Leaderboard'])
  const modeStats = optionalRecord(leaderboard?.[mode])
  const total = optionalRecord(modeStats?.['value_total'])
  const wrapped = optionalRecord(total?.[name])
  return metric(wrapped?.['value_total'] ?? null, `Profile.Leaderboard.${mode}.${name}`)
}

function profileTotal(
  profile: JsonRecord,
  profileMode: string,
  leaderboardMode: string,
  mode: string,
  category: 'pvp' | 'skirmish',
): NormalizedPlayerExternalTotal | null {
  const modeStats = optionalRecord(profile[profileMode])
  if (modeStats === null) return null
  const sourceKey = category === 'pvp' ? 'pvp_played' : 'skirmish_played'
  const values = optionalRecord(modeStats[sourceKey])
  if (values === null) return null

  const battles = metric(values['games'], `Profile.${profileMode}.${sourceKey}.games`)
  const victories = metric(values['wins'], `Profile.${profileMode}.${sourceKey}.wins`)
  return {
    gameType: 'all',
    mode,
    category,
    battles,
    victories,
    defeats: defeats(battles, victories, `Profile.${profileMode}.${sourceKey}`),
    deaths: category === 'pvp' ? leaderboardMetric(profile, leaderboardMode, 'deaths') : null,
    timePlayedSec: metric(
      values['timePlayed'],
      `Profile.${profileMode}.${sourceKey}.timePlayed`,
    ),
    respawns: metric(values['respawns'], `Profile.${profileMode}.${sourceKey}.respawns`),
    airKills: metric(values['airKillsP'], `Profile.${profileMode}.${sourceKey}.airKillsP`),
    groundKills: metric(
      values['groundKillsP'],
      `Profile.${profileMode}.${sourceKey}.groundKillsP`,
    ),
    navalKills: metric(
      values['navalKillsP'],
      `Profile.${profileMode}.${sourceKey}.navalKillsP`,
    ),
  }
}

function vehicleGameType(vehicleInfo: JsonRecord, vehicleId: string): string | null {
  const info = optionalRecord(vehicleInfo[vehicleId])
  return optionalText(info?.['unitClass']) ?? optionalText(info?.['unitMoveType'])
}

function vehicleRows(profileRoot: JsonRecord, vehicleInfo: JsonRecord): NormalizedPlayerExternalVehicle[] {
  const rawModes = profileRoot['Vehicles']
  if (!Array.isArray(rawModes)) {
    throw new StatSharkSchemaError('StatShark: Vehicles должен быть массивом режимов')
  }

  const result: NormalizedPlayerExternalVehicle[] = []
  const seen = new Set<string>()
  for (let modeIndex = 0; modeIndex < MODE_NAMES.length; modeIndex += 1) {
    const mode = MODE_NAMES[modeIndex]!
    const modeRows = rawModes[modeIndex]
    if (modeRows === undefined || modeRows === null) continue
    if (!Array.isArray(modeRows)) {
      throw new StatSharkSchemaError(`StatShark: Vehicles[${modeIndex}] должен быть массивом`)
    }
    for (let rowIndex = 0; rowIndex < modeRows.length; rowIndex += 1) {
      const row = modeRows[rowIndex]
      if (!Array.isArray(row)) {
        throw new StatSharkSchemaError(
          `StatShark: Vehicles[${modeIndex}][${rowIndex}] должен быть массивом`,
        )
      }
      const vehicleId = requiredText(row[15], `Vehicles[${modeIndex}][${rowIndex}][15]`)
      const key = `${modeIndex}\u0000${vehicleId}`
      if (seen.has(key)) {
        throw new StatSharkSchemaError(
          `StatShark: повторная машина ${vehicleId} в режиме ${MODE_NAMES[modeIndex]}`,
        )
      }
      seen.add(key)

      const battles = metric(row[4], `Vehicles[${modeIndex}][${rowIndex}][4]`)
      const victories = metric(row[3], `Vehicles[${modeIndex}][${rowIndex}][3]`)
      result.push({
        gameType: vehicleGameType(vehicleInfo, vehicleId),
        mode,
        vehicleId,
        // StatShark называет поле [6] respawns; в нашей vehicle-схеме этому
        // соответствует число выходов на машине.
        flyouts: metric(row[6], `Vehicles[${modeIndex}][${rowIndex}][6]`),
        victories,
        defeats: defeats(
          battles,
          victories,
          `Vehicles[${modeIndex}][${rowIndex}]`,
        ),
        deaths: metric(row[7], `Vehicles[${modeIndex}][${rowIndex}][7]`),
        airKills: metric(row[8], `Vehicles[${modeIndex}][${rowIndex}][8]`),
        groundKills: metric(row[9], `Vehicles[${modeIndex}][${rowIndex}][9]`),
        navalKills: metric(row[10], `Vehicles[${modeIndex}][${rowIndex}][10]`),
        timePlayedSec: null,
      })
    }
  }
  return result
}

function updatedAt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new StatSharkSchemaError('StatShark: Basics.lastupdate должен быть строкой')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new StatSharkSchemaError('StatShark: Basics.lastupdate содержит неверную дату')
  }
  return Math.floor(milliseconds / 1_000)
}

/**
 * Нормализует только опубликованные текущие значения. Истории leaderboard и
 * vehicle diff остаются в raw_json snapshot-а и не складываются с текущими
 * итогами повторно.
 */
export function normalizeStatSharkBundle(bundle: StatSharkBundle): NormalizedStatSharkBundle {
  const profileRoot = record(bundle.profile, 'profile')
  const basics = record(profileRoot['Basics'], 'Basics')
  const profile = record(profileRoot['Profile'], 'Profile')
  const vehicleInfo = record(bundle.vehicleInfo, 'vehicleInfo')
  const requestedId = playerId(bundle.playerId, 'playerId')
  const actualId = playerId(basics['uid'], 'Basics.uid')
  if (actualId !== requestedId) {
    throw new StatSharkSchemaError(
      `StatShark: запрошен игрок ${requestedId}, но ответ относится к ${actualId}`,
    )
  }

  const totals: NormalizedPlayerExternalTotal[] = []
  const pvpTotals: NormalizedPlayerExternalTotal[] = []
  for (let index = 0; index < MODE_NAMES.length; index += 1) {
    const profileMode = PROFILE_MODE_KEYS[index]!
    const leaderboardMode = LEADERBOARD_MODE_KEYS[index]!
    const mode = MODE_NAMES[index]!
    const pvp = profileTotal(
      profile,
      profileMode,
      leaderboardMode,
      mode,
      'pvp',
    )
    if (pvp !== null) {
      totals.push(pvp)
      pvpTotals.push(pvp)
    }
    const skirmish = profileTotal(
      profile,
      profileMode,
      leaderboardMode,
      mode,
      'skirmish',
    )
    if (skirmish !== null) totals.push(skirmish)
  }
  if (pvpTotals.length === 0) {
    throw new StatSharkSchemaError('StatShark: не найдены PvP-итоги ни одного режима')
  }

  // Бои и победы — только по режимам, где известны оба числа: иначе сводный
  // win rate делил бы победы одних режимов на бои других.
  const paired = pvpTotals.filter((row) => row.battles !== null && row.victories !== null)
  const battles = sum(paired.map((row) => row.battles))
  const victories = sum(paired.map((row) => row.victories))
  totals.unshift({
    gameType: null,
    mode: null,
    category: null,
    battles,
    victories,
    defeats: defeats(battles, victories, 'сводный PvP итог'),
    deaths: sum(pvpTotals.map((row) => row.deaths)),
    timePlayedSec: sum(pvpTotals.map((row) => row.timePlayedSec)),
    respawns: sum(pvpTotals.map((row) => row.respawns)),
    airKills: sum(pvpTotals.map((row) => row.airKills)),
    groundKills: sum(pvpTotals.map((row) => row.groundKills)),
    navalKills: sum(pvpTotals.map((row) => row.navalKills)),
  })

  return {
    playerId: actualId,
    nick: requiredText(basics['nickname'], 'Basics.nickname'),
    sourceUpdatedAt: updatedAt(basics['lastupdate']),
    stats: {
      totals,
      vehicles: vehicleRows(profileRoot, vehicleInfo),
    },
  }
}
