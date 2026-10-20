import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { deflateSync, inflateSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decodeDdsxTexture, parseDdsxHeader, readDxpPack } from '../tactical-map/dxp.js'
import { oodleDecompress } from '../tactical-map/oodle.js'
import { BitReader } from './bit-reader.js'
import { parseBlk } from './blk.js'
import { parseComponentHashMaps } from './ecs.js'
import { rle0kiDecompress } from './gm-sync.js'
import { lz4DecompressBlock } from './lz4.js'
import { deserializeIdFields32, deserializeIdFields255, readEID } from './packet-stream.js'
import { extractReplayEvents, packetStreamCodec } from './replay-events.js'
import { parseWrplHeader } from './replay.js'
import { unpackVromfs } from './vromfs.js'

/**
 * Untrusted binary input (AGENTS.md section 7): every decoder, fed random
 * bytes and mutations of valid input, returns or throws an Error — within a
 * time budget, never a hang, a non-Error throw or an allocation past its
 * limits. Seeded: a failure repeats on every run and prints its input. A
 * longer campaign: WTBOT_FUZZ_SEED (added to every seed) and WTBOT_FUZZ_SCALE
 * (multiplies the iterations).
 */

const CALL_BUDGET_MS = 2_000
const SEED_OFFSET = Number(process.env['WTBOT_FUZZ_SEED'] ?? 0)
const SCALE = Math.max(1, Number(process.env['WTBOT_FUZZ_SCALE'] ?? 1))
/** Iterations of a loop at the current scale. */
const runs = (count: number): number => Math.round(count * SCALE)

/** xorshift32 over a fixed seed per suite. */
function rng(seed: number): (bound: number) => number {
  let state = (seed + SEED_OFFSET) >>> 0 || 1
  return (bound) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % bound
  }
}

function randomBytes(next: (bound: number) => number, length: number): Buffer {
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) out[i] = next(256)
  return out
}

const EXTREMES = [0, 1, 0x7f, 0x80, 0xff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]

/** One random damage: bit flips, a cut, an inflated length field, a repeated or zeroed slice. */
function mutate(next: (bound: number) => number, input: Buffer): Buffer {
  if (input.length === 0) return randomBytes(next, 1 + next(16))
  const out = Buffer.from(input)
  switch (next(5)) {
    case 0:
      for (let i = 1 + next(8); i > 0; i -= 1) {
        const at = next(out.length)
        out[at] = out[at]! ^ (1 << next(8))
      }
      return out
    case 1:
      return out.subarray(0, next(out.length))
    case 2: {
      const at = next(Math.max(1, out.length - 3))
      if (out.length >= at + 4) out.writeUInt32LE(EXTREMES[next(EXTREMES.length)]!, at)
      else out[at] = 0xff
      return out
    }
    case 3: {
      const from = next(out.length)
      const slice = out.subarray(from, from + 1 + next(64))
      const at = next(out.length)
      return Buffer.concat([out.subarray(0, at), slice, out.subarray(at)])
    }
    default: {
      const from = next(out.length)
      out.fill(next(2) === 0 ? 0 : 0xff, from, Math.min(out.length, from + 1 + next(32)))
      return out
    }
  }
}

/** Runs one decode: an Error is fine, anything else, or a slow call, fails with the input. */
function contained(label: string, input: Uint8Array, decode: () => unknown): unknown {
  const started = performance.now()
  let result: unknown
  try {
    result = decode()
  } catch (error) {
    assert.ok(error instanceof Error, `${label}: threw a non-Error ${String(error)} for ${Buffer.from(input).subarray(0, 64).toString('hex')}`)
  }
  const elapsed = performance.now() - started
  assert.ok(elapsed < CALL_BUDGET_MS, `${label}: ${elapsed.toFixed(0)} ms for ${Buffer.from(input).subarray(0, 64).toString('hex')}`)
  return result
}

