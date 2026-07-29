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
