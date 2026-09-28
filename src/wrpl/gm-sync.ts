/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Содержит код, портированный из WrplReplayParser
 * (Copyright (c) 2025 LivingTheDagor, BSD-3-Clause) и Dagor Engine
 * (Copyright (c) 2023 Gaijin Entertainment, BSD-3-Clause). Изменено участниками
 * wtbot в 2026 году. Полные тексты лицензий и обязательные уведомления
 * BSD-3-Clause — в LICENSES/BSD-3-Clause-WrplReplayParser.txt и
 * LICENSES/BSD-3-Clause-DagorEngine.txt. Файл распространяется как часть wtbot
 * на условиях GNU AGPL-3.0-or-later; полный текст — в LICENSE. Без гарантий.
 */
import { BitReader, EofError } from './bit-reader.js'
import type { SpaceTime } from './replay-events.js'

/**
 * GMSync — позиции наземной техники из MPI-сообщения
 * GroundModelPositionsServerReplay (сигнатура 02 58 74 f0).
 *
 * Порт с C++: WrplReplayParser (LivingTheDagor, BSD-3-Clause) —
 * replay/mpi/PositionSync.cpp, плюс движковый daNet из Dagor Engine
 * (Gaijin, BSD-3-Clause): delta/deltaCompression.cpp, delta/rle.cpp,
 * delta/diff_impl.h. Устройство:
 *
 *  - пакет несёт обновления для диапазона юнитов [uidLower, uidUpper);
 *  - состояние каждого юнита сжато дельтой против одного из 32 предыдущих
 *    состояний ЭТОГО юнита (кольцо истории): XOR-diff, свёрнутый битовым
 *    RLE-кодеком rle0ki; первый пакет юнита приходит целиком (fullDiff);
 *  - внутри восстановленного состояния — ориентация, позиция (3×float32
 *    или упакованная в 2×uint32: x/z — 22 бита на ±36000 м, y — 20 бит
 *    на −100..7900 м), скорости, башни, сенсоры и прочее.
 *
 * Ошибка разбора одного юнита не мешает остальным: границы состояний
 * известны из дельта-слоя, разбор каждого состояния изолирован.
 */

const HISTORY_BITS = 5
const INDEX_BITS = 13
const HISTORY_SIZE = 1 << HISTORY_BITS

// ---------- битовый RLE-кодек rle0ki (delta/rle.cpp) ----------

const RLE0_PARITY_NO = 111
const RLE0_PARITY_YES = 222

/** Распаковка rle0ki; вход и выход — последовательности 2-битных юнитов */
export function rle0kiDecompress(src: Buffer, maxOut: number): Buffer {
  if (!Number.isSafeInteger(maxOut) || maxOut < 0) throw new RangeError('rle0ki: некорректный maxOut')
  if (src.length === 0) return Buffer.alloc(0)
  const parity = src[src.length - 1]!
  if (parity !== RLE0_PARITY_NO && parity !== RLE0_PARITY_YES) return Buffer.alloc(0)
  return rle0kiDecompressInto(src, Buffer.allocUnsafe(maxOut))
}

function rle0kiDecompressInto(src: Buffer, out: Buffer): Buffer {
  if (src.length === 0) return Buffer.alloc(0)
  const limit = src.length - 1
  const parity = src[limit]!
  if (parity !== RLE0_PARITY_NO && parity !== RLE0_PARITY_YES) return Buffer.alloc(0)

  let code = -1
  let offset = 0
  let outputByte = 0
  let d = 0
  let super_ = -1

  for (let i = 0; i < limit; i++) {
    const klim = i !== limit - 1 || parity === RLE0_PARITY_YES ? 2 : 1
    for (let k = 0; k < klim; k++) {
      let first = (src[i]! >> (k * 4)) & 3
      let second = (src[i]! >> (2 + k * 4)) & 3
      let num = 0

      if (code !== 4) code = first

      switch (code) {
        case 0: // zr0: 3–6 нулей
          num = second + 3
          first = second = 0
          break
        case 3: // zr1: 7–10 нулей
          num = second + 7
          first = second = 0
          break
        case 1: // ki6: три юнита как есть (первый — сейчас, ещё два следом)
          code = 4
          super_ = second
          num = 1
          first = second
          break
        case 2: // ki2: один юнит как есть
          num = 1
          first = second
          break
        case 4: // хвост ki6
          code = -1
          num = 2
          if (super_ === 0 && first === 0 && second === 0) num = 39
          break
      }

      if (d + Math.ceil((offset + num) / 4) > out.length) {
        throw new Error('rle0ki: выход за буфер')
      }
      let n = 0
      while (n < num && offset > 0) {
        outputByte |= (n & 1 ? second : first) << (offset * 2)
        offset++
        n++
        if (offset === 4) {
          out[d] = outputByte
          offset = 0
          outputByte = 0
          d++
        }
      }
      if (n + 4 <= num) {
        const pair = n & 1
          ? second | (first << 2) | (second << 4) | (first << 6)
          : first | (second << 2) | (first << 4) | (second << 6)
        while (n + 4 <= num) {
          out[d] = pair
          d++
          n += 4
        }
      }
      while (n < num) {
        outputByte |= (n & 1 ? second : first) << (offset * 2)
        offset++
        n++
      }
    }
  }
  if (offset > 0) out[d] = outputByte
  return out.subarray(0, offset > 0 ? d + 1 : d)
}

