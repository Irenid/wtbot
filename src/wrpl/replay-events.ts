import { inflateSync, zstdDecompressSync } from 'node:zlib'
import { BitReader, EofError } from './bit-reader.js'
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
      r.readCompressed() // размер после распаковки — не нужен
      const at = r.bitOffset >> 3
      const src = payload.subarray(4 + at, 4 + at + compSize)
      data = new BitReader(zstdDecompressSync(src))
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
        r.readBits(3)
        const len = r.readBits(4)[0]!
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
      const count = r.readBits(6)[0]!
      for (let i = 0; i < count; i++) r.readU32()
      r.readBits(6)
    }
  }

  private readTargets(r: BitReader): void {
    const n = r.readBits(4)[0]!
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

function parseChat(pk: RawPacket): ReplayChat {
  const r = new BitReader(pk.payload)
  return {
    time: pk.time,
    sender: r.readLenStr(),
    message: r.readLenStr(),
    channel: r.readByte(),
  }
}

// ---------- оркестрация ----------

const matches = (p: Buffer, conds: [number, number][]): boolean =>
  conds.every(([pos, val]) => pos < p.length && p[pos] === val)

/** Прореживание траектории: точка реже 500 мс и 4 м не нужна */
function thinPath(path: SpaceTime[]): SpaceTime[] {
  if (path.length <= 2) return path
  const out: SpaceTime[] = [path[0]!]
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i]!
    const last = out[out.length - 1]!
    const dist = Math.hypot(p.x - last.x, p.z - last.z)
    if (p.t - last.t >= 500 || dist >= 4) out.push(p)
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

/**
 * Извлекает события боя из скачанных частей реплея.
 * Ошибки разбора отдельных пакетов не прерывают обработку — копятся в errors.
 */
export function extractReplayEvents(parts: Buffer[], hashes: ComponentHashMaps): ReplayEvents {
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
  const ordered = parts
    .map((buf) => ({ buf, header: parseWrplHeader(buf) }))
    .filter((p) => p.header.isServer)
    .sort((a, b) => a.header.partNumber - b.header.partNumber)

  let seq = 0
  for (const { buf, header } of ordered) {
    let stream: Buffer
    try {
      stream = inflateSync(buf.subarray(1234 + header.settingsBlkSize))
    } catch (err) {
      errors.push(`часть ${header.partNumber}: zlib: ${(err as Error).message}`)
      continue
    }
    for (const pk of iteratePackets(stream, seq)) {
      seq = pk.seq + 1
      if (pk.time > endTime) endTime = pk.time
      try {
        switch (pk.type) {
          case 2:
            fm.parse(pk)
            break
          case 3:
            chat.push(parseChat(pk))
            break
          case 4:
            if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x2d], [3, 0xf0]])) slot.parse(pk.payload)
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x74], [3, 0xf0]])) gm.parse(pk.payload, pk.time)
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x73], [3, 0xf0]])) gm.parse(pk.payload, pk.time)
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x58], [3, 0xf0]])) kills.parse(pk)
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x78], [3, 0xf0]])) awards.push(parseAward(pk))
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x56], [3, 0xf0]]))
              damage.push(parseDamage(pk, 'critical', ecs))
            else if (matches(pk.payload, [[0, 0x02], [1, 0x58], [2, 0x57], [3, 0xf1]]))
              damage.push(parseDamage(pk, 'severe', ecs))
            else if (
              matches(pk.payload, [[0, 0xff], [1, 0x0f], [5, 0xa3], [6, 0xf0], [10, 0x00], [11, 0x00], [13, 0x13]]) ||
              matches(pk.payload, [[0, 0xff], [1, 0x0f], [4, 0xa3], [5, 0xf0], [9, 0x00], [10, 0x00], [12, 0x13]])
            )
              movement.parse(pk)
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
  }

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

  // Зоны захвата: ECS-сущности с позицией из transform
  const zones: ReplayZone[] = []
  for (const entity of ecs.mgr.entities.values()) {
    if (!/capzone|capture_zone/i.test(entity.template)) continue
    const tr = entity.data.get('transform') as { pos?: number[] } | undefined
    if (tr?.pos && (tr.pos[0] !== 0 || tr.pos[2] !== 0)) {
      zones.push({ name: entity.template, x: tr.pos[0]!, z: tr.pos[2]! })
    }
  }

  return {
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
}

export const DEFAULT_REPLAY_FETCH_CONCURRENCY = 2
export const REPLAY_TOTAL_MAX_BYTES = 512 * 1024 * 1024

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
  parts: IndexedReplayPartTiming[]
}

export interface ReplayPartsFetchOptions {
  concurrency?: number
  maxTotalBytes?: number
  /** Только для изолированных benchmark/smoke; undefined использует production cache. */
  cacheDirectory?: string | null
  onTiming?: (timing: ReplayPartsTiming) => void
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
  const started = performance.now()
  const startedAtMs = Date.now()
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

  const reservePartBytes = (index: number): void => {
    const nextBudget = loadedBytes + reservedBytes + REPLAY_PART_MAX_BYTES
    if (nextBudget > maxTotalBytes) {
      throw new Error(
        `replay ${index + 1}/${partUrls.length}: loaded/in-flight budget ` +
        `${Math.ceil(nextBudget / 1024 / 1024)} МиБ больше лимита ` +
        `${Math.ceil(maxTotalBytes / 1024 / 1024)} МиБ`,
      )
    }
    reservedBytes += REPLAY_PART_MAX_BYTES
    peakBudgetBytes = Math.max(peakBudgetBytes, loadedBytes + reservedBytes)
  }
  const releaseReservation = (): void => {
    reservedBytes -= REPLAY_PART_MAX_BYTES
  }
  const commitReservation = (bytes: number): void => {
    releaseReservation()
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

      let reserved = false
      try {
        reservePartBytes(index)
        reserved = true
      } catch (error) {
        fail(error)
        throw error
      }

      active += 1
      peakActive = Math.max(peakActive, active)
      try {
        const part = await fetchReplayPart(partUrls[index]!, {
          signal: combinedSignal,
          ...(options.cacheDirectory === undefined
            ? {}
            : { cacheDirectory: options.cacheDirectory }),
          onTiming: (timing) => {
            partTimings[index] = { ...timing, index }
          },
        })
        parts[index] = part
        commitReservation(part.byteLength)
        reserved = false
      } catch (error) {
        fail(error)
        throw error
      } finally {
        if (reserved) releaseReservation()
        active -= 1
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
    parts: partTimings.filter((value): value is IndexedReplayPartTiming => value !== undefined),
  })
  emitReplayPartsTiming(options.onTiming, timing)
  if (failed) throw new ReplayPartsFetchError(firstError, timing)
  return parts
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
