import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fetchMissionInfo } from './mission-info.js'
import { extractReplayEvents, fetchReplayParts, type ReplayEvents } from './replay-events.js'
import { applyRealNames, parseReplayResults, parseWrplHeader, type ReplayResults, type WrplHeader } from './replay.js'
import { renderBattleLogImage } from './render-battle-log.js'
import { renderHeatmapImage } from './render-heatmap.js'
import { decorateTag } from './render-battle.js'
import { ensureVehicleDict } from './vehicles.js'

/**
 * Дополнительные материалы боя из пакетного потока реплея: battle log,
 * хитмапы (наземка/авиация) и чат матча. Готовые картинки кэшируются в
 * data/battles/ навсегда — реплей неизменяемый, а его части высыхают с
 * CDN через пару недель, поэтому один раз собранное не пересобираем.
 */

const CACHE_DIR = './data/battles'

export type BattleMediaKind = 'log' | 'heatmap-ground' | 'heatmap-air' | 'chat'

export interface BattleMedia {
  log: Buffer
  heatmapGround: Buffer
  heatmapAir: Buffer
  /** Текст чата матча (уже с юникод-заменами украшений тегов) */
  chat: string
}

const cacheFile = (sessionIdHex: string, kind: BattleMediaKind): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-${kind}${kind === 'chat' ? '.txt' : '.png'}`)

/** Достаёт материал из кэша, не собирая ничего */
export function cachedBattleMedia(sessionIdHex: string, kind: BattleMediaKind): Buffer | null {
  const file = cacheFile(sessionIdHex, kind)
  return existsSync(file) ? readFileSync(file) : null
}

/** Крохи из пакетного потока, которых нет в results-BLK (победитель) */
export interface BattleMeta {
  /** Номер победившей команды (как team в results) или 0 — не определён */
  teamWon: number
  /** Длительность записи, мс */
  endTimeMs: number
}

/** Мета из кэша (пишется при сборке материалов), не собирая ничего */
export function cachedBattleMeta(sessionIdHex: string): BattleMeta | null {
  const file = path.join(CACHE_DIR, `${sessionIdHex}-meta.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BattleMeta
  } catch {
    return null
  }
}

type BuiltBattleMedia = BattleMedia & { events: ReplayEvents; header: WrplHeader }

/** Сессии, которые уже собираются: параллельные вызовы (две кнопки разом,
 * автоанонс + кнопка) получают общий промис вместо второй скачки и сборки */
const inflightBuilds = new Map<string, Promise<BuiltBattleMedia>>()

/**
 * Собирает все материалы боя: скачивает части реплея, разбирает пакетный
 * поток и рендерит картинки. Результат кэшируется; повторный вызов отдаёт
 * кэш. missionName — как в записи парсера (" [Domination #2] North Holland"),
 * realNames — реальные ники по userId (см. realNamesFromItem): в results-BLK
 * у игроков с анонимайзером лежат выдуманные.
 */
export function buildBattleMedia(
  partUrls: string[],
  missionName: string,
  realNames: Map<string, string> = new Map(),
): Promise<BuiltBattleMedia> {
  const key = partUrls[0] ?? ''
  const running = inflightBuilds.get(key)
  if (running) return running
  const build = doBuildBattleMedia(partUrls, missionName, realNames).finally(() => inflightBuilds.delete(key))
  inflightBuilds.set(key, build)
  return build
}

async function doBuildBattleMedia(
  partUrls: string[],
  missionName: string,
  realNames: Map<string, string>,
): Promise<BuiltBattleMedia> {
  if (partUrls.length === 0) throw new Error('пустой список частей реплея')
  const parts = await fetchReplayParts(partUrls)

  const header = parseWrplHeader(parts[0]!)
  let results: ReplayResults | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const h = parseWrplHeader(parts[i]!)
    if (h.resultsBlkOffset > 0 && h.resultsBlkOffset < parts[i]!.length) {
      results = parseReplayResults(parts[i]!.subarray(h.resultsBlkOffset))
      break
    }
  }
  if (!results) throw new Error('ни одна часть реплея не содержит results-BLK')
  applyRealNames(results, realNames)

  const events = await extractReplayEvents(parts)
  if (events.errors.length > 0) {
    console.warn(`[wrpl] события ${header.sessionId}: ${events.errors.length} ошибок разбора, первая: ${events.errors[0]}`)
  }
  const dict = await ensureVehicleDict()
  const mission = await fetchMissionInfo(levelSettingsOf(parts[0]!))

  const [log, heatmapGround, heatmapAir] = await Promise.all([
    renderBattleLogImage({ missionName, header, results, events, dict }),
    renderHeatmapImage({ missionName, header, results, events, dict, mission, mode: 'ground' }),
    renderHeatmapImage({ missionName, header, results, events, dict, mission, mode: 'air' }),
  ])
  const chat = formatChat(events)

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile(header.sessionIdHex, 'log'), log)
  writeFileSync(cacheFile(header.sessionIdHex, 'heatmap-ground'), heatmapGround)
  writeFileSync(cacheFile(header.sessionIdHex, 'heatmap-air'), heatmapAir)
  writeFileSync(cacheFile(header.sessionIdHex, 'chat'), chat)
  writeFileSync(
    path.join(CACHE_DIR, `${header.sessionIdHex}-meta.json`),
    JSON.stringify({ teamWon: events.teamWon, endTimeMs: events.endTime } satisfies BattleMeta),
  )

  return { log, heatmapGround, heatmapAir, chat, events, header }
}

/** Путь к файлу миссии из заголовка (поле levelSettings, 260 байт с 136) */
function levelSettingsOf(part0: Buffer): string {
  const chunk = part0.subarray(136, 136 + 260)
  const end = chunk.indexOf(0)
  return chunk.subarray(0, end < 0 ? chunk.length : end).toString('utf8')
}

const CHANNEL_LABEL = ['TEAM', 'ALL', 'SQUAD', 'DM']

function formatChat(events: ReplayEvents): string {
  if (events.chat.length === 0) return 'В этом бою никто не писал в чат.'
  const clanOf = new Map(events.players.map((p) => [p.name, p.clanTag]))
  return events.chat
    .map((m) => {
      const s = Math.floor(m.time / 1000)
      const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      const clan = clanOf.get(m.sender)
      const who = clan ? `[${decorateTag(clan)}] ${m.sender}` : m.sender
      return `[${t}] [${CHANNEL_LABEL[m.channel] ?? '?'}] ${who}: ${m.message}`
    })
    .join('\n')
}
