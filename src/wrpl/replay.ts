import { parseBlk, type BlkMap, type BlkValue } from './blk.js'
import { MAX_REPLAY_PARTS, replayUrlStructureProblem } from './replay-url-policy.js'
import { fetchReplayPart } from './replay-cache.js'
import { runWorkerTask, transferableBuffer, type WorkerPriority } from '../workers/pool.js'

/**
 * Разбор контейнера .wrpl (серверный реплей War Thunder).
 *
 * Структура файла (смещения проверены на реальных реплеях версии 2.57,
 * формат описан в Go-библиотеке wrpl-inspector, AGPL-3.0):
 *
 *   0     магия e5 ac 00 10
 *   4     версия (i32)
 *   8     карта, 128 байт ("levels/avg_finland.bin")
 *   684   смещение results-BLK (i32; 0 — в этой части результатов нет)
 *   732   session id (u64)
 *   740   номер части реплея (u8); байт 742 == 0x5a — серверный реплей
 *   748   размер settings-BLK (u16), сам BLK лежит после заголовка (1226)
 *   780   локализованное имя миссии, 128 байт
 *   908   время начала боя (unix, u32)
 *   1226  конец заголовка
 *
 * Результаты боя (таблица игроков) лежат в конце ПОСЛЕДНЕЙ части реплея
 * в формате BLK — для них пакетный поток распаковывать не нужно.
 */

const HEADER_SIZE = 1226

export interface WrplHeader {
  version: number
  /** Версия игры из metadata сайта; в бинарном заголовке её нет. */
  gameVersion?: string
  level: string
  battleType: string
  environment: string
  visibility: string
  resultsBlkOffset: number
  difficulty: number
  sessionId: string
  sessionIdHex: string
  partNumber: number
  isServer: boolean
  settingsBlkSize: number
  locName: string
  startTime: number
  timeLimit: number
  scoreLimit: number
  battleClass: string
}

export function parseWrplHeader(buf: Buffer): WrplHeader {
  if (buf.length < HEADER_SIZE) throw new Error(`файл короче заголовка (${buf.length} байт)`)
  if (!(buf[0] === 0xe5 && buf[1] === 0xac && buf[2] === 0x00 && buf[3] === 0x10)) {
    throw new Error('неверная магия — это не .wrpl файл')
  }
  const cstr = (off: number, len: number): string => {
    const chunk = buf.subarray(off, off + len)
    const end = chunk.indexOf(0)
    return chunk.subarray(0, end < 0 ? len : end).toString('utf8')
  }
  const sessionId = buf.readBigUInt64LE(732)
  return {
    version: buf.readInt32LE(4),
    level: cstr(8, 128),
    battleType: cstr(396, 128),
    environment: cstr(524, 128),
    visibility: cstr(652, 32),
    resultsBlkOffset: buf.readInt32LE(684),
    difficulty: buf[688]!,
    sessionId: sessionId.toString(10),
    sessionIdHex: sessionId.toString(16).padStart(16, '0'),
    partNumber: buf[740]!,
    isServer: buf[742] === 0x5a,
    settingsBlkSize: buf.readUInt16LE(748),
    locName: cstr(780, 128),
    startTime: buf.readUInt32LE(908),
    timeLimit: buf.readUInt32LE(912),
    scoreLimit: buf.readUInt32LE(916),
    battleClass: cstr(968, 128),
  }
}

/** Результаты боя одного игрока из results-BLK */
export interface ReplayPlayerResult {
  userId: string
  name: string
  clanTag: string
  team: number
  /** Воздушные фраги (по людям) */
  kills: number
  groundKills: number
  navalKills: number
  aiKills: number
  aiGroundKills: number
  assists: number
  deaths: number
  captureZone: number
  damageZone: number
  score: number
  awardDamage: number
  teamKills: number
  squadId: number
  autoSquad: boolean
  /** Данные ECS-слота; отсутствуют в results-BLK. */
  slot?: number | null
  title?: string | null
  /** Техника игрока в бою: внутренние имена, в порядке слотов */
  vehicles: string[]
}

export interface ReplayResults {
  status: string
  /** Длительность боя в секундах */
  timePlayed: number
  players: ReplayPlayerResult[]
}

