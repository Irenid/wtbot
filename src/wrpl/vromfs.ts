import { zstdDecompressSync } from 'node:zlib'

/**
 * Распаковка контейнера VROMFS — в таких War Thunder хранит ресурсы
 * (например, ui/fonts.vromfs.bin со шрифтами игры).
 *
 * Формат разобран по коду klensy/wt-tools (vromfs_parser.py):
 *   0   магия "VRFs" | "VRFx"
 *   4   платформа "\0\0PC" | "\0iOS" | "\0and"
 *   8   размер распакованного образа (u32)
 *   12  размер сжатых данных (3 байта LE) + тип (байт):
 *       0xC0 — zstd с обфускацией, 0x80 — без сжатия, 0x40 — неизвестный
 *   16  (только VRFx) доп. заголовок 8 байт — пропускаем
 *
 * Обфускация zstd-потока: первые 16 байт и последние выровненные по 4
 * 16 байт XOR-ятся с фиксированными ключами.
 *
 * Образ внутри: u32 смещение таблицы имён, u32 число файлов,
 * u32 на смещении 16 — таблица данных (записи по 16 байт: смещение, размер).
 */

const KEY_HEAD = [0xaa55aa55, 0xf00ff00f, 0xaa55aa55, 0x12481248]
const KEY_TAIL = [0x12481248, 0xaa55aa55, 0xf00ff00f, 0xaa55aa55]

function xor16(buf: Buffer, off: number, key: number[]): void {
  for (let i = 0; i < 4; i++) {
    buf.writeUInt32LE((buf.readUInt32LE(off + i * 4) ^ key[i]!) >>> 0, off + i * 4)
  }
}

export interface VromfsFile {
  name: string
  data: Buffer
}

export function unpackVromfs(raw: Buffer): VromfsFile[] {
  const magic = raw.subarray(0, 4).toString('latin1')
  if (magic !== 'VRFs' && magic !== 'VRFx') throw new Error(`не VROMFS: магия "${magic}"`)
  const originalSize = raw.readUInt32LE(8)
  const packedSize = raw.readUInt32LE(12) & 0xffffff
  const type = raw[15]!
  let off = 16
  if (magic === 'VRFx') off += 8

  let image: Buffer
  if (type === 0xc0 && packedSize > 0) {
    const packed = Buffer.from(raw.subarray(off, off + packedSize))
    if (packed.length >= 16) xor16(packed, 0, KEY_HEAD)
    if (packed.length >= 32) xor16(packed, (packed.length & ~3) - 16, KEY_TAIL)
    image = zstdDecompressSync(packed, { maxOutputLength: Math.max(originalSize, 1 << 26) })
  } else {
    image = Buffer.from(raw.subarray(off, off + originalSize))
  }

  const filenameTableOffset = image.readUInt32LE(0)
  const filesCount = image.readUInt32LE(4)
  const filedataTableOffset = image.readUInt32LE(16)

  // Имена: по смещению таблицы лежит смещение первой строки,
  // дальше filesCount нуль-терминированных строк подряд
  const firstNameOffset = image.readUInt32LE(filenameTableOffset)
  const names: string[] = []
  let p = firstNameOffset
  for (let i = 0; i < filesCount; i++) {
    const end = image.indexOf(0, p)
    if (end < 0) throw new Error('VROMFS: таблица имён обрезана')
    names.push(image.subarray(p, end).toString('utf8'))
    p = end + 1
  }

  const files: VromfsFile[] = []
  for (let i = 0; i < filesCount; i++) {
    const rec = filedataTableOffset + i * 16
    const dataOff = image.readUInt32LE(rec)
    const dataSize = image.readUInt32LE(rec + 4)
    if (dataOff + dataSize > image.length) throw new Error(`VROMFS: файл ${names[i]} выходит за границы образа`)
    files.push({ name: names[i]!, data: image.subarray(dataOff, dataOff + dataSize) })
  }
  return files
}
