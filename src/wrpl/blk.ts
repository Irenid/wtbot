/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Портировано из wrpl-inspector (Copyright (C) 2025 flexcoral),
 * https://github.com/maxsupermanhd/wrpl-inspector, ветка v3.
 * Изменено участниками wtbot в 2026 году: порт на TypeScript и адаптация к
 * архитектуре wtbot. Распространяется на условиях GNU AGPL-3.0-or-later; полный
 * текст лицензии — в файле LICENSE в корне репозитория. Без каких-либо гарантий.
 */
import { zstdDecompressSync } from 'node:zlib'
import { MAX_BLK_DECOMPRESSED_BYTES } from './decompression-limits.js'

/**
 * Разбор бинарного формата BLK (Gaijin/Dagor Engine) — в нём War Thunder
 * хранит настройки и результаты боя внутри реплеев .wrpl.
 *
 * Портировано с Go-библиотеки wrpl-inspector (AGPL-3.0, автор flexcoral):
 * https://github.com/maxsupermanhd/wrpl-inspector — файл wrpl/blk.go.
 *
 * Поддержаны варианты FAT (0x01) и FAT_ZSTD (0x02) — их достаточно для
 * results-BLK серверных реплеев. SLIM-варианты требуют внешний словарь имён
 * из файлов игры и здесь не нужны.
 */

export type BlkValue = string | number | boolean | BlkValue[] | BlkMap
export interface BlkMap {
  [key: string]: BlkValue
}

export function parseBlk(input: Buffer): BlkMap {
  if (input.length === 0) throw new Error('пустой BLK-буфер')
  switch (input[0]) {
    case 0x01: // FAT
      return parseFatBlk(input.subarray(1))
    case 0x02: {
      // FAT_ZSTD: 3 байта длины (big-endian), затем zstd-поток
      if (input.length < 4) throw new Error('FAT_ZSTD: обрезанный заголовок')
      const len = (input[1]! << 16) | (input[2]! << 8) | input[3]!
      if (input.length < 4 + len) {
        throw new Error(`FAT_ZSTD: сжатые данные обрезаны: нужно ${4 + len}, есть ${input.length}`)
      }
      const out = zstdDecompressSync(input.subarray(4, 4 + len), {
        maxOutputLength: MAX_BLK_DECOMPRESSED_BYTES,
      })
      if (out.length === 0 || out[0] !== 0x01) {
        throw new Error('FAT_ZSTD: внутри нет FAT-заголовка')
      }
      return parseFatBlk(out.subarray(1))
    }
    case 0x03:
      throw new Error('SLIM BLK не поддерживается')
    case 0x04:
      throw new Error('SLIM_ZSTD BLK не поддерживается (нужен внешний словарь имён)')
    case 0x05:
      throw new Error('SLIM_ZSTD_DICT BLK не поддерживается (нужен словарь)')
    case 0x00:
      throw new Error('легаси-формат BBF не поддерживается')
    default:
      throw new Error(`неизвестный заголовок BLK 0x${input[0]!.toString(16).padStart(2, '0')}`)
  }
}

/**
 * Предел вложенности дерева. Реальные BLK реплеев и миссий неглубокие;
 * предел защищает стек от цепочки из сотен тысяч блоков.
 */
const MAX_BLK_DEPTH = 256

interface BlockDesc {
  nameId: number
  fieldCount: number
  childCount: number
  firstChild: number
}

