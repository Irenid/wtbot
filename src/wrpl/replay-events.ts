/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Портировано из wrpl-inspector (Copyright (C) 2025 flexcoral),
 * https://github.com/maxsupermanhd/wrpl-inspector, ветка v3.
 * Изменено участниками wtbot в 2026 году: порт на TypeScript и адаптация к
 * архитектуре wtbot. Распространяется на условиях GNU AGPL-3.0-or-later; полный
 * текст лицензии — в файле LICENSE в корне репозитория. Без каких-либо гарантий.
 */
import { inflateSync, zstdDecompressSync } from 'node:zlib'
import { workerResourcePlan } from '../runtime-options.js'
import { BitReader, EofError } from './bit-reader.js'
import {
  AsyncByteBudget,
  ByteBudgetOversizeError,
  ByteBudgetTimeoutError,
  type ByteBudgetReservation,
  type ByteBudgetSnapshot,
} from './byte-budget.js'
import {
  MAX_REPLAY_STREAM_BYTES,
  MAX_SLOT_PACKET_BYTES,
} from './decompression-limits.js'
import { EcsParser, type ComponentHashMaps, type EcsEntity } from './ecs.js'
import { GmSyncParser } from './gm-sync.js'
import {
  deserializeIdFields32,
  deserializeIdFields255,
  iteratePackets,
  SKIP_FIELD,
  type RawPacket,
} from './packet-stream.js'
import {
  fetchReplayPart,
  REPLAY_PART_MAX_BYTES,
  type ReplayFetchPrioritySource,
  type ReplayPartTiming,
} from './replay-cache.js'
import { parseWrplHeader } from './replay.js'

/**
 * События боя из пакетного потока .wrpl — порт wrpl-inspector/wrpl/carve
 * и parser/{slot,movement,fm,kill,chat,award,damage} (AGPL-3.0).
 *
 * Поток лежит в каждой части реплея по смещению 1234 + settingsBlkSize,
 * сжат zlib; куски конкатенируются по номерам частей. Времена пакетов —
 * миллисекунды от старта записи.
 *
 * Что достаём:
 *  - слоты игроков (номер слота → ник/клан/команда/аккаунт);
 *  - убийства с позициями убийцы и жертвы;
 *  - критические/тяжёлые повреждения;
 *  - чат;
 *  - траектории: наземка из MPI-пакетов позиций, авиация из пакетов
 *    лётной модели (тип 2);
 *  - зоны захвата (ECS-сущности с transform);
 *  - победившая команда (по награде hidden_win_streak).
 */

export interface SpaceTime {
  t: number
  x: number
  y: number
  z: number
}

export interface SlotPlayer {
  slot: number
  userId: string
  name: string
  clanTag: string
  title: string
  team: number
}

export interface ReplayKill {
  time: number
  killerId: string
  killerModel: string
  killerPos: SpaceTime | null
  victimId: string
  victimModel: string
  victimPos: SpaceTime | null
  weapon: string
}

export interface ReplayDamage {
  time: number
  variant: 'critical' | 'severe'
  offenderId: string
  offenderModel: string
  victimId: string
  victimModel: string
  fire: boolean
}

export interface ReplayChat {
  time: number
  sender: string
  message: string
  /** 0 — команда, 1 — все, 2 — отряд, 3 — личное */
  channel: number
  /** false для нестандартного значения, которое всё равно сохраняется как есть */
  channelValid?: boolean
}

export interface ReplayUnitPath {
  userId: string
  model: string
  source: 'ground' | 'air'
  path: SpaceTime[]
}

export interface ReplayZone {
  name: string
  x: number
  z: number
}

export interface ReplayEvents {
  /** Номер победившей команды (как team в результатах) или 0 */
  teamWon: number
  players: SlotPlayer[]
  kills: ReplayKill[]
  damage: ReplayDamage[]
  chat: ReplayChat[]
  units: ReplayUnitPath[]
  zones: ReplayZone[]
  /** Время последнего пакета, мс — длина записи */
  endTime: number
  errors: string[]
}

export interface ReplayEventsProfile {
  headerOrderMs: number
  inflateMs: number
  packetDecodeMs: number
  finalizeMs: number
  totalMs: number
}

// ---------- разбор слотов игроков ----------

interface SlotRecord {
  playerId: bigint
  name: string
  clanTag: string
  title: string
  team: number
  realNick: string
}

const FIELD_UID = 2
const FIELD_CLAN_TAG = 5
const FIELD_TITLE = 6
const FIELD_TEAM = 9
const FIELD_REAL_NICK = 41

class SlotParser {
  players = new Map<number, SlotRecord>()

  parse(payload: Buffer): void {
    const r = new BitReader(payload.subarray(4))
    const compressed = r.readByte()
    let data = r
    if (compressed > 0) {
      const compSize = r.readCompressed()
      const decompressedSize = r.readCompressed()
      if (decompressedSize > MAX_SLOT_PACKET_BYTES) {
        throw new Error(`слот: распакованный пакет слишком большой (${decompressedSize} байт)`)
      }
      const at = Math.floor(r.bitOffset / 8)
      if (compSize > payload.length - 4 - at) {
        throw new Error('слот: сжатый пакет выходит за пределы payload')
      }
      const src = payload.subarray(4 + at, 4 + at + compSize)
      data = new BitReader(zstdDecompressSync(src, {
        maxOutputLength: Math.max(decompressedSize, 1),
      }))
    }
    const messageCount = data.readU16()
    for (let m = 0; m < messageCount; m++) {
      const messageLen = data.readU16()
      const before = data.bitOffset
      const oid = data.readU16()
      if ((oid & 0x7ff) === 0x7ff && oid !== 0xffff) data.readCompressed() // ext uid
      const used = (data.bitOffset - before) >> 3
      const msg = Buffer.from(data.readBytes(messageLen - used))
      if (oid >>> 11 === 0xe) this.parseSlotMessage(oid & 0x7ff, msg)
    }
  }

