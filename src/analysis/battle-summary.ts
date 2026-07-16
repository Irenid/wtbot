import { mkdirSync, writeFileSync } from 'node:fs'
import { config } from '../config.js'
import { closeDb, getItemByExternalId, getLatestItems, initDb } from '../db/index.js'
import { levelId } from '../wrpl/battle-assets.js'
import { buildBattleMedia } from '../wrpl/battle-media.js'
import { fetchRatingsForTags } from '../wrpl/clan-info.js'
import { fetchReplayResults, normalizeSessionId, replayPartUrls } from '../wrpl/replay.js'
import { buildRosters, renderBattleImage, summarizeTeams } from '../wrpl/render-battle.js'
import { ensureVehicleDict, vehicleInfo } from '../wrpl/vehicles.js'

// Результаты боя из файла реплея .wrpl. Запуск:
//   npm run battle                        — последний собранный реплей
//   npm run battle -- 498256029276764042  — конкретный бой (sessionId из БД)
//   npm run battle -- --image             — ещё и PNG-картинка (data/battles/)
//   npm run battle -- --media             — battle log, хитмапы и чат (data/battles/)
//   npm run battle -- ... --json          — сырой JSON вместо таблицы
//
// Данные берутся из results-BLK в конце последней части реплея —
// это та же таблица, которую показывает сайт и Discord-боты вроде Boris Stats.
// --media скачивает ВСЕ части и разбирает пакетный поток (см. replay-events.ts).

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const wanted = args[0]

initDb(config.dbPath)

let sessionId: string | undefined
if (wanted) {
  sessionId = normalizeSessionId(wanted)
} else {
  const latest = getLatestItems(1, 'wt-replays')[0]
  if (!latest) {
    console.error('В БД ещё нет реплеев — подожди первый цикл парсера wt-replays')
    closeDb()
    process.exit(1)
  }
  sessionId = latest.externalId
}

const item = getItemByExternalId('wt-replays', sessionId)
if (!item) {
  console.error(`Реплей ${sessionId} не найден в БД (таблица items, источник wt-replays)`)
  closeDb()
  process.exit(1)
}
// БД остаётся открытой: ниже в неё пишутся снимки кланового рейтинга

const data = item.data as { missionName?: string; replayParts?: string[] | null; url?: string; partsCount?: number }
const parts = replayPartUrls(data)
if (parts.length === 0) {
  console.error('У записи нет ссылок на части реплея (replayParts)')
  closeDb()
  process.exit(1)
}

const { header, results } = await fetchReplayResults(parts)
const dict = await ensureVehicleDict()

if (flags.has('--json')) {
  console.log(JSON.stringify({ header, results }, null, 2))
  closeDb()
  process.exit(0)
}

// ---------- Консольная таблица ----------

// CJK-символы занимают в терминале две колонки — учитываем при выравнивании
const charW = (ch: string): number => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1)
const width = (s: string): number => [...s].reduce((acc, ch) => acc + charW(ch), 0)
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)))
const cut = (s: string, w: number): string => {
  let out = ''
  let used = 0
  for (const ch of s) {
    const cw = charW(ch)
    if (used + cw > w - 1) return out + '…'
    out += ch
    used += cw
  }
  return out
}

const mmss = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

console.log()
console.log(item.title)
console.log(
  `Match ID: ${header.sessionId} · ${new Date(header.startTime * 1000).toLocaleString()}` +
    ` · длительность ${mmss(results.timePlayed)}` +
    ` · ${header.environment}/${header.visibility} · карта ${levelId(header.level)} · сессия ${header.sessionIdHex}`,
)

const teamSummaries = summarizeTeams(results, dict)
// ПКР обеих команд (пишет снимки в БД); без сети таблица выйдет с прочерками
const ratings = await fetchRatingsForTags(teamSummaries.flatMap((t) => (t.rawTag ? [t.rawTag] : [])))

// Ростеры в том же порядке, что и на картинке (и в teamSummaries):
// первой идёт команда с большей суммой очков
const rosters = buildRosters(results)
for (const [ti, roster] of rosters.entries()) {
  const summary = teamSummaries[ti]
  const teamNo = roster[0]?.team ?? ti + 1
  const label = summary ? `${summary.clan ?? `Команда ${teamNo}`} (${summary.composition})` : `Команда ${teamNo}`
  console.log()
  console.log(`— ${label} ${'—'.repeat(96)}`.slice(0, 100))
  console.log(
    `${pad('Игрок', 28)} ${pad('Техника', 30)} ${pad('ПКР', 10)} ${pad('Возд', 5)} ${pad('Назем', 6)} ${pad('Ассист', 7)} ${pad('Захв', 5)} ${pad('Смерти', 7)} ${pad('Очки', 6)}`,
  )
  for (const p of roster) {
    const displayName = p.name || 'Unknown Player'
    const name = p.clanTag ? `${p.clanTag} ${displayName}` : displayName
    const disconnected = p.name === '' || p.vehicles.length === 0
    const craftNames = disconnected ? 'Disconnected' : p.vehicles.map((v) => vehicleInfo(dict, v).name).join(', ')
    const r = ratings.get(p.name) ?? ratings.get(p.name.replace(/@(psn|live|epic)$/i, ''))
    const rStr = r ? `${r.rating}${r.delta ? ` (${r.delta > 0 ? '+' : ''}${r.delta})` : ''}` : '—'
    console.log(
      `${pad(cut(name, 28), 28)} ${pad(cut(craftNames || '—', 30), 30)} ${pad(rStr, 10)} ` +
        `${pad(String(Math.max(p.kills, 0)), 5)} ${pad(String(Math.max(p.groundKills, 0)), 6)} ${pad(String(Math.max(p.assists, 0)), 7)} ` +
        `${pad(String(Math.max(p.captureZone, 0)), 5)} ${pad(String(Math.max(p.deaths, 0)), 7)} ${pad(String(Math.max(p.score, 0)), 6)}`,
    )
  }
}

console.log()
console.log(`Игроков: ${results.players.length} · статус: ${results.status || '—'}`)

if (flags.has('--image')) {
  const png = await renderBattleImage({
    missionName: data.missionName ?? item.title,
    header,
    results,
    dict,
    ratings,
  })
  mkdirSync('./data/battles', { recursive: true })
  const file = `./data/battles/${header.sessionIdHex}.png`
  writeFileSync(file, png)
  console.log(`Картинка: ${file}`)
}

if (flags.has('--media')) {
  console.log('Скачиваю все части реплея и разбираю пакетный поток...')
  const media = await buildBattleMedia(parts, data.missionName ?? item.title)
  const ev = media.events
  const won = ev.teamWon > 0 ? `команда ${ev.teamWon}` : 'не определён'
  console.log(
    `События: убийств ${ev.kills.length}, повреждений ${ev.damage.length}, сообщений в чате ${ev.chat.length},` +
      ` траекторий ${ev.units.length} · победитель: ${won}` +
      (ev.errors.length > 0 ? ` · ошибок разбора: ${ev.errors.length}` : ''),
  )
  for (const kind of ['log', 'heatmap-ground', 'heatmap-air', 'chat'] as const) {
    console.log(`  data/battles/${header.sessionIdHex}-${kind}${kind === 'chat' ? '.txt' : '.png'}`)
  }
}

closeDb()
