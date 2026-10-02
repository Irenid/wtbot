import { deleteBotState, getBotState, getDbWorkerPath, setBotState } from './index.js'
import { runWorkerTask } from '../workers/pool.js'

/**
 * Фоновое обслуживание базы в долгоживущем процессе бота. Вся работа с
 * SQLite — в worker-задачах на своём подключении, main thread только
 * планирует:
 *
 * - перевод блобов событий в колоночный формат (events-codec.ts) пачками:
 *   ~70 → 20 КиБ на бой у zstd-JSON и ~130 → 20 КиБ у gzip; курсор в bot_state
 *   переживает перезапуск, в конце таблицы задача останавливается. Каждая
 *   пачка сразу возвращает ОС освободившиеся страницы;
 * - раз в несколько часов PRAGMA optimize и возврат ОС оставшихся свободных
 *   страниц (incremental_vacuum) порциями, пока они есть.
 *
 * Обе работы последовательны (overlap guard) и останавливаются до закрытия
 * CPU pool (shutdown в index.ts).
 */

const RECOMPRESS_CURSOR_KEY = 'db-maintenance:events-columnar-after'
const RECOMPRESS_DONE_KEY = 'db-maintenance:events-columnar-done'
/** Курсор прежнего перевода gzip → zstd-JSON: колоночный перевод его заменил. */
const LEGACY_RECOMPRESS_KEYS = ['db-maintenance:recompress-after', 'db-maintenance:recompress-done'] as const
/** Пачка ~20 боёв: кодирование с проверкой ~45 мс на бой, пачка держит worker ~1 с. */
const RECOMPRESS_BATCH = 20
const RECOMPRESS_PAUSE_MS = 2_000
const RECOMPRESS_RETRY_MS = 5 * 60_000
/** Пачка освобождает ~500 страниц; потолок — с запасом, шаги короткие. */
const RECOMPRESS_VACUUM_PAGES = 4_096
const RECOMPRESS_PROGRESS_EVERY = 5_000
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
/** Пока свободных страниц больше порции — следующая порция через 2 минуты. */
const MAINTENANCE_BUSY_INTERVAL_MS = 2 * 60_000
/** Первое обслуживание — не сразу: старт и так читает базу (прогрев, парсеры). */
const MAINTENANCE_FIRST_DELAY_MS = 10 * 60_000
/** 32 МиБ за задачу — шагами по VACUUM_STEP_PAGES (db/index.ts) с паузами. */
const MAINTENANCE_MAX_PAGES = 8_192

let recompressTimer: NodeJS.Timeout | null = null
let maintenanceTimer: NodeJS.Timeout | null = null
let recompressRunning: Promise<void> | null = null
let maintenanceRunning: Promise<void> | null = null
let stopped = true
let totals = { scanned: 0, converted: 0, kept: 0, bytesBefore: 0, bytesAfter: 0, freedBytes: 0 }
let nextProgressAt = RECOMPRESS_PROGRESS_EVERY

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

function recompressSummary(): string {
  return (
    `${totals.converted} боёв, ${mib(totals.bytesBefore)} → ${mib(totals.bytesAfter)} МиБ` +
    (totals.kept > 0 ? `, ${totals.kept} оставлено в zstd-JSON` : '') +
    `, возвращено ОС ${mib(totals.freedBytes)} МиБ`
  )
}

function scheduleRecompress(delayMs: number): void {
  if (stopped) return
  recompressTimer = setTimeout(() => {
    recompressTimer = null
    recompressRunning = recompressBatch().finally(() => {
      recompressRunning = null
    })
  }, delayMs)
  recompressTimer.unref()
}

