import type {
  NormalizedPlayerExternalTotal,
  NormalizedPlayerExternalVehicle,
  NormalizedPlayerStats,
} from './types.js'

const MAX_MESSAGE_FIELDS = 8_192
const MAX_NESTING_DEPTH = 8
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

type WireValue = bigint | Uint8Array

interface WireField {
  fieldNumber: number
  wireType: number
  value: WireValue
}

interface Cursor {
  offset: number
}

interface BattleTypeMapping {
  gameType: string | null
  mode: string
}

export interface CompanionProfile {
  userId: string
  nick: string
  title: string | null
  clanTag: string | null
  level: number | null
  stats: NormalizedPlayerStats
}

const BATTLE_TYPES: Readonly<Record<number, BattleTypeMapping>> = {
  0: { gameType: null, mode: 'arcade' },
  1: { gameType: null, mode: 'realistic' },
  2: { gameType: null, mode: 'simulation' },
  3: { gameType: 'ground', mode: 'arcade' },
  4: { gameType: 'ground', mode: 'realistic' },
  5: { gameType: 'air', mode: 'arcade' },
  6: { gameType: 'air', mode: 'realistic' },
  7: { gameType: 'naval', mode: 'arcade' },
  8: { gameType: 'naval', mode: 'realistic' },
  9: { gameType: 'ground', mode: 'simulation' },
  10: { gameType: 'air', mode: 'simulation' },
  11: { gameType: 'naval', mode: 'simulation' },
}

class CompanionProfileSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanionProfileSchemaError'
  }
}

export class CompanionProfileAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanionProfileAuthError'
  }
}

function readVarint(bytes: Uint8Array, cursor: Cursor, label: string): bigint {
  let value = 0n
  for (let index = 0; index < 10; index += 1) {
    if (cursor.offset >= bytes.length) {
      throw new CompanionProfileSchemaError(`${label}: varint оборван`)
    }
    const byte = bytes[cursor.offset++]!
    value |= BigInt(byte & 0x7f) << BigInt(index * 7)
    if ((byte & 0x80) === 0) {
      if (index === 9 && byte > 1) {
        throw new CompanionProfileSchemaError(`${label}: varint переполнен`)
      }
      return value
    }
  }
  throw new CompanionProfileSchemaError(`${label}: varint слишком длинный`)
}

function readBytes(bytes: Uint8Array, cursor: Cursor, length: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - cursor.offset) {
    throw new CompanionProfileSchemaError(`${label}: длина выходит за границы ответа`)
  }
  const value = bytes.slice(cursor.offset, cursor.offset + length)
  cursor.offset += length
  return value
}

function readMessage(bytes: Uint8Array, label: string, depth: number): WireField[] {
  if (depth > MAX_NESTING_DEPTH) {
    throw new CompanionProfileSchemaError(`${label}: слишком глубокая protobuf-структура`)
  }
  const cursor: Cursor = { offset: 0 }
  const fields: WireField[] = []
  while (cursor.offset < bytes.length) {
    if (fields.length >= MAX_MESSAGE_FIELDS) {
      throw new CompanionProfileSchemaError(`${label}: слишком много protobuf-полей`)
    }
    const key = readVarint(bytes, cursor, `${label}.key`)
    const fieldNumber = Number(key >> 3n)
    const wireType = Number(key & 7n)
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) {
      throw new CompanionProfileSchemaError(`${label}: неверный номер protobuf-поля`)
    }
    let value: WireValue
    if (wireType === 0) {
      value = readVarint(bytes, cursor, `${label}.${fieldNumber}`)
    } else if (wireType === 1) {
      value = readBytes(bytes, cursor, 8, `${label}.${fieldNumber}`)
    } else if (wireType === 2) {
      const length = readVarint(bytes, cursor, `${label}.${fieldNumber}.length`)
      if (length > BigInt(bytes.length - cursor.offset) || length > MAX_SAFE_BIGINT) {
        throw new CompanionProfileSchemaError(`${label}.${fieldNumber}: неверная длина`)
      }
      value = readBytes(bytes, cursor, Number(length), `${label}.${fieldNumber}`)
    } else if (wireType === 5) {
      value = readBytes(bytes, cursor, 4, `${label}.${fieldNumber}`)
    } else {
      throw new CompanionProfileSchemaError(`${label}.${fieldNumber}: wire type ${wireType} не поддержан`)
    }
    fields.push({ fieldNumber, wireType, value })
  }
  return fields
}

