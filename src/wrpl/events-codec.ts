import { constants, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { MAX_EVENTS_BLOB_BYTES } from './decompression-limits.js'

/**
 * Хранение событий боя (battle_events.events_blob).
 *
 * 99% JSON событий — траектории юнитов: точки {t, x, y, z} с целыми
 * миллисекундами и метрами, у построек одна и та же точка десятки раз подряд.
 * Колоночный формат (октябрь 2026) хранит каждую траекторию четырьмя
 * массивами разностей соседних значений и сжимает документ zstd-19: на
 * выборке 500 боёв 70 → 20 КиБ на бой против zstd-JSON, сжатие 230 → 35 мс,
 * чтение 2,7 → 1,1 мс (docs/database.md). Остальные поля не меняются.
 *
 * Блоб: 'WTEV', байт версии, zstd-кадр JSON документа, где у подходящих
 * юнитов path — объект {t, x, y, z} массивов: первое значение как есть, дальше
 * разности. Траектория подходит, если каждая точка — ровно ключи t, x, y, z
 * в этом порядке и целые |v| < 2^40: разности и их суммы тогда точны. Запись
 * проверяет блоб: восстановленный JSON обязан совпасть с исходным байт в байт,
 * иначе пишется zstd-JSON. Поэтому формат не теряет данных ни на каком входе.
 *
 * Читаются все форматы: колоночный, zstd-JSON (октябрь 2026, до колоночного)
 * и gzip (до октября 2026); старые переводит фоновая задача
 * (db/maintenance.ts). Образ бота без колоночного формата такие блобы не
 * прочитает: ошибка «Неизвестный формат events_blob», а не мусор на карте.
 */
export const EVENTS_ZSTD_LEVEL = 19

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const
/** 'WTEV' + версия колоночного формата. */
const COLUMNAR_HEADER = Buffer.from([0x57, 0x54, 0x45, 0x56, 0x01])
/** Предел |значения| координаты или времени: суммы разностей остаются точными. */
const COLUMNAR_VALUE_LIMIT = 2 ** 40
/**
 * Предел точек на бой при восстановлении: самая короткая точка в JSON —
 * `{"t":0,"x":0,"y":0,"z":0},` (26 байт), так что колоночный блоб не
 * разворачивается больше прежнего предела распаковки JSON.
 */
const MAX_COLUMNAR_POINTS = Math.floor(MAX_EVENTS_BLOB_BYTES / 26)

type TrajectoryPoint = { t: number; x: number; y: number; z: number }
type TrajectoryColumns = { t: number[]; x: number[]; y: number[]; z: number[] }

export function isZstdEventsBlob(blob: Uint8Array): boolean {
  return blob.byteLength >= 4 && ZSTD_MAGIC.every((byte, index) => blob[index] === byte)
}

export function isGzipEventsBlob(blob: Uint8Array): boolean {
  return blob.byteLength >= 2 && blob[0] === 0x1f && blob[1] === 0x8b
}

export function isColumnarEventsBlob(blob: Uint8Array): boolean {
  return blob.byteLength > COLUMNAR_HEADER.byteLength && COLUMNAR_HEADER.every((byte, index) => blob[index] === byte)
}

function zstd(data: Buffer): Buffer {
  return zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: EVENTS_ZSTD_LEVEL } })
}

/** JSON событий → zstd-JSON (запасной формат). Вызывать только в worker thread: это CPU-heavy. */
export function compressEventsJson(json: Buffer): Buffer {
  return zstd(json)
}

/**
 * JSON событий (ровно то, что раньше хранилось, — JSON.stringify payload) →
 * блоб: колоночный, если его восстановление совпало с json байт в байт,
 * иначе zstd-JSON. Вызывать только в worker thread: это CPU-heavy.
 */
export function encodeEventsJson(json: string): Buffer {
  try {
    const columnar = toColumnarDocument(JSON.parse(json) as unknown)
    if (columnar !== null) {
      const packed = zstd(Buffer.from(JSON.stringify(columnar), 'utf8'))
      const blob = Buffer.concat([COLUMNAR_HEADER, packed])
      if (JSON.stringify(decodeEventsPayload(blob)) === json) return blob
    }
  } catch {
    // Любой сбой колоночного пути (необычный вход) — запись прежним форматом.
  }
  return compressEventsJson(Buffer.from(json, 'utf8'))
}

export interface EventsDecodeProfile {
  inflateMs: number
  utf8Ms: number
  jsonParseMs: number
  /** Сборка точек траекторий из колонок (0 у zstd-JSON и gzip). */
  restoreMs: number
}

/** Блоб любого формата → объект событий в исходном виде. */
export function decodeEventsPayload(blob: Uint8Array): unknown {
  return decodeEventsPayloadProfiled(blob).payload
}

