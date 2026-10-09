import { zstdDecompressSync } from 'node:zlib'
import { MAX_BLK_DECOMPRESSED_BYTES, MAX_VROMFS_IMAGE_BYTES } from './decompression-limits.js'

/**
 * VROMFS containers, where War Thunder keeps its resources (ui/fonts.vromfs.bin,
 * aces.vromfs.bin, mis.vromfs.bin, ...).
 *
 * Format after klensy/wt-tools (vromfs_parser.py) and Dagor's vromfsLoad.cpp:
 *   0   magic "VRFs" | "VRFx"
 *   4   platform "\0\0PC" | "\0iOS" | "\0and"
 *   8   unpacked image size (u32)
 *   12  u32: low 26 bits — packed size, high 6 bits — type:
 *       0x30 zstd, obfuscated; 0x10 zstd, obfuscated, no digest; 0x20 plain
 *       (images over 16 MiB set the low bits of the top byte: aces 0xc1)
 *   16  (VRFx only) an 8-byte extended header, skipped
 *
 * The obfuscated zstd stream XORs its first 16 bytes and the last 16 bytes
 * (aligned to 4) with fixed keys.
 *
 * The image: u32 name table offset, u32 file count, at 16 a u32 data table
 * offset (16-byte records: offset, size).
 */

const KEY_HEAD = [0xaa55aa55, 0xf00ff00f, 0xaa55aa55, 0x12481248]
const KEY_TAIL = [0x12481248, 0xaa55aa55, 0xf00ff00f, 0xaa55aa55]
const PACK_ZSTD_NO_DIGEST = 0x10
const PACK_PLAIN = 0x20
const PACK_ZSTD = 0x30

function requireRange(length: number, offset: number, size: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > length ||
    size > length - offset
  ) {
    throw new Error(`VROMFS: ${label} is out of bounds`)
  }
}

function xor16(buf: Buffer, off: number, key: number[]): void {
  requireRange(buf.length, off, 16, 'XOR block')
  for (let i = 0; i < 4; i++) {
    buf.writeUInt32LE((buf.readUInt32LE(off + i * 4) ^ key[i]!) >>> 0, off + i * 4)
  }
}

export interface VromfsFile {
  name: string
  data: Buffer
}

export function unpackVromfs(raw: Buffer): VromfsFile[] {
  if (raw.length < 16) throw new Error('VROMFS: truncated header')
  const magic = raw.subarray(0, 4).toString('latin1')
  if (magic !== 'VRFs' && magic !== 'VRFx') throw new Error(`not a VROMFS: magic "${magic}"`)
  const originalSize = raw.readUInt32LE(8)
  if (originalSize < 20 || originalSize > MAX_VROMFS_IMAGE_BYTES) {
    throw new Error(`VROMFS: invalid image size ${originalSize}`)
  }
  const packedWord = raw.readUInt32LE(12)
  const packedSize = packedWord & 0x3ffffff
  const type = packedWord >>> 26
  let off = 16
  if (magic === 'VRFx') {
    if (raw.length < 24) throw new Error('VROMFS: truncated extended header')
    off += 8
  }

  let image: Buffer
  if (type === PACK_ZSTD || type === PACK_ZSTD_NO_DIGEST) {
    if (packedSize === 0) throw new Error('VROMFS: empty zstd stream')
    requireRange(raw.length, off, packedSize, 'packed image')
    const packed = Buffer.from(raw.subarray(off, off + packedSize))
    if (packed.length >= 16) xor16(packed, 0, KEY_HEAD)
    if (packed.length >= 32) xor16(packed, (packed.length & ~3) - 16, KEY_TAIL)
    image = zstdDecompressSync(packed, { maxOutputLength: originalSize })
    if (image.length !== originalSize) {
      throw new Error(`VROMFS: expected ${originalSize} bytes, unpacked ${image.length}`)
    }
  } else if (type === PACK_PLAIN) {
    requireRange(raw.length, off, originalSize, 'plain image')
    image = Buffer.from(raw.subarray(off, off + originalSize))
  } else {
    throw new Error(`VROMFS: unsupported pack type 0x${type.toString(16).padStart(2, '0')}`)
  }

  const filenameTableOffset = image.readUInt32LE(0)
  const filesCount = image.readUInt32LE(4)
  const filedataTableOffset = image.readUInt32LE(16)
  requireRange(image.length, filenameTableOffset, 4, 'name table')
  requireRange(image.length, filedataTableOffset, filesCount * 16, 'file table')

  // The name table holds the offset of the first name; filesCount
  // null-terminated names follow it.
  const firstNameOffset = image.readUInt32LE(filenameTableOffset)
  if (filesCount > 0) requireRange(image.length, firstNameOffset, 1, 'first name')
  const names: string[] = []
  let p = firstNameOffset
  for (let i = 0; i < filesCount; i++) {
    const end = image.indexOf(0, p)
    if (end < 0) throw new Error('VROMFS: truncated name table')
    names.push(image.subarray(p, end).toString('utf8'))
    p = end + 1
  }

  const files: VromfsFile[] = []
  for (let i = 0; i < filesCount; i++) {
    const rec = filedataTableOffset + i * 16
    const dataOff = image.readUInt32LE(rec)
    const dataSize = image.readUInt32LE(rec + 4)
    requireRange(image.length, dataOff, dataSize, `file ${names[i]}`)
    files.push({ name: names[i]!, data: image.subarray(dataOff, dataOff + dataSize) })
  }
  return files
}

