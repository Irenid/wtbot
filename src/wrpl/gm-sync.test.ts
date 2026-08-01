import assert from 'node:assert/strict'
import test from 'node:test'
import { rle0kiDecompress } from './gm-sync.js'

function referenceRle0ki(src: Buffer, maxOut: number): Buffer {
  if (src.length === 0) return Buffer.alloc(0)
  const limit = src.length - 1
  const parity = src[limit]!
  if (parity !== 111 && parity !== 222) return Buffer.alloc(0)
  const out = Buffer.alloc(maxOut)
  const values = [0, 0]
  let code = -1
  let offset = 0
  let outputOffset = 0
  let superValue = -1
  for (let index = 0; index < limit; index += 1) {
    const nibbleCount = index !== limit - 1 || parity === 222 ? 2 : 1
    for (let nibble = 0; nibble < nibbleCount; nibble += 1) {
      values[0] = (src[index]! >> (nibble * 4)) & 3
      values[1] = (src[index]! >> (2 + nibble * 4)) & 3
      let count = 0
      if (code !== 4) code = values[0]!
      switch (code) {
        case 0:
          count = values[1]! + 3
          values[0] = values[1] = 0
          break
        case 3:
          count = values[1]! + 7
          values[0] = values[1] = 0
          break
        case 1:
          code = 4
          superValue = values[1]!
          count = 1
          values[0] = values[1]!
          break
        case 2:
          count = 1
          values[0] = values[1]!
          break
        case 4:
          code = -1
          count = superValue === 0 && values[0] === 0 && values[1] === 0 ? 39 : 2
          break
      }
      for (let unit = 0; unit < count; unit += 1) {
        if (outputOffset >= maxOut) throw new Error('rle0ki: выход за буфер')
        out[outputOffset] = out[outputOffset]! | (values[unit & 1]! << (offset * 2))
        offset++
        if (offset === 4) {
          offset = 0
          outputOffset++
        }
      }
    }
  }
  return out.subarray(0, offset ? outputOffset + 1 : outputOffset)
}

test('rle0ki optimized decoder совпадает с эталонным алгоритмом', () => {
  for (const parity of [111, 222]) {
    for (let first = 0; first <= 0xff; first += 1) {
      const sources = [
        Buffer.from([first, parity]),
        Buffer.from([first, first ^ 0xa5, parity]),
        Buffer.from([first, (first * 29) & 0xff, first ^ 0x5a, parity]),
      ]
      for (const source of sources) {
        assert.deepEqual(rle0kiDecompress(source, 4096), referenceRle0ki(source, 4096))
      }
    }
  }
})

test('rle0ki optimized decoder сохраняет проверку размера выхода', () => {
  const source = Buffer.from([0x00, 222])
  assert.throws(() => rle0kiDecompress(source, 0), /выход за буфер/)
  assert.throws(() => rle0kiDecompress(source, -1), /maxOut/)
})