// ---------- XOR-патч (delta/diff_impl.h + history.cpp) ----------

/** result[i] = base[i]^delta[i], хвост — из более длинного; длина = длине дельты */
function applyPatch(base: Buffer, delta: Buffer): Buffer {
  const lower = Math.min(base.length, delta.length)
  const out = Buffer.allocUnsafe(delta.length)
  for (let i = 0; i < lower; i++) out[i] = base[i]! ^ delta[i]!
  if (delta.length > lower) delta.copy(out, lower, lower)
  return out
}

// ---------- дельта-декомпрессия (delta/deltaCompression.cpp) ----------

class DeltaHistory {
  baseHist: (Buffer | null)[] = new Array(HISTORY_SIZE).fill(null)
  curPacketNo = 0

  isValidBase(packetNo: number): boolean {
    if (((this.curPacketNo - packetNo) >>> 0) >= HISTORY_SIZE) return false
    const b = this.baseHist[packetNo & (HISTORY_SIZE - 1)]
    return b !== null && b !== undefined && b.length > 0
  }
}

/** Индексы по модулю 2^bits: идёт ли idx1 раньше idx2 с учётом переполнения */
function idxLess(idx1: number, idx2: number, bits: number): boolean {
  const d = (idx2 - idx1) & ((1 << bits) - 1)
  return d < 1 << (bits - 1)
}

/** Читает один дельта-блок из r, возвращает восстановленное состояние или null */
function readDelta(r: BitReader, history: DeltaHistory, rleScratch: Buffer): Buffer | null {
  const fullDiff = r.readBit()
  const packetNoDelta = r.readUnsignedBits(HISTORY_BITS)
  const nextPacketNo = r.readUnsignedBits(INDEX_BITS)
  const compressedSize = r.readCompressed()
  r.alignToByteBoundary()
  const encoded = r.readBytes(compressedSize)
  const block = fullDiff ? Buffer.from(encoded) : encoded

  const basePacketNo = (nextPacketNo - packetNoDelta) >>> 0
  if (!fullDiff && !history.isValidBase(basePacketNo)) return null // базы нет — ждём fullDiff

  let result: Buffer
  if (fullDiff) {
    result = block
  } else {
    const delta = rle0kiDecompressInto(block, rleScratch)
    result = applyPatch(history.baseHist[basePacketNo & (HISTORY_SIZE - 1)]!, delta)
  }

  let inOrder = idxLess(history.curPacketNo, nextPacketNo, INDEX_BITS)
  if (!inOrder && idxLess(nextPacketNo + HISTORY_SIZE - 1, history.curPacketNo, INDEX_BITS)) {
    if (fullDiff) inOrder = true // слишком старый полный пакет — принимаем как сброс
    else return null
  }
  if (inOrder) {
    // очистить кольцо на промежутке (cur; next] — эти записи устарели
    let cur = history.curPacketNo
    let iter = 0
    while (cur !== nextPacketNo && iter++ < HISTORY_SIZE) {
      cur = (cur + 1) >>> 0
      history.baseHist[cur & (HISTORY_SIZE - 1)] = null
    }
    history.curPacketNo = nextPacketNo
  }
  history.baseHist[nextPacketNo & (HISTORY_SIZE - 1)] = result
  return result
}

