import { BitReader } from './bit-reader.js'

/**
 * Пакетный поток реплея .wrpl — порт wrpl-inspector/wrpl/packet и
 * wrpl/idfieldserializer (AGPL-3.0).
 *
 * Поток (после распаковки zlib, см. replay-events.ts) — цепочка пакетов:
 * varint-размер, байт типа (бит 0x10 — «время не менялось»), u32 время в мс
 * (если бит не выставлен), полезная нагрузка. Типы: 2 — обновления
 * лётных моделей, 3 — чат, 4 — MPI-сообщения (слоты игроков, убийства,
 * повреждения, позиции наземки), 5 — конец сегмента, 6 — ECS.
 */

export interface RawPacket {
  seq: number
  time: number
  type: number
  payload: Buffer
}

/** Префикс переменной длины (1–5 байт) перед каждым пакетом */
function readVariableLengthSize(buf: Buffer, pos: number): { size: number; next: number } | null {
  if (pos >= buf.length) return null
  const first = buf[pos]!
  if (first & 0x80) {
    if ((first & 0x40) === 0) return { size: first & 0x7f, next: pos + 1 }
    throw new Error(`неверный первый байт префикса размера: 0x${first.toString(16)}`)
  }
  if (first & 0x40) {
    if (pos + 2 > buf.length) return null
    return { size: ((first << 8) | buf[pos + 1]!) ^ 0x4000, next: pos + 2 }
  }
  if (first & 0x20) {
    if (pos + 3 > buf.length) return null
    return { size: ((first << 16) | (buf[pos + 1]! << 8) | buf[pos + 2]!) ^ 0x200000, next: pos + 3 }
  }
  if (first & 0x10) {
    if (pos + 4 > buf.length) return null
    return {
      size: ((first << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) ^ 0x10000000,
      next: pos + 4,
    }
  }
  if (pos + 5 > buf.length) return null
  return { size: buf.readUInt32LE(pos + 1), next: pos + 5 }
}

/** Итератор пакетов распакованного потока; seq продолжается с startSeq */
export function* iteratePackets(stream: Buffer, startSeq = 0): Generator<RawPacket> {
  let pos = 0
  let time = 0
  let seq = startSeq
  for (;;) {
    const vls = readVariableLengthSize(stream, pos)
    if (vls === null) return
    pos = vls.next
    if (vls.size === 0) continue

    if (pos + 2 > stream.length) return
    const h0 = stream[pos]!
    let type: number
    let payloadSize: number
    if (h0 & 0b0001_0000) {
      type = h0 ^ 0b0001_0000
      payloadSize = vls.size - 2
      pos += 2
    } else {
      type = h0
      if (pos + 6 > stream.length) return
      time = stream.readUInt32LE(pos + 2)
      payloadSize = vls.size - 6
      pos += 6
    }
    if (payloadSize < 0) return
    if (pos + payloadSize > stream.length) return
    const payload = stream.subarray(pos, pos + payloadSize)
    pos += payloadSize
    yield { seq: seq++, time, type, payload }
  }
}

/** Сущность ECS: упакованный id → индекс (см. packet.ReadEID в Go) */
export function readEID(r: BitReader): number {
  const first16 = r.readU16()
  if (first16 & 1) {
    return (first16 >>> 2) | (((first16 & 2) >>> 1) << 22)
  }
  if (first16 & 2) {
    const gen = r.readByte()
    return (first16 >>> 2) | (gen << 22)
  }
  const second16 = r.readU16()
  const ret = second16 * 0x10000 + first16
  return ((ret & 0x00ffffff) >>> 2) | ((ret >>> 24) & 0xff) * 2 ** 22
}

/** Размер поля в битах: 3-битный код или varint (idfieldserializer.ReadSize) */
function readFieldSize(r: BitReader): number {
  const hdr = r.readBits(3)[0]!
  switch (hdr) {
    case 1: return 1
    case 2: return 8
    case 3: return 16
    case 4: return 32
    case 5: return 64
    case 6: return 96
    case 7: return 128
  }
  return r.readCompressed()
}

/** Возврат из колбэка: поле незнакомо, пропустить по известному размеру */
export const SKIP_FIELD = Symbol('skip')

/**
 * IdFieldSerializer32: до 32 полей, битовая маска присутствия.
 * Колбэк читает поле из r; вернул SKIP_FIELD — поле пропускается.
 */
export function deserializeIdFields32(
  r: BitReader,
  fieldReader: (fieldNum: number) => typeof SKIP_FIELD | void,
): void {
  const start = r.bitOffset
  if (start & 7) throw new Error('IdFieldSerializer32 не выровнен по байту')
  const offset = r.readU16()
  let fields = r.readCompressed()
  const startBody = r.bitOffset

  // Кол-во установленных бит = число полей; их размеры лежат по offset
  let count = 0
  for (let f = fields; f > 0; f >>>= 1) count += f & 1
  r.bitOffset = offset * 8 + start
  const sizes: number[] = []
  for (let i = 0; i < count; i++) sizes.push(readFieldSize(r))
  r.bitOffset = startBody

  let ordinal = 0
  while (fields > 0) {
    let fieldNum = 0
    while (((fields >>> fieldNum) & 1) === 0) fieldNum++
    fields = (fields & ~(1 << fieldNum)) >>> 0
    const before = r.bitOffset
    const res = fieldReader(fieldNum)
    if (res === SKIP_FIELD) r.bitOffset = before + sizes[ordinal]!
    ordinal++
  }
}

/**
 * IdFieldSerializer255: до 255 полей, индексы и размеры отдельными
 * таблицами. Размер поля передаётся колбэку; после чтения смещение
 * принудительно ставится на конец поля.
 */
export function deserializeIdFields255(
  r: BitReader,
  fieldReader: (fieldIndex: number, fieldSizeBits: number) => typeof SKIP_FIELD | void,
): void {
  const start = r.bitOffset
  if (start & 7) throw new Error('IdFieldSerializer255 не выровнен по байту')
  const offset = r.readU16()
  const count = r.readU16()

  const fieldsCount = count & 0x0fff
  if (fieldsCount >= 255) throw new Error(`IdFieldSerializer255: fieldsCount ${fieldsCount}`)
  const bitsPerId = count >>> 12
  const startBody = r.bitOffset

  r.bitOffset = offset * 8 + start
  const sizes: number[] = []
  for (let i = 0; i < fieldsCount; i++) sizes.push(readFieldSize(r))

  const alignedToByte = (n: number): number => n + 8 - (((n - 1) & 7) + 1)
  const bitsForIndices = alignedToByte(bitsPerId * fieldsCount)
  const indicesAt = startBody - 32 + offset * 8 - bitsForIndices
  if (indicesAt < 0) throw new Error('IdFieldSerializer255: таблица индексов вне буфера')
  r.bitOffset = indicesAt
  const indexes: number[] = []
  for (let i = 0; i < fieldsCount; i++) {
    const b = r.readBits(bitsPerId)
    indexes.push(b.length > 1 ? b[0]! | (b[1]! << 8) : b[0] ?? 0)
  }

  r.bitOffset = startBody
  for (let i = 0; i < fieldsCount; i++) {
    const before = r.bitOffset
    fieldReader(indexes[i]!, sizes[i]!)
    r.bitOffset = before + sizes[i]!
  }
}
