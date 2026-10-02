import { getBotState, getDbWorkerPath, runDbMaintenance, setBotState } from './index.js'
import { runWorkerTask } from '../workers/pool.js'

/**
 * Фоновое обслуживание базы в долгоживущем процессе бота:
 *
 * - перевод старых gzip-блобов событий в zstd (events-codec.ts) пачками в
 *   worker — минус ~2,6 ГБ на боевой базе без простоя; курсор в bot_state
 *   переживает перезапуск, в конце таблицы задача останавливается;
 * - раз в несколько часов runDbMaintenance: PRAGMA optimize и возврат ОС
 *   свободных страниц (incremental_vacuum) — в том числе после перевода.
 *
 * Обе работы последовательны (overlap guard) и останавливаются до закрытия
 * CPU pool (shutdown в index.ts).
 */

const RECOMPRESS_CURSOR_KEY = 'db-maintenance:recompress-after'
const RECOMPRESS_DONE_KEY = 'db-maintenance:recompress-done'
/** Пачка ~10 боёв: zstd-19 сжимает бой ~170 мс, пачка держит worker ~2 с. */
const RECOMPRESS_BATCH = 10
const RECOMPRESS_PAUSE_MS = 5_000
const RECOMPRESS_RETRY_MS = 5 * 60_000
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
/** Пока свободных страниц больше порции — следующая порция через 10 минут. */
const MAINTENANCE_BUSY_INTERVAL_MS = 10 * 60_000
/** Первое обслуживание — не сразу: старт и так читает базу (прогрев, парсеры). */
const MAINTENANCE_FIRST_DELAY_MS = 10 * 60_000
const MAINTENANCE_MAX_PAGES = 16_384

let recompressTimer: NodeJS.Timeout | null = null
let maintenanceTimer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let stopped = true
let totals = { converted: 0, bytesBefore: 0, bytesAfter: 0 }

function scheduleRecompress(delayMs: number): void {
  if (stopped) return
  recompressTimer = setTimeout(() => {
    recompressTimer = null
    running = recompressBatch().finally(() => {
      running = null
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
      { kind: 'recompress-events-blobs', input: { dbPath, afterSessionId: after, limit: RECOMPRESS_BATCH } },
      { priority: 'background', timeoutMs: 120_000 },
    )
    totals = {
      converted: totals.converted + result.converted,
      bytesBefore: totals.bytesBefore + result.bytesBefore,
      bytesAfter: totals.bytesAfter + result.bytesAfter,
    }
    if (result.lastSessionId === null) {
      setBotState(RECOMPRESS_DONE_KEY, String(Math.floor(Date.now() / 1_000)))
      if (totals.converted > 0) {
        const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
        console.log(
          `[db] Блобы событий переведены в zstd: ${totals.converted} боёв, ` +
            `${mib(totals.bytesBefore)} → ${mib(totals.bytesAfter)} МиБ`,
        )
      }
      return
    }
    setBotState(RECOMPRESS_CURSOR_KEY, result.lastSessionId)
    scheduleRecompress(RECOMPRESS_PAUSE_MS)
  } catch (error) {
    // Сбой пачки (занятая база, timeout пула) не теряет курсор: повтор позже.
    console.warn(`[db] Перевод блобов в zstd отложен: ${error instanceof Error ? error.message : String(error)}`)
    scheduleRecompress(RECOMPRESS_RETRY_MS)
  }
}

function scheduleMaintenance(delayMs: number): void {
  if (stopped) return
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null
    scheduleMaintenance(runMaintenanceTick() ? MAINTENANCE_BUSY_INTERVAL_MS : MAINTENANCE_INTERVAL_MS)
  }, delayMs)
  maintenanceTimer.unref()
}

/** true — свободных страниц больше порции, нужна следующая. */
function runMaintenanceTick(): boolean {
  if (stopped) return false
  try {
    const result = runDbMaintenance(MAINTENANCE_MAX_PAGES)
    if (result.freedPages > 0) {
      console.log(`[db] Обслуживание: возвращено ${result.freedPages} страниц за ${Math.round(result.elapsedMs)} мс`)
    }
    return result.freedPages >= MAINTENANCE_MAX_PAGES
  } catch (error) {
    console.warn(`[db] Обслуживание не выполнено: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function startDbMaintenance(): void {
  if (!stopped) return
  stopped = false
  totals = { converted: 0, bytesBefore: 0, bytesAfter: 0 }
  if (getBotState(RECOMPRESS_DONE_KEY) === null) scheduleRecompress(RECOMPRESS_PAUSE_MS)
  scheduleMaintenance(MAINTENANCE_FIRST_DELAY_MS)
}

/** Запрещает новые пачки и ждёт текущую: CPU pool закрывается после. */
export async function stopDbMaintenance(): Promise<void> {
  stopped = true
  if (recompressTimer) clearTimeout(recompressTimer)
  recompressTimer = null
  if (maintenanceTimer) clearTimeout(maintenanceTimer)
  maintenanceTimer = null
  await running
}