// ---------- разбор состояния машины (ParseVehicleInfo) ----------

function unpackPackedPos(tv1: number, tv2: number): { x: number; y: number; z: number } {
  const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))
  const x = clamp1((tv1 >>> 10) * 4.7683727e-7 - 1) * 36000
  const y = ((((tv1 & 0x3ff) << 10) | (tv2 >>> 22)) >>> 0) * 0.007629402 - 100
  const z = clamp1((tv2 & 0x3fffff) * 4.7683727e-7 - 1) * 36000
  return { x, y, z }
}

function readSensor(r: BitReader): void {
  const firstBool = r.readBit()
  const sensorType = r.readByte() >> 4
  switch (sensorType) {
    case 1: {
      if (!r.readBit()) return
      const bitPacked = r.readU16()
      r.readBytes(4) // f32
      r.readU16()
      r.readU16()
      r.readU16()
      if (bitPacked & 0x8000) r.readByte()
      if (r.readBit()) r.readByte()
      break
    }
    case 2: {
      if (!firstBool) return
      r.readBit()
      r.readU16()
      r.ignoreBytes(24)
      r.readU32()
      break
    }
    case 4:
      if (r.readBit()) r.ignoreBytes(12)
      break
    default:
      throw new Error(`gm: сенсор типа ${sensorType}`)
  }
  if (r.readBit()) {
    const count = r.readUnsignedBits(6)
    for (let i = 0; i < count; i++) r.readU32()
    r.ignoreBits(6)
  }
}

function readTarget(r: BitReader): void {
  r.readByte()
  r.readByte()
  if (r.readBit()) r.ignoreBytes(12) // Point3
  if (r.readBit()) {
    r.ignoreBytes(12) // Point3
    r.ignoreBytes(6) // 3×i16 (read_vector)
  } else {
    r.ignoreBytes(24) // 2×Point3
  }
  r.readU32() // f32
  r.readBit()
  r.readBit()
  if (r.readBit()) r.readByte()
  r.readBit()
  const hasV14 = r.readBit()
  r.readBit()
  if (hasV14) r.readByte()
  if (r.readBit()) r.readU32()
}

/**
 * Состояние машины из восстановленного дельта-потока.
 * Возвращает позицию (если в этом состоянии она есть).
 */
export function parseVehicleState(
  state: Buffer,
  val1: boolean,
  turretCount: number,
): { x: number; y: number; z: number } | null {
  const r = new BitReader(state)
  let pos: { x: number; y: number; z: number } | null = null

  r.readByte() // v1
  if (r.readBit()) {
    if (val1) {
      r.ignoreBytes(16) // 4×f32
      if (r.readBit()) r.ignoreBytes(84) // 21×f32
    } else {
      r.ignoreBytes(6) // euler 3×i16
    }
    r.readBit() // bool2
    const rawPos = r.readBit()
    if (rawPos) {
      const b = r.readBytes(12)
      pos = { x: b.readFloatLE(0), y: b.readFloatLE(4), z: b.readFloatLE(8) }
    } else {
      const tv1 = r.readU32()
      const tv2 = r.readU32()
      pos = unpackPackedPos(tv1, tv2)
    }
    if (val1) r.ignoreBytes(12) // скорость 3×f32
    else r.ignoreBytes(6) // 3×i16
    r.ignoreBytes(3) // 3×i8
    if (r.readBit()) r.ignoreBytes(4)
    r.readByte() // local_584
    if (r.readBit()) {
      // bool5: редкий блок (порт из декомпилята как есть)
      r.ignoreBytes(6)
      if (r.readBit()) r.ignoreBytes(2)
      r.readBit()
      r.ignoreBytes(4)
      r.ignoreBytes(4)
    }
    r.readBit()
    r.readBit()
    if (r.readBit()) {
      // bool8: набор флагов и битовых полей
      r.readByte()
      for (let i = 0; i < 7; i++) r.readBit()
      r.readByte()
      r.readByte()
      r.ignoreBits(5)
      r.ignoreBits(4)
      r.ignoreBits(4)
      r.ignoreBits(2)
      r.ignoreBits(3)
      r.ignoreBits(4)
    }
    if (r.readBit()) {
      const subCount = r.readByte()
      if (subCount > 4) throw new Error(`gm: субмашин ${subCount} > 4`)
      for (let i = 0; i < subCount; i++) {
        r.ignoreBytes(6) // euler 3×i16
        r.ignoreBytes(3) // 3×i8
        r.ignoreBytes(12) // Point3
      }
    }
  }

  const b2 = r.readBit()
  r.readBit() // b3
  for (let i = 0; i < turretCount; i++) {
    r.readBit()
    r.readByte()
    if (r.readBit()) r.readByte()
    r.readBit()
    r.readBit()
    if (b2 && r.readBit()) {
      r.readU16()
      r.readU16()
      r.readByte()
      r.readByte()
      if (r.readBit()) r.readU16()
    }
  }

  const sensors = r.readByte()
  if (sensors > 4) throw new Error(`gm: сенсоров ${sensors} > 4`)
  for (let i = 0; i < sensors; i++) readSensor(r)
  if (sensors > 0) r.readByte()

  const cm = r.readByte()
  for (let i = 0; i < cm; i++) r.ignoreBytes(2)

  const targets = r.readUnsignedBits(4)
  if (targets > 8) throw new Error(`gm: целей ${targets} > 8`)
  for (let i = 0; i < targets; i++) readTarget(r)

  return pos
}

