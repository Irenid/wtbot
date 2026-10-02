import { deleteBotState, getBotState, getDbWorkerPath, setBotState } from './index.js'
import { runWorkerTask } from '../workers/pool.js'

/**
 * Фоновое обслуживание базы в долгоживущем процессе бота. Вся работа с
 * SQLite — в worker-задачах на своём подключении, main thread только
 * планирует:
 *
 * - проход починки записанных боёв (repair-battle-events): события — в
 *   канонический вид events-repair.ts и колоночный формат events-codec.ts,
 *   пустые slot, title и счётчики — из событий. Курсор в bot_state
 *   переживает перезапуск; в конце таблицы проход отмечается выполненным.
 *   Новое правило починки — новая REPAIR_VERSION: проход повторяется по всем
 *   боям. Каждая пачка сразу возвращает ОС освободившиеся страницы;
 * - раз в несколько часов PRAGMA optimize и возврат ОС оставшихся свободных
 *   страниц (incremental_vacuum) порциями, пока они есть.
 *
 * Обе работы последовательны (overlap guard) и останавливаются до закрытия
 * CPU pool (shutdown в index.ts).
 */

/** v1 (2026-10-02): аудит данных — docs/database.md, «Ошибки в данных». */
const REPAIR_VERSION = 1
const REPAIR_CURSOR_KEY = `db-maintenance:battle-repair-v${REPAIR_VERSION}-after`
const REPAIR_DONE_KEY = `db-maintenance:battle-repair-v${REPAIR_VERSION}-done`
/** Курсоры прежних проходов (gzip → zstd-JSON, перевод в колоночный формат). */
const LEGACY_REPAIR_KEYS = [
  'db-maintenance:recompress-after',
  'db-maintenance:recompress-done',
  'db-maintenance:events-columnar-after',
  'db-maintenance:events-columnar-done',
] as const
/**
 * Пачка 50 боёв: распаковка и проверка ~2 мс на бой, перекодирование —
 * ~45 мс только у починенных; транзакция записи — десятки миллисекунд.
 */
const REPAIR_BATCH = 50
const REPAIR_PAUSE_MS = 500
const REPAIR_RETRY_MS = 5 * 60_000
/** Пачка освобождает немного страниц; потолок — с запасом, шаги короткие. */
const REPAIR_VACUUM_PAGES = 4_096
const REPAIR_PROGRESS_EVERY = 10_000
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
/** Пока свободных страниц больше порции — следующая порция через 2 минуты. */
const MAINTENANCE_BUSY_INTERVAL_MS = 2 * 60_000
/** Первое обслуживание — не сразу: старт и так читает базу (прогрев, парсеры). */
const MAINTENANCE_FIRST_DELAY_MS = 10 * 60_000
/** 32 МиБ за задачу — шагами по VACUUM_STEP_PAGES (db/index.ts) с паузами. */
const MAINTENANCE_MAX_PAGES = 8_192

let repairTimer: NodeJS.Timeout | null = null
let maintenanceTimer: NodeJS.Timeout | null = null
let repairRunning: Promise<void> | null = null
let maintenanceRunning: Promise<void> | null = null
let stopped = true

interface RepairTotals {
  scanned: number
  rewritten: number
  changedMeanwhile: number
  filledRows: number
  bytesBefore: number
  bytesAfter: number
  freedBytes: number
  repairs: Record<string, number>
}

function emptyTotals(): RepairTotals {
  return { scanned: 0, rewritten: 0, changedMeanwhile: 0, filledRows: 0, bytesBefore: 0, bytesAfter: 0, freedBytes: 0, repairs: {} }
}

let totals = emptyTotals()
let nextProgressAt = REPAIR_PROGRESS_EVERY

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

const REPAIR_LABELS: Record<string, string> = {
  chatNames: 'имён в чате',
  duplicateKills: 'дублей убийств',
  signedIds: 'id ботов',
  brokenChat: 'обрезанных сообщений',
  roundedValues: 'дробных координат',
}

