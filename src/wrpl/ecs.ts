import { readFile, rm } from 'node:fs/promises'
import { writeFileAtomic } from '../atomic-file.js'
import { readResponseText } from '../http-response.js'
import { BitReader } from './bit-reader.js'
import { lz4DecompressBlock } from './lz4.js'
import { readEID } from './packet-stream.js'

/**
 * ECS-пакеты реплея (тип 6): создание игровых сущностей — порт
 * wrpl-inspector/wrpl/packet/parser/ecs2 (AGPL-3.0).
 *
 * Каждая сущность создаётся из шаблона (имя + список компонентов).
 * В потоке компоненты идентифицируются хэшами имён/типов; соответствие
 * хэш → имя лежит в ecshashes.json из репозитория wrpl-inspector
 * (кэшируется в data/, скачивается при первом использовании).
 *
 * Нам из всего ECS нужны: uid → сущность (по нему события ссылаются на
 * технику), unit__playerId (номер слота игрока), unit__className (модель
 * техники) и позиции из transform (зоны захвата для хитмапы).
 */

const HASHES_FILE = './data/ecshashes.json'
const HASHES_URL = 'https://raw.githubusercontent.com/maxsupermanhd/wrpl-inspector/v3/data/ecshashes.json'

export interface EcsComponentValue {
  name: string
  value: unknown
}

export class EcsObject {
  components: EcsComponentValue[] = []

  add(name: string, value: unknown): void {
    this.components.push({ name, value })
  }

  get(name: string): unknown {
    return this.components.find((c) => c.name === name)?.value
  }
}

export interface EcsEntity {
  template: string
  data: EcsObject
}

export class EntityManager {
  entities = new Map<number, EcsEntity>()
  uidLookup = new Map<number, EcsEntity>()

  addEntity(eid: number, entity: EcsEntity): void {
    this.entities.set(eid & 0x3fffff, entity)
    const uid = entity.data.get('uid')
    if (typeof uid === 'number') this.uidLookup.set(uid, entity)
  }
}

type ComponentParser = (r: BitReader, ctx: EcsParser) => unknown

interface HashedComponent {
  nameHash: number
  typeHash: number
}

interface Template {
  id: number
  name: string
  components: number[]
}

export interface ComponentHashMaps {
  /** хэш типа → имя типа ("int", "ecs::Object", ...) */
  componentNames: Map<number, string>
  /** хэш имени → { имя компонента, хэш типа, свой загрузчик } */
  dataComponents: Map<number, { name: string; comp: number; hasLoader: boolean }>
  componentParsers: Map<number, ComponentParser>
  dataComponentParsers: Map<number, ComponentParser>
}

/** Сырой JSON готовится в main thread; тяжёлый JSON.parse остаётся в CPU worker. */
let hashesJsonPromise: Promise<string> | null = null

export function ensureEcsHashesJson(): Promise<string> {
  if (hashesJsonPromise) return hashesJsonPromise
  hashesJsonPromise = loadEcsHashesJson().catch((error: unknown) => {
    hashesJsonPromise = null
    throw error
  })
  return hashesJsonPromise
}

/** Offline-проверка/benchmark: не обращается к сети при пустом cache. */
export async function readCachedEcsHashesJson(): Promise<string> {
  const json = await readFile(HASHES_FILE, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Для offline-проверки нужен ${HASHES_FILE}; один раз запусти обычный разбор с сетью`)
    }
    throw error
  })
  validateHashesEnvelope(json)
  return json
}

async function loadEcsHashesJson(): Promise<string> {
  let cached: string | null = null
  try {
    cached = await readFile(HASHES_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (cached) {
    try {
      validateHashesEnvelope(cached)
      return cached
    } catch {
      await rm(HASHES_FILE, { force: true }).catch(() => undefined)
    }
  }

  const response = await fetch(HASHES_URL, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} при скачивании ecshashes.json`)
  const json = await readResponseText(response, 8 * 1024 * 1024, 'ecshashes.json')
  validateHashesEnvelope(json)
  await writeFileAtomic(HASHES_FILE, json)
  console.log('[wrpl] словарь ECS-хэшей сохранён в', HASHES_FILE)
  return json
}

