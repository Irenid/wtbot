/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Ported from wrpl-inspector (Copyright (C) 2025 flexcoral),
 * https://github.com/maxsupermanhd/wrpl-inspector, branch v3.
 * Modified by wtbot contributors in 2026: the TypeScript port and its
 * adaptation to wtbot's architecture. Distributed under the GNU
 * AGPL-3.0-or-later; the full license text is in the LICENSE file at the root
 * of the repository. Without any warranty.
 */
import { zstdDecompressSync } from 'node:zlib'
import { MAX_BLK_DECOMPRESSED_BYTES } from './decompression-limits.js'

/**
 * The binary BLK format (Gaijin/Dagor Engine): War Thunder's settings, battle
 * results inside .wrpl replays and the game's level and mission files.
 *
 * Ported from the Go library wrpl-inspector (wrpl/blk.go); the slim variants
 * follow Dagor's blk_serialize.cpp and blk_zstd.cpp. The first byte is the
 * label:
 *   1 FAT — the BLK with its own name table;
 *   2 FAT_ZSTD — 3 bytes of packed size (big-endian), then a zstd FAT BLK;
 *   3 SLIM, 4 SLIM_ZSTD, 5 SLIM_ZSTD_DICT — the body names its keys by the
 *     shared name map of the container (vromfsBlkNames), zstd-packed (4) or
 *     packed with the container's dictionary (5).
 * Name ids index the shared names first, then the file's own ones.
 */

export type BlkValue = string | number | boolean | BlkValue[] | BlkMap
export interface BlkMap {
  [key: string]: BlkValue
}

/** What slim BLKs (labels 3–5) need: the container's shared names and zstd dictionary. */
export interface BlkSharedNames {
  names: readonly string[]
  dict: Buffer | null
}

export function parseBlk(input: Buffer, shared?: BlkSharedNames | null): BlkMap {
  if (input.length === 0) throw new Error('empty BLK buffer')
  const slimNames = (): readonly string[] => {
    if (!shared) throw new Error(`slim BLK 0x0${input[0]} needs the shared name map of its container`)
    return shared.names
  }
  switch (input[0]) {
    case 0x01: // FAT
      return parseFatBlk(input.subarray(1))
    case 0x02: {
      // FAT_ZSTD: 3 bytes of length (big-endian), then the zstd stream
      if (input.length < 4) throw new Error('FAT_ZSTD: truncated header')
      const len = (input[1]! << 16) | (input[2]! << 8) | input[3]!
      if (input.length < 4 + len) {
        throw new Error(`FAT_ZSTD: packed data truncated: need ${4 + len}, have ${input.length}`)
      }
      const out = zstdDecompressSync(input.subarray(4, 4 + len), {
        maxOutputLength: MAX_BLK_DECOMPRESSED_BYTES,
      })
      if (out.length === 0 || out[0] !== 0x01) {
        throw new Error('FAT_ZSTD: no FAT header inside')
      }
      return parseFatBlk(out.subarray(1))
    }
    case 0x03:
      return parseFatBlk(input.subarray(1), slimNames())
    case 0x04: {
      const names = slimNames()
      return parseFatBlk(zstdDecompressSync(input.subarray(1), { maxOutputLength: MAX_BLK_DECOMPRESSED_BYTES }), names)
    }
    case 0x05: {
      const names = slimNames()
      if (!shared?.dict) throw new Error('SLIM_ZSTD_DICT BLK needs the zstd dictionary of its container')
      const body = zstdDecompressSync(input.subarray(1), {
        dictionary: shared.dict,
        maxOutputLength: MAX_BLK_DECOMPRESSED_BYTES,
      })
      return parseFatBlk(body, names)
    }
    case 0x00:
      throw new Error('the legacy BBF format is not supported')
    default:
      throw new Error(`unknown BLK label 0x${input[0]!.toString(16).padStart(2, '0')}`)
  }
}

/**
 * The tree depth limit. Real replay and mission BLKs are shallow; the limit
 * protects the stack from a chain of hundreds of thousands of blocks.
 */
const MAX_BLK_DEPTH = 256

interface BlockDesc {
  nameId: number
  fieldCount: number
  childCount: number
  firstChild: number
}