  private parseSlotMessage(slot: number, msg: Buffer): void {
    const r = new BitReader(msg)
    let rec = this.players.get(slot)
    if (!rec) {
      rec = { playerId: 0n, name: '', clanTag: '', title: '', team: 0, realNick: '' }
      this.players.set(slot, rec)
    }
    const plr = rec
    deserializeIdFields255(r, (idx) => {
      switch (idx) {
        case FIELD_UID: {
          plr.playerId = r.readU64()
          const raw = r.readBytes(65)
          const end = raw.indexOf(0)
          plr.name = raw.subarray(0, end < 0 ? 65 : end).toString('utf8')
          break
        }
        case FIELD_CLAN_TAG:
          plr.clanTag = r.readLenStr()
          break
        case FIELD_TITLE:
          plr.title = r.readLenStr()
          break
        case FIELD_TEAM:
          plr.team = r.readByte()
          break
        case FIELD_REAL_NICK:
          plr.realNick = r.readLenStr()
          break
        default:
          return SKIP_FIELD
      }
      return undefined
    })
  }
}

// ---------- позиции наземной техники (MPI) ----------

class MovementParser {
  /** eid → траектория */
  paths = new Map<number, SpaceTime[]>()

  parse(pk: RawPacket): void {
    if (pk.payload.length < 40) return
    const r = new BitReader(pk.payload.subarray(2))
    const eid = r.readCompressed()
    const byteOffset = r.bitOffset >> 3
    const st: SpaceTime = {
      t: pk.time,
      x: pk.payload.readDoubleLE(11 + byteOffset),
      y: pk.payload.readDoubleLE(19 + byteOffset),
      z: pk.payload.readDoubleLE(27 + byteOffset),
    }
    let path = this.paths.get(eid)
    if (!path) {
      path = []
      this.paths.set(eid, path)
    }
    path.push(st)
  }

  /** eid MPI-пакета → индекс сущности ECS (магия из carve/entity.go) */
  static eidToEntityIndex(eid: number): number {
    return (((eid & 0xff) * 2 ** 22) | Math.floor(eid / 256)) & 0x7ff
  }

  lastPositionOf(entity: EcsEntity, ecs: EcsParser): SpaceTime | null {
    for (const [eid, path] of this.paths) {
      const e = ecs.mgr.entities.get(MovementParser.eidToEntityIndex(eid))
      if (e === entity && path.length > 0) return path[path.length - 1]!
    }
    return null
  }
}

// ---------- лётные модели (тип 2): позиции авиации ----------

interface FmEntry {
  uid: number
  entity: EcsEntity | null
  pos: { x: number; y: number; z: number } | null
}

interface FmUpdate {
  time: number
  entries: FmEntry[]
}

class FmParser {
  updates: FmUpdate[] = []
  private ecs: EcsParser

  constructor(ecs: EcsParser) {
    this.ecs = ecs
  }

  parse(pk: RawPacket): void {
    const update: FmUpdate = { time: pk.time, entries: [] }
    this.updates.push(update)
    const r = new BitReader(pk.payload)
    let uid = 0
    for (;;) {
      const hasUid = r.readBit()
      if (hasUid) uid = r.readCompressed() & 0x7ff
      else uid++
      if (uid === 0x7ff) break

      const entry: FmEntry = { uid, entity: this.ecs.mgr.uidLookup.get(uid) ?? null, pos: null }
      update.entries.push(entry)

      const noData = r.readBit()
      if (noData) continue

      const unk0 = r.readBit()
      const unk1 = r.readBit()
      if (unk0 && unk1) continue

      r.readBit() // unk2
      r.readU32() // unk3
      r.readBit() // unk4
      if (r.readBit()) {
        // unk5: три флага + битсет
        r.ignoreBits(3)
        const len = r.readUnsignedBits(4)
        r.ignoreBits(len)
      }

      const listLen = this.zigzag(r)
      if (listLen < 0) throw new Error(`fm: отрицательная длина списка ${listLen}`)
      for (let i = 0; i < listLen; i++) {
        this.zigzag(r)
        const inner = this.zigzag(r)
        for (let j = 0; j < inner; j++) this.zigzag(r)
      }

      entry.pos = { x: r.readF32(), y: r.readF32(), z: r.readF32() }
      r.readU32() // углы Эйлера, упакованы
      r.readU32() // unk12
      r.alignToByteBoundary()
      r.ignoreBytes(7)

      this.readEngines(r)
      const sensors = this.readSensors(r)
      if (sensors > 0) r.readByte()
      const cm = r.readByte()
      for (let i = 0; i < cm; i++) r.ignoreBytes(2)
      if (cm > 0) r.readByte()
      this.readTargets(r)

      if (r.readBit()) {
        r.readU16()
        r.readU16()
      }
      if (r.readBit()) {
        const n = r.readU32()
        r.ignoreBits(n)
      }
    }
  }

  private zigzag(r: BitReader): number {
    const v = r.readCompressed() >>> 0
    return (v >>> 1) ^ -(v & 1)
  }