test('LZ4: random blocks stay within maxOut; matches before the output start are refused', () => {
  const next = rng(0x1234)
  for (let i = 0; i < runs(3_000); i += 1) {
    const input = randomBytes(next, next(256))
    const maxOut = next(4_096)
    const out = contained('lz4', input, () => lz4DecompressBlock(input, maxOut))
    if (out !== undefined) assert.ok((out as Buffer).length <= maxOut)
  }
  // One literal, then a match at offset 1: an overlapping copy repeats it.
  assert.deepEqual(lz4DecompressBlock(Buffer.from([0x10, 0x61, 0x01, 0x00]), 5), Buffer.from('aaaaa'))
  // Offset 5 with one byte written: before the output start.
  assert.throws(() => lz4DecompressBlock(Buffer.from([0x10, 0x61, 0x05, 0x00]), 16))
  // Output exactly at the limit, then one byte short.
  assert.deepEqual(lz4DecompressBlock(Buffer.from([0x30, 0x41, 0x42, 0x43]), 3), Buffer.from('ABC'))
  assert.throws(() => lz4DecompressBlock(Buffer.from([0x30, 0x41, 0x42, 0x43]), 2))
  assert.deepEqual(lz4DecompressBlock(Buffer.alloc(0), 0), Buffer.alloc(0))
})

test('rle0ki: random streams stay within maxOut', () => {
  const next = rng(0x2345)
  for (let i = 0; i < runs(3_000); i += 1) {
    const input = randomBytes(next, next(512))
    const maxOut = next(8_192)
    const out = contained('rle0ki', input, () => rle0kiDecompress(input, maxOut))
    if (out !== undefined) assert.ok((out as Buffer).length <= maxOut)
  }
})

