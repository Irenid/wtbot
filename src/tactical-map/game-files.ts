import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseBlk, type BlkMap } from '../wrpl/blk.js'
import { unpackVromfs, vromfsBlkNames, type VromfsBlkNames, type VromfsFile } from '../wrpl/vromfs.js'
import { decodeDdsxTexture, dxpIndexSize, readDxpIndex, unpackDdsxData, type DxpEntry, type RgbaImage } from './dxp.js'

/**
 * Read access to a War Thunder install for the tactical map builder. Runs in
 * a CPU worker with synchronous I/O. Archives are unpacked once per worker and
 * reused while their size and mtime stay the same (a game patch replaces them).
 */

/** Every game file the map is built from, relative to the game folder. */
export const TACTICAL_MAP_SOURCES = {
  missions: 'mis.vromfs.bin',
  config: 'aces.vromfs.bin',
  maps: 'content/base/res/locations_maps.dxp.bin',
  icons: 'ui/atlases.vromfs.bin',
  textures: 'ui/tex.vromfs.bin',
  fonts: 'ui/fonts.vromfs.bin',
} as const

interface Archive {
  stamp: string
  files: Map<string, VromfsFile>
  names: VromfsBlkNames | null
  blk: Map<string, BlkMap | null>
}

interface PackIndex {
  stamp: string
  entries: Map<string, DxpEntry>
}

const archives = new Map<string, Archive>()
const packs = new Map<string, PackIndex>()

function fileStamp(file: string): string {
  const info = statSync(file)
  return `${info.size}:${Math.round(info.mtimeMs)}`
}

export class GameFiles {
  constructor(readonly dir: string) {}

  private resolve(rel: string): string {
    return path.join(this.dir, ...rel.split('/'))
  }

  /** Size and mtime of every source: a new stamp means a new game version. */
  sourcesStamp(): string {
    return Object.values(TACTICAL_MAP_SOURCES).map((rel) => `${rel}=${fileStamp(this.resolve(rel))}`).join(';')
  }

  archive(rel: string): Archive {
    const file = this.resolve(rel)
    const stamp = fileStamp(file)
    const cached = archives.get(file)
    if (cached?.stamp === stamp) return cached
    const files = unpackVromfs(readFileSync(file))
    const archive: Archive = {
      stamp,
      files: new Map(files.map((entry) => [entry.name.toLowerCase(), entry])),
      names: vromfsBlkNames(files),
      blk: new Map(),
    }
    archives.set(file, archive)
    return archive
  }

  /** A raw file of an archive; null when absent. */
  file(archiveRel: string, name: string): Buffer | null {
    return this.archive(archiveRel).files.get(name.toLowerCase())?.data ?? null
  }

  /** A BLK of an archive as a tree; null when absent. */
  blk(archiveRel: string, name: string): BlkMap | null {
    const archive = this.archive(archiveRel)
    const key = name.toLowerCase().replace(/\\/g, '/')
    if (archive.blk.has(key)) return archive.blk.get(key)!
    const entry = archive.files.get(key)
    const tree = entry ? parseBlk(entry.data, archive.names) : null
    archive.blk.set(key, tree)
    return tree
  }

  /** A texture of a DxP2 pack, read from the file by its byte range. */
  texture(packRel: string, name: string): RgbaImage | null {
    const file = this.resolve(packRel)
    const stamp = fileStamp(file)
    const fd = openSync(file, 'r')
    try {
      let index = packs.get(file)
      if (index?.stamp !== stamp) {
        const length = statSync(file).size
        const head = readRange(fd, 0, 16)
        index = { stamp, entries: readDxpIndex(readRange(fd, 0, dxpIndexSize(head)), length) }
        packs.set(file, index)
      }
      const entry = index.entries.get(name)
      if (!entry) return null
      const packed = readRange(fd, entry.offset, entry.size)
      return decodeDdsxTexture(entry.header, unpackDdsxData(entry.header, packed))
    } finally {
      closeSync(fd)
    }
  }
}

function readRange(fd: number, offset: number, size: number): Buffer {
  const out = Buffer.alloc(size)
  let done = 0
  while (done < size) {
    const read = readSync(fd, out, done, size - done, offset + done)
    if (read === 0) throw new Error(`unexpected end of file at ${offset + done}`)
    done += read
  }
  return out
}