  private readEngines(r: BitReader): void {
    const n = r.readByte()
    if (n > 0xf) throw new Error(`fm: двигателей ${n} > 15`)
    for (let i = 0; i < n; i++) {
      const hasPower = r.readBit()
      r.readByte()
      if (hasPower) r.readU16()
      if (r.readBit()) r.readByte()
      r.readByte()
      r.readByte()
    }
  }

  private readSensors(r: BitReader): number {
    const n = r.readByte()
    if (n > 4) throw new Error(`fm: сенсоров ${n} > 4`)
    for (let i = 0; i < n; i++) this.readSensor(r)
    return n
  }

  private readSensor(r: BitReader): void {
    const firstBool = r.readBit()
    const sensorType = r.readByte()
    switch (sensorType >> 4) {
      case 1: {
        if (!r.readBit()) return
        const unk1 = r.readU16()
        r.readU32()
        r.readU16()
        r.readU16()
        r.readU16()
        if (unk1 & 0x8000) r.readByte()
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
      case 3:
        throw new Error('fm: сенсор типа 3')
      case 4:
        if (r.readBit()) r.ignoreBytes(12)
        break
    }
    if (r.readBit()) {
      const count = r.readUnsignedBits(6)
      for (let i = 0; i < count; i++) r.readU32()
      r.ignoreBits(6)
    }
  }

  private readTargets(r: BitReader): void {
    const n = r.readUnsignedBits(4)
    if (n > 8) throw new Error(`fm: целей ${n} > 8`)
    for (let i = 0; i < n; i++) {
      r.readByte()
      r.readByte()
      if (r.readBit()) r.ignoreBytes(12)
      if (r.readBit()) r.ignoreBytes(18)
      else r.ignoreBytes(24)
      r.readU32()
      r.readBit()
      r.readBit()
      if (r.readBit()) r.readByte()
      r.readBit()
      const unk15 = r.readBit()
      r.readBit()
      if (unk15) r.readByte()
      if (r.readBit()) r.readU32()
    }
  }

  /** Последняя известная позиция юнита по uid (для точек убийств) */
  lastPositionOf(uid: number): SpaceTime | null {
    const last = this.updates[this.updates.length - 1]
    if (!last) return null
    for (const e of last.entries) {
      if (e.uid === uid && e.pos) return { t: last.time, ...e.pos }
    }
    return null
  }
}

// ---------- убийства, повреждения, награды, чат ----------

interface RawKill {
  time: number
  killer: EcsEntity | null
  killerPos: SpaceTime | null
  victim: EcsEntity | null
  victimPos: SpaceTime | null
  weapon: string
}

class KillParser {
  kills: RawKill[] = []

  constructor(
    private ecs: EcsParser,
    private ground: MovementParser,
    private air: FmParser,
    private gm: GmSyncParser,
  ) {}

  parse(pk: RawPacket): void {
    const kill: RawKill = { time: pk.time, killer: null, killerPos: null, victim: null, victimPos: null, weapon: '' }
    const r = new BitReader(pk.payload.subarray(4))
    deserializeIdFields32(r, (field) => {
      switch (field) {
        case 1:
          r.readU32() // pid убийцы — не используется
          break
        case 2:
          r.readLenStr() // техника игрока (дублируется ECS-данными)
          break
        case 3: {
          const uid = r.readU16() & 0x7ff
          if (uid !== 0x7ff) {
            kill.victim = this.ecs.mgr.uidLookup.get(uid) ?? null
            kill.victimPos = this.resolvePosition(kill.victim, uid)
          }
          break
        }
        case 4: {
          const uid = r.readU16() & 0x7ff
          if (uid !== 0x7ff) {
            kill.killer = this.ecs.mgr.uidLookup.get(uid) ?? null
            kill.killerPos = this.resolvePosition(kill.killer, uid)
          }
          break
        }
        case 0xa:
          kill.weapon = r.readLenStr()
          break
        case 0xb:
          r.readU32() // pid жертвы
          break
        case 0xc:
          r.readLenStr() // чем уничтожено (снаряд)
          break
        default:
          return SKIP_FIELD
      }
      return undefined
    })
    this.kills.push(kill)
  }

  private resolvePosition(entity: EcsEntity | null, uid: number): SpaceTime | null {
    const gmPath = this.gm.paths.get(uid)
    const candidates = [
      entity ? this.ground.lastPositionOf(entity, this.ecs) : null,
      this.air.lastPositionOf(uid),
      gmPath && gmPath.length > 0 ? gmPath[gmPath.length - 1]! : null,
    ].filter((p): p is SpaceTime => p !== null)
    if (candidates.length === 0) return null
    return candidates.reduce((a, b) => (b.t > a.t ? b : a))
  }
}

interface RawAward {
  time: number
  slot: number
  name: string
}

function parseAward(pk: RawPacket): RawAward {
  const p = pk.payload
  const slot = p[4 + 3]!
  const nameLen = p[4 + 7]!
  const name = p.subarray(4 + 8, 4 + 8 + nameLen).toString('utf8')
  return { time: pk.time, slot, name }
}

interface RawDamage {
  time: number
  variant: 'critical' | 'severe'
  offended: EcsEntity | null
  player: EcsEntity | null
  fire: boolean
}

function parseDamage(pk: RawPacket, variant: 'critical' | 'severe', ecs: EcsParser): RawDamage {
  const ret: RawDamage = { time: pk.time, variant, offended: null, player: null, fire: false }
  const r = new BitReader(pk.payload.subarray(4))
  deserializeIdFields32(r, (field) => {
    switch (field) {
      case 1:
        ret.offended = ecs.mgr.uidLookup.get(r.readU16() & 0x7ff) ?? null
        break
      case 2:
        r.readU32()
        break
      case 3:
        r.readLenStr()
        break
      case 4:
        ret.player = ecs.mgr.uidLookup.get(r.readU16() & 0x7ff) ?? null
        break
      case 5:
        if (variant === 'critical') ret.fire = r.readBit()
        else r.readByte()
        break
      case 6:
        r.readByte()
        break
      default:
        return SKIP_FIELD
    }
    return undefined
  })
  return ret
}

export function isValidReplayChatChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= 0 && channel <= 3
}