/**
 * What a container's "slim" BLKs (types 3–5) need to decode: the shared name
 * map and the zstd dictionary (blk_zstd.cpp). The name map is the file
 * "\xff?nm": an 8-byte name hash, the 32-byte hash of the dictionary (the
 * dictionary file is its hex + ".dict"), then a zstd stream of the names
 * (uleb count, uleb byte size, null-terminated names).
 */
export interface VromfsBlkNames {
  names: string[]
  dict: Buffer | null
}

// Names are decoded as UTF-8, where the lone 0xff byte becomes U+FFFD.
const SHARED_NAME_MAP_FILES = new Set(['\xff?nm', '\ufffd?nm'])
const NAME_MAP_HEADER = 8 + 32

export function vromfsBlkNames(files: readonly VromfsFile[]): VromfsBlkNames | null {
  const nameMap = files.find((file) => SHARED_NAME_MAP_FILES.has(file.name))
  if (!nameMap || nameMap.data.length <= NAME_MAP_HEADER) return null
  const dictName = `${nameMap.data.subarray(8, NAME_MAP_HEADER).toString('hex')}.dict`
  const dict = files.find((file) => file.name.toLowerCase() === dictName)?.data ?? null
  const list = zstdDecompressSync(nameMap.data.subarray(NAME_MAP_HEADER), {
    maxOutputLength: MAX_BLK_DECOMPRESSED_BYTES,
  })
  const ptr = { at: 0 }
  const count = readUleb(list, ptr)
  const names: string[] = []
  if (count > 0) {
    const size = readUleb(list, ptr)
    requireRange(list.length, ptr.at, size, 'shared name list')
    let start = ptr.at
    const end = ptr.at + size
    for (let i = start; i < end && names.length < count; i++) {
      if (list[i] !== 0) continue
      names.push(list.subarray(start, i).toString('utf8'))
      start = i + 1
    }
    if (names.length !== count) throw new Error(`VROMFS: the shared name map holds ${names.length} of ${count} names`)
  }
  return { names, dict }
}

function readUleb(buf: Buffer, ptr: { at: number }): number {
  let value = 0
  for (let shift = 0; shift < 35; shift += 7) {
    if (ptr.at >= buf.length) throw new Error('VROMFS: truncated varint')
    const byte = buf[ptr.at++]!
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return value
  }
  throw new Error('VROMFS: varint overflow')
}
