// Микрозамер горячих read-функций сайта на реальной БД: поиск блокировок
// event loop. Только чтение. Запуск: npx tsx src/analysis/site-bench.ts
import {
  getClanRatingsWithDelta,
  getPlayerIdentityByWtUserId,
  getPlayerRating,
  getPlayerReplayStats,
  getSiteBattleTeamClans,
  getSiteClanBattleTeams,
  getSiteReplayNick,
  initDb,
  closeDb,
  listSiteBattles,
} from '../db/index.js'

const CLAN_TAG = process.argv[2] ?? '╝BufSs╝'
const USER_ID = process.argv[3] ?? '207019239'

function time(label: string, run: () => unknown): void {
  const started = process.hrtime.bigint()
  const result = run()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const size = result instanceof Map ? result.size : Array.isArray(result) ? result.length : ''
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  ${size !== '' ? `(${size})` : ''}`)
}

initDb(process.env['DB_PATH'] ?? 'data/wtbot.db')
const nowSec = Math.floor(Date.now() / 1_000)

time('getClanRatingsWithDelta', () => getClanRatingsWithDelta(CLAN_TAG))
time('getSiteClanBattleTeams 30д', () => getSiteClanBattleTeams([CLAN_TAG], nowSec - 30 * 86_400, nowSec + 1))
time('listSiteBattles clan 30д', () => listSiteBattles({ clanTags: [CLAN_TAG], from: nowSec - 30 * 86_400, limit: 20 }))
const recent = listSiteBattles({ clanTags: [CLAN_TAG], from: nowSec - 30 * 86_400, limit: 20 })
time('battleTeamClans ×' + recent.length, () => recent.map((row) => getSiteBattleTeamClans(row.sessionId)))
time('getPlayerIdentityByWtUserId', () => getPlayerIdentityByWtUserId(USER_ID))
time('getSiteReplayNick', () => getSiteReplayNick(USER_ID))
const nick = getSiteReplayNick(USER_ID) ?? ''
time('getPlayerReplayStats', () => getPlayerReplayStats({ userId: USER_ID }))
time('getPlayerRating', () => getPlayerRating(nick))
closeDb()
