import { zstdDecompressSync } from 'node:zlib'
import { MAX_TEXTURE_BYTES } from '../wrpl/decompression-limits.js'
import { oodleDecompress } from './oodle.js'

/**
 * Dagor texture packs (*.dxp.bin, DxP2) and DDSx textures, after Dagor's
 * texPackMgr2.cpp and ddsxTex.h (BSD-3-Clause, LICENSES/README.md).
 *
 * A pack: u32[4] {'DxP2', version 2|3, texture count, dump size}, then the
 * dump; its tables are {u32 offset from the dump start (file offset 16), u32
 * count, 8 bytes of padding}:
 *   +0  names — u64 offsets of null-terminated names
 *   +16 DDSx headers — 32 bytes each
 *   +32 records — v2: 24 bytes {u64 unused, i32 texId,
 *       i32 data offset in the file, i32 packed size, i32 reserved}; v3: 12
 *       bytes {texId, offset, size}.
 * A DDSx header: 'DDSx', d3dFormat (FourCC), flags (FLG_* below), u16 w, h,
 * u8 levels, hqPartLevels, u16 depth, bitsPerPixel, u8 qmip bits, u8
 * dxtShift|uQmip, u32 memSz (decoded mip chain), u32 packedSz.
 */

const DUMP_START = 16
const FLG_COMPR_MASK = 0xe0000000
const FLG_ZSTD = 0x20000000
const FLG_7ZIP = 0x40000000
const FLG_OODLE = 0x60000000
const FLG_ZLIB = 0x80000000
const FLG_REV_MIP_ORDER = 0x00040000
const FLG_CUBTEX = 0x0800
const FLG_VOLTEX = 0x1000
const FLG_ARRTEX = 0x00200000

export interface DdsxHeader {
  format: string
  flags: number
  width: number
  height: number
  levels: number
  memSize: number
  packedSize: number
}

export interface DxpEntry {
  /** The texture name without the asset suffix: "avg_berlin_tankmap" of "avg_berlin_tankmap*?acq0-0-0". */
  name: string
  header: DdsxHeader
  offset: number
  size: number
}

function requireRange(length: number, offset: number, size: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) {
    throw new Error(`DxP2: ${label} is out of bounds`)
  }
}

export function parseDdsxHeader(data: Uint8Array, at = 0): DdsxHeader {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  requireRange(view.length, at, 32, 'DDSx header')
  if (view.toString('latin1', at, at + 4) !== 'DDSx') throw new Error('not a DDSx header')
  return {
    format: view.toString('latin1', at + 4, at + 8),
    flags: view.readUInt32LE(at + 8),
    width: view.readUInt16LE(at + 12),
    height: view.readUInt16LE(at + 14),
    levels: view[at + 16]!,
    memSize: view.readUInt32LE(at + 24),
    packedSize: view.readUInt32LE(at + 28),
  }
}

/** Bytes from the file start that hold every table of the pack (the header and its dump). */
export function dxpIndexSize(head: Buffer): number {
  requireRange(head.length, 0, DUMP_START, 'header')
  if (head.toString('latin1', 0, 4) !== 'DxP2') throw new Error('not a DxP2 texture pack')
  return DUMP_START + head.readUInt32LE(12)
}

/** The entries of a texture pack, keyed by name; data stays in the file buffer. */
export function readDxpPack(file: Buffer): Map<string, DxpEntry> {
  return readDxpIndex(file, file.length)
}

/**
 * The entries from the pack's first dxpIndexSize() bytes; `fileLength` bounds
 * the data offsets, which then are read from the file one texture at a time.
 */
export function readDxpIndex(file: Buffer, fileLength: number): Map<string, DxpEntry> {
  requireRange(file.length, 0, DUMP_START + 48, 'header')
  if (file.toString('latin1', 0, 4) !== 'DxP2') throw new Error('not a DxP2 texture pack')
  const version = file.readUInt32LE(4)
  if (version !== 2 && version !== 3) throw new Error(`DxP2: unsupported version ${version}`)
  const count = file.readUInt32LE(8)
  const table = (at: number, itemSize: number, label: string): number => {
    const offset = DUMP_START + file.readUInt32LE(DUMP_START + at)
    const items = file.readUInt32LE(DUMP_START + at + 4)
    if (items !== count) throw new Error(`DxP2: ${label} holds ${items} of ${count} entries`)
    requireRange(file.length, offset, count * itemSize, label)
    return offset
  }
  const names = table(0, 8, 'name table')
  const headers = table(16, 32, 'header table')
  const recordSize = version === 2 ? 24 : 12
  const records = table(32, recordSize, 'record table')
  const recordData = version === 2 ? 12 : 4

  const entries = new Map<string, DxpEntry>()
  for (let i = 0; i < count; i++) {
    const nameAt = DUMP_START + Number(file.readBigUInt64LE(names + i * 8))
    requireRange(file.length, nameAt, 1, 'name')
    const end = file.indexOf(0, nameAt)
    if (end < 0 || end - nameAt > 1024) throw new Error('DxP2: unterminated name')
    const name = file.toString('utf8', nameAt, end).replace(/[*$?].*$/, '')
    const offset = file.readUInt32LE(records + i * recordSize + recordData)
    const size = file.readUInt32LE(records + i * recordSize + recordData + 4)
    requireRange(fileLength, offset, size, `data of ${name}`)
    entries.set(name, { name, header: parseDdsxHeader(file, headers + i * 32), offset, size })
  }
  return entries
}

