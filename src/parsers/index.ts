import {
  getDbWorkerPath,
  primeKnownItemExternalIds,
  recordParseResult,
  saveItems,
} from '../db/index.js'
import { emitBattleLifecycle } from '../battle-lifecycle.js'
import { runWorkerTask } from '../workers/pool.js'
import { sources } from './sources/index.js'
import type { ParserSource } from './types.js'

// Планировщик: каждый источник запускается сразу при старте,
// затем повторяется со своим интервалом. Собранные записи сохраняются
// в БД пачкой, результат запуска (успех/ошибка) — тоже в БД:
// его видно на дашборде и в /stats.

const MAX_SOURCE_BACKOFF_MS = 30 * 60_000
const runtimes = new Map<string, { failures: number; timer: NodeJS.Timeout | null }>()
let parsersRunning = false
/** Поколение планировщика: stop/restart делает результаты старых запусков неактуальными. */
let generation = 0
let stopController = new AbortController()
/** Незавершённые запуски по источникам — чтобы догон парсера (может листать
 *  десятки страниц) не наложился на следующий тик, а shutdown дождался их. */
const activeRuns = new Map<string, Promise<boolean>>()

function isCurrent(runGeneration: number): boolean {
  return parsersRunning && runGeneration === generation
}

async function persistParseResult(
  source: string,
  ok: boolean,
  summary: string | null,
  error: string | null,
): Promise<void> {
  const dbPath = getDbWorkerPath()
  if (dbPath === null) {
    recordParseResult(source, ok, summary, error)
    return
  }
  await runWorkerTask(
    {
      kind: 'record-parse-result',
      input: { dbPath, source, ok, summary, error },
    },
    { priority: 'normal', timeoutMs: 30_000 },
  )
}

async function runOnce(source: ParserSource, runGeneration: number, signal: AbortSignal): Promise<boolean> {
  try {
    const output = await source.run(signal)
    // После stop или перезапуска результат не сохраняем: БД и worker pool
    // могут уже закрываться, а несохранённые записи источник соберёт снова.
    if (!isCurrent(runGeneration)) return true
    let summary = output.summary
    const gotItems = output.items !== undefined && output.items.length > 0
    if (gotItems) {
      const saved = saveItems(source.name, output.items!)
      summary += ` · сохранено: ${saved.changed}, без изменений: ${saved.unchanged}`
      if (source.name === 'wt-replays' && saved.changed > 0) {
        emitBattleLifecycle({
          kind: 'discovered',
          sessionIds: output.items!.map((item) => item.externalId),
          bulk: output.items!.length > 20,
        })
      }
    } else if (source.name === 'wt-replays') {
      summary += ' · сохранено: 0'
    }
    await persistParseResult(source.name, true, summary, null)
    // Для replay показываем и нулевой результат: так видна исправность частого опроса.
    if (gotItems || source.name === 'wt-replays') console.log(`[parser:${source.name}] OK — ${summary}`)
    return true
  } catch (err) {
    // Отмена при остановке — не ошибка источника и не повод для backoff.
    if (!isCurrent(runGeneration)) return true
    const message = err instanceof Error ? err.message : String(err)
    await persistParseResult(source.name, false, null, message)
    console.error(`[parser:${source.name}] Ошибка — ${message}`)
    return false
  }
}

function launch(source: ParserSource, runGeneration: number, signal: AbortSignal): Promise<boolean> {
  // Прошлый запуск (в том числе прошлого поколения) ещё идёт — тик пропускаем.
  if (activeRuns.has(source.name)) return Promise.resolve(true)
  const run: Promise<boolean> = runOnce(source, runGeneration, signal).finally(() => {
    if (activeRuns.get(source.name) === run) activeRuns.delete(source.name)
  })
  activeRuns.set(source.name, run)
  return run
}

export function parserBackoffMs(intervalMs: number, failures: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs должен быть положительным')
  if (!Number.isInteger(failures) || failures < 0) throw new RangeError('число ошибок должно быть неотрицательным целым')
  if (failures === 0) return intervalMs
  return Math.min(intervalMs * 2 ** Math.min(failures - 1, 10), MAX_SOURCE_BACKOFF_MS)
}

function schedule(source: ParserSource, delayMs: number, runGeneration: number, signal: AbortSignal): void {
  if (!isCurrent(runGeneration)) return
  const runtime = runtimes.get(source.name)
  if (!runtime) return
  runtime.timer = setTimeout(() => {
    runtime.timer = null
    void launch(source, runGeneration, signal)
      .then((ok) => {
        if (ok) {
          runtime.failures = 0
          schedule(source, source.intervalMs, runGeneration, signal)
          return
        }
        runtime.failures += 1
        const nextDelay = parserBackoffMs(source.intervalMs, runtime.failures)
        console.warn(
          `[parser:${source.name}] backoff после ${runtime.failures} ошибок: следующая попытка через ${Math.ceil(nextDelay / 1_000)} с`,
        )
        schedule(source, nextDelay, runGeneration, signal)
      })
      .catch((error: unknown) => {
        if (!isCurrent(runGeneration)) return
        runtime.failures += 1
        console.error(`[parser:${source.name}] scheduler завершился ошибкой:`, error)
        schedule(source, parserBackoffMs(source.intervalMs, runtime.failures), runGeneration, signal)
      })
  }, Math.max(0, delayMs))
}

export function startParsers(sourceList: readonly ParserSource[] = sources): void {
  const names = new Set<string>()
  for (const source of sourceList) {
    if (names.has(source.name)) throw new Error(`Повторяющееся имя parser source: ${source.name}`)
    if (!Number.isFinite(source.intervalMs) || source.intervalMs < 1) {
      throw new Error(`Некорректный interval parser source ${source.name}: ${source.intervalMs}`)
    }
    names.add(source.name)
  }
  // Старые запуски дорабатывают в фоне, но их результаты уже не сохраняются.
  if (parsersRunning) void stopParsers()
  parsersRunning = true
  stopController = new AbortController()
  const runGeneration = generation
  const signal = stopController.signal
  if (sourceList.some((source) => source.name === 'wt-replays')) {
    primeKnownItemExternalIds('wt-replays')
  }
  for (const source of sourceList) {
    runtimes.set(source.name, { failures: 0, timer: null })
    schedule(source, 0, runGeneration, signal)
  }
  console.log(`[parsers] Запущено источников: ${sourceList.length}`)
}

/**
 * Запрещает новые запуски, отменяет активные через AbortSignal и возвращает
 * promise их завершения — shutdown включает его в общий drain producers.
 * Результаты запусков, закончившихся после stop, в БД не пишутся.
 */
export function stopParsers(): Promise<void> {
  parsersRunning = false
  generation += 1
  stopController.abort(new Error('parser scheduler остановлен'))
  for (const runtime of runtimes.values()) {
    if (runtime.timer !== null) clearTimeout(runtime.timer)
  }
  runtimes.clear()
  return Promise.allSettled([...activeRuns.values()]).then(() => undefined)
}