function validateHashesEnvelope(json: string): void {
  if (!/^\s*\{/.test(json) || !/"components"\s*:/.test(json) || !/"dataComponents"\s*:/.test(json)) {
    throw new Error('ecshashes.json имеет неверный формат')
  }
}

export function parseComponentHashMaps(json: string): ComponentHashMaps {
  const raw = JSON.parse(json) as {
    components: Record<string, string>
    dataComponents: Record<string, { name: string; comp: string; has_loader: boolean }>
  }
  const maps: ComponentHashMaps = {
    componentNames: new Map(),
    dataComponents: new Map(),
    componentParsers: new Map(),
    dataComponentParsers: new Map(),
  }
  for (const [k, v] of Object.entries(raw.components)) {
    maps.componentNames.set(Number.parseInt(k, 16), v)
  }
  for (const [k, v] of Object.entries(raw.dataComponents)) {
    maps.dataComponents.set(Number.parseInt(k, 16), {
      name: v.name,
      comp: Number.parseInt(v.comp, 16),
      hasLoader: v.has_loader,
    })
  }
  for (const [hash, typeName] of maps.componentNames) {
    const p = COMPONENT_PARSERS[typeName]
    if (p) maps.componentParsers.set(hash, p)
  }
  for (const [hash, def] of maps.dataComponents) {
    if (def.hasLoader) {
      const p = DATA_COMPONENT_PARSERS[def.name]
      if (p) maps.dataComponentParsers.set(hash, p)
    } else {
      const p = maps.componentParsers.get(def.comp)
      if (p) maps.dataComponentParsers.set(hash, p)
    }
  }
  return maps
}

export class EcsParser {
  mgr = new EntityManager()
  templates = new Map<number, Template>()
  componentDefs = new Map<number, HashedComponent>()
  internedStrings = new Map<number, string>()
  maps: ComponentHashMaps

  constructor(maps: ComponentHashMaps) {
    this.maps = maps
  }

  /** Пакет типа 6: 0x24 — создание сущностей, 0x25 — то же в LZ4 */
  parsePacket(payload: Buffer): void {
    let r = new BitReader(payload)
    let control = r.readByte()
    if (control === 0x25) {
      const decomp = lz4DecompressBlock(payload.subarray(1), (payload.length - 1) * 8)
      r = new BitReader(decomp)
      control = 0x24
    }
    if (control !== 0x24) return
    const messageCount = r.readByte()
    for (let i = 0; i <= messageCount; i++) this.parseConstructMessage(r)
  }

  private parseConstructMessage(r: BitReader): void {
    const eid = readEID(r)
    const blockSize = r.readCompressed()
    const block = Buffer.from(r.readBytes(blockSize))
    const br = new BitReader(block)
    const templ = this.parseTemplate(br)
    const entity = this.deserializeConstruction(br, templ)
    this.mgr.addEntity(eid, entity)
  }

  private parseTemplate(r: BitReader): Template {
    const id = r.readCompressed()
    const known = this.templates.get(id)
    if (known) return known
    const name = r.readLenStr()
    const numComponents = r.readU16()
    const components: number[] = []
    for (let i = 0; i < numComponents; i++) {
      const compId = r.readCompressed()
      if (!this.componentDefs.has(compId)) {
        const nameHash = r.readU32()
        const typeHash = r.readU32()
        this.componentDefs.set(compId, { nameHash, typeHash })
      }
      components.push(compId)
    }
    const templ: Template = { id, name, components }
    this.templates.set(id, templ)
    return templ
  }

  private deserializeConstruction(r: BitReader, templ: Template): EcsEntity {
    const total = templ.components.length
    const compCount = total < 256 ? r.readByte() : r.readCompressed()
    const entity: EcsEntity = { template: templ.name, data: new EcsObject() }
    let comp = 0
    for (let i = 0; i < compCount; i++) {
      const ofs = total < 256 ? r.readByte() : r.readCompressed()
      comp = i === 0 ? ofs : comp + ofs + 1
      if (comp >= total) throw new Error(`индекс компонента ${comp} вне шаблона ${templ.name} (${total})`)
      const def = this.componentDefs.get(templ.components[comp]!)
      if (!def) throw new Error(`нет определения компонента ${templ.components[comp]}`)
      const value = this.deserializeComponent(r, def.typeHash, def.nameHash)
      const named = this.maps.dataComponents.get(def.nameHash)
      if (!named) throw new Error(`неизвестный хэш компонента 0x${def.nameHash.toString(16)} (обнови ${HASHES_FILE})`)
      entity.data.add(named.name, value)
    }
    return entity
  }

  deserializeComponent(r: BitReader, typeHash: number, nameHash: number): unknown {
    if (typeHash === 0) return null
    const parser =
      (nameHash !== 0 ? this.maps.dataComponentParsers.get(nameHash) : undefined) ??
      (nameHash === 0 ? this.maps.componentParsers.get(typeHash) : undefined)
    if (!parser) {
      const typeName = this.maps.componentNames.get(typeHash) ?? `0x${typeHash.toString(16)}`
      throw new Error(`нет сериализатора для компонента типа ${typeName}`)
    }
    return parser(r, this)
  }
}

// ---------- сериализаторы значений компонентов ----------

const skipBytes = (n: number) => (r: BitReader): null => {
  r.ignoreBytes(n)
  return null
}

function readString(r: BitReader): string {
  return r.readCstr()
}

/** Интернированная строка: сырое значение или 10-битный индекс словаря */
function readIString(r: BitReader, ctx: EcsParser): string {
  if (r.readBit()) return readString(r)
  const b = r.readBits(10)
  const idx = b[0]! | ((b[1] ?? 0) << 8)
  const known = ctx.internedStrings.get(idx)
  if (known !== undefined) return known
  const str = readString(r)
  ctx.internedStrings.set(idx, str)
  return str
}

function listOf(item: (r: BitReader, ctx: EcsParser) => unknown): ComponentParser {
  return (r, ctx) => {
    const count = r.readCompressed()
    if (count > Math.floor(r.remainingBits)) {
      throw new Error(`ECS list: count ${count} превышает остаток буфера`)
    }
    const out: unknown[] = []
    for (let i = 0; i < count; i++) out.push(item(r, ctx))
    return out
  }
}

/** Хранилища моделей техники: varint-размер в битах + блоб */
const storageParser: ComponentParser = (r) => {
  const bits = r.readCompressed()
  if (bits > r.remainingBits) throw new Error(`ECS storage: размер ${bits} превышает остаток буфера`)
  r.ignoreBits(bits)
  return null
}

/**
 * transform: кватернион/матрица не нужны, но позиция (последние 12 байт)
 * нужна — по ней ставятся маркеры зон захвата.
 */
const transformParser: ComponentParser = (r) => {
  if (r.readBit()) {
    r.ignoreBits(62)
    if (r.readBit()) r.ignoreBytes(4)
  } else {
    r.ignoreBytes(36)
  }
  const pos = r.readBytes(12)
  return { pos: [pos.readFloatLE(0), pos.readFloatLE(4), pos.readFloatLE(8)] }
}

const rendInstDescParser: ComponentParser = (r) => {
  r.readCompressed()
  const v2 = r.readCompressed()
  if (v2 !== 0) r.readCompressed()
  return null
}

const rendInstHandleParser: ComponentParser = (r) => {
  const word24 = r.readU32()
  if (word24 & (1 << 23)) r.readU32()
  return null
}

/** Payload/Bomb/Rocket/...: подвесное вооружение (структуру не разбираем) */
const rocketParser: ComponentParser = (r) => {
  r.readCompressed()
  readEID(r)
  readEID(r)
  r.readByte()
  r.ignoreBits(792)
  for (let i = 0; i < 3; i++) {
    const n = r.readBytes(2)
    const bits = ((n[0]! | (n[1]! << 8)) + 7) & 0xfffffff8
    r.readBits(bits)
  }
  r.ignoreBits(112)
  return null
}

const partIdParser: ComponentParser = (r) => r.readBits(6)[0]!

const COMPONENT_PARSERS: Record<string, ComponentParser> = {
  FlightModelWrapStorageComponent: storageParser,
  HeavyVehicleModelStorageComponent: storageParser,
  WarShipModelStorageComponent: storageParser,
  InfantryTroopStorageComponent: storageParser,
  HumanStorageComponent: storageParser,
  WalkerVehicleStorageComponent: storageParser,
  FortificationModelStorageComponent: storageParser,
  LightVehicleModelStorageComponent: storageParser,
  BarrageBalloonStorageComponent: storageParser,
  bool: (r) => r.readBit(),
  float: (r) => r.readF32(),
  'ecs::EntityId': (r) => readEID(r),
  TMatrix: (r) => {
    r.ignoreBytes(36)
    const pos = r.readBytes(12)
    return { pos: [pos.readFloatLE(0), pos.readFloatLE(4), pos.readFloatLE(8)] }
  },
  E3DCOLOR: skipBytes(4),
  int: (r) => r.readI32(),
  uint32_t: (r) => r.readU32(),
  Point2: skipBytes(8),
  Point3: (r) => {
    const b = r.readBytes(12)
    return { pos: [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)] }
  },
  Point4: skipBytes(16),
  IPoint2: skipBytes(8),
  IPoint3: skipBytes(12),
  IPoint4: skipBytes(16),
  'ecs::string': (r) => readString(r),
  'ecs::Object': (r, ctx) => {
    const obj = new EcsObject()
    const count = r.readCompressed()
    if (count > Math.floor(r.remainingBits / 33)) {
      throw new Error(`ECS object: count ${count} превышает остаток буфера`)
    }
    for (let i = 0; i < count; i++) {
      const name = readIString(r, ctx)
      const typeHash = r.readU32()
      obj.add(name, ctx.deserializeComponent(r, typeHash, 0))
    }
    return obj
  },
  'ecs::Array': (r, ctx) => {
    const count = r.readCompressed()
    if (count > Math.floor(r.remainingBits / 32)) {
      throw new Error(`ECS array: count ${count} превышает остаток буфера`)
    }
    const out: unknown[] = []
    for (let i = 0; i < count; i++) {
      const typeHash = r.readU32()
      out.push(ctx.deserializeComponent(r, typeHash, 0))
    }
    return out
  },
  'ecs::UInt8List': listOf((r) => r.readByte()),
  'ecs::UInt16List': listOf((r) => r.readU16()),
  'ecs::UInt32List': listOf((r) => r.readU32()),
  'ecs::UInt64List': listOf((r) => r.readU64()),
  'ecs::StringList': listOf((r) => readString(r)),
  'ecs::EidList': listOf((r) => readEID(r)),
  'ecs::FloatList': listOf((r) => r.readF32()),
  'ecs::Point2List': listOf((r) => void r.ignoreBytes(8)),
  'ecs::Point3List': listOf((r) => void r.ignoreBytes(12)),
  'ecs::Point4List': listOf((r) => void r.ignoreBytes(16)),
  'ecs::IPoint2List': listOf((r) => void r.ignoreBytes(8)),
  'ecs::IPoint3List': listOf((r) => void r.ignoreBytes(12)),
  'ecs::IPoint4List': listOf((r) => void r.ignoreBytes(16)),
  'ecs::BoolList': listOf((r) => r.readBit()),
  'ecs::TMatrixList': listOf((r) => void r.ignoreBytes(48)),
  'ecs::ColorList': listOf((r) => void r.ignoreBytes(4)),
  'ecs::Int8List': listOf((r) => r.readByte()),
  'ecs::Int16List': listOf((r) => r.readU16()),
  'ecs::IntList': listOf((r) => r.readI32()),
  'ecs::Int64List': listOf((r) => r.readU64()),
  // Да, в Go-исходнике dm::PartIdList читает count<<3 значений, а
  // uint16_t разбирается как список — переносим поведение как есть.
  'dm::PartIdList': (r) => {
    const rawCount = r.readCompressed()
    if (rawCount > Math.floor(r.remainingBits / 6 / 8)) {
      throw new Error(`ECS PartIdList: count ${rawCount} превышает остаток буфера`)
    }
    const count = rawCount * 8
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push(r.readBits(6)[0]!)
    return out
  },
  uint8_t: (r) => r.readByte(),
  uint16_t: listOf((r) => r.readU16()),
  'dm::PartId': partIdParser,
  Payload: rocketParser,
  Bomb: rocketParser,
  Rocket: rocketParser,
  Jettisoned: rocketParser,
  Torpedo: rocketParser,
  BufferedHudData: listOf((r) => r.readByte()),
}

const DATA_COMPONENT_PARSERS: Record<string, ComponentParser> = {
  ri_extra__riSyncDesc: rendInstDescParser,
  transform: transformParser,
  ri_extra__handle: rendInstHandleParser,
}
