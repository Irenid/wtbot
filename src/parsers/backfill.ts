import { config } from '../config.js'
import { closeDb, initDb, saveItems } from '../db/index.js'
import { collectFreshReplays } from './sources/wt-replays.js'

/**
 * Разовый бэкфилл клановых боёв. Инкрементальный парсер держит бота в
 * актуальном состоянии, но при большом простое всё, что глубже его предела
 * догона, читается только так. Запуск:
 *
 *   npm run backfill            — последние 3 дня
 *   npm run backfill -- 14      — последние 14 дней
 *
 * Листает список боёв от свежих к старым, пока не дойдёт до боёв старше
 * заданной даты, и сохраняет всё новое в items. Ссылки на .wrpl строятся из
 * url+partsCount (без пофайловых запросов — быстрее), сам разбор боёв в БД
 * (фраги/траектории/победитель) сделает фоновый воркер ingest при npm run dev.
 *
 * Смысл держаться окна CDN: части реплеев живут на CDN ~2 недели, старше
 * разобрать всё равно не выйдет — поэтому по умолчанию окно небольшое.
 */

const days = Math.max(1, Math.floor(Number(process.argv[2]) || 3))
const sinceTs = Math.floor(Date.now() / 1000) - days * 86_400
// ~473 боя/сутки, 20 на странице → с запасом, но с потолком
const maxPages = Math.min(500, Math.ceil((days * 500) / 20) + 5)

initDb(config.dbPath)

console.log(
  `Бэкфилл клановых боёв за последние ${days} дн (с ${new Date(sinceTs * 1000).toISOString().slice(0, 10)}), ` +
    `до ${maxPages} страниц. Это может занять минуты...`,
)

try {
  const { items, totalOnSite, pagesRead, hitCap } = await collectFreshReplays({
    maxPages,
    stopAtKnown: false, // идём насквозь: возможны пропуски-«дыры» в середине
    sinceTs,
    fetchDetails: false,
  })
  const saved = saveItems('wt-replays', items)
  console.log(
    `Готово. Страниц прочитано: ${pagesRead}${hitCap ? ` (упёрлись в предел ${maxPages} — возьми окно поменьше или запусти ещё раз)` : ''}.`,
  )
  console.log(
    `Новых боёв: ${items.length}, сохранено: ${saved.changed}, без изменений: ${saved.unchanged}. Всего на сайте: ${totalOnSite}.`,
  )
  if (saved.changed > 0) {
    console.log('Разбор в БД (фраги, траектории, победитель) сделает воркер ingest при следующем npm run dev.')
  }
} catch (err) {
  console.error('Бэкфилл не удался:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}

closeDb()
