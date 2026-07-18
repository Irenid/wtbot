import { recordParseResult, saveItems } from '../db/index.js'
import { sources } from './sources/index.js'
import type { ParserSource } from './types.js'

// Планировщик: каждый источник запускается сразу при старте,
// затем повторяется со своим интервалом. Собранные записи сохраняются
// в БД пачкой, результат запуска (успех/ошибка) — тоже в БД:
// его видно на дашборде и в /stats.

const timers: NodeJS.Timeout[] = []
/** Источники, чей прошлый запуск ещё не завершился — чтобы догон парсера
 *  (может листать десятки страниц) не наложился на следующий тик */
const running = new Set<string>()

async function runOnce(source: ParserSource): Promise<void> {
  if (running.has(source.name)) return
  running.add(source.name)
  try {
    const output = await source.run()
    let summary = output.summary
    const gotItems = output.items !== undefined && output.items.length > 0
    if (gotItems) {
      const saved = saveItems(source.name, output.items!)
      summary += ` · сохранено: ${saved.changed}, без изменений: ${saved.unchanged}`
    }
    recordParseResult(source.name, true, summary, null)
    // при частых интервалах пустые прогоны не логируем — только находки
    if (gotItems) console.log(`[parser:${source.name}] OK — ${summary}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordParseResult(source.name, false, null, message)
    console.error(`[parser:${source.name}] Ошибка — ${message}`)
  } finally {
    running.delete(source.name)
  }
}

export function startParsers(): void {
  for (const source of sources) {
    void runOnce(source)
    timers.push(setInterval(() => void runOnce(source), source.intervalMs))
  }
  console.log(`[parsers] Запущено источников: ${sources.length}`)
}

export function stopParsers(): void {
  for (const timer of timers) clearInterval(timer)
  timers.length = 0
}