const asArray = (v: BlkValue | undefined): BlkValue[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const asMap = (v: BlkValue | undefined): BlkMap => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as BlkMap) : {})
const num = (m: BlkMap, k: string, def = -1): number => (typeof m[k] === 'number' ? (m[k] as number) : def)
const str = (m: BlkMap, k: string, def = ''): string => (typeof m[k] === 'string' ? (m[k] as string) : def)
const bool = (m: BlkMap, k: string, def = false): boolean => {
  const value = m[k]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return /^(?:1|true|yes)$/i.test(value.trim())
  return def
}

/** Разбирает results-BLK последней части реплея в таблицу результатов */
export function parseReplayResults(resultsBlk: Buffer): ReplayResults {
  const root = parseBlk(resultsBlk)

  const matchingInfo = asMap(root['matchingInfo'])
  const players: ReplayPlayerResult[] = []

  // Техника: matchingInfo.<userId>.crafts_info.{array0, array1, ...}.name
  const vehiclesOf = (userId: string): string[] => {
    const vehicles: string[] = []
    const craftsInfo = asMap(asMap(matchingInfo[userId])['crafts_info'])
    const slots = Object.keys(craftsInfo)
      .filter((k) => /^array\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    for (const slot of slots) {
      const name = str(asMap(craftsInfo[slot]), 'name')
      if (name) vehicles.push(name)
    }
    return vehicles
  }

  for (const p of asArray(root['player'])) {
    const pm = asMap(p)
    const userId = str(pm, 'userId')
    if (!userId) continue

    players.push({
      userId,
      name: str(pm, 'name'),
      clanTag: str(pm, 'clanTag'),
      team: num(pm, 'team'),
      kills: num(pm, 'kills'),
      groundKills: num(pm, 'groundKills'),
      navalKills: num(pm, 'navalKills'),
      aiKills: num(pm, 'aiKills'),
      aiGroundKills: num(pm, 'aiGroundKills'),
      assists: num(pm, 'assists'),
      deaths: num(pm, 'deaths'),
      captureZone: num(pm, 'captureZone'),
      damageZone: num(pm, 'damageZone'),
      score: num(pm, 'score'),
      awardDamage: num(pm, 'awardDamage'),
      teamKills: num(pm, 'teamKills'),
      squadId: num(pm, 'squadId'),
      autoSquad: bool(pm, 'autoSquad'),
      vehicles: vehiclesOf(userId),
    })
  }

  // Игрок попал в матч (есть в matchingInfo), но строки результатов нет —
  // отключился до конца боя, ник в реплее не сохранился. Добавляем запись
  // с пустым именем: рендер покажет её как «Unknown Player · Disconnected».
  const knownIds = new Set(players.map((p) => p.userId))
  for (const userId of Object.keys(matchingInfo)) {
    if (knownIds.has(userId)) continue
    players.push({
      userId,
      name: '',
      clanTag: '',
      team: -1,
      kills: -1,
      groundKills: -1,
      navalKills: -1,
      aiKills: -1,
      aiGroundKills: -1,
      assists: -1,
      deaths: -1,
      captureZone: -1,
      damageZone: -1,
      score: -1,
      awardDamage: -1,
      teamKills: -1,
      squadId: -1,
      autoSquad: false,
      vehicles: vehiclesOf(userId),
    })
  }

  return {
    status: str(root, 'status'),
    timePlayed: num(root, 'timePlayed', 0),
    players,
  }
}

/** sessionId в БД хранится десятичным; принимаем и hex-вид из URL реплея */
export function normalizeSessionId(raw: string): string {
  return /^\d+$/.test(raw) ? raw : BigInt('0x' + raw.replace(/^0x/i, '')).toString(10)
}

export interface ReplayPartUrlSource {
  replayParts?: string[] | null
  url?: string
  partsCount?: number
}

export interface ReplayPartsResolution {
  urls: string[]
  /** Почему ссылки отклонены; null — ссылки корректны или их просто нет. */
  problem: string | null
}

function explicitPartUrls(parts: unknown): ReplayPartsResolution {
  if (!Array.isArray(parts)) return { urls: [], problem: 'replayParts не является списком' }
  if (parts.length > MAX_REPLAY_PARTS) {
    return { urls: [], problem: `частей ${parts.length} больше предела ${MAX_REPLAY_PARTS}` }
  }
  const urls: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') return { urls: [], problem: 'ссылка на часть не является строкой' }
    const problem = replayUrlStructureProblem(part, true)
    if (problem !== null) return { urls: [], problem }
    urls.push(part)
  }
  return { urls, problem: null }
}

