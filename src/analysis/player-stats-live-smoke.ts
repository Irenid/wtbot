import { closeDb, initDb, savePlayerIdentity } from '../db/index.js'
import { closeWtBrowser } from '../parsers/sources/wt-browser.js'
import { warmupWtTransport } from '../parsers/sources/wt-request.js'
import { OFFICIAL_PROFILE_PARSER_VERSION } from '../player-stats/normalizer.js'
import { OfficialProfileProvider } from '../player-stats/providers/official-profile.js'
import { PlayerStatsService } from '../player-stats/service.js'

/**
 * Живая сквозная проверка account-статистики: реальная страница профиля →
 * провайдер → нормализатор → SQLite в памяти. Сеть обязательна, поэтому это
 * отдельный скрипт, а не тест.
 */

const players = process.argv.slice(2)
const nicknames = players.length > 0 ? players : ['Venukbr', 'ТУМ4Н']

function hours(seconds: number | null): string {
  return seconds === null ? '—' : `${Math.round(seconds / 3_600)} ч`
}

function metric(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('ru-RU')
}

initDb(':memory:')
const service = new PlayerStatsService({
  provider: new OfficialProfileProvider(),
  parserVersion: OFFICIAL_PROFILE_PARSER_VERSION,
})

let failures = 0
try {
  await warmupWtTransport()
  for (const nickname of nicknames) {
    const identity = savePlayerIdentity({ wtUserId: null, canonicalNick: nickname, platform: null })
    const started = Date.now()
    const stats = await service.refreshNow(identity.id)
    const elapsed = Date.now() - started

    if (stats === null) {
      failures += 1
      console.log(`\n### ${nickname}: статистика не получена (${elapsed} мс)`)
      continue
    }
    const totals = stats.totals
    const aggregate = totals.find((row) => row.gameType === null && row.mode === null && row.category === null)
    const modes = totals.filter((row) => row.gameType === null && row.mode !== null)
    const branches = totals.filter((row) => row.gameType !== null)

    console.log(`\n### ${nickname} — snapshot ${stats.snapshot.id}, статус ${stats.snapshot.status} (${elapsed} мс)`)
    console.log(`    строк тоталов: ${totals.length}; техники: ${stats.vehicles.length}`)
    if (aggregate === undefined) {
      failures += 1
      console.log('    НЕТ сводной строки (gameType/mode/category = null) — win rate не посчитается')
    } else {
      const winRate = aggregate.battles !== null && aggregate.battles > 0 && aggregate.victories !== null
        ? `${((aggregate.victories / aggregate.battles) * 100).toFixed(1)}%`
        : '—'
      console.log(
        `    всего: боёв ${metric(aggregate.battles)}, побед ${metric(aggregate.victories)} (${winRate}), ` +
          `смертей ${metric(aggregate.deaths)}, время ${hours(aggregate.timePlayedSec)}`,
      )
    }
    for (const row of modes) {
      console.log(
        `    ${String(row.mode).padEnd(11)} боёв ${metric(row.battles).padStart(7)}, ` +
          `побед ${metric(row.victories).padStart(6)}, смертей ${metric(row.deaths).padStart(7)}, ` +
          `время ${hours(row.timePlayedSec).padStart(8)}, фраги ${metric(row.airKills)}/${metric(row.groundKills)}/${metric(row.navalKills)}`,
      )
    }
    const byBranch = new Map<string, number>()
    for (const row of branches) {
      byBranch.set(String(row.gameType), (byBranch.get(String(row.gameType)) ?? 0) + 1)
    }
    console.log(`    ветки техники: ${[...byBranch].map(([name, count]) => `${name}×${count}`).join(', ') || 'нет'}`)
    const air = branches.find((row) => row.gameType === 'air' && row.mode === 'realistic' && row.category === 'all')
    if (air !== undefined) {
      console.log(`    авиация РБ: выходов ${metric(air.respawns)}, время ${hours(air.timePlayedSec)}, воздушных фрагов ${metric(air.airKills)}`)
    }

    if (totals.length < 4) {
      failures += 1
      console.log('    ПОДОЗРИТЕЛЬНО: слишком мало строк — вероятно, разобрался только общий блок')
    }
  }
} finally {
  await service.stop().catch(() => undefined)
  await closeWtBrowser()
  closeDb()
}

if (failures > 0) {
  console.error(`\nПРОВАЛ: ${failures} проверок не прошли`)
  process.exit(1)
}
console.log('\nOK: account-статистика собрана и разложена по таблицам')
