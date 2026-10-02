import assert from 'node:assert/strict'
import test from 'node:test'
import { BitReader, EofError } from './bit-reader.js'

function referenceReadBits(data: Buffer, startBit: number, bits: number): Buffer {
  if (bits > data.length * 8 - startBit) throw new EofError()
  const out = Buffer.alloc(Math.ceil(bits / 8))
  const offset = startBit & 7
  let bitOffset = startBit
  let outputOffset = 0
  let left = bits
  while (left > 0) {
    const byteIndex = Math.floor(bitOffset / 8)
    let value = (data[byteIndex]! << offset) & 0xff
    if (offset > 0 && left > 8 - offset) value |= data[byteIndex + 1]! >> (8 - offset)
    if (left >= 8) {
      out[outputOffset] = value
      left -= 8
      bitOffset += 8
      outputOffset += 1
    } else {
      out[outputOffset] = value >> (8 - left)
      break
    }
  }
  return out
}

function littleEndianBitsValue(data: Buffer): number {
  let value = 0
  for (let index = 0; index < data.length; index += 1) {
    value += data[index]! * 2 ** (index * 8)
  }
  return value
}

test('BitReader сохраняет побитовую семантику на выровненных и смещённых чтениях', () => {
  const data = Buffer.from([0xd3, 0x69, 0xa5, 0x1e, 0x87, 0x4c, 0xf0, 0x2b])
  for (let start = 0; start < data.length * 8; start += 1) {
    const maxBits = Math.min(32, data.length * 8 - start)
    for (let bits = 0; bits <= maxBits; bits += 1) {
      const expected = referenceReadBits(data, start, bits)
      const reader = new BitReader(data)
      reader.setBitOffset(start)
      assert.deepEqual(reader.readBits(bits), expected, `start=${start}, bits=${bits}`)
      assert.equal(reader.bitOffset, start + bits)

      const scalar = new BitReader(data)
      scalar.setBitOffset(start)
      assert.equal(
        scalar.readUnsignedBits(bits),
        littleEndianBitsValue(expected),
        `scalar start=${start}, bits=${bits}`,
      )
      assert.equal(scalar.bitOffset, start + bits)
    }
  }
})

test('BitReader читает скаляры без изменения результата при битовом смещении', () => {
  const data = Buffer.from([
    0x7a, 0x41, 0x9c, 0x03, 0xde, 0x88, 0x57, 0x21,
    0x65, 0xfa, 0x12, 0x44, 0x81, 0x30, 0xbc, 0x09,
  ])
  for (const start of [0, 1, 3, 7, 8, 11]) {
    const expected = referenceReadBits(data, start, 8)
    const byteReader = new BitReader(data)
    byteReader.setBitOffset(start)
    assert.equal(byteReader.readByte(), expected[0])

    const bitReader = new BitReader(data)
    bitReader.setBitOffset(start)
    assert.equal(bitReader.readBit(), expected[0]! >= 0x80)

    const u16 = referenceReadBits(data, start, 16).readUInt16LE(0)
    const u16Reader = new BitReader(data)
    u16Reader.setBitOffset(start)
    assert.equal(u16Reader.readU16(), u16)

    const u32 = referenceReadBits(data, start, 32).readUInt32LE(0)
    const u32Reader = new BitReader(data)
    u32Reader.setBitOffset(start)
    assert.equal(u32Reader.readU32(), u32)

    const f32 = referenceReadBits(data, start, 32).readFloatLE(0)
    const f32Reader = new BitReader(data)
    f32Reader.setBitOffset(start)
    assert.ok(Object.is(f32Reader.readF32(), f32))

    const f64 = referenceReadBits(data, start, 64).readDoubleLE(0)
    const f64Reader = new BitReader(data)
    f64Reader.setBitOffset(start)
    assert.ok(Object.is(f64Reader.readF64(), f64))
  }
})

test('BitReader быстро читает выровненную C-строку и сохраняет границы', () => {
  const reader = new BitReader(Buffer.from('alpha\0omega', 'utf8'))
  assert.equal(reader.readCstr(), 'alpha')
  assert.equal(reader.bitOffset, 48)
  assert.throws(() => new BitReader(Buffer.from('unterminated')).readCstr(), EofError)
})

test('BitReader не сдвигает позицию при обрезанном скалярном чтении', () => {
  for (const read of [
    (reader: BitReader) => reader.readU16(),
    (reader: BitReader) => reader.readU32(),
    (reader: BitReader) => reader.readU64(),
    (reader: BitReader) => reader.readF32(),
    (reader: BitReader) => reader.readF64(),
  ]) {
    const reader = new BitReader(Buffer.from([0xff]))
    reader.setBitOffset(1)
    assert.throws(() => read(reader), EofError)
    assert.equal(reader.bitOffset, 1)
  }
})

test('BitReader читает строку с длиной-varint: короткую как раньше, длинную целиком', () => {
  const short = Buffer.concat([Buffer.from([5]), Buffer.from('hello'), Buffer.from([1])])
  const reader = new BitReader(short)
  assert.equal(reader.readVarLenStr(), 'hello')
  assert.equal(reader.readByte(), 1)

  // 200 байт: длина 0xC8 0x01 (LEB128). Однобайтовая длина прочитала бы 0xC8
  // байт начиная с 0x01 и потеряла хвост — так ломались длинные сообщения чата.
  const text = 'ж'.repeat(100)
  const long = Buffer.concat([Buffer.from([0xc8, 0x01]), Buffer.from(text), Buffer.from([2])])
  const longReader = new BitReader(long)
  assert.equal(longReader.readVarLenStr(), text)
  assert.equal(longReader.readByte(), 2, 'канал — сразу после текста')

  assert.throws(() => new BitReader(Buffer.from([0xc8, 0x01, 1, 2])).readVarLenStr(), EofError)
})