function parseChat(pk: RawPacket): ReplayChat {
  const r = new BitReader(pk.payload)
  const sender = r.readLenStr()
  const message = r.readLenStr()
  const channel = r.readByte()
  return {
    time: pk.time,
    sender,
    message,
    channel,
    channelValid: isValidReplayChatChannel(channel),
  }
}

// ---------- оркестрация ----------

function isMovementPacket(payload: Buffer): boolean {
  return (
    payload.length >= 14
    && payload[0] === 0xff
    && payload[1] === 0x0f
    && payload[5] === 0xa3
    && payload[6] === 0xf0
    && payload[10] === 0x00
    && payload[11] === 0x00
    && payload[13] === 0x13
  ) || (
    payload.length >= 13
    && payload[0] === 0xff
    && payload[1] === 0x0f
    && payload[4] === 0xa3
    && payload[5] === 0xf0
    && payload[9] === 0x00
    && payload[10] === 0x00
    && payload[12] === 0x13
  )
}

/** Прореживание траектории: точка реже 500 мс и 4 м не нужна */
function thinPath(path: SpaceTime[]): SpaceTime[] {
  if (path.length <= 2) return path
  const out: SpaceTime[] = [path[0]!]
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i]!
    const last = out[out.length - 1]!
    const dx = p.x - last.x
    const dz = p.z - last.z
    if (p.t - last.t >= 500 || dx * dx + dz * dz >= 16) out.push(p)
  }
  out.push(path[path.length - 1]!)
  return out
}

function userIdOf(entity: EcsEntity | null, slots: Map<number, SlotRecord>): string {
  if (!entity) return ''
  const slot = entity.data.get('unit__playerId')
  if (typeof slot !== 'number') return ''
  const rec = slots.get(slot)
  return rec && rec.playerId !== 0n ? rec.playerId.toString(10) : ''
}

function modelOf(entity: EcsEntity | null): string {
  const model = entity?.data.get('unit__className')
  return typeof model === 'string' ? model : ''
}

const ZONE_TEMPLATE_HINT = /(?:cap(?:ture)?[_-]?zone|base[_-]?zone|capture[_-]?point|objective[_-]?zone)/i
const ZONE_COMPONENT_HINT = /^(?:capture_zone__|capzone__)/i

function finiteNumberArray(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return value
  }
  return null
}

function zonePosition(entity: EcsEntity): { x: number; z: number } | null {
  const transform = entity.data.get('transform')
  if (transform === null || typeof transform !== 'object') return null
  const value = transform as { pos?: unknown; tm?: unknown }
  const pos = finiteNumberArray(value.pos)
  if (pos && pos.length >= 3) return { x: pos[0]!, z: pos[2]! }
  const matrix = Array.isArray(value.tm) ? value.tm : null
  const translation = matrix && finiteNumberArray(matrix[3])
  if (translation && translation.length >= 3) return { x: translation[0]!, z: translation[2]! }
  return null
}

function zoneName(entity: EcsEntity): string {
  const name = entity.data.get('capture_zone__name')
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  const id = entity.data.get('capture_zone__zoneId')
  return typeof id === 'number' && Number.isInteger(id) ? `zone_${id}` : entity.template
}

/**
 * Сжатие пакетного потока части. До версии игры 2.59 — zlib (`78 xx`),
 * с 2.59 (заголовок 101404) — zstd-кадр (`28 b5 2f fd`). Определяем по магии,
 * а не по версии: старые и новые реплеи разбираются одним кодом.
 */
export function packetStreamCodec(packed: Uint8Array): 'zstd' | 'zlib' {
  return packed.length >= 4
    && packed[0] === 0x28 && packed[1] === 0xb5 && packed[2] === 0x2f && packed[3] === 0xfd
    ? 'zstd'
    : 'zlib'
}

/**
 * Извлекает события боя из скачанных частей реплея.
 * Ошибки разбора отдельных пакетов не прерывают обработку — копятся в errors.
 */
export function extractReplayEvents(parts: Buffer[], hashes: ComponentHashMaps): ReplayEvents {
  return extractReplayEventsProfiled(parts, hashes).events
}

