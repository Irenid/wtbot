import { recordParseResult, saveItems } from '../db/index.js'
import { sources } from './sources/index.js'
import type { ParserSource } from './types.js'

// Планировщик: каждый источник запускается сразу при старте,
// затем повторяется со своим интервалом. Собранные записи сохраняются
// в БД пачкой, результат запуска (успех/ошибка) — тоже в БД:
// его видно на дашборде и в /stats.

const timers: NodeJS.Timeout[] = []

async function runOnce(source: ParserSource): Promise<void> {
  try {
    const output = await source.run()
    let summary = output.summary
    if (output.items && output.items.length > 0) {
      const saved = saveItems(source.name, output.items)
      summary += ` · сохранено: ${saved.changed}, без изменений: ${saved.unchanged}`
    }
    recordParseResult(source.name, true, summary, null)
    console.log(`[parser:${source.name}] OK — ${summary}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordParseResult(source.name, false, null, message)
    console.error(`[parser:${source.name}] Ошибка — ${message}`)
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