/** The decoded mip chain of a texture: Oodle, zstd or stored. */
export function unpackDdsxData(header: DdsxHeader, packed: Uint8Array): Buffer {
  if (header.memSize <= 0 || header.memSize > MAX_TEXTURE_BYTES) throw new Error(`DDSx: invalid size ${header.memSize}`)
  switch ((header.flags & FLG_COMPR_MASK) >>> 0) {
    case 0:
      if (packed.length < header.memSize) throw new Error('DDSx: truncated data')
      return Buffer.from(packed.subarray(0, header.memSize))
    case FLG_OODLE:
      return oodleDecompress(packed, header.memSize)
    case FLG_ZSTD: {
      const data = zstdDecompressSync(packed, { maxOutputLength: header.memSize })
      if (data.length !== header.memSize) throw new Error('DDSx: zstd size mismatch')
      return data
    }
    case FLG_7ZIP:
    case FLG_ZLIB:
    default:
      throw new Error(`DDSx: unsupported compression 0x${((header.flags & FLG_COMPR_MASK) >>> 0).toString(16)}`)
  }
}

export interface RgbaImage {
  width: number
  height: number
  /** Row-major RGBA8. */
  data: Buffer
}

/** The largest mip of a 2D DXT1/DXT5 texture as RGBA. */
export function decodeDdsxTexture(header: DdsxHeader, mips: Buffer): RgbaImage {
  if (header.flags & (FLG_CUBTEX | FLG_VOLTEX | FLG_ARRTEX)) throw new Error('DDSx: only 2D textures are supported')
  const blockBytes = header.format === 'DXT1' ? 8 : header.format === 'DXT5' ? 16 : 0
  if (blockBytes === 0) throw new Error(`DDSx: unsupported format ${JSON.stringify(header.format)}`)
  const { width, height } = header
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new Error('DDSx: invalid size')
  const levelSize = (level: number): number =>
    Math.max(1, (Math.max(1, width >> level) + 3) >> 2) * Math.max(1, (Math.max(1, height >> level) + 3) >> 2) * blockBytes
  const levels = Math.max(1, header.levels)
  let total = 0
  for (let level = 0; level < levels; level++) total += levelSize(level)
  if (total > mips.length) throw new Error(`DDSx: ${mips.length} bytes hold no ${levels}-level mip chain`)
  // FLG_REV_MIP_ORDER stores the smallest level first.
  const top = header.flags & FLG_REV_MIP_ORDER ? total - levelSize(0) : 0
  return { width, height, data: decodeDxt(mips.subarray(top, top + levelSize(0)), width, height, header.format === 'DXT5') }
}

function decodeDxt(blocks: Uint8Array, width: number, height: number, dxt5: boolean): Buffer {
  const out = Buffer.alloc(width * height * 4)
  const blocksX = Math.max(1, (width + 3) >> 2)
  const blocksY = Math.max(1, (height + 3) >> 2)
  const stride = dxt5 ? 16 : 8
  const colors = new Uint8Array(16)
  const alphas = new Uint8Array(8)
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const at = (by * blocksX + bx) * stride
      const color = dxt5 ? at + 8 : at
      const c0 = blocks[color]! | (blocks[color + 1]! << 8)
      const c1 = blocks[color + 2]! | (blocks[color + 3]! << 8)
      expand565(c0, colors, 0)
      expand565(c1, colors, 4)
      colors[3] = 255
      colors[7] = 255
      if (c0 > c1 || dxt5) {
        for (let k = 0; k < 3; k++) {
          colors[8 + k] = Math.round((2 * colors[k]! + colors[4 + k]!) / 3)
          colors[12 + k] = Math.round((colors[k]! + 2 * colors[4 + k]!) / 3)
        }
        colors[11] = 255
        colors[15] = 255
      } else {
        for (let k = 0; k < 3; k++) {
          colors[8 + k] = (colors[k]! + colors[4 + k]!) >> 1
          colors[12 + k] = 0
        }
        colors[11] = 255
        colors[15] = 0
      }
      const indices = (blocks[color + 4]! | (blocks[color + 5]! << 8) | (blocks[color + 6]! << 16) | (blocks[color + 7]! << 24)) >>> 0
      let alphaLow = 0
      let alphaHigh = 0
      if (dxt5) {
        const a0 = blocks[at]!
        const a1 = blocks[at + 1]!
        alphas[0] = a0
        alphas[1] = a1
        if (a0 > a1) {
          for (let k = 1; k < 7; k++) alphas[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7)
        } else {
          for (let k = 1; k < 5; k++) alphas[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5)
          alphas[6] = 0
          alphas[7] = 255
        }
        // 16 three-bit indices: 24 bits per half, little-endian
        alphaLow = blocks[at + 2]! | (blocks[at + 3]! << 8) | (blocks[at + 4]! << 16)
        alphaHigh = blocks[at + 5]! | (blocks[at + 6]! << 8) | (blocks[at + 7]! << 16)
      }
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3)
        const y = by * 4 + (i >> 2)
        if (x >= width || y >= height) continue
        const c = ((indices >>> (2 * i)) & 3) * 4
        const target = (y * width + x) * 4
        out[target] = colors[c]!
        out[target + 1] = colors[c + 1]!
        out[target + 2] = colors[c + 2]!
        out[target + 3] = dxt5
          ? alphas[(i < 8 ? alphaLow >> (3 * i) : alphaHigh >> (3 * (i - 8))) & 7]!
          : colors[c + 3]!
      }
    }
  }
  return out
}

function expand565(c: number, out: Uint8Array, at: number): void {
  const r = (c >> 11) & 31
  const g = (c >> 5) & 63
  const b = c & 31
  out[at] = (r << 3) | (r >> 2)
  out[at + 1] = (g << 2) | (g >> 4)
  out[at + 2] = (b << 3) | (b >> 2)
}
