import { readFileSync } from 'node:fs'
import { MAX_TEXTURE_BYTES } from '../wrpl/decompression-limits.js'

/**
 * Oodle decompression (Kraken, Mermaid, Selkie, Leviathan, ...) for the game's
 * textures: Dagor packs DDSx data with Oodle Leviathan (ddsxTex.h FLG_OODLE).
 * oodle.wasm is oozextract 0.5.5, a Rust port of powzix/ooz, built by
 * tools/oodle-wasm (GPL-3.0-or-later, LICENSES/README.md). It has no imports;
 * the C ABI is buffer_alloc/buffer_free/decompress over its linear memory.
 */

/** The part of the WebAssembly global this module uses (the repo builds without the DOM lib). */
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => object
  Instance: new (module: object, imports: object) => { exports: unknown }
  RuntimeError: new (message?: string) => Error
}

interface OodleExports {
  memory: { buffer: ArrayBuffer }
  buffer_alloc(len: number): number
  buffer_free(ptr: number, len: number): void
  decompress(src: number, srcLen: number, dst: number, dstLen: number): number
}

let instance: OodleExports | null = null

function oodle(): OodleExports {
  if (!instance) {
    const module = new WebAssembly.Module(readFileSync(new URL('./oodle.wasm', import.meta.url)))
    instance = new WebAssembly.Instance(module, {}).exports as OodleExports
  }
  return instance
}

/** Exactly `rawSize` decoded bytes of an Oodle stream; throws on a malformed one. */
export function oodleDecompress(input: Uint8Array, rawSize: number): Buffer {
  if (!Number.isSafeInteger(rawSize) || rawSize <= 0 || rawSize > MAX_TEXTURE_BYTES) {
    throw new Error(`Oodle: invalid output size ${rawSize}`)
  }
  if (input.length === 0 || input.length > MAX_TEXTURE_BYTES) throw new Error(`Oodle: invalid input size ${input.length}`)
  const wasm = oodle()
  const src = wasm.buffer_alloc(input.length)
  const dst = wasm.buffer_alloc(rawSize)
  try {
    if (src === 0 || dst === 0) throw new Error('Oodle: out of WebAssembly memory')
    new Uint8Array(wasm.memory.buffer, src, input.length).set(input)
    const decoded = wasm.decompress(src, input.length, dst, rawSize)
    if (decoded !== rawSize) throw new Error(`Oodle: malformed stream (${decoded} of ${rawSize} bytes)`)
    // A copy: the view dies with the next allocation that grows the memory.
    return Buffer.from(new Uint8Array(wasm.memory.buffer, dst, rawSize))
  } catch (error) {
    // A trap (panic = abort) leaves the allocator in an unknown state.
    if (error instanceof WebAssembly.RuntimeError) instance = null
    throw error
  } finally {
    if (instance === wasm) {
      if (src !== 0) wasm.buffer_free(src, input.length)
      if (dst !== 0) wasm.buffer_free(dst, rawSize)
    }
  }
}