function field(fields: readonly WireField[], fieldNumber: number): WireField | null {
  return fields.find((candidate) => candidate.fieldNumber === fieldNumber) ?? null
}

function repeatedFields(fields: readonly WireField[], fieldNumber: number): WireField[] {
  return fields.filter((candidate) => candidate.fieldNumber === fieldNumber)
}

function bytesValue(value: WireValue, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CompanionProfileSchemaError(`${label}: ожидался length-delimited field`)
  }
  return value
}

function integerValue(value: WireValue | null, label: string): number | null {
  if (value === null || typeof value !== 'bigint') return null
  if (value > MAX_SAFE_BIGINT) {
    throw new CompanionProfileSchemaError(`${label}: число не помещается в safe integer`)
  }
  return Number(value)
}

function integerField(fields: readonly WireField[], fieldNumber: number, label: string): number | null {
  return integerValue(field(fields, fieldNumber)?.value ?? null, `${label}.${fieldNumber}`)
}

function stringField(
  fields: readonly WireField[],
  fieldNumber: number,
  label: string,
  required = false,
): string | null {
  const raw = field(fields, fieldNumber)
  if (raw === null) {
    if (required) throw new CompanionProfileSchemaError(`${label}.${fieldNumber}: поле отсутствует`)
    return null
  }
  const value = Buffer.from(bytesValue(raw.value, `${label}.${fieldNumber}`)).toString('utf8').trim()
  if (required && value === '') {
    throw new CompanionProfileSchemaError(`${label}.${fieldNumber}: строка пустая`)
  }
  return value || null
}

function stringOrIntegerField(
  fields: readonly WireField[],
  fieldNumber: number,
  label: string,
): string | null {
  const raw = field(fields, fieldNumber)
  if (raw === null) return null
  if (typeof raw.value === 'bigint') {
    const value = integerValue(raw.value, `${label}.${fieldNumber}`)
    return value === null ? null : String(value)
  }
  return Buffer.from(raw.value).toString('utf8').trim() || null
}

function nestedField(
  fields: readonly WireField[],
  fieldNumber: number,
  label: string,
  depth: number,
): WireField[] | null {
  const raw = field(fields, fieldNumber)
  return raw === null ? null : readMessage(bytesValue(raw.value, `${label}.${fieldNumber}`), `${label}.${fieldNumber}`, depth + 1)
}

function defeats(battles: number | null, victories: number | null): number | null {
  return battles !== null && victories !== null && victories <= battles
    ? battles - victories
    : null
}

function sumFields(
  fields: readonly WireField[],
  fieldNumbers: readonly number[],
  label: string,
): number | null {
  const values = fieldNumbers
    .map((fieldNumber) => integerField(fields, fieldNumber, label))
    .filter((value): value is number => value !== null)
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
}

function sumMetrics(
  totals: readonly NormalizedPlayerExternalTotal[],
  selector: (total: NormalizedPlayerExternalTotal) => number | null,
): number | null {
  const values = totals.map(selector).filter((value): value is number => value !== null)
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
}