export function extractReplayEventsProfiled(
  parts: Buffer[],
  hashes: ComponentHashMaps,
): { events: ReplayEvents; profile: ReplayEventsProfile } {
  const totalStarted = performance.now()
  const ecs = new EcsParser(hashes)
  const slot = new SlotParser()
  const movement = new MovementParser()
  const gm = new GmSyncParser()
  const fm = new FmParser(ecs)
  const kills = new KillParser(ecs, movement, fm, gm)
  const awards: RawAward[] = []
  const damage: RawDamage[] = []
  const chat: ReplayChat[] = []
  const errors: string[] = []
  let endTime = 0

  // Части в порядке номеров; заголовок у каждой свой, поток продолжается
  let phaseStarted = performance.now()
  const ordered = parts
    .map((buf) => ({ buf, header: parseWrplHeader(buf) }))
    .filter((p) => p.header.isServer)
    .sort((a, b) => a.header.partNumber - b.header.partNumber)
  const headerOrderMs = performance.now() - phaseStarted
  // Все части одного боя пишет одна версия игры; формат ECS — по первой.
  if (ordered[0]) ecs.useReplayVersion(ordered[0].header.version)
  let inflateMs = 0
  let packetDecodeMs = 0

  let seq = 0
  let decodedParts = 0
  for (const { buf, header } of ordered) {
    let stream: Buffer
    phaseStarted = performance.now()
    const packed = buf.subarray(1234 + header.settingsBlkSize)
    const codec = packetStreamCodec(packed)
    try {
      stream = codec === 'zstd'
        ? zstdDecompressSync(packed, { maxOutputLength: MAX_REPLAY_STREAM_BYTES })
        : inflateSync(packed, { maxOutputLength: MAX_REPLAY_STREAM_BYTES })
    } catch (err) {
      inflateMs += performance.now() - phaseStarted
      errors.push(`часть ${header.partNumber}: ${codec}: ${(err as Error).message}`)
      continue
    }
    inflateMs += performance.now() - phaseStarted
    phaseStarted = performance.now()
    for (const pk of iteratePackets(stream, seq)) {
      seq = pk.seq + 1
      if (pk.time > endTime) endTime = pk.time
      try {
        switch (pk.type) {
          case 2:
            fm.parse(pk)
            break
          case 3: {
            const message = parseChat(pk)
            chat.push(message)
            if (message.channelValid === false && errors.length < 200) {
              errors.push(`пакет ${pk.seq}: неизвестный канал чата ${message.channel}`)
            }
            break
          }
          case 4:
            if (
              pk.payload.length >= 4
              && pk.payload[0] === 0x02
              && pk.payload[1] === 0x58
            ) {
              const kind = pk.payload[2]
              const tail = pk.payload[3]
              if (kind === 0x2d && tail === 0xf0) slot.parse(pk.payload)
              else if ((kind === 0x74 || kind === 0x73) && tail === 0xf0) {
                gm.parse(pk.payload, pk.time)
              } else if (kind === 0x58 && tail === 0xf0) kills.parse(pk)
              else if (kind === 0x78 && tail === 0xf0) awards.push(parseAward(pk))
              else if (kind === 0x56 && tail === 0xf0) {
                damage.push(parseDamage(pk, 'critical', ecs))
              } else if (kind === 0x57 && tail === 0xf1) {
                damage.push(parseDamage(pk, 'severe', ecs))
              }
            } else if (isMovementPacket(pk.payload)) {
              movement.parse(pk)
            }
            break
          case 6:
            ecs.parsePacket(pk.payload)
            break
        }
      } catch (err) {
        if (errors.length < 200) {
          const kind = err instanceof EofError ? 'обрыв данных' : (err as Error).message
          errors.push(`пакет ${pk.seq} (тип ${pk.type}): ${kind}`)
        }
      }
    }
    packetDecodeMs += performance.now() - phaseStarted
    decodedParts += 1
  }
  // Ни одна часть не распаковалась — это смена формата, а не бой без событий:
  // пустой результат записался бы как успешный разбор (так было с 2.59).
  if (ordered.length > 0 && decodedParts === 0) {
    throw new Error(`пакетный поток не распакован ни в одной части: ${errors.slice(0, 3).join('; ')}`)
  }

  for (const entityError of ecs.entityErrors) {
    if (errors.length >= 200) break
    errors.push(`ECS-сущность ${entityError}`)
  }

  const finalizeStarted = performance.now()
  // Победитель: последняя награда hidden_win_streak → команда игрока
  let teamWon = 0
  for (let i = awards.length - 1; i >= 0; i--) {
    if (awards[i]!.name === 'hidden_win_streak') {
      teamWon = slot.players.get(awards[i]!.slot)?.team ?? 0
      if (teamWon) break
    }
  }

  // Игроки из слотов
  const players: SlotPlayer[] = []
  for (const [n, p] of [...slot.players.entries()].sort((a, b) => a[0] - b[0])) {
    if (p.playerId === 0n || (p.name === '' && p.realNick === '')) continue
    players.push({
      slot: n,
      userId: p.playerId.toString(10),
      name: p.realNick || p.name,
      clanTag: p.clanTag,
      title: p.title,
      team: p.team,
    })
  }

  // Наземные траектории: GMSync по uid юнита → сущность → игрок
  const units: ReplayUnitPath[] = []
  for (const [uid, path] of gm.paths) {
    const entity = ecs.mgr.uidLookup.get(uid) ?? null
    if (!entity || path.length < 2) continue
    units.push({
      userId: userIdOf(entity, slot.players),
      model: modelOf(entity),
      source: 'ground',
      path: thinPath(path),
    })
  }
  // Старый формат позиций (реплеи прошлых версий игры)
  for (const [eid, path] of movement.paths) {
    const entity = ecs.mgr.entities.get(MovementParser.eidToEntityIndex(eid)) ?? null
    if (!entity || path.length < 2) continue
    units.push({
      userId: userIdOf(entity, slot.players),
      model: modelOf(entity),
      source: 'ground',
      path: thinPath(path),
    })
  }

  // Воздушные траектории: группируем записи лётной модели по сущностям
  const airPaths = new Map<EcsEntity, SpaceTime[]>()
  for (const upd of fm.updates) {
    for (const e of upd.entries) {
      if (!e.entity || !e.pos) continue
      let path = airPaths.get(e.entity)
      if (!path) {
        path = []
        airPaths.set(e.entity, path)
      }
      path.push({ t: upd.time, ...e.pos })
    }
  }
  for (const [entity, path] of airPaths) {
    if (path.length < 2) continue
    units.push({
      userId: userIdOf(entity, slot.players),
      model: modelOf(entity),
      source: 'air',
      path: thinPath(path),
    })
  }

  // Зоны захвата: ECS-сущности с transform. В разных версиях игры менялись
  // имена template и форма transform, поэтому проверяем также имена компонентов
  // и не отбрасываем валидную точку (0, 0).
  const zones: ReplayZone[] = []
  const seenZones = new Set<string>()
  for (const entity of ecs.mgr.entities.values()) {
    const isZone = ZONE_TEMPLATE_HINT.test(entity.template) ||
      entity.data.components.some((component) => ZONE_COMPONENT_HINT.test(component.name))
    if (!isZone) continue
    const point = zonePosition(entity)
    if (!point) continue
    const key = `${Math.round(point.x * 10)}:${Math.round(point.z * 10)}`
    if (seenZones.has(key)) continue
    seenZones.add(key)
    zones.push({ name: zoneName(entity), x: point.x, z: point.z })
  }

  const events: ReplayEvents = {
    teamWon,
    players,
    kills: kills.kills.map((k) => ({
      time: k.time,
      killerId: userIdOf(k.killer, slot.players),
      killerModel: modelOf(k.killer),
      killerPos: k.killerPos,
      victimId: userIdOf(k.victim, slot.players),
      victimModel: modelOf(k.victim),
      victimPos: k.victimPos,
      weapon: k.weapon,
    })).filter((k) => k.victimId !== '' || k.victimModel !== ''),
    damage: damage.map((d) => ({
      time: d.time,
      variant: d.variant,
      offenderId: userIdOf(d.player, slot.players),
      offenderModel: modelOf(d.player),
      victimId: userIdOf(d.offended, slot.players),
      victimModel: modelOf(d.offended),
      fire: d.fire,
    })),
    chat,
    units,
    zones,
    endTime,
    errors,
  }
  const finalizeMs = performance.now() - finalizeStarted
  return {
    events,
    profile: {
      headerOrderMs,
      inflateMs,
      packetDecodeMs,
      finalizeMs,
      totalMs: performance.now() - totalStarted,
    },
  }
}