function templatePartUrls(base: unknown, partsCount: unknown): ReplayPartsResolution {
  if (typeof base !== 'string' || typeof partsCount !== 'number') return { urls: [], problem: null }
  // partsCount — индекс последней части: частей partsCount + 1.
  if (!Number.isSafeInteger(partsCount) || partsCount < 0 || partsCount >= MAX_REPLAY_PARTS) {
    return { urls: [], problem: `некорректное число частей ${String(partsCount)}` }
  }
  if (base.includes('?') || base.includes('#') || !base.endsWith('/')) {
    return { urls: [], problem: 'базовый URL реплея должен заканчиваться на / без query' }
  }
  const urls = Array.from({ length: partsCount + 1 }, (_, i) => `${base}${String(i).padStart(4, '0')}.wrpl`)
  const problem = replayUrlStructureProblem(urls[0]!, true)
  return problem === null ? { urls, problem: null } : { urls: [], problem }
}

/**
 * Ссылки на части реплея из данных записи (с фолбэком по шаблону CDN) после
 * структурной проверки URL и предела частей: данные пришли из внешнего API.
 * Отказ здесь терминален (no_parts), поэтому allowlist WT_REPLAY_HOSTS
 * проверяется позже, при скачивании, как обычная повторяемая ошибка.
 */
export function resolveReplayPartUrls(data: ReplayPartUrlSource): ReplayPartsResolution {
  let explicitProblem: string | null = null
  if (data.replayParts !== undefined && data.replayParts !== null
    && !(Array.isArray(data.replayParts) && data.replayParts.length === 0)) {
    const explicit = explicitPartUrls(data.replayParts)
    if (explicit.problem === null) return explicit
    explicitProblem = explicit.problem
  }
  const templated = templatePartUrls(data.url, data.partsCount)
  if (templated.urls.length > 0) return templated
  return { urls: [], problem: templated.problem ?? explicitProblem }
}

/** Список проверенных ссылок на части реплея; пустой, если ссылок нет или они отклонены. */
export function replayPartUrls(data: ReplayPartUrlSource): string[] {
  return resolveReplayPartUrls(data).urls
}

/**
 * Реальные ники по userId из данных записи сайта. Игровой анонимайзер
 * (премиум-фича) подменяет ник в бою: в results-BLK реплея лежит
 * выдуманный (fakeName с сайта), из-за чего ломается показ ника и
 * поиск ПКР на клановой странице. Сайт отдаёт и настоящее имя, и подмену.
 */
export function realNamesFromItem(data: { players?: unknown }): Map<string, string> {
  const map = new Map<string, string>()
  if (data.players === null || typeof data.players !== 'object') return map
  for (const list of Object.values(data.players)) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const p = raw as { userId?: unknown; name?: unknown; fakeName?: unknown } | null
      if (
        p !== null &&
        typeof p.userId === 'string' &&
        typeof p.name === 'string' &&
        typeof p.fakeName === 'string' &&
        p.fakeName !== ''
      ) {
        map.set(p.userId, p.name)
      }
    }
  }
  return map
}

/** Подменяет анонимные ники в results на реальные (по userId) */
export function applyRealNames(results: ReplayResults, names: Map<string, string>): void {
  if (names.size === 0) return
  for (const p of results.players) {
    const real = names.get(p.userId)
    // пустое имя — признак отключившегося, его не трогаем
    if (real !== undefined && p.name !== '') p.name = real
  }
}

/**
 * Скачивает части реплея и возвращает результаты боя.
 * Идёт с конца списка: results-BLK лежит в последней части.
 */
export async function fetchReplayResults(
  partUrls: string[],
  priority: WorkerPriority = 'interactive',
): Promise<{ header: WrplHeader; results: ReplayResults }> {
  if (partUrls.length === 0) throw new Error('пустой список частей реплея')
  for (let i = partUrls.length - 1; i >= 0; i--) {
    const url = partUrls[i]!
    const buf = await fetchReplayPart(url, {
      priority: priority === 'background' ? 'background' : 'live',
    })
    const part = transferableBuffer(buf)
    const parsed = await runWorkerTask(
      { kind: 'parse-results', input: { part, realNames: [] } },
      { priority, transferList: [part] },
    )
    if (parsed) return parsed
    // в этой части результатов нет — пробуем предыдущую
  }
  throw new Error('ни одна часть реплея не содержит results-BLK')
}
