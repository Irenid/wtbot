import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { markBattleIngest, saveBattle } from '../db/index.js'
import { buildBattleInput, levelSettingsOf, loadBattleData, reconstructBattle, type BattleItemMeta } from './battle-data.js'
import { fetchMissionInfo } from './mission-info.js'
import { type ReplayEvents } from './replay-events.js'
import { dropReplayCache } from './replay-cache.js'
import { type ReplayResults, type WrplHeader } from './replay.js'
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

/**
 * Достаёт материал из кэша, не собирая ничего. При попадании обновляет mtime
 * файла — так вытеснение LRU оставляет часто открываемые бои и выкидывает
 * давно не тронутые (кэш ограничен по размеру, см. enforceCacheCap).
 */
export function cachedBattleMedia(sessionIdHex: string, kind: BattleMediaKind): Buffer | null {
  const file = cacheFile(sessionIdHex, kind)
  if (!existsSync(file)) return null
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    // не смогли обновить mtime — не критично
  }
  return readFileSync(file)
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
 * Собирает все материалы боя и кэширует картинки в data/battles/.
 *
 * Источник данных выбирается сам: если бой уже разобран в БД — рендерит
 * прямо из неё, реплей не качается (см. reconstructBattle). Иначе скачивает
 * части, разбирает пакетный поток, сохраняет бой в БД (saveBattle — так
 * кнопка/автоанонс тоже пополняют датасет) и удаляет части с диска.
 *
 * meta — метаданные записи парсера (missionName вида
 * "[Domination #2] North Holland", режим, версия игры); realNames —
 * реальные ники по userId (см. realNamesFromItem): в results-BLK у игроков
 * с анонимайзером лежат выдуманные. Для боёв, уже лежащих в БД, partUrls и
 * realNames не нужны — можно передать [] и пустую карту.
 */
export function buildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string> = new Map(),
): Promise<BuiltBattleMedia> {
  const running = inflightBuilds.get(sessionId)
  if (running) return running
  const build = doBuildBattleMedia(sessionId, partUrls, meta, realNames).finally(() =>
    inflightBuilds.delete(sessionId),
  )
  inflightBuilds.set(sessionId, build)
  return build
}

async function doBuildBattleMedia(
  sessionId: string,
  partUrls: string[],
  meta: BattleItemMeta,
  realNames: Map<string, string>,
): Promise<BuiltBattleMedia> {
  let header: WrplHeader
  let results: ReplayResults
  let events: ReplayEvents
  let missionSettings: string | null

  // 1. Бой уже разобран — рендерим из БД, реплей не трогаем
  const recon = reconstructBattle(sessionId)
  if (recon) {
    ;({ header, results, events, missionSettings } = recon)
  } else {
    // 2. Нет в БД — качаем, разбираем, пополняем датасет, части удаляем
    const loaded = await loadBattleData(partUrls, realNames)
    header = loaded.header
    results = loaded.results
    events = loaded.events
    missionSettings = loaded.parts[0] ? levelSettingsOf(loaded.parts[0]) : null
    if (events.errors.length > 0) {
      console.warn(
        `[wrpl] события ${header.sessionId}: ${events.errors.length} ошибок разбора, первая: ${events.errors[0]}`,
      )
    }
    try {
      saveBattle(buildBattleInput(meta, loaded))
      markBattleIngest(header.sessionId, 'ok')
      dropReplayCache(header.sessionIdHex)
    } catch (err) {
      console.warn(`[wrpl] не сохранил бой ${header.sessionId} в БД: ${(err as Error).message}`)
    }
  }

  const missionName = meta.missionName ?? header.locName ?? ''
  const dict = await ensureVehicleDict()
  const mission = missionSettings ? await fetchMissionInfo(missionSettings) : null

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
  enforceCacheCap()

  return { log, heatmapGround, heatmapAir, chat, events, header }
}

/**
 * data/battles — кэш готовых картинок, а не хранилище: всё в нём
 * перерисовывается из БД без реплея, поэтому размер ограничен. Когда каталог
 * перерастает лимит (WT_BATTLE_CACHE_MB, по умолчанию 400 МБ), удаляем файлы
 * от самых давно нетронутых (mtime), пока не уйдём под 90% лимита.
 */
const CACHE_CAP_BYTES = Math.max(50, Number(config.battleCacheMb) || 400) * 1024 * 1024
let cacheCapChecked = false

function enforceCacheCap(): void {
  try {
    const files = readdirSync(CACHE_DIR).map((name) => {
      const st = statSync(path.join(CACHE_DIR, name))
      return { path: path.join(CACHE_DIR, name), size: st.size, mtime: st.mtimeMs }
    })
    let total = files.reduce((acc, f) => acc + f.size, 0)
    if (total <= CACHE_CAP_BYTES) {
      cacheCapChecked = true
      return
    }
    const target = CACHE_CAP_BYTES * 0.9
    files.sort((a, b) => a.mtime - b.mtime) // старые первыми
    let removed = 0
    for (const f of files) {
      if (total <= target) break
      try {
        rmSync(f.path, { force: true })
        total -= f.size
        removed++
      } catch {
        // не смогли удалить — пропускаем
      }
    }
    if (!cacheCapChecked && removed > 0) {
      console.log(`[battle-media] кэш картинок превысил ${(CACHE_CAP_BYTES / 1024 / 1024) | 0} МБ — вытеснено ${removed} файлов`)
    }
    cacheCapChecked = true
  } catch {
    // каталога ещё нет или гонка — не мешаем сборке
  }
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
