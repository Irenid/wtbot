import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseBlk, type BlkMap } from '../wrpl/blk.js'
import { unpackVromfs, vromfsBlkNames, type VromfsBlkNames, type VromfsFile } from '../wrpl/vromfs.js'
import { decodeDdsxTexture, dxpIndexSize, readDxpIndex, unpackDdsxData, type DxpEntry, type RgbaImage } from './dxp.js'

/**
 * Read access to a War Thunder install for the tactical map builder. Runs in
 * a CPU worker with synchronous I/O. Archives are unpacked once per worker and
 * reused while their size and mtime stay the same (a game patch replaces them),
 * then released, with the last decoded map texture, after ARCHIVE_IDLE_MS
 * unused: aces.vromfs.bin alone takes ~130 MB unpacked, and every worker of
 * the pool may build a map.
 */

/** Every game file a map needs, relative to the game folder. */
export const TACTICAL_MAP_SOURCES = {
  missions: 'mis.vromfs.bin',
  config: 'aces.vromfs.bin',
  maps: 'content/base/res/locations_maps.dxp.bin',
  icons: 'ui/atlases.vromfs.bin',
  textures: 'ui/tex.vromfs.bin',
  fonts: 'ui/fonts.vromfs.bin',
} as const

/**
 * Used when present: the HQ textures (the launcher's optional high-quality pack):
 * 2048² tank and air maps of every squadron level where the base pack has 1024²
 * (avg_ireland_tankmap and avg_falklands are 4096² there and empty here).
 */
export const TACTICAL_MAP_OPTIONAL_SOURCES = {
  mapsHq: 'content.hq/hq_tex/res/hq_tex_locations_maps.dxp.bin',
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
/** The last decoded map texture: an air heatmap draws its map once per perspective. */
let lastTexture: { key: string; image: RgbaImage } | null = null
const ARCHIVE_IDLE_MS = 60_000
let usedAt = 0
let releaseTimer: NodeJS.Timeout | null = null

/** Marks the caches used; ARCHIVE_IDLE_MS after the last use they are dropped. */
function touchCaches(): void {
  usedAt = Date.now()
  if (releaseTimer) return
  releaseTimer = setTimeout(releaseIdleCaches, ARCHIVE_IDLE_MS)
  releaseTimer.unref()
}

function releaseIdleCaches(): void {
  const idle = Date.now() - usedAt
  if (idle >= ARCHIVE_IDLE_MS) {
    archives.clear()
    lastTexture = null
    releaseTimer = null
    return
  }
  releaseTimer = setTimeout(releaseIdleCaches, ARCHIVE_IDLE_MS - idle)
  releaseTimer.unref()
}

function fileStamp(file: string): string {
  const info = statSync(file)
  return `${info.size}:${Math.round(info.mtimeMs)}`
}

export class GameFiles {
  constructor(readonly dir: string) {}

  private resolve(rel: string): string {
    return path.join(this.dir, ...rel.split('/'))
  }

  archive(rel: string): Archive {
    touchCaches()
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

  /** A texture of a DxP2 pack, read from the file by its byte range; null when absent. */
  texture(packRel: string, name: string): RgbaImage | null {
    const entry = this.textureEntry(packRel, name)
    return entry ? this.decode(packRel, entry) : null
  }

  /**
   * A map texture at the best resolution installed: the HQ pack's when it is
   * present, readable and larger (2048² over 1024²), else the base pack's. An
   * unreadable HQ pack (a partial copy, an interrupted download) is skipped.
   */
  mapTexture(name: string): RgbaImage | null {
    touchCaches()
    const base = this.textureEntry(TACTICAL_MAP_SOURCES.maps, name)
    const hq = this.hqTextureEntry(name)
    const [pack, entry] = hq && hq.header.width > (base?.header.width ?? 0)
      ? [TACTICAL_MAP_OPTIONAL_SOURCES.mapsHq, hq] as const
      : [TACTICAL_MAP_SOURCES.maps, base] as const
    if (!entry) return null
    const key = `${this.resolve(pack)}:${packs.get(this.resolve(pack))?.stamp}:${name}`
    if (lastTexture?.key === key) return lastTexture.image
    let image: RgbaImage
    try {
      image = this.decode(pack, entry)
    } catch (error) {
      if (pack === TACTICAL_MAP_SOURCES.maps || !base) throw error
      image = this.decode(TACTICAL_MAP_SOURCES.maps, base)
    }
    lastTexture = { key, image }
    return image
  }

  /** Whether a map texture is installed (an index lookup, no decoding). */
  hasMapTexture(name: string): boolean {
    return (this.textureEntry(TACTICAL_MAP_SOURCES.maps, name)?.header.width ?? 0) > 0 || (this.hqTextureEntry(name)?.header.width ?? 0) > 0
  }

  private hqTextureEntry(name: string): DxpEntry | null {
    if (!existsSync(this.resolve(TACTICAL_MAP_OPTIONAL_SOURCES.mapsHq))) return null
    try {
      return this.textureEntry(TACTICAL_MAP_OPTIONAL_SOURCES.mapsHq, name)
    } catch {
      return null
    }
  }

  private textureEntry(packRel: string, name: string): DxpEntry | null {
    const file = this.resolve(packRel)
    const stamp = fileStamp(file)
    let index = packs.get(file)
    if (index?.stamp !== stamp) {
      const fd = openSync(file, 'r')
      try {
        const head = readRange(fd, 0, 16)
        index = { stamp, entries: readDxpIndex(readRange(fd, 0, dxpIndexSize(head)), statSync(file).size) }
      } finally {
        closeSync(fd)
      }
      packs.set(file, index)
    }
    return index.entries.get(name) ?? null
  }

  private decode(packRel: string, entry: DxpEntry): RgbaImage {
    const fd = openSync(this.resolve(packRel), 'r')
    try {
      return decodeDdsxTexture(entry.header, unpackDdsxData(entry.header, readRange(fd, entry.offset, entry.size)))
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