function parseFatBlk(buf: Buffer, sharedNames: readonly string[] = []): BlkMap {
  const ptr = { at: 0 }

  // The file's own names follow the shared ones; a slim BLK usually has none,
  // and then the byte size is absent too (Dagor's read_names_base).
  const ownCount = readUleb128(buf, ptr)
  let names: readonly string[] = sharedNames
  if (ownCount > 0) {
    const namesSize = readUleb128(buf, ptr)
    if (ptr.at + namesSize > buf.length) throw new Error('names buffer truncated')
    names = [...sharedNames, ...parseNullSeparatedStrings(buf.subarray(ptr.at, ptr.at + namesSize))]
    ptr.at += namesSize
  }

  const totalBlocks = readUleb128(buf, ptr)
  const paramsCount = readUleb128(buf, ptr)
  const paramsDataSize = readUleb128(buf, ptr)
  if (ptr.at + paramsDataSize > buf.length) throw new Error('param data truncated')
  const paramsData = buf.subarray(ptr.at, ptr.at + paramsDataSize)
  ptr.at += paramsDataSize

  if (paramsCount > Math.floor((buf.length - ptr.at) / 8)) {
    throw new Error('param descriptions truncated')
  }
  const paramsInfo = buf.subarray(ptr.at, ptr.at + paramsCount * 8)
  ptr.at += paramsCount * 8

  // Block descriptions: name, field count, child count, first child index
  if (totalBlocks > Math.floor((buf.length - ptr.at) / 3)) {
    throw new Error('block descriptions truncated')
  }
  const descs: BlockDesc[] = []
  for (let i = 0; i < totalBlocks; i++) {
    const nameId = readUleb128(buf, ptr)
    const fieldCount = readUleb128(buf, ptr)
    const childCount = readUleb128(buf, ptr)
    const firstChild = childCount > 0 ? readUleb128(buf, ptr) : 0
    descs.push({ nameId, fieldCount, childCount, firstChild })
  }

  // One param: 3 bytes of name id, 1 byte of type, 4 bytes of data or offset
  function getNthParam(index: number): { name: string; value: BlkValue } {
    const start = index * 8
    if (start + 8 > paramsInfo.length) throw new Error(`param[${index}]: out of bounds`)
    const nameId = paramsInfo[start]! | (paramsInfo[start + 1]! << 8) | (paramsInfo[start + 2]! << 16)
    const typeId = paramsInfo[start + 3]!
    const data = paramsInfo.subarray(start + 4, start + 8)

    const name = names[nameId]
    if (name === undefined) throw new Error(`param[${index}]: name id ${nameId} out of range`)

    const readAt = (off: number, n: number): Buffer => {
      if (off < 0 || off + n > paramsData.length) {
        throw new Error(`param[${index}]: offset out of bounds`)
      }
      return paramsData.subarray(off, off + n)
    }
    const floats = (off: number, n: number): number[] => {
      const bs = readAt(off, n * 4)
      return Array.from({ length: n }, (_, k) => bs.readFloatLE(k * 4))
    }
    const ints = (off: number, n: number): number[] => {
      const bs = readAt(off, n * 4)
      return Array.from({ length: n }, (_, k) => bs.readInt32LE(k * 4))
    }

    let value: BlkValue
    switch (typeId) {
      case 0x01: {
        // STRING: the top bit means the string is a name id, otherwise a data offset
        const raw = data.readUInt32LE(0)
        const inNames = raw >>> 31 === 1
        const off = raw & 0x7fffffff
        if (inNames) {
          const s = names[off]
          if (s === undefined) throw new Error(`param[${index}]: string ${off} outside the name table`)
          value = s
        } else {
          const rest = paramsData.subarray(off)
          const end = rest.indexOf(0)
          if (end < 0) throw new Error(`param[${index}]: unterminated string`)
          value = rest.subarray(0, end).toString('utf8')
        }
        break
      }
      case 0x02: // INT
        value = data.readInt32LE(0)
        break
      case 0x03: // FLOAT
        value = data.readFloatLE(0)
        break
      case 0x04: // FLOAT2
        value = floats(data.readUInt32LE(0), 2)
        break
      case 0x05: // FLOAT3
        value = floats(data.readUInt32LE(0), 3)
        break
      case 0x06: // FLOAT4
        value = floats(data.readUInt32LE(0), 4)
        break
      case 0x07: // INT2
        value = ints(data.readUInt32LE(0), 2)
        break
      case 0x08: // INT3
        value = ints(data.readUInt32LE(0), 3)
        break
      case 0x09: // BOOL
        value = data.readUInt32LE(0) !== 0
        break
      case 0x0a: // COLOR (r, g, b, a)
        value = [data[0]!, data[1]!, data[2]!, data[3]!]
        break
      case 0x0b: {
        // FLOAT12: a matrix of 4 rows of 3 floats
        const off = data.readUInt32LE(0)
        const bs = readAt(off, 48)
        const rows: BlkValue[] = []
        for (let r = 0; r < 4; r++) {
          rows.push([bs.readFloatLE(r * 12), bs.readFloatLE(r * 12 + 4), bs.readFloatLE(r * 12 + 8)])
        }
        value = rows
        break
      }
      case 0x0c: {
        // LONG (int64): battle numbers fit a double
        const off = data.readUInt32LE(0)
        const bs = readAt(off, 8)
        value = Number(bs.readBigInt64LE(0))
        break
      }
      case 0x0d: // INT4
        value = ints(data.readUInt32LE(0), 4)
        break
      default:
        throw new Error(`param[${index}]: unknown type 0x${typeId.toString(16)}`)
    }
    return { name, value }
  }

  // Params belong to the blocks in order
  let paramPtr = 0
  const flat: { name: string; fields: { name: string; value: BlkValue }[]; childCount: number; firstChild: number }[] = []
  for (const d of descs) {
    let name = 'root'
    if (d.nameId !== 0) {
      const n = names[d.nameId - 1]
      if (n === undefined) throw new Error(`block: name index ${d.nameId - 1} out of range`)
      name = n
    }
    const fields = []
    if (d.fieldCount > paramsCount - paramPtr) {
      throw new Error('a block refers to params out of range')
    }
    for (let j = 0; j < d.fieldCount; j++) fields.push(getNthParam(paramPtr + j))
    paramPtr += d.fieldCount
    flat.push({ name, fields, childCount: d.childCount, firstChild: d.firstChild })
  }

  // The tree; repeated keys become an array. In a valid BLK every block has
  // exactly one parent. Without this check a DAG of shared children
  // (i → i+1, i+2) unfolds exponentially: 85 input bytes gave tens of
  // thousands of objects. With it each block is built at most once, and the
  // tree is linear in the input.
  const visiting = new Set<number>()
  const claimed = new Uint8Array(flat.length)
  claimed[0] = 1
  function build(idx: number, depth: number): BlkMap {
    const fb = flat[idx]
    if (!fb) throw new Error(`block ${idx} out of range`)
    if (depth > MAX_BLK_DEPTH) throw new Error(`BLK tree deeper than ${MAX_BLK_DEPTH} levels`)
    if (fb.firstChild > flat.length || fb.childCount > flat.length - fb.firstChild) {
      throw new Error(`children of block ${idx} out of range`)
    }
    visiting.add(idx)
    const m: BlkMap = {}
    const repeated = new Set<string>()
    for (const f of fb.fields) putKV(m, f.name, f.value, repeated)
    for (let c = fb.firstChild; c < fb.firstChild + fb.childCount; c++) {
      const child = flat[c]
      if (!child) throw new Error(`child block ${c} out of range`)
      if (visiting.has(c)) throw new Error(`cycle in the BLK tree at block ${c}`)
      if (claimed[c] === 1) throw new Error(`block ${c} occurs twice in the BLK tree`)
      claimed[c] = 1
      putKV(m, child.name, build(c, depth + 1), repeated)
    }
    visiting.delete(idx)
    return m
  }

  return build(0, 0)
}