export const DEFAULT_REPLAY_FETCH_CONCURRENCY = 2
export const REPLAY_TOTAL_MAX_BYTES = 512 * 1024 * 1024
const PROCESS_BUDGET_WAIT_TIMEOUT_MS = 30_000
const replayProcessByteBudget = new AsyncByteBudget(
  workerResourcePlan().replayProcessByteBudgetMb * 1024 * 1024,
)
let exactReplayReservationsEnabled = false

export function configureReplayProcessBudget(options: { exactReservations: boolean }): void {
  exactReplayReservationsEnabled = options.exactReservations
}

export function replayProcessByteBudgetSnapshot(): ByteBudgetSnapshot {
  return replayProcessByteBudget.snapshot()
}

export interface IndexedReplayPartTiming extends ReplayPartTiming {
  index: number
}

export interface ReplayPartsTiming {
  startedAtMs: number
  completedAtMs: number
  totalMs: number
  outcome: 'success' | 'error' | 'aborted'
  requestedParts: number
  completedParts: number
  concurrency: number
  peakActive: number
  maxTotalBytes: number
  peakBudgetBytes: number
  bytes: number
  cacheHits: number
  networkParts: number
  networkAttempts: number
  retries: number
  httpErrors: number
  slotWaitMs: number
  ttfbMs: number
  downloadMs: number
  retryDelayMs: number
  processBudgetWaitMs: number
  processBudgetLimitBytes: number
  processBudgetPeakBytes: number
  parts: IndexedReplayPartTiming[]
}

export interface ReplayPartsFetchOptions {
  concurrency?: number
  maxTotalBytes?: number
  priority?: ReplayFetchPrioritySource
  /** Только для изолированных benchmark/smoke; undefined использует production cache. */
  cacheDirectory?: string | null
  /** null отключает process budget только в изолированном benchmark/test. */
  processByteBudget?: AsyncByteBudget | null
  processBudgetTimeoutMs?: number
  exactProcessReservation?: boolean
  onTiming?: (timing: ReplayPartsTiming) => void
}

export interface RetainedReplayParts {
  parts: Buffer[]
  release(): void
}

export class ReplayPartsFetchError extends Error {
  readonly timing: ReplayPartsTiming
  readonly originalError: unknown

  constructor(error: unknown, timing: ReplayPartsTiming) {
    super(error instanceof Error ? error.message : String(error))
    this.name = error instanceof Error ? error.name : 'ReplayPartsFetchError'
    this.timing = timing
    this.originalError = error
  }
}

export function isReplayByteBudgetSchedulingError(error: unknown): boolean {
  const cause = error instanceof ReplayPartsFetchError ? error.originalError : error
  return cause instanceof ByteBudgetTimeoutError || cause instanceof ByteBudgetOversizeError
}

/**
 * Все части реплея (для событий нужен весь поток пакетов) — через дисковый
 * cache. Pipeline ограничен числом ответов и worst-case суммой уже загруженных
 * плюс in-flight частей; паузы и ретраи к CDN остаются в fetchReplayPart.
 */
