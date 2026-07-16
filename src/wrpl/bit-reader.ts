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

  constructor(data: Buffer) {
    this.data = data
  }

  ignoreBits(n: number): void {
    this.bitOffset += n
  }

  ignoreBytes(n: number): void {
    this.bitOffset += n * 8
  }

  /** Читает bits бит; неполный последний байт прижат к младшим битам */
  readBits(bits: number): Buffer {
    if (bits === 0) return Buffer.alloc(0)
    if ((this.bitOffset + bits + 7) >> 3 > this.data.length) throw new EofError()

    const offset = this.bitOffset & 7
    if (offset === 0 && (bits & 7) === 0) {
      const start = this.bitOffset >> 3
      const out = this.data.subarray(start, start + (bits >> 3))
      this.bitOffset += bits
      return out
    }

    const out = Buffer.alloc((bits + 7) >> 3)
    let offs = 0
    let left = bits
    while (left > 0) {
      let b = (this.data[this.bitOffset >> 3]! << offset) & 0xff
      if (offset > 0 && left > 8 - offset) {
        b |= this.data[(this.bitOffset >> 3) + 1]! >> (8 - offset)
      }
      if (left >= 8) {
        out[offs] = b
        left -= 8
        this.bitOffset += 8
        offs += 1
      } else {
        out[offs] = b >> (8 - left)
        this.bitOffset += left
        break
      }
    }
    return out
  }

  readBytes(n: number): Buffer {
    return this.readBits(n * 8)
  }

  readByte(): number {
    return this.readBits(8)[0]!
  }

  readBit(): boolean {
    return this.readBits(1)[0] === 1
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
      v += (a & 0x7f) * 2 ** shift
      shift += 7
      if ((a & 0x80) === 0) break
    }
    return v
  }

  readU16(): number {
    const b = this.readBytes(2)
    return b[0]! | (b[1]! << 8)
  }

  readU32(): number {
    return this.readBytes(4).readUInt32LE(0)
  }

  readU64(): bigint {
    return this.readBytes(8).readBigUInt64LE(0)
  }

  readI32(): number {
    return this.readBytes(4).readInt32LE(0)
  }

  readF32(): number {
    return this.readBytes(4).readFloatLE(0)
  }

  readF64(): number {
    return this.readBytes(8).readDoubleLE(0)
  }

  /** Строка до NUL-байта (ECS) */
  readCstr(): string {
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
}