test('packet stream readers refuse reads past the end', () => {
  const next = rng(0x3456)
  for (let i = 0; i < runs(3_000); i += 1) {
    const input = randomBytes(next, next(48))
    contained('readEID', input, () => readEID(new BitReader(input)))
    contained('idFields32', input, () => {
      const reader = new BitReader(input)
      deserializeIdFields32(reader, () => {
        reader.readByte()
      })
    })
    contained('idFields255', input, () => deserializeIdFields255(new BitReader(input), () => undefined))
  }
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

/** A FAT BLK without params: each block's children are [first child, count]. */
function fatBlk(names: string[], blocks: { nameId: number; children?: [number, number] }[]): Buffer {
  const nameBytes = Buffer.from(names.map((name) => `${name}\0`).join(''), 'utf8')
  const bytes = [0x01, ...uleb128(names.length), ...uleb128(nameBytes.length), ...nameBytes, ...uleb128(blocks.length), ...uleb128(0), ...uleb128(0)]
  for (const block of blocks) {
    const [first, count] = block.children ?? [0, 0]
    bytes.push(...uleb128(block.nameId), ...uleb128(0), ...uleb128(count))
    if (count > 0) bytes.push(...uleb128(first))
  }
  return Buffer.from(bytes)
}

test('BLK: random bytes and damaged trees parse or fail cleanly', () => {
  const next = rng(0x4567)
  const valid = fatBlk(['a', 'b', 'c'], [
    { nameId: 0, children: [1, 3] },
    { nameId: 1, children: [4, 2] },
    { nameId: 2 },
    { nameId: 3 },
    { nameId: 2 },
    { nameId: 3 },
  ])
  assert.ok(parseBlk(valid))
  for (let i = 0; i < runs(3_000); i += 1) {
    const input = i % 2 === 0 ? mutate(next, valid) : Buffer.concat([Buffer.from([next(6)]), randomBytes(next, next(200))])
    contained('blk', input, () => parseBlk(input))
  }
})

test('VROMFS: damaged headers and tables fail cleanly', () => {
  const next = rng(0x5678)
  for (let i = 0; i < runs(2_000); i += 1) {
    const input = Buffer.concat([Buffer.from(next(2) === 0 ? 'VRFs' : 'VRFx', 'latin1'), randomBytes(next, next(256))])
    if (input.length >= 12 && next(2) === 0) input.writeUInt32LE(20 + next(4_096), 8)
    contained('vromfs', input, () => unpackVromfs(input))
  }
})

test('Oodle: random and damaged streams decode to the asked size or fail cleanly', () => {
  const next = rng(0x6789)
  const data = Buffer.from('tactical map '.repeat(40))
  const stored = Buffer.concat([Buffer.from([0xcc, 0x0c]), data])
  assert.deepEqual(oodleDecompress(stored, data.length), data)
  for (let i = 0; i < runs(1_500); i += 1) {
    const input = i % 2 === 0 ? mutate(next, stored) : randomBytes(next, 1 + next(300))
    const rawSize = i % 3 === 0 ? data.length : 1 + next(8_192)
    const out = contained('oodle', input, () => oodleDecompress(input, rawSize))
    if (out !== undefined) assert.equal((out as Buffer).length, rawSize)
  }
})

test('DDSx and DxP2: random headers and packs fail cleanly', () => {
  const next = rng(0x789a)
  for (let i = 0; i < runs(2_000); i += 1) {
    const ddsx = Buffer.concat([Buffer.from('DDSx', 'latin1'), randomBytes(next, 28 + next(64))])
    const header = contained('ddsx header', ddsx, () => parseDdsxHeader(ddsx)) as ReturnType<typeof parseDdsxHeader> | undefined
    if (header !== undefined) contained('ddsx texture', ddsx, () => decodeDdsxTexture(header, ddsx.subarray(32)))
    const pack = Buffer.concat([Buffer.from('DxP2', 'latin1'), randomBytes(next, 12 + next(256))])
    if (next(2) === 0) pack.writeUInt32LE(2, 4)
    contained('dxp pack', pack, () => readDxpPack(pack))
  }
})

const CORPUS = 'benchmarks/fixtures/replays/06feb0d100099a2e'
const HASHES = path.join('data', 'ecshashes.json')

test('WRPL: damaged headers and replay parts give clean errors or events', { skip: !existsSync(HASHES) && `needs ${HASHES} (CI downloads it)` }, () => {
  const next = rng(0x89ab)
  const parts = ['0000.wrpl', '0001.wrpl', '0002.wrpl', '0004.wrpl'].map((name) => readFileSync(path.join(CORPUS, name)))
  const hashes = parseComponentHashMaps(readFileSync(HASHES, 'utf8'))
  for (let i = 0; i < runs(300); i += 1) {
    const input = mutate(next, parts[0]!.subarray(0, 2_048))
    contained('wrpl header', input, () => parseWrplHeader(input))
  }
  const intact = extractReplayEvents(parts, hashes)
  assert.ok(intact.units.length > 0, 'the intact replay has tracks')
  // Damage inside the packet stream itself: decompressed, damaged, packed again with the same codec,
  // so the packet, ECS and GMSync parsers read it (damaged compressed bytes stop at inflate).
  const big = parts[1]!
  const streamAt = 1234 + parseWrplHeader(big).settingsBlkSize
  const packed = big.subarray(streamAt)
  const zstd = packetStreamCodec(packed) === 'zstd'
  const stream = zstd ? zstdDecompressSync(packed) : inflateSync(packed)
  for (let i = 0; i < runs(16); i += 1) {
    const damagedStream = mutate(next, stream)
    const repacked = zstd ? zstdCompressSync(damagedStream) : deflateSync(damagedStream, { level: 1 })
    const damaged = [parts[0]!, Buffer.concat([big.subarray(0, streamAt), repacked]), parts[2]!, parts[3]!]
    const events = contained('replay events', damagedStream, () => extractReplayEvents(damaged, hashes)) as { errors: string[] } | undefined
    if (events !== undefined) assert.ok(Array.isArray(events.errors))
  }
})
