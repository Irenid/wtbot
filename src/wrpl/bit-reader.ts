/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Портировано из wrpl-inspector (Copyright (C) 2025 flexcoral),
 * https://github.com/maxsupermanhd/wrpl-inspector, ветка v3.
 * Изменено участниками wtbot в 2026 году: порт на TypeScript и адаптация к
 * архитектуре wtbot. Распространяется на условиях GNU AGPL-3.0-or-later; полный
 * текст лицензии — в файле LICENSE в корне репозитория. Без каких-либо гарантий.
 */
/**
 * Битовый ридер сетевого формата danet (Dagor networking) — порт
 * wrpl-inspector/wrpl/danet/bitStream.go (AGPL-3.0).
 *
 * Особенности формата: смещение считается в битах, «хвостовой» неполный
 * байт выравнивается по младшим битам (см. readBits). Чтение за концом
 * буфера — ошибка EofError, по ней парсеры пакетов прекращают разбор.
 */

export class EofError extends Error {
  constructor() {
    super('конец буфера')
  }
}

export class BitReader {
  data: Buffer
  bitOffset = 0
  private scratch: Buffer | null = null

  constructor(data: Buffer) {
    this.data = data
  }

  get remainingBits(): number {
    return this.data.length * 8 - this.bitOffset
  }

  setBitOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.data.length * 8) {
      throw new EofError()
    }
    this.bitOffset = offset
  }

  ignoreBits(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('число битов должно быть неотрицательным целым')
    this.setBitOffset(this.bitOffset + n)
  }

  ignoreBytes(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER / 8) {
      throw new RangeError('число байт должно быть неотрицательным целым')
    }
    this.setBitOffset(this.bitOffset + n * 8)
  }

  /** Читает bits бит; неполный последний байт прижат к младшим битам */
  readBits(bits: number): Buffer {
    if (!Number.isSafeInteger(bits) || bits < 0) {
      throw new RangeError('число битов должно быть неотрицательным целым')
    }
    if (bits === 0) return Buffer.alloc(0)
    if (bits > this.remainingBits) throw new EofError()

    const offset = this.bitOffset % 8
    if (offset === 0 && bits % 8 === 0) {
      const start = Math.floor(this.bitOffset / 8)
      const out = this.data.subarray(start, start + Math.floor(bits / 8))
      this.bitOffset += bits
      return out
    }

    const out = Buffer.alloc(Math.ceil(bits / 8))
    const wholeBytes = Math.floor(bits / 8)
    for (let index = 0; index < wholeBytes; index += 1) {
      out[index] = this.readByte()
    }
    const remaining = bits - wholeBytes * 8
    if (remaining > 0) out[wholeBytes] = this.readUnsignedBits(remaining)
    return out
  }

  readBytes(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER / 8) {
      throw new RangeError('число байт должно быть неотрицательным целым')
    }
    const bits = n * 8
    if (bits > this.remainingBits) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const start = this.bitOffset / 8
      this.bitOffset += bits
      return this.data.subarray(start, start + n)
    }
    const out = Buffer.allocUnsafe(n)
    for (let index = 0; index < n; index += 1) out[index] = this.readByte()
    return out
  }

  readByte(): number {
    if (this.remainingBits < 8) throw new EofError()
    const byteIndex = Math.floor(this.bitOffset / 8)
    const offset = this.bitOffset & 7
    const current = this.data[byteIndex]!
    this.bitOffset += 8
    if (offset === 0) return current
    return ((current << offset) & 0xff) | (this.data[byteIndex + 1]! >>> (8 - offset))
  }

  readBit(): boolean {
    if (this.remainingBits < 1) throw new EofError()
    const value = this.data[Math.floor(this.bitOffset / 8)]!
    const offset = this.bitOffset & 7
    this.bitOffset += 1
    return ((value >>> (7 - offset)) & 1) === 1
  }

  readUnsignedBits(bits: number): number {
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > 32) {
      throw new RangeError('число битов должно быть целым от 0 до 32')
    }
    if (bits > this.remainingBits) throw new EofError()
    let value = 0
    let shift = 0
    let left = bits
    while (left >= 8) {
      value += this.readByte() * 2 ** shift
      shift += 8
      left -= 8
    }
    if (left > 0) {
      const byteIndex = Math.floor(this.bitOffset / 8)
      const offset = this.bitOffset & 7
      let chunk = (this.data[byteIndex]! << offset) & 0xff
      if (offset > 0 && left > 8 - offset) {
        chunk |= this.data[byteIndex + 1]! >>> (8 - offset)
      }
      value += (chunk >>> (8 - left)) * 2 ** shift
      this.bitOffset += left
    }
    return value
  }

  readLenStr(): string {
    const l = this.readByte()
    return this.readBytes(l).toString('utf8')
  }

  /** LEB128-подобный varint по 7 бит */
  readCompressed(): number {
    let v = 0
    let shift = 0
    for (;;) {
      const a = this.readByte()
      const part = (a & 0x7f) * 2 ** shift
      if (!Number.isSafeInteger(part) || !Number.isSafeInteger(v + part)) {
        throw new RangeError('varint выходит за безопасный диапазон')
      }
      v += part
      shift += 7
      if (shift > 56 && (a & 0x80) !== 0) {
        throw new RangeError('varint слишком длинный')
      }
      if ((a & 0x80) === 0) break
    }
    return v
  }

  readU16(): number {
    if (this.remainingBits < 16) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const offset = this.bitOffset / 8
      this.bitOffset += 16
      return this.data.readUInt16LE(offset)
    }
    return this.readByte() | (this.readByte() << 8)
  }

  readU32(): number {
    if (this.remainingBits < 32) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const offset = this.bitOffset / 8
      this.bitOffset += 32
      return this.data.readUInt32LE(offset)
    }
    return (
      this.readByte()
      + this.readByte() * 0x100
      + this.readByte() * 0x1_0000
      + this.readByte() * 0x100_0000
    ) >>> 0
  }

  readU64(): bigint {
    if (this.remainingBits < 64) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const offset = this.bitOffset / 8
      this.bitOffset += 64
      return this.data.readBigUInt64LE(offset)
    }
    return this.readScratch(8).readBigUInt64LE(0)
  }

  readI32(): number {
    return this.readU32() | 0
  }

  readF32(): number {
    if (this.remainingBits < 32) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const offset = this.bitOffset / 8
      this.bitOffset += 32
      return this.data.readFloatLE(offset)
    }
    return this.readScratch(4).readFloatLE(0)
  }

  readF64(): number {
    if (this.remainingBits < 64) throw new EofError()
    if ((this.bitOffset & 7) === 0) {
      const offset = this.bitOffset / 8
      this.bitOffset += 64
      return this.data.readDoubleLE(offset)
    }
    return this.readScratch(8).readDoubleLE(0)
  }

  /** Строка до NUL-байта (ECS) */
  readCstr(): string {
    if ((this.bitOffset & 7) === 0) {
      const start = this.bitOffset / 8
      const end = this.data.indexOf(0, start)
      if (end < 0) throw new EofError()
      this.bitOffset = (end + 1) * 8
      return this.data.subarray(start, end).toString('utf8')
    }
    const bytes: number[] = []
    for (;;) {
      const b = this.readByte()
      if (b === 0) break
      bytes.push(b)
    }
    return Buffer.from(bytes).toString('utf8')
  }

  alignToByteBoundary(): void {
    this.bitOffset += 8 - (((this.bitOffset - 1) & 7) + 1)
  }

  private readScratch(bytes: number): Buffer {
    const scratch = this.scratch ??= Buffer.allocUnsafe(8)
    for (let index = 0; index < bytes; index += 1) scratch[index] = this.readByte()
    return scratch
  }
}