export async function fetchReplayParts(
  partUrls: string[],
  signal?: AbortSignal,
  options: ReplayPartsFetchOptions = {},
): Promise<Buffer[]> {
  const retained = await fetchReplayPartsRetained(partUrls, signal, options)
  try {
    return retained.parts
  } finally {
    retained.release()
  }
}

export async function fetchReplayPartsRetained(
  partUrls: string[],
  signal?: AbortSignal,
  options: ReplayPartsFetchOptions = {},
): Promise<RetainedReplayParts> {
  const started = performance.now()
  const startedAtMs = Date.now()
  const processBudget = options.processByteBudget === undefined
    ? replayProcessByteBudget
    : options.processByteBudget
  const exactProcessReservation =
    options.exactProcessReservation ?? exactReplayReservationsEnabled
  const requestedProcessBudgetTimeoutMs =
    options.processBudgetTimeoutMs ?? PROCESS_BUDGET_WAIT_TIMEOUT_MS
  const processBudgetTimeoutMs =
    Number.isFinite(requestedProcessBudgetTimeoutMs) && requestedProcessBudgetTimeoutMs >= 0
      ? requestedProcessBudgetTimeoutMs
      : PROCESS_BUDGET_WAIT_TIMEOUT_MS
  const requestedConcurrency = options.concurrency ?? DEFAULT_REPLAY_FETCH_CONCURRENCY
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(3, Math.floor(requestedConcurrency)))
    : DEFAULT_REPLAY_FETCH_CONCURRENCY
  const requestedMaxTotalBytes = options.maxTotalBytes ?? REPLAY_TOTAL_MAX_BYTES
  const maxTotalBytes = Number.isFinite(requestedMaxTotalBytes) && requestedMaxTotalBytes > 0
    ? Math.floor(requestedMaxTotalBytes)
    : REPLAY_TOTAL_MAX_BYTES
  const parts = new Array<Buffer>(partUrls.length)
  const partTimings = new Array<IndexedReplayPartTiming | undefined>(partUrls.length)
  const controller = new AbortController()
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let nextIndex = 0
  let active = 0
  let peakActive = 0
  let loadedBytes = 0
  let reservedBytes = 0
  let peakBudgetBytes = 0
  let failed = false
  let firstError: unknown = null
  let processBudgetWaitMs = 0
  let processBudgetPeakBytes = processBudget?.snapshot().usedBytes ?? 0
  const processReservations = new Set<ByteBudgetReservation>()
  let processReservationsReleased = false
  const releaseProcessReservations = (): void => {
    if (processReservationsReleased) return
    processReservationsReleased = true
    for (const reservation of processReservations) reservation.release()
    processReservations.clear()
  }

  const reservePartBytes = (index: number, bytes: number): void => {
    const nextBudget = loadedBytes + reservedBytes + bytes
    if (nextBudget > maxTotalBytes) {
      throw new Error(
        `replay ${index + 1}/${partUrls.length}: loaded/in-flight budget ` +
        `${Math.ceil(nextBudget / 1024 / 1024)} МиБ больше лимита ` +
        `${Math.ceil(maxTotalBytes / 1024 / 1024)} МиБ`,
      )
    }
    reservedBytes += bytes
    peakBudgetBytes = Math.max(peakBudgetBytes, loadedBytes + reservedBytes)
  }
  const releaseReservation = (bytes: number): void => {
    reservedBytes = Math.max(0, reservedBytes - bytes)
  }
  const commitReservation = (reserved: number, bytes: number): void => {
    releaseReservation(reserved)
    loadedBytes += bytes
    peakBudgetBytes = Math.max(peakBudgetBytes, loadedBytes + reservedBytes)
  }
  const fail = (error: unknown): void => {
    if (failed) return
    failed = true
    firstError = error
    controller.abort(error)
  }

  const runner = async (): Promise<void> => {
    for (;;) {
      if (combinedSignal.aborted) {
        if (failed) return
        const error = abortError()
        fail(error)
        throw error
      }
      const index = nextIndex
      nextIndex += 1
      if (index >= partUrls.length) return

      let reserved = 0
      let activeStarted = false
      let processReservation: ByteBudgetReservation | null = null
      let retainProcessReservation = false
      const releasePartReservation = (): void => {
        if (processReservation) {
          processReservations.delete(processReservation)
          processReservation.release()
          processReservation = null
        }
        if (reserved > 0) {
          releaseReservation(reserved)
          reserved = 0
        }
      }
      const reservePartMemory = async (requestedBytes: number): Promise<void> => {
        const reservationBytes = exactProcessReservation
          ? requestedBytes
          : REPLAY_PART_MAX_BYTES
        if (!Number.isSafeInteger(reservationBytes) || reservationBytes <= 0) {
          throw new Error(
            `replay ${index + 1}/${partUrls.length}: некорректный reservation ` +
            `${reservationBytes}`,
          )
        }
        if (reserved > 0) {
          if (reservationBytes > reserved) {
            throw new Error(
              `replay ${index + 1}/${partUrls.length}: повторный reservation ` +
              `${reservationBytes} больше уже удерживаемого ${reserved}`,
            )
          }
          return
        }
        reservePartBytes(index, reservationBytes)
        reserved = reservationBytes
        if (!processBudget) return
        try {
          const budgetWaitStarted = performance.now()
          processReservation = await processBudget.acquire(reservationBytes, {
            signal: combinedSignal,
            timeoutMs: processBudgetTimeoutMs,
          })
          processBudgetWaitMs += performance.now() - budgetWaitStarted
          processReservations.add(processReservation)
          processBudgetPeakBytes = Math.max(
            processBudgetPeakBytes,
            processBudget.snapshot().usedBytes,
          )
        } catch (error) {
          releaseReservation(reserved)
          reserved = 0
          throw error
        }
      }
      const commitPartMemory = (bytes: number): void => {
        if (bytes > reserved) {
          throw new Error(
            `replay ${index + 1}/${partUrls.length}: фактический размер ` +
            `${bytes} больше reservation ${reserved}`,
          )
        }
        processReservation?.shrinkTo(bytes)
        commitReservation(reserved, bytes)
        reserved = 0
        retainProcessReservation = true
        if (processBudget) {
          processBudgetPeakBytes = Math.max(
            processBudgetPeakBytes,
            processBudget.snapshot().usedBytes,
          )
        }
      }
      try {
        // Rollback-off обязан сохранять прежнюю семантику: worst-case budget
        // выдаётся до cache/network I/O, а не после получения HTTP headers.
        if (!exactProcessReservation) await reservePartMemory(REPLAY_PART_MAX_BYTES)
        active += 1
        activeStarted = true
        peakActive = Math.max(peakActive, active)
        const part = await fetchReplayPart(partUrls[index]!, {
          signal: combinedSignal,
          ...(options.priority === undefined ? {} : { priority: options.priority }),
          ...(options.cacheDirectory === undefined
            ? {}
            : { cacheDirectory: options.cacheDirectory }),
          memoryReservation: {
            reserve: reservePartMemory,
            commit: commitPartMemory,
            release: releasePartReservation,
          },
          onTiming: (timing) => {
            partTimings[index] = { ...timing, index }
          },
        })
        parts[index] = part
      } catch (error) {
        fail(error)
        throw error
      } finally {
        if (!retainProcessReservation) releasePartReservation()
        if (activeStarted) active -= 1
      }
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, partUrls.length)) },
    () => runner(),
  )
  await Promise.allSettled(runners)

  const timing = summarizeReplayPartsTiming({
    startedAtMs,
    totalMs: performance.now() - started,
    outcome: !failed
      ? 'success'
      : signal?.aborted || (firstError instanceof Error && firstError.name === 'AbortError')
        ? 'aborted'
        : 'error',
    requestedParts: partUrls.length,
    concurrency,
    peakActive,
    maxTotalBytes,
    peakBudgetBytes,
    bytes: loadedBytes,
    processBudgetWaitMs,
    processBudgetLimitBytes: processBudget?.limitBytes ?? 0,
    processBudgetPeakBytes,
    parts: partTimings.filter((value): value is IndexedReplayPartTiming => value !== undefined),
  })
  emitReplayPartsTiming(options.onTiming, timing)
  if (failed) {
    releaseProcessReservations()
    throw new ReplayPartsFetchError(firstError, timing)
  }
  return { parts, release: releaseProcessReservations }
}