// ---------- сам GMSync ----------

export class GmSyncParser {
  /** uid юнита → траектория */
  paths = new Map<number, SpaceTime[]>()
  private histories = new Map<number, DeltaHistory>()
  private readonly rleScratch = Buffer.allocUnsafe(4096)
  errors = 0

  private historyOf(uid: number): DeltaHistory {
    let h = this.histories.get(uid)
    if (!h) {
      h = new DeltaHistory()
      this.histories.set(uid, h)
    }
    return h
  }

  /** Пакет 02 58 74 f0 (или 73 f0); time — время пакета, мс */
  parse(payload: Buffer, time: number): void {
    // Тело обёрнуто в BitStream с varint-префиксом длины в битах
    const outer = new BitReader(payload.subarray(4))
    const bodyBits = outer.readCompressed()
    outer.alignToByteBoundary()
    const start = outer.bitOffset >> 3
    const r = new BitReader(payload.subarray(4 + start, 4 + start + ((bodyBits + 7) >> 3)))

    const uidLower = r.readU16()
    const uidUpper = r.readU16()
    r.readU32() // f32 время сервера
    r.readU16() // порядковый номер
    if (uidUpper - uidLower > 4096) throw new Error(`gm: диапазон юнитов ${uidLower}..${uidUpper}`)

    for (let uid = uidLower; uid < uidUpper; uid++) {
      if (!r.readBit()) continue
      r.readBit() // bool2
      if (r.readBit()) r.ignoreBits(4)
      const val2 = r.readBit()
      const val3 = r.readBit()
      if (val2 && val3) continue

      r.readBit() // bool5
      const val1 = r.readBit()
      const turretCount = r.readByte()
      const isCompressed = r.readBit()
      if (!isCompressed) throw new Error('gm: несжатое состояние (не серверный реплей?)')

      const state = readDelta(r, this.historyOf(uid), this.rleScratch)
      if (state) {
        try {
          const pos = parseVehicleState(state, val1, turretCount)
          if (pos) {
            let path = this.paths.get(uid)
            if (!path) {
              path = []
              this.paths.set(uid, path)
            }
            path.push({ t: time, ...pos })
          }
        } catch (err) {
          // Позиции этого обновления не будет, но дельта-слой цел —
          // следующие состояния юнита восстановятся нормально
          this.errors++
          if (!(err instanceof EofError) && this.errors < 3) {
            console.warn('[wrpl] gm-sync:', (err as Error).message)
          }
        }
      }

      if (r.readBit()) r.ignoreBytes(16) // 4×f32
      if (r.readBit() && turretCount > 0) {
        for (let i = 0; i < turretCount; i++) {
          if (!r.readBit()) continue
          r.readByte()
          r.readU32()
          r.readU32()
          const n = r.readByte()
          for (let j = 0; j < n; j++) r.readU16()
        }
      }
      if (r.readBit() && r.readBit()) {
        const skip = r.readU32() // seeker: размер в битах
        r.ignoreBits(skip)
      }
      r.alignToByteBoundary()
    }
  }
}