function parseCommonTotals(fields: readonly WireField[]): NormalizedPlayerExternalTotal[] {
  const totals: NormalizedPlayerExternalTotal[] = []
  for (const [index, raw] of repeatedFields(fields, 6).entries()) {
    const item = readMessage(bytesValue(raw.value, `common_statistic[${index}]`), `common_statistic[${index}]`, 1)
    const mapping = BATTLE_TYPES[integerField(item, 1, `common_statistic[${index}]`) ?? -1]
    if (mapping === undefined) continue
    const pvp = nestedField(item, 2, `common_statistic[${index}]`, 1)
    if (pvp === null) continue
    const battles = integerField(pvp, 12, `common_statistic[${index}].pvp`)
    const victories = integerField(pvp, 1, `common_statistic[${index}].pvp`)
    totals.push({
      gameType: mapping.gameType,
      mode: mapping.mode,
      category: 'all',
      battles,
      victories,
      defeats: defeats(battles, victories),
      deaths: integerField(item, 9, `common_statistic[${index}]`),
      timePlayedSec: sumFields(
        pvp,
        [2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 18, 19],
        `common_statistic[${index}].pvp`,
      ),
      respawns: null,
      airKills: integerField(pvp, 10, `common_statistic[${index}].pvp`),
      groundKills: integerField(pvp, 9, `common_statistic[${index}].pvp`),
      navalKills: integerField(pvp, 20, `common_statistic[${index}].pvp`),
    })
  }
  const general = totals.filter((total) => total.gameType === null)
  if (general.length > 0) {
    const battles = sumMetrics(general, (total) => total.battles)
    const victories = sumMetrics(general, (total) => total.victories)
    totals.unshift({
      gameType: null,
      mode: null,
      category: null,
      battles,
      victories,
      defeats: defeats(battles, victories),
      deaths: sumMetrics(general, (total) => total.deaths),
      timePlayedSec: sumMetrics(general, (total) => total.timePlayedSec),
      respawns: null,
      airKills: sumMetrics(general, (total) => total.airKills),
      groundKills: sumMetrics(general, (total) => total.groundKills),
      navalKills: sumMetrics(general, (total) => total.navalKills),
    })
  }
  return totals
}

function parseVehicles(fields: readonly WireField[]): NormalizedPlayerExternalVehicle[] {
  const vehicles: NormalizedPlayerExternalVehicle[] = []
  for (const [index, raw] of repeatedFields(fields, 10).entries()) {
    const item = readMessage(bytesValue(raw.value, `battle_list[${index}]`), `battle_list[${index}]`, 1)
    const mapping = BATTLE_TYPES[integerField(item, 1, `battle_list[${index}]`) ?? -1]
    const vehicleId = stringOrIntegerField(item, 11, `battle_list[${index}]`)
    if (mapping === undefined || vehicleId === null) continue
    const battles = integerField(item, 3, `battle_list[${index}]`)
    const victories = integerField(item, 2, `battle_list[${index}]`)
    vehicles.push({
      gameType: mapping.gameType,
      mode: mapping.mode,
      vehicleId,
      flyouts: integerField(item, 6, `battle_list[${index}]`),
      victories,
      defeats: defeats(battles, victories),
      deaths: integerField(item, 5, `battle_list[${index}]`),
      airKills: integerField(item, 7, `battle_list[${index}]`),
      groundKills: integerField(item, 8, `battle_list[${index}]`),
      navalKills: integerField(item, 12, `battle_list[${index}]`),
      timePlayedSec: null,
    })
  }
  return vehicles
}

export function decodeCompanionProfile(
  rawBytes: Uint8Array,
  requestedUserId: string,
): CompanionProfile {
  if (rawBytes.byteLength === 0) throw new CompanionProfileSchemaError('профиль companion пуст')
  const root = readMessage(rawBytes, 'profile', 0)
  const first = field(root, 1)
  if (first?.wireType === 0) {
    const message = stringField(root, 2, 'error') ?? 'companion вернул ошибку авторизации'
    if (/login|auth|session/i.test(message)) throw new CompanionProfileAuthError(message)
    throw new CompanionProfileSchemaError(message)
  }

  const base = nestedField(root, 1, 'profile', 0)
  if (base === null) throw new CompanionProfileSchemaError('profile.1: базовая информация отсутствует')
  const nick = stringField(base, 2, 'profile.base', true)
  if (nick === null) throw new CompanionProfileSchemaError('profile.base.2: ник отсутствует')
  const level = nestedField(root, 2, 'profile', 0)
  const stats = parseCommonTotals(root)
  const vehicles = parseVehicles(root)
  if (stats.length === 0 && vehicles.length === 0) {
    throw new CompanionProfileSchemaError('profile: не найдены статистические строки')
  }
  return {
    userId: requestedUserId,
    nick,
    title: stringField(base, 4, 'profile.base'),
    clanTag: stringField(base, 6, 'profile.base'),
    level: level === null ? null : integerField(level, 1, 'profile.level'),
    stats: {
      totals: stats,
      vehicles,
    },
  }
}