export function decodeEventsPayloadProfiled(blob: Uint8Array): { payload: unknown; profile: EventsDecodeProfile } {
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  let started = performance.now()
  const columnar = isColumnarEventsBlob(view)
  const raw = inflateRaw(view, columnar)
  const inflateMs = performance.now() - started

  started = performance.now()
  const text = raw.toString('utf8')
  const utf8Ms = performance.now() - started

  started = performance.now()
  const parsed = JSON.parse(text) as unknown
  const jsonParseMs = performance.now() - started

  started = performance.now()
  const payload = columnar ? fromColumnarDocument(parsed) : parsed
  return { payload, profile: { inflateMs, utf8Ms, jsonParseMs, restoreMs: performance.now() - started } }
}

/**
 * Блоб любого формата → JSON событий байт в байт таким, каким его отдал
 * JSON.stringify при записи: хэши корпуса реплеев и перевод форматов. Для
 * чтения событий дешевле decodeEventsPayload — без лишней сериализации.
 */
export function inflateEventsBlob(blob: Uint8Array): Buffer {
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (!isColumnarEventsBlob(view)) return inflateRaw(view, false)
  return Buffer.from(JSON.stringify(decodeEventsPayload(view)), 'utf8')
}

function inflateRaw(view: Buffer, columnar: boolean): Buffer {
  const limit = { maxOutputLength: MAX_EVENTS_BLOB_BYTES }
  if (columnar) return zstdDecompressSync(view.subarray(COLUMNAR_HEADER.byteLength), limit)
  if (isZstdEventsBlob(view)) return zstdDecompressSync(view, limit)
  if (isGzipEventsBlob(view)) return gunzipSync(view, limit)
  throw new Error('Неизвестный формат events_blob: ни колоночный, ни zstd, ни gzip')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isColumnarValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) < COLUMNAR_VALUE_LIMIT
}

function isTrajectory(path: unknown): path is TrajectoryPoint[] {
  if (!Array.isArray(path) || path.length === 0) return false
  for (const point of path) {
    if (!isRecord(point)) return false
    const keys = Object.keys(point)
    if (keys.length !== 4 || keys[0] !== 't' || keys[1] !== 'x' || keys[2] !== 'y' || keys[3] !== 'z') return false
    if (!isColumnarValue(point['t']) || !isColumnarValue(point['x'])) return false
    if (!isColumnarValue(point['y']) || !isColumnarValue(point['z'])) return false
  }
  return true
}

function deltas(path: readonly TrajectoryPoint[], key: keyof TrajectoryPoint): number[] {
  const out = new Array<number>(path.length)
  let previous = 0
  for (let index = 0; index < path.length; index += 1) {
    const value = path[index]![key]
    out[index] = value - previous
    previous = value
  }
  return out
}

/** null — нет ни одной подходящей траектории: колоночный формат ничего не даст. */
function toColumnarDocument(document: unknown): unknown {
  if (!isRecord(document) || !Array.isArray(document['units'])) return null
  let converted = 0
  const units = document['units'].map((unit: unknown) => {
    if (!isRecord(unit) || !isTrajectory(unit['path'])) return unit
    converted += 1
    const path = unit['path']
    const columns: TrajectoryColumns = {
      t: deltas(path, 't'),
      x: deltas(path, 'x'),
      y: deltas(path, 'y'),
      z: deltas(path, 'z'),
    }
    // Spread сохраняет порядок ключей юнита: path остаётся на своём месте.
    return { ...unit, path: columns }
  })
  return converted > 0 ? { ...document, units } : null
}

function corrupted(reason: string): Error {
  return new Error(`Повреждённый колоночный events_blob: ${reason}`)
}

/** Разность из колонки: только целое число, иначе блоб повреждён. */
function columnDelta(column: readonly unknown[], index: number): number {
  const value = column[index]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw corrupted('разность — не целое число')
  return value
}

function fromColumnarDocument(document: unknown): unknown {
  if (!isRecord(document) || !Array.isArray(document['units'])) throw corrupted('нет массива units')
  let points = 0
  for (const unit of document['units'] as unknown[]) {
    // Колонки — только объект; массив точек (неподходящая траектория) и
    // любое иное значение path записаны как были.
    if (!isRecord(unit) || !isRecord(unit['path'])) continue
    const { t, x, y, z } = unit['path']
    if (!Array.isArray(t) || !Array.isArray(x) || !Array.isArray(y) || !Array.isArray(z)) {
      throw corrupted('колонки траектории — не массивы')
    }
    const length = t.length
    if (length === 0 || x.length !== length || y.length !== length || z.length !== length) {
      throw corrupted('колонки траектории разной длины')
    }
    points += length
    if (points > MAX_COLUMNAR_POINTS) throw corrupted(`больше ${MAX_COLUMNAR_POINTS} точек`)
    const path = new Array<TrajectoryPoint>(length)
    let tv = 0
    let xv = 0
    let yv = 0
    let zv = 0
    for (let index = 0; index < length; index += 1) {
      tv += columnDelta(t, index)
      xv += columnDelta(x, index)
      yv += columnDelta(y, index)
      zv += columnDelta(z, index)
      if (!isColumnarValue(tv) || !isColumnarValue(xv) || !isColumnarValue(yv) || !isColumnarValue(zv)) {
        throw corrupted('значение точки вне диапазона')
      }
      path[index] = { t: tv, x: xv, y: yv, z: zv }
    }
    unit['path'] = path
  }
  return document
}
