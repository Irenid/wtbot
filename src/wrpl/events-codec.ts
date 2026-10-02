import { constants, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { MAX_EVENTS_BLOB_BYTES } from './decompression-limits.js'

/**
 * Сжатие JSON событий боя (battle_events.events_blob).
 *
 * До октября 2026 блоб был gzip; zstd-19 на тех же данных на 47% меньше
 * и распаковывается вдвое быстрее (0,4 мс против 0,8 мс на бой, замеры —
 * docs/database.md). Сжатие на 19-м уровне дорогое (~170 мс на бой), но идёт
 * в worker один раз при ingest. Формат читается по магическим байтам: старые
 * gzip-блобы переводятся в zstd фоновой задачей (db-maintenance.ts), до этого
 * оба формата живут рядом.
 */
export const EVENTS_ZSTD_LEVEL = 19

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const

export function isZstdEventsBlob(blob: Uint8Array): boolean {
  return blob.byteLength >= 4 && ZSTD_MAGIC.every((byte, index) => blob[index] === byte)
}

export function isGzipEventsBlob(blob: Uint8Array): boolean {
  return blob.byteLength >= 2 && blob[0] === 0x1f && blob[1] === 0x8b
}

/** JSON событий → блоб для БД. Вызывать только в worker thread: это CPU-heavy. */
export function compressEventsJson(json: Buffer): Buffer {
  return zstdCompressSync(json, { params: { [constants.ZSTD_c_compressionLevel]: EVENTS_ZSTD_LEVEL } })
}

/** Блоб из БД (zstd или прежний gzip) → JSON с пределом размера распаковки. */
export function inflateEventsBlob(blob: Uint8Array): Buffer {
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (isZstdEventsBlob(view)) return zstdDecompressSync(view, { maxOutputLength: MAX_EVENTS_BLOB_BYTES })
  if (isGzipEventsBlob(view)) return gunzipSync(view, { maxOutputLength: MAX_EVENTS_BLOB_BYTES })
  throw new Error('Неизвестный формат events_blob: ни zstd, ни gzip')
}
