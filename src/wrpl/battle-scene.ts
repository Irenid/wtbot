import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { config } from '../config.js'
import {
  getSiteBattleEventsBlob,
  getSiteBattleSummary,
} from '../db/index.js'
import { runWorkerTask } from '../workers/pool.js'
import { writeFileAtomic } from '../atomic-file.js'
import { ensureTacticalMap, loadCachedTacticalMap, loadLocalTacticalMap } from './battle-assets.js'
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
 * The battle scene for the player: gzip JSON (BattleScene in
 * battle-scene-core.ts). Reads the database only; the result is cached in
 * data/battles/ under the shared LRU cap. Parallel requests for one session
 * are merged.
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
    // The map covers the mission's battleArea: without it no map is needed,
    // and the player draws a grid and zones.
    const mapBuffer = mission?.area ? await sceneMapImage(battle.mission_name, battle.level) : null
    const botSlots = new Map(
      summary.players.flatMap((player) => (player.bot_user_id ? [[player.bot_user_id, player.user_id] as const] : [])),
    )

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
      // Team ≤ 0 is unknown; a paired bot slot's tracks belong to its player.
      players: summary.players
        .filter((player) => player.user_id !== '' && player.team > 0 && !botSlots.has(player.user_id))
        .map((player) => ({
          userId: player.user_id,
          nick: player.nick,
          team: player.team,
          clanTag: player.clan_tag || null,
        })),
      botSlots: [...botSlots],
    }

    // An exact ArrayBuffer, no SharedArrayBuffer branch: a copy of just the slice.
    const eventsAb = new ArrayBuffer(blob.byteLength)
    new Uint8Array(eventsAb).set(blob)
    const sceneAb = await runWorkerTask(
      { kind: 'prepare-scene', input: { eventsBlob: eventsAb, scene } },
      { priority: 'interactive', timeoutMs: SCENE_TIMEOUT_MS, transferList: [eventsAb] },
    )
    const sceneGzip = Buffer.from(sceneAb)
    // Like the PNG artifacts: saved even with the read cache disabled,
    // written atomically and subject to the directory's shared LRU cap.
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

/**
 * Подложка сцены — та же, что у наземной хитмапы: снимок тактической карты
 * режима миссии (wt-tools, покрывает ровно battleArea; скачивается один раз и
 * лежит в data/maps), иначе старая локальная карта уровня. Раньше сцена брала
 * только локальную, а она есть у единиц уровней — плеер почти всегда был без карты.
 */
async function sceneMapImage(missionName: string, level: string): Promise<Buffer | null> {
  return (await ensureTacticalMap(missionName).catch(() => null))
    ?? (await loadLocalTacticalMap(level).catch(() => null))
}

/**
 * Карта боя для плеера; null — карты нет. Только с диска: снимок скачивает
 * сборка сцены, и плеер просит карту, лишь когда сцена её объявила.
 */
export async function loadBattleSceneMap(sessionId: string): Promise<Buffer | null> {
  const summary = getSiteBattleSummary(sessionId)
  if (!summary) return null
  return (await loadCachedTacticalMap(summary.battle.mission_name).catch(() => null))
    ?? (await loadLocalTacticalMap(summary.battle.level).catch(() => null))
}
