import assert from 'node:assert/strict'
import test from 'node:test'
import { BitReader, EofError } from './bit-reader.js'
import { parseBlk } from './blk.js'
import { MAX_VROMFS_IMAGE_BYTES } from './decompression-limits.js'
import { lz4DecompressBlock } from './lz4.js'
import { deserializeIdFields32 } from './packet-stream.js'
import { unpackVromfs } from './vromfs.js'

test('BitReader отвергает чтение и пропуск за концом буфера', () => {
  const reader = new BitReader(Buffer.from([0xab]))
  assert.throws(() => reader.readBits(2 ** 31), EofError)
  assert.throws(() => reader.readBytes(2 ** 29), EofError)
  assert.throws(() => reader.ignoreBits(9), EofError)
  assert.throws(() => reader.ignoreBytes(2), EofError)
})

test('BitReader отвергает слишком длинный varint', () => {
  assert.throws(
    () => new BitReader(Buffer.alloc(10, 0x80)).readCompressed(),
    /varint слишком длинный/,
  )
})

test('IdFieldSerializer32 отвергает маску вне uint32', () => {
  const mask = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10])
  const reader = new BitReader(Buffer.concat([Buffer.from([0, 0]), mask]))
  assert.throws(
    () => deserializeIdFields32(reader, () => undefined),
    /маска вне uint32/,
  )
})

test('LZ4 отвергает обрезанную длину и смещение', () => {
  assert.deepEqual(
    lz4DecompressBlock(Buffer.from([0x30, 0x41, 0x42, 0x43]), 3),
    Buffer.from('ABC'),
  )
  assert.throws(() => lz4DecompressBlock(Buffer.from([0xf0]), 16), /литералов/)
  assert.throws(() => lz4DecompressBlock(Buffer.from([0x00, 0x01]), 16), /смещение/)
  assert.throws(() => lz4DecompressBlock(Buffer.from([0x00, 0x00, 0x00]), 16), /смещение/)
  assert.throws(() => lz4DecompressBlock(Buffer.alloc(0), -1), /maxOut/)
})

test('VROMFS проверяет заголовок, размер и таблицы', () => {
  assert.throws(() => unpackVromfs(Buffer.alloc(15)), /обрезанный заголовок/)

  const oversized = Buffer.alloc(16)
  oversized.write('VRFs', 0, 'latin1')
  oversized.writeUInt32LE(MAX_VROMFS_IMAGE_BYTES + 1, 8)
  oversized[15] = 0x80
  assert.throws(() => unpackVromfs(oversized), /недопустимый размер образа/)

  const truncated = Buffer.alloc(16)
  truncated.write('VRFs', 0, 'latin1')
  truncated.writeUInt32LE(20, 8)
  truncated[15] = 0x80
  assert.throws(() => unpackVromfs(truncated), /несжатый образ/)

  const invalidTable = Buffer.alloc(36)
  invalidTable.write('VRFs', 0, 'latin1')
  invalidTable.writeUInt32LE(20, 8)
  invalidTable[15] = 0x80
  invalidTable.writeUInt32LE(19, 16)
  assert.throws(() => unpackVromfs(invalidTable), /таблица имён/)
})

test('BLK ограничивает varint, описания и циклы дерева', () => {
  assert.throws(
    () => parseBlk(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(10, 0xff)])),
    /uleb128: переполнение/,
  )
  assert.throws(
    () => parseBlk(Buffer.from([0x01, 0x00, 0x00, 0x64, 0x00, 0x00])),
    /описания блоков обрезаны/,
  )
  assert.throws(
    () => parseBlk(Buffer.from([0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00])),
    /цикл в дереве BLK/,
  )
})

function uleb128(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest > 0) byte |= 0x80
    out.push(byte)
  } while (rest > 0)
  return out
}

/** Минимальный FAT BLK без параметров: children — [первый ребёнок, число детей]. */
function fatBlk(names: string[], blocks: { nameId: number; children?: [number, number] }[]): Buffer {
  const nameBytes = Buffer.from(names.map((name) => `${name}\0`).join(''), 'utf8')
  const bytes = [
    0x01,
    ...uleb128(names.length),
    ...uleb128(nameBytes.length),
    ...nameBytes,
    ...uleb128(blocks.length),
    ...uleb128(0),
    ...uleb128(0),
  ]
  for (const block of blocks) {
    const [first, count] = block.children ?? [0, 0]
    bytes.push(...uleb128(block.nameId), ...uleb128(0), ...uleb128(count))
    if (count > 0) bytes.push(...uleb128(first))
  }
  return Buffer.from(bytes)
}

test('BLK собирает корректное дерево и склеивает повторяющиеся ключи', () => {
  const blk = fatBlk(['a', 'b'], [
    { nameId: 0, children: [1, 3] },
    { nameId: 1, children: [4, 1] },
    { nameId: 2 },
    { nameId: 2 },
    { nameId: 2 },
  ])
  assert.deepEqual(parseBlk(blk), { a: { b: {} }, b: [{}, {}] })
})

test('BLK отвергает общих потомков вместо экспоненциального разворачивания', () => {
  // i → i+1, i+2: раньше 20 блоков разворачивались в 17 710 объектов.
  const blocks: { nameId: number; children?: [number, number] }[] = []
  for (let i = 0; i < 20; i++) {
    blocks.push(i < 18 ? { nameId: 1, children: [i + 1, 2] } : { nameId: 1 })
  }
  assert.throws(() => parseBlk(fatBlk(['x'], blocks)), /повторно встречается/)
})

test('BLK ограничивает глубину вложенности', () => {
  const blocks: { nameId: number; children?: [number, number] }[] = []
  for (let i = 0; i < 300; i++) {
    blocks.push(i < 299 ? { nameId: 1, children: [i + 1, 1] } : { nameId: 1 })
  }
  assert.throws(() => parseBlk(fatBlk(['x'], blocks)), /глубже 256/)
})
