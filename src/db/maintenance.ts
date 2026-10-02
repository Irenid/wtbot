import { deleteBotState, getBotState, getDbWorkerPath, setBotState } from './index.js'
import { runWorkerTask } from '../workers/pool.js'

/**
 * Background database maintenance in the long-running bot process. All SQLite
 * work runs in worker tasks on their own connection; the main thread only
 * schedules:
 *
 * - the repair pass over stored battles (repair-battle-events): events to the
 *   canonical form of events-repair.ts and the columnar format of
 *   events-codec.ts, empty slot, title and counters from the events, player
 *   facts from the events (player-events.ts). The cursor in bot_state survives
 *   restarts; at the end of the table the pass is marked done. A new repair
 *   rule is a new REPAIR_VERSION: the pass repeats over every battle. Each
 *   batch returns freed pages to the OS at once;
 * - every few hours PRAGMA optimize and returning the remaining free pages to
 *   the OS (incremental_vacuum) in portions while there are any.
 *
 * Both jobs are sequential (overlap guard) and stop before the CPU pool
 * closes (shutdown in index.ts).
 */

/**
 * v1 (2026-10-02): data audit — docs/database.md, "Data errors". v2
 * (2026-10-02): played vehicles, bot slots, team kills from the kill feed and
 * the team of team-0 players — docs/replay-data-quality.md.
 */
const REPAIR_VERSION = 2
const REPAIR_CURSOR_KEY = `db-maintenance:battle-repair-v${REPAIR_VERSION}-after`
const REPAIR_DONE_KEY = `db-maintenance:battle-repair-v${REPAIR_VERSION}-done`
/** Cursors of earlier passes: gzip → zstd-JSON, the columnar format, repair v1. */
const LEGACY_REPAIR_KEYS = [
  'db-maintenance:recompress-after',
  'db-maintenance:recompress-done',
  'db-maintenance:events-columnar-after',
  'db-maintenance:events-columnar-done',
  'db-maintenance:battle-repair-v1-after',
  'db-maintenance:battle-repair-v1-done',
] as const
/**
 * A batch of 50 battles: decoding and checking take ~2 ms per battle,
 * re-encoding ~45 ms only for repaired ones; the write transaction takes tens
 * of milliseconds (the first v2 pass rewrites ~16 player rows per battle).
 */
const REPAIR_BATCH = 50
const REPAIR_PAUSE_MS = 500
const REPAIR_RETRY_MS = 5 * 60_000
/** A batch frees few pages; the cap has headroom, the steps are short. */
const REPAIR_VACUUM_PAGES = 4_096
const REPAIR_PROGRESS_EVERY = 10_000
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
/** While more free pages than one portion remain, the next portion runs in 2 minutes. */
const MAINTENANCE_BUSY_INTERVAL_MS = 2 * 60_000
/** The first maintenance is delayed: startup already reads the database (warmup, parsers). */
const MAINTENANCE_FIRST_DELAY_MS = 10 * 60_000
/** 32 MiB per task, in VACUUM_STEP_PAGES steps (db/index.ts) with pauses. */
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
  playerRows: number
  bytesBefore: number
  bytesAfter: number
  freedBytes: number
  repairs: Record<string, number>
}

function emptyTotals(): RepairTotals {
  return {
    scanned: 0, rewritten: 0, changedMeanwhile: 0, filledRows: 0, playerRows: 0,
    bytesBefore: 0, bytesAfter: 0, freedBytes: 0, repairs: {},
  }
}

let totals = emptyTotals()
let nextProgressAt = REPAIR_PROGRESS_EVERY

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

const REPAIR_LABELS: Record<string, string> = {
  chatNames: 'chat names',
  duplicateKills: 'duplicate kills',
  signedIds: 'bot ids',
  brokenChat: 'truncated messages',
  roundedValues: 'fractional coordinates',
}

function repairSummary(): string {
  const fixes = Object.entries(totals.repairs)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${REPAIR_LABELS[key] ?? key} ${count}`)
  return (
    `battles ${totals.scanned}, rewritten ${totals.rewritten} ` +
    `(${mib(totals.bytesBefore)} → ${mib(totals.bytesAfter)} MiB), rows filled ${totals.filledRows}, ` +
    `player rows updated ${totals.playerRows}` +
    (fixes.length > 0 ? `; fixed: ${fixes.join(', ')}` : '') +
    (totals.changedMeanwhile > 0 ? `; re-parsed during the pass ${totals.changedMeanwhile}` : '') +
    `; returned to the OS ${mib(totals.freedBytes)} MiB`
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
      playerRows: totals.playerRows + result.playerRows,
      bytesBefore: totals.bytesBefore + result.bytesBefore,
      bytesAfter: totals.bytesAfter + result.bytesAfter,
      freedBytes: totals.freedBytes + result.freedBytes,
      repairs,
    }
    if (result.lastSessionId === null) {
      setBotState(REPAIR_DONE_KEY, String(Math.floor(Date.now() / 1_000)))
      if (totals.scanned > 0) console.log(`[db] Stored battle repair v${REPAIR_VERSION} done: ${repairSummary()}`)
      return
    }
    setBotState(REPAIR_CURSOR_KEY, result.lastSessionId)
    if (totals.scanned >= nextProgressAt) {
      nextProgressAt += REPAIR_PROGRESS_EVERY
      console.log(`[db] Stored battle repair v${REPAIR_VERSION}: ${repairSummary()}`)
    }
    scheduleRepair(REPAIR_PAUSE_MS)
  } catch (error) {
    // A failed batch (busy database, pool timeout) keeps the cursor: retried later.
    console.warn(`[db] Stored battle repair postponed: ${error instanceof Error ? error.message : String(error)}`)
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