/**
 * A repeated key becomes an array of its values. `repeated` tells that array
 * apart from a single vector value: two `gridSteps` give [[2048, 2048],
 * [3250, 3250]], not [2048, 2048, [3250, 3250]].
 */
function putKV(m: BlkMap, k: string, v: BlkValue, repeated: Set<string>): void {
  const existing = m[k]
  if (existing === undefined) {
    m[k] = v
  } else if (repeated.has(k)) {
    (existing as BlkValue[]).push(v)
  } else {
    m[k] = [existing, v]
    repeated.add(k)
  }
}

function parseNullSeparatedStrings(b: Buffer): string[] {
  const res: string[] = []
  let start = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) {
      res.push(b.subarray(start, i).toString('utf8'))
      start = i + 1
    }
  }
  return res
}

function readUleb128(b: Buffer, ptr: { at: number }): number {
  // Multiplication, not shifts: JS bit operations are 32-bit
  let val = 0
  let mult = 1
  while (ptr.at < b.length) {
    const cur = b[ptr.at]!
    ptr.at++
    const part = (cur & 0x7f) * mult
    if (!Number.isSafeInteger(part) || val > Number.MAX_SAFE_INTEGER - part) {
      throw new Error('uleb128: overflow')
    }
    val += part
    if ((cur & 0x80) === 0) return val
    if (mult > Number.MAX_SAFE_INTEGER / 128) throw new Error('uleb128: overflow')
    mult *= 128
  }
  throw new Error('uleb128: buffer ended')
}