async function recompressBatch(): Promise<void> {
  const dbPath = getDbWorkerPath()
  if (stopped || dbPath === null) return
  const after = getBotState(RECOMPRESS_CURSOR_KEY) ?? ''
  try {
    const result = await runWorkerTask(
      {
        kind: 'recompress-events-blobs',
        input: { dbPath, afterSessionId: after, limit: RECOMPRESS_BATCH, vacuumPages: RECOMPRESS_VACUUM_PAGES },
      },
      { priority: 'background', timeoutMs: 120_000 },
    )
    totals = {
      scanned: totals.scanned + result.scanned,
      converted: totals.converted + result.converted,
      kept: totals.kept + result.kept,
      bytesBefore: totals.bytesBefore + result.bytesBefore,
      bytesAfter: totals.bytesAfter + result.bytesAfter,
      freedBytes: totals.freedBytes + result.freedBytes,
    }
    if (result.lastSessionId === null) {
      setBotState(RECOMPRESS_DONE_KEY, String(Math.floor(Date.now() / 1_000)))
      if (totals.scanned > 0) console.log(`[db] Блобы событий переведены в колоночный формат: ${recompressSummary()}`)
      return
    }
    setBotState(RECOMPRESS_CURSOR_KEY, result.lastSessionId)
    if (totals.scanned >= nextProgressAt) {
      nextProgressAt += RECOMPRESS_PROGRESS_EVERY
      console.log(`[db] Перевод блобов событий: просмотрено ${totals.scanned}, переведено ${recompressSummary()}`)
    }
    scheduleRecompress(RECOMPRESS_PAUSE_MS)
  } catch (error) {
    // Сбой пачки (занятая база, timeout пула) не теряет курсор: повтор позже.
    console.warn(`[db] Перевод блобов событий отложен: ${error instanceof Error ? error.message : String(error)}`)
    scheduleRecompress(RECOMPRESS_RETRY_MS)
  }
}

function scheduleMaintenance(delayMs: number, optimize: boolean): void {
  if (stopped) return
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null
    maintenanceRunning = runMaintenanceTick(optimize)
      .then((busy) => {
        // Пока есть что возвращать — порции чаще; статистику хватает обновить
        // раз в несколько часов.
        if (busy) scheduleMaintenance(MAINTENANCE_BUSY_INTERVAL_MS, false)
        else scheduleMaintenance(MAINTENANCE_INTERVAL_MS, true)
      })
      .finally(() => {
        maintenanceRunning = null
      })
  }, delayMs)
  maintenanceTimer.unref()
}

/** true — свободных страниц больше порции, нужна следующая. */
async function runMaintenanceTick(optimize: boolean): Promise<boolean> {
  const dbPath = getDbWorkerPath()
  if (stopped || dbPath === null) return false
  try {
    const result = await runWorkerTask(
      { kind: 'db-maintenance', input: { dbPath, maxPages: MAINTENANCE_MAX_PAGES, optimize } },
      { priority: 'background', timeoutMs: 120_000 },
    )
    if (result.freedPages > 0 || result.analyzed.length > 0) {
      console.log(
        `[db] Обслуживание за ${Math.round(result.elapsedMs)} мс: возвращено ОС ` +
          `${mib(result.freedPages * result.pageSize)} МиБ, свободно ещё ${mib(result.freelistPages * result.pageSize)} МиБ` +
          (result.analyzed.length > 0 ? `, статистика: ${result.analyzed.join(', ')}` : ''),
      )
    }
    return result.freedPages >= MAINTENANCE_MAX_PAGES && result.freelistPages > 0
  } catch (error) {
    console.warn(`[db] Обслуживание не выполнено: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function startDbMaintenance(): void {
  if (!stopped) return
  stopped = false
  totals = { scanned: 0, converted: 0, kept: 0, bytesBefore: 0, bytesAfter: 0, freedBytes: 0 }
  nextProgressAt = RECOMPRESS_PROGRESS_EVERY
  for (const key of LEGACY_RECOMPRESS_KEYS) deleteBotState(key)
  if (getBotState(RECOMPRESS_DONE_KEY) === null) scheduleRecompress(RECOMPRESS_PAUSE_MS)
  scheduleMaintenance(MAINTENANCE_FIRST_DELAY_MS, true)
}

/** Запрещает новые задачи и ждёт текущие: CPU pool закрывается после. */
export async function stopDbMaintenance(): Promise<void> {
  stopped = true
  if (recompressTimer) clearTimeout(recompressTimer)
  recompressTimer = null
  if (maintenanceTimer) clearTimeout(maintenanceTimer)
  maintenanceTimer = null
  await Promise.all([recompressRunning, maintenanceRunning])
}