function parseFatBlk(buf: Buffer): BlkMap {
  const ptr = { at: 0 }

  readUleb128(buf, ptr) // names_count — не нужен, имена разделены нулями
  const namesSize = readUleb128(buf, ptr)
  if (ptr.at + namesSize > buf.length) throw new Error('буфер имён обрезан')
  const names = parseNullSeparatedStrings(buf.subarray(ptr.at, ptr.at + namesSize))
  ptr.at += namesSize

  const totalBlocks = readUleb128(buf, ptr)
  const paramsCount = readUleb128(buf, ptr)
  const paramsDataSize = readUleb128(buf, ptr)
  if (ptr.at + paramsDataSize > buf.length) throw new Error('данные параметров обрезаны')
  const paramsData = buf.subarray(ptr.at, ptr.at + paramsDataSize)
  ptr.at += paramsDataSize

  if (paramsCount > Math.floor((buf.length - ptr.at) / 8)) {
    throw new Error('описания параметров обрезаны')
  }
  const paramsInfo = buf.subarray(ptr.at, ptr.at + paramsCount * 8)
  ptr.at += paramsCount * 8

  // Описания блоков: имя, число полей, число детей, индекс первого ребёнка
  if (totalBlocks > Math.floor((buf.length - ptr.at) / 3)) {
    throw new Error('описания блоков обрезаны')
  }
  const descs: BlockDesc[] = []
  for (let i = 0; i < totalBlocks; i++) {
    const nameId = readUleb128(buf, ptr)
    const fieldCount = readUleb128(buf, ptr)
    const childCount = readUleb128(buf, ptr)
    const firstChild = childCount > 0 ? readUleb128(buf, ptr) : 0
    descs.push({ nameId, fieldCount, childCount, firstChild })
  }

  // Один параметр: 3 байта id имени, 1 байт типа, 4 байта данных/смещения
  function getNthParam(index: number): { name: string; value: BlkValue } {
    const start = index * 8
    if (start + 8 > paramsInfo.length) throw new Error(`параметр[${index}]: вне границ`)
    const nameId = paramsInfo[start]! | (paramsInfo[start + 1]! << 8) | (paramsInfo[start + 2]! << 16)
    const typeId = paramsInfo[start + 3]!
    const data = paramsInfo.subarray(start + 4, start + 8)

    const name = names[nameId]
    if (name === undefined) throw new Error(`параметр[${index}]: id имени ${nameId} вне диапазона`)

    const readAt = (off: number, n: number): Buffer => {
      if (off < 0 || off + n > paramsData.length) {
        throw new Error(`параметр[${index}]: смещение вне границ`)
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
        // STRING: старший бит — строка лежит в таблице имён, иначе в данных
        const raw = data.readUInt32LE(0)
        const inNames = raw >>> 31 === 1
        const off = raw & 0x7fffffff
        if (inNames) {
          const s = names[off]
          if (s === undefined) throw new Error(`параметр[${index}]: строка ${off} вне таблицы имён`)
          value = s
        } else {
          const rest = paramsData.subarray(off)
          const end = rest.indexOf(0)
          if (end < 0) throw new Error(`параметр[${index}]: строка без терминатора`)
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
        // FLOAT12: матрица 4 строки по 3 float
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
        // LONG (int64) — числа боя влезают в double
        const off = data.readUInt32LE(0)
        const bs = readAt(off, 8)
        value = Number(bs.readBigInt64LE(0))
        break
      }
      case 0x0d: // INT4
        value = ints(data.readUInt32LE(0), 4)
        break
      default:
        throw new Error(`параметр[${index}]: неизвестный тип 0x${typeId.toString(16)}`)
    }
    return { name, value }
  }

  // Раскладываем параметры по блокам в порядке следования
  let paramPtr = 0
  const flat: { name: string; fields: { name: string; value: BlkValue }[]; childCount: number; firstChild: number }[] = []
  for (const d of descs) {
    let name = 'root'
    if (d.nameId !== 0) {
      const n = names[d.nameId - 1]
      if (n === undefined) throw new Error(`блок: индекс имени ${d.nameId - 1} вне диапазона`)
      name = n
    }
    const fields = []
    if (d.fieldCount > paramsCount - paramPtr) {
      throw new Error('блок ссылается на параметры вне диапазона')
    }
    for (let j = 0; j < d.fieldCount; j++) fields.push(getNthParam(paramPtr + j))
    paramPtr += d.fieldCount
    flat.push({ name, fields, childCount: d.childCount, firstChild: d.firstChild })
  }

  // Собираем дерево; повторяющиеся ключи склеиваются в массив. В корректном
  // FAT BLK у каждого блока ровно один родитель. Без этой проверки DAG из
  // общих потомков (i → i+1, i+2) разворачивается экспоненциально: 85 байт
  // входа давали десятки тысяч объектов. С ней каждый блок строится не более
  // одного раза, и размер дерева линеен по входу.
  const visiting = new Set<number>()
  const claimed = new Uint8Array(flat.length)
  claimed[0] = 1
  function build(idx: number, depth: number): BlkMap {
    const fb = flat[idx]
    if (!fb) throw new Error(`блок ${idx} вне диапазона`)
    if (depth > MAX_BLK_DEPTH) throw new Error(`дерево BLK глубже ${MAX_BLK_DEPTH} уровней`)
    if (fb.firstChild > flat.length || fb.childCount > flat.length - fb.firstChild) {
      throw new Error(`дочерние блоки ${idx} вне диапазона`)
    }
    visiting.add(idx)
    const m: BlkMap = {}
    for (const f of fb.fields) putKV(m, f.name, f.value)
    for (let c = fb.firstChild; c < fb.firstChild + fb.childCount; c++) {
      const child = flat[c]
      if (!child) throw new Error(`дочерний блок ${c} вне диапазона`)
      if (visiting.has(c)) throw new Error(`цикл в дереве BLK на блоке ${c}`)
      if (claimed[c] === 1) throw new Error(`блок ${c} повторно встречается в дереве BLK`)
      claimed[c] = 1
      putKV(m, child.name, build(c, depth + 1))
    }
    visiting.delete(idx)
    return m
  }

  return build(0, 0)
}

function putKV(m: BlkMap, k: string, v: BlkValue): void {
  const existing = m[k]
  if (existing === undefined) {
    m[k] = v
  } else if (Array.isArray(existing)) {
    existing.push(v)
  } else {
    m[k] = [existing, v]
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
  // Через умножение, а не сдвиги: битовые операции в JS 32-битные
  let val = 0
  let mult = 1
  while (ptr.at < b.length) {
    const cur = b[ptr.at]!
    ptr.at++
    const part = (cur & 0x7f) * mult
    if (!Number.isSafeInteger(part) || val > Number.MAX_SAFE_INTEGER - part) {
      throw new Error('uleb128: переполнение')
    }
    val += part
    if ((cur & 0x80) === 0) return val
    if (mult > Number.MAX_SAFE_INTEGER / 128) throw new Error('uleb128: переполнение')
    mult *= 128
  }
  throw new Error('uleb128: буфер закончился')
}