function summarizeReplayPartsTiming(input: {
  startedAtMs: number
  totalMs: number
  outcome: ReplayPartsTiming['outcome']
  requestedParts: number
  concurrency: number
  peakActive: number
  maxTotalBytes: number
  peakBudgetBytes: number
  bytes: number
  processBudgetWaitMs: number
  processBudgetLimitBytes: number
  processBudgetPeakBytes: number
  parts: IndexedReplayPartTiming[]
}): ReplayPartsTiming {
  const attempts = input.parts.flatMap((part) => part.attempts)
  const networkParts = input.parts.filter((part) => part.attempts.length > 0).length
  return {
    startedAtMs: input.startedAtMs,
    completedAtMs: Date.now(),
    totalMs: input.totalMs,
    outcome: input.outcome,
    requestedParts: input.requestedParts,
    completedParts: input.parts.filter((part) => part.outcome === 'success').length,
    concurrency: input.concurrency,
    peakActive: input.peakActive,
    maxTotalBytes: input.maxTotalBytes,
    peakBudgetBytes: input.peakBudgetBytes,
    bytes: input.bytes,
    cacheHits: input.parts.filter((part) => part.cacheHit).length,
    networkParts,
    networkAttempts: attempts.length,
    retries: attempts.filter((attempt) => attempt.retryDelayMs > 0).length,
    httpErrors: attempts.filter((attempt) => (attempt.status ?? 0) >= 400).length,
    slotWaitMs: attempts.reduce((sum, attempt) => sum + attempt.slotWaitMs, 0),
    ttfbMs: attempts.reduce((sum, attempt) => sum + (attempt.ttfbMs ?? 0), 0),
    downloadMs: attempts.reduce((sum, attempt) => sum + (attempt.downloadMs ?? 0), 0),
    retryDelayMs: attempts.reduce((sum, attempt) => sum + attempt.retryDelayMs, 0),
    processBudgetWaitMs: input.processBudgetWaitMs,
    processBudgetLimitBytes: input.processBudgetLimitBytes,
    processBudgetPeakBytes: input.processBudgetPeakBytes,
    parts: input.parts.sort((a, b) => a.index - b.index),
  }
}

function emitReplayPartsTiming(
  callback: ReplayPartsFetchOptions['onTiming'],
  timing: ReplayPartsTiming,
): void {
  if (!callback) return
  try {
    callback({
      ...timing,
      parts: timing.parts.map((part) => ({
        ...part,
        attempts: part.attempts.map((attempt) => ({ ...attempt })),
      })),
    })
  } catch {
    // Метрики не должны менять результат загрузки.
  }
}

function abortError(): Error {
  const error = new Error('Разбор replay отменён при остановке')
  error.name = 'AbortError'
  return error
}
