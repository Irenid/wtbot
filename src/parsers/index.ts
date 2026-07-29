import { recordParseResult, saveItems } from '../db/index.js'
import { sources } from './sources/index.js'
import type { ParserSource } from './types.js'

// Планировщик: каждый источник запускается сразу при старте,
// затем повторяется со своим интервалом. Собранные записи сохраняются
// в БД пачкой, результат запуска (успех/ошибка) — тоже в БД:
// его видно на дашборде и в /stats.

const MAX_SOURCE_BACKOFF_MS = 30 * 60_000
const runtimes = new Map<string, { failures: number; timer: NodeJS.Timeout | null }>()
let parsersRunning = false
/** Источники, чей прошлый запуск ещё не завершился — чтобы догон парсера
 *  (может листать десятки страниц) не наложился на следующий тик */
const running = new Set<string>()

async function runOnce(source: ParserSource): Promise<boolean> {
  if (running.has(source.name)) return true
  running.add(source.name)
  try {
    const output = await source.run()
    let summary = output.summary
    const gotItems = output.items !== undefined && output.items.length > 0
    if (gotItems) {
      const saved = saveItems(source.name, output.items!)
      summary += ` · сохранено: ${saved.changed}, без изменений: ${saved.unchanged}`
    } else if (source.name === 'wt-replays') {
      summary += ' · сохранено: 0'
    }
    recordParseResult(source.name, true, summary, null)
    // Для replay показываем и нулевой результат: так видна исправность частого опроса.
    if (gotItems || source.name === 'wt-replays') console.log(`[parser:${source.name}] OK — ${summary}`)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordParseResult(source.name, false, null, message)
    console.error(`[parser:${source.name}] Ошибка — ${message}`)
    return false
  } finally {
    running.delete(source.name)
  }
}

export function parserBackoffMs(intervalMs: number, failures: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs должен быть положительным')
  if (!Number.isInteger(failures) || failures < 0) throw new RangeError('число ошибок должно быть неотрицательным целым')
  if (failures === 0) return intervalMs
  return Math.min(intervalMs * 2 ** Math.min(failures - 1, 10), MAX_SOURCE_BACKOFF_MS)
}

function schedule(source: ParserSource, delayMs: number): void {
  if (!parsersRunning) return
  const runtime = runtimes.get(source.name)
  if (!runtime) return
  runtime.timer = setTimeout(() => {
    runtime.timer = null
    void runOnce(source)
      .then((ok) => {
        if (ok) {
          runtime.failures = 0
          schedule(source, source.intervalMs)
          return
        }
        runtime.failures += 1
        const nextDelay = parserBackoffMs(source.intervalMs, runtime.failures)
        console.warn(
          `[parser:${source.name}] backoff после ${runtime.failures} ошибок: следующая попытка через ${Math.ceil(nextDelay / 1_000)} с`,
        )
        schedule(source, nextDelay)
      })
      .catch((error: unknown) => {
        runtime.failures += 1
        console.error(`[parser:${source.name}] scheduler завершился ошибкой:`, error)
        schedule(source, parserBackoffMs(source.intervalMs, runtime.failures))
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
  if (parsersRunning) stopParsers()
  parsersRunning = true
  for (const source of sourceList) {
    runtimes.set(source.name, { failures: 0, timer: null })
    schedule(source, 0)
  }
  console.log(`[parsers] Запущено источников: ${sourceList.length}`)
}

export function stopParsers(): void {
  parsersRunning = false
  for (const runtime of runtimes.values()) {
    if (runtime.timer !== null) clearTimeout(runtime.timer)
  }
  runtimes.clear()
}