function repairSummary(): string {
  const fixes = Object.entries(totals.repairs)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${REPAIR_LABELS[key] ?? key} ${count}`)
  return (
    `боёв ${totals.scanned}, переписано ${totals.rewritten} ` +
    `(${mib(totals.bytesBefore)} → ${mib(totals.bytesAfter)} МиБ), заполнено строк ${totals.filledRows}` +
    (fixes.length > 0 ? `; исправлено: ${fixes.join(', ')}` : '') +
    (totals.changedMeanwhile > 0 ? `; переразобраны во время прохода ${totals.changedMeanwhile}` : '') +
    `; возвращено ОС ${mib(totals.freedBytes)} МиБ`
  )
}

function scheduleRepair(delayMs: number): void {
  if (stopped) return
  repairTimer = setTimeout(() => {
    repairTimer = null
    repairRunning = repairBatch().finally(() => {
      repairRunning = null
    })
  }, delayMs)
  repairTimer.unref()
}

async function repairBatch(): Promise<void> {
  const dbPath = getDbWorkerPath()
  if (stopped || dbPath === null) return
  const after = getBotState(REPAIR_CURSOR_KEY) ?? ''
  try {
    const result = await runWorkerTask(
      {
        kind: 'repair-battle-events',
        input: { dbPath, afterSessionId: after, limit: REPAIR_BATCH, vacuumPages: REPAIR_VACUUM_PAGES },
      },
      { priority: 'background', timeoutMs: 120_000 },
    )
    const repairs = { ...totals.repairs }
    for (const [key, count] of Object.entries(result.repairs)) repairs[key] = (repairs[key] ?? 0) + count
    totals = {
      scanned: totals.scanned + result.scanned,
      rewritten: totals.rewritten + result.rewritten,
      changedMeanwhile: totals.changedMeanwhile + result.changedMeanwhile,
      filledRows: totals.filledRows + result.filledRows,
      bytesBefore: totals.bytesBefore + result.bytesBefore,
      bytesAfter: totals.bytesAfter + result.bytesAfter,
      freedBytes: totals.freedBytes + result.freedBytes,
      repairs,
    }
    if (result.lastSessionId === null) {
      setBotState(REPAIR_DONE_KEY, String(Math.floor(Date.now() / 1_000)))
      if (totals.scanned > 0) console.log(`[db] Починка записанных боёв v${REPAIR_VERSION} завершена: ${repairSummary()}`)
      return
    }
    setBotState(REPAIR_CURSOR_KEY, result.lastSessionId)
    if (totals.scanned >= nextProgressAt) {
      nextProgressAt += REPAIR_PROGRESS_EVERY
      console.log(`[db] Починка записанных боёв v${REPAIR_VERSION}: ${repairSummary()}`)
    }
    scheduleRepair(REPAIR_PAUSE_MS)
  } catch (error) {
    // Сбой пачки (занятая база, timeout пула) не теряет курсор: повтор позже.
    console.warn(`[db] Починка записанных боёв отложена: ${error instanceof Error ? error.message : String(error)}`)
    scheduleRepair(REPAIR_RETRY_MS)
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
  totals = emptyTotals()
  nextProgressAt = REPAIR_PROGRESS_EVERY
  for (const key of LEGACY_REPAIR_KEYS) deleteBotState(key)
  if (getBotState(REPAIR_DONE_KEY) === null) scheduleRepair(REPAIR_PAUSE_MS)
  scheduleMaintenance(MAINTENANCE_FIRST_DELAY_MS, true)
}

/** Запрещает новые задачи и ждёт текущие: CPU pool закрывается после. */
export async function stopDbMaintenance(): Promise<void> {
  stopped = true
  if (repairTimer) clearTimeout(repairTimer)
  repairTimer = null
  if (maintenanceTimer) clearTimeout(maintenanceTimer)
  maintenanceTimer = null
  await Promise.all([repairRunning, maintenanceRunning])
}
