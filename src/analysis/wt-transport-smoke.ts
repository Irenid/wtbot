import { readResponseText } from '../http-response.js'
import { closeWtBrowser, wtBrowserMetrics, wtBrowserUserAgent } from '../parsers/sources/wt-browser.js'
import { fetchWtResponse, warmupWtTransport, wtTransportMode, WT_USER_AGENT } from '../parsers/sources/wt-request.js'

/**
 * Живая проверка транспорта warthunder.com: прогрев, затем несколько профилей
 * подряд. Ожидание — три ответа 200 с разметкой профиля и суммарное время
 * запросов в пределах нескольких секунд после прогрева.
 */

const NICKS = process.argv.slice(2)
const PROFILE_URL = 'https://warthunder.com/en/community/userinfo/'
const players = NICKS.length > 0 ? NICKS : ['Venukbr', 'ТУМ4Н', 'D1moN4k']

function profileHeaders(nickname: string): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en,en-US;q=0.9',
    'user-agent': WT_USER_AGENT,
    'upgrade-insecure-requests': '1',
    referer: `https://warthunder.com/en/community/searchplayers?name=${encodeURIComponent(nickname.toLowerCase())}`,
  }
}

let failures = 0

const warmupStarted = Date.now()
await warmupWtTransport()
console.log(`[1/3] Прогрев: ${Date.now() - warmupStarted} мс; режим=${wtTransportMode()}`)
console.log(`      UA браузера: ${wtBrowserUserAgent() ?? 'браузер не поднят'}`)

console.log('[2/3] Запросы профилей')
const requestsStarted = Date.now()
for (const nickname of players) {
  const started = Date.now()
  const url = new URL(PROFILE_URL)
  url.searchParams.set('nick', nickname)
  try {
    const response = await fetchWtResponse(url, { headers: profileHeaders(nickname) }, `профиль ${nickname}`)
    const html = await readResponseText(response, 4 * 1024 * 1024, `профиль ${nickname}`)
    const hasProfile = html.includes('user-profile__data-nick')
    const statBlocks = html.match(/user-stat__list--titles/g)?.length ?? 0
    if (!hasProfile || statBlocks === 0) failures += 1
    console.log(
      `      ${nickname}: HTTP ${response.status}, ${html.length} символов, профиль=${hasProfile ? 'да' : 'НЕТ'}, блоков статистики=${statBlocks} (${Date.now() - started} мс)`,
    )
  } catch (error) {
    failures += 1
    console.log(`      ${nickname}: ОШИБКА — ${error instanceof Error ? error.message : String(error)} (${Date.now() - started} мс)`)
  }
}
const requestsMs = Date.now() - requestsStarted

const metrics = wtBrowserMetrics()
console.log('[3/3] Метрики транспорта')
console.log(
  `      запросов через страницу: ${metrics.requests}, challenge: ${metrics.challenged}, ` +
    `сбоев транспорта: ${metrics.transportErrors}, ` +
    `проверок пройдено: ${metrics.clearances}, провалов: ${metrics.clearanceFailures}, ` +
    `последняя проверка: ${metrics.lastClearanceMs ?? '—'} мс, вкладок: ${metrics.poolSize}`,
)
console.log(`      суммарно на ${players.length} профиля: ${requestsMs} мс`)

await closeWtBrowser()

if (failures > 0) {
  console.error(`ПРОВАЛ: ${failures} из ${players.length} запросов не вернули профиль`)
  process.exit(1)
}
console.log('OK: все профили получены')
