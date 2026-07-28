import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { config } from '../config.js'
import {
  getSiteBattleEventsBlob,
  getSiteBattleSummary,
} from '../db/index.js'
import { runWorkerTask } from '../workers/pool.js'
import { writeFileAtomic } from '../atomic-file.js'
import { loadLocalTacticalMap } from './battle-assets.js'
import { enforceBattleCacheCap } from './battle-media.js'
import { fetchMissionInfo } from './mission-info.js'
import { BATTLE_SCENE_VERSION, type ScenePrepareInput } from './battle-scene-core.js'

// Оркестрация сцены боя (main thread): чтение БД, миссия, выбор карты и кэш.
// Тяжёлая работа (gunzip/прореживание/gzip) — в worker-задаче prepare-scene;
// сюда данные приходят и уходят transferable-буферами (воркер не видит БД).

const CACHE_DIR = './data/battles'
const MAX_SCENE_BYTES = 16 * 1024 * 1024
/** Бюджет одновременных сборок сцен: разные session не должны занимать пул целиком. */
const MAX_ACTIVE_BUILDS = 2
const SCENE_TIMEOUT_MS = 120_000

const sceneCacheFile = (sessionIdHex: string): string =>
  path.join(CACHE_DIR, `${sessionIdHex}-scene-v${BATTLE_SCENE_VERSION}.json.gz`)

const isGzip = (data: Buffer): boolean => data.length > 2 && data[0] === 0x1f && data[1] === 0x8b

export type BattleSceneResult =
  | { status: 'ok'; sceneGzip: Buffer }
  | { status: 'not_found' }
  /** Бой разобран, но events_blob отсутствует — плеер деградирует до сообщения. */
  | { status: 'no_events' }
  /** Заняты все слоты сборки сцен; клиенту стоит повторить через несколько секунд. */
  | { status: 'busy' }

const inflightScenes = new Map<string, Promise<BattleSceneResult>>()
let activeBuilds = 0

async function readCachedScene(file: string): Promise<Buffer | null> {
  if (!config.battleCacheEnabled) return null
  try {
    const data = await readFile(file)
    if (data.byteLength > MAX_SCENE_BYTES || !isGzip(data)) return null
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Сцена боя для плеера: gzip JSON (см. BattleScene в battle-scene-core.ts).
 * Read-only относительно БД; результат кэшируется в data/battles/ под общим
 * LRU-лимитом. Параллельные запросы одной session дедуплицируются.
 */
export async function buildBattleSceneGzip(sessionId: string): Promise<BattleSceneResult> {
  const summary = getSiteBattleSummary(sessionId)
  if (!summary) return { status: 'not_found' }
  const file = sceneCacheFile(summary.battle.session_hex)
  const cached = await readCachedScene(file)
  if (cached) return { status: 'ok', sceneGzip: cached }

  const existing = inflightScenes.get(sessionId)
  if (existing) return existing
  if (activeBuilds >= MAX_ACTIVE_BUILDS) return { status: 'busy' }

  activeBuilds += 1
  const job = (async (): Promise<BattleSceneResult> => {
    const blob = getSiteBattleEventsBlob(sessionId)
    if (!blob || blob.byteLength === 0) return { status: 'no_events' }

    const battle = summary.battle
    const mission = battle.mission_settings
      ? await fetchMissionInfo(battle.mission_settings, 'interactive').catch(() => null)
      : null
    // Политика этапа 3: карта — только уже скачанный локальный файл; холодный
    // кэш отдаёт сцену без картинки, плеер рисует сетку и зоны.
    const mapBuffer = await loadLocalTacticalMap(battle.level).catch(() => null)

    const scene: ScenePrepareInput = {
      sessionId: battle.session_id,
      missionName: battle.mission_name,
      gameMode: battle.game_mode,
      startTime: battle.start_time,
      durationSec: battle.duration_sec,
      teamWon: battle.team_won,
      missionArea: mission?.area ?? null,
      mapAvailable: mapBuffer !== null,
      level: battle.level,
      players: summary.players
        .filter((player) => player.user_id !== '')
        .map((player) => ({
          userId: player.user_id,
          nick: player.nick,
          team: player.team,
          clanTag: player.clan_tag || null,
        })),
    }

    // Точный ArrayBuffer без SharedArrayBuffer-ветки: копия ровно нужного среза.
    const eventsAb = new ArrayBuffer(blob.byteLength)
    new Uint8Array(eventsAb).set(blob)
    const sceneAb = await runWorkerTask(
      { kind: 'prepare-scene', input: { eventsBlob: eventsAb, scene } },
      { priority: 'interactive', timeoutMs: SCENE_TIMEOUT_MS, transferList: [eventsAb] },
    )
    const sceneGzip = Buffer.from(sceneAb)
    // Как и PNG-артефакты: результат сохраняется даже при выключенном кэше
    // чтения, пишется атомарно и подчиняется общему LRU-лимиту каталога.
    if (sceneGzip.byteLength <= MAX_SCENE_BYTES) {
      await writeFileAtomic(file, sceneGzip).catch(() => undefined)
      await enforceBattleCacheCap(sceneGzip.byteLength).catch(() => undefined)
    }
    return { status: 'ok', sceneGzip }
  })().finally(() => {
    activeBuilds -= 1
    inflightScenes.delete(sessionId)
  })
  inflightScenes.set(sessionId, job)
  return job
}

/** Локальная тактическая карта боя для плеера; null — файла нет (без докачки). */
export async function loadBattleSceneMap(sessionId: string): Promise<Buffer | null> {
  const summary = getSiteBattleSummary(sessionId)
  if (!summary) return null
  return loadLocalTacticalMap(summary.battle.level).catch(() => null)
}
