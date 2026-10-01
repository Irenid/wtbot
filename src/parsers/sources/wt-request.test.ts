import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  fetchWtResponse,
  resetWtTransportState,
  retryAfterWtSessionRefresh,
  wtRouteOf,
  wtTransportRoutes,
} from './wt-request.js'

const LEADERBOARD = 'https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page/1/sort/dr_era5'
const PROFILE = 'https://warthunder.com/en/community/userinfo/?nick=Venukbr'
const REPLAYS = 'https://warthunder.com/en/api/replay'

interface BrowserCall {
  url: string
  session: boolean | undefined
}

/** Транспорт без очереди, браузера и jar: тест видит каждый прямой и браузерный запрос. */
function fakeTransport(options: { now?: () => number } = {}) {
  const browserCalls: BrowserCall[] = []
  const absorbed: Response[] = []
  resetWtTransportState({
    waitSlot: async () => undefined,
    browserEnabled: () => true,
    browserFetch: async (url, _init, _maxBytes, _label, browserOptions) => {
      browserCalls.push({ url: String(url), session: browserOptions.session })
      return new Response('browser', { status: 200 })
    },
    sessionHeaders: async () => ({ cookie: 'identity_sid=jar', userAgent: 'BrowserUA/1' }),
    absorbSessionCookies: async (response) => {
      absorbed.push(response)
    },
    ...(options.now ? { now: options.now } : {}),
  })
  return { browserCalls, absorbed }
}

function challenge(): Response {
  return new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  resetWtTransportState()
})

test('маршрут — первые три сегмента пути', () => {
  assert.equal(wtRouteOf(`${REPLAYS}/123456`), '/en/api/replay')
  assert.equal(wtRouteOf(PROFILE), '/en/community/userinfo')
  assert.equal(wtRouteOf(LEADERBOARD), '/en/community/getclansleaderboard')
})

test('публичный адрес идёт напрямую и без cookies сессии', async () => {
  const { browserCalls } = fakeTransport()
  const sent: Headers[] = []
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init?.headers))
    return new Response('{}', { status: 200 })
  }

  const response = await fetchWtResponse(LEADERBOARD, { headers: { cookie: 'identity_sid=leak' } }, 'лидерборд')

  assert.equal(await response.text(), '{}')
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.get('cookie'), null)
  assert.equal(browserCalls.length, 0)
  assert.deepEqual(wtTransportRoutes(), { '/en/community/getclansleaderboard': 'direct' })
})

test('проверка Cloudflare переводит на браузер только свой адрес', async () => {
  const { browserCalls } = fakeTransport()
  const direct: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    direct.push(url)
    return url.includes('userinfo') ? challenge() : new Response('{}', { status: 200 })
  }

  assert.equal(await (await fetchWtResponse(PROFILE, {}, 'профиль')).text(), 'browser')
  assert.equal(await (await fetchWtResponse(PROFILE, {}, 'профиль')).text(), 'browser')
  await fetchWtResponse(LEADERBOARD, {}, 'лидерборд')

  // Второй запрос профиля сразу идёт в браузер, лидерборд остаётся прямым.
  assert.deepEqual(direct, [PROFILE, LEADERBOARD])
  assert.deepEqual(browserCalls, [
    { url: PROFILE, session: false },
    { url: PROFILE, session: false },
  ])
  assert.deepEqual(wtTransportRoutes(), {
    '/en/community/getclansleaderboard': 'direct',
    '/en/community/userinfo': 'browser',
  })
})

test('через 6 часов адрес снова пробует прямой путь', async () => {
  let now = 1_000_000
  const { browserCalls } = fakeTransport({ now: () => now })
  let challenged = true
  const direct: string[] = []
  globalThis.fetch = async (input) => {
    direct.push(String(input))
    return challenged ? challenge() : new Response('ok', { status: 200 })
  }

  await fetchWtResponse(PROFILE, {}, 'профиль')
  now += 6 * 60 * 60_000 - 1
  await fetchWtResponse(PROFILE, {}, 'профиль')
  assert.equal(direct.length, 1)

  challenged = false
  now += 1
  assert.equal(await (await fetchWtResponse(PROFILE, {}, 'профиль')).text(), 'ok')
  assert.equal(direct.length, 2)
  assert.equal(browserCalls.length, 2)
  assert.deepEqual(wtTransportRoutes(), { '/en/community/userinfo': 'direct' })
})

test('Replay API несёт сессию jar и User-Agent её браузера, ответ обновляет jar', async () => {
  const { absorbed, browserCalls } = fakeTransport()
  const sent: Headers[] = []
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init?.headers))
    return new Response('{"items":[]}', { status: 200, headers: { 'set-cookie': 'identity_sid=next; Path=/' } })
  }

  await fetchWtResponse(REPLAYS, { method: 'POST', headers: { 'user-agent': 'Fallback/1' } }, 'replay')

  assert.equal(sent[0]!.get('cookie'), 'identity_sid=jar')
  assert.equal(sent[0]!.get('user-agent'), 'BrowserUA/1')
  assert.equal(absorbed.length, 1)
  assert.equal(browserCalls.length, 0)
})

test('Replay API под проверкой Cloudflare уходит в браузер вместе с сессией', async () => {
  const { browserCalls } = fakeTransport()
  globalThis.fetch = async () => challenge()

  await fetchWtResponse(`${REPLAYS}/123`, {}, 'детали replay')

  assert.deepEqual(browserCalls, [{ url: `${REPLAYS}/123`, session: true }])
  assert.deepEqual(wtTransportRoutes(), { '/en/api/replay': 'browser' })
})

test('сетевой сбой прямого запроса повторяется через браузер, не меняя режим адреса', async () => {
  const { browserCalls } = fakeTransport()
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }

  assert.equal(await (await fetchWtResponse(LEADERBOARD, {}, 'лидерборд')).text(), 'browser')
  assert.equal(browserCalls.length, 1)
  assert.deepEqual(wtTransportRoutes(), {})
})

test('повторяет запрос один раз после успешного обновления WT-сессии', async () => {
  let requests = 0
  let refreshes = 0

  const result = await retryAfterWtSessionRefresh(
    async () => ({ empty: requests++ === 0 }),
    (response) => response.empty,
    'пустой Replay API',
    async () => {
      refreshes += 1
      return true
    },
  )

  assert.deepEqual(result, { empty: false })
  assert.equal(requests, 2)
  assert.equal(refreshes, 1)
})

test('не обновляет сессию для нормального ответа', async () => {
  let refreshes = 0

  const result = await retryAfterWtSessionRefresh(
    async () => ({ empty: false }),
    (response) => response.empty,
    'пустой Replay API',
    async () => {
      refreshes += 1
      return true
    },
  )

  assert.deepEqual(result, { empty: false })
  assert.equal(refreshes, 0)
})

test('не повторяет запрос, если Edge не смог обновить сессию', async () => {
  let requests = 0

  const result = await retryAfterWtSessionRefresh(
    async () => {
      requests += 1
      return { empty: true }
    },
    (response) => response.empty,
    'пустой Replay API',
    async () => false,
  )

  assert.deepEqual(result, { empty: true })
  assert.equal(requests, 1)
})
