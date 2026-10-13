import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import type { WtSignInRenewal } from './wt-browser.js'
import {
  fetchWtResponse,
  renewWtSessionIfDue,
  resetWtTransportState,
  retryAfterWtSessionRefresh,
  WT_SESSION_LIFETIME_MS,
  wtRouteOf,
  wtSessionStatus,
  wtTransportRoutes,
} from './wt-request.js'
import { GAIJIN_RELOGIN_URL } from './wt-sign-in.js'

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
  const absorbed: Array<{ response: Response; sentCookie: string }> = []
  resetWtTransportState({
    waitSlot: async () => undefined,
    browserEnabled: () => true,
    browserFetch: async (url, _init, _maxBytes, _label, browserOptions) => {
      browserCalls.push({ url: String(url), session: browserOptions.session })
      return new Response('browser', { status: 200 })
    },
    sessionHeaders: async () => ({ cookie: 'identity_sid=jar', userAgent: 'BrowserUA/1' }),
    absorbSessionCookies: async (response, sentCookie) => {
      absorbed.push({ response, sentCookie })
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

test('the Replay API carries the jar session and its browser User-Agent; the jar learns what was sent', async () => {
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
  assert.equal(absorbed[0]!.sentCookie, 'identity_sid=jar')
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

const HOUR = 60 * 60_000

/**
 * Session recovery with fake browser steps: `calls` records each step,
 * `renewals` are the Gaijin sign-in results in order (then "failed").
 */
function sessionTransport(options: {
  renewals?: WtSignInRenewal[]
  adopt?: boolean
  signedInAt?: number | null
  configured?: boolean
  pageUrl?: string | null
} = {}) {
  const calls: string[] = []
  const visited: string[] = []
  const renewals = [...(options.renewals ?? [])]
  const clock = { now: Date.parse('2026-10-13T12:00:00Z') }
  resetWtTransportState({
    waitSlot: async () => {
      calls.push('slot')
    },
    browserEnabled: () => true,
    now: () => clock.now,
    sessionConfigured: () => options.configured ?? true,
    signedInAt: async () => options.signedInAt ?? null,
    renewSignIn: async (_reason, prepareVisit) => {
      calls.push('renew')
      visited.push(await prepareVisit())
      return renewals.shift() ?? 'failed'
    },
    adoptBrowserSession: async () => {
      calls.push('adopt')
      return options.adopt ?? false
    },
    refreshClearance: async () => {
      calls.push('clearance')
      return true
    },
    fetchReLoginUrl: async () => {
      calls.push('page')
      return options.pageUrl === undefined ? 'https://login.gaijin.net/en/sso/reLogin/?from=page' : options.pageUrl
    },
  })
  return { calls, visited, clock }
}

/** One Replay API call that answers an empty list first and a full one after a refresh. */
async function emptyThenFull(): Promise<{ empty: boolean }> {
  let requests = 0
  return retryAfterWtSessionRefresh(
    async () => ({ empty: requests++ === 0 }),
    (response) => response.empty,
    'Replay API returned an empty list',
  )
}

test('a lost session is signed in again through Gaijin before anything else', async (t) => {
  t.mock.method(console, 'log', () => undefined)
  const { calls, visited } = sessionTransport({ renewals: ['renewed'] })

  assert.deepEqual(await emptyThenFull(), { empty: false })

  // The visit gets the page's reLogin address and a request slot (it ends on warthunder.com).
  assert.deepEqual(calls, ['renew', 'page', 'slot'])
  assert.deepEqual(visited, ['https://login.gaijin.net/en/sso/reLogin/?from=page'])
  assert.equal(wtSessionStatus().lastRenewal, 'renewed')
})

test('without a Gaijin sign-in the browser session is adopted, and the warning says what to do', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined)
  const signedInAt = Date.parse('2026-09-28T20:52:00Z')
  const { calls } = sessionTransport({ renewals: ['signed-out'], adopt: true, signedInAt })

  assert.deepEqual(await emptyThenFull(), { empty: false })

  assert.deepEqual(calls, ['renew', 'page', 'slot', 'adopt'])
  const warnings = warn.mock.calls.map((call) => String(call.arguments[0]))
  const advice = warnings.find((line) => line.includes('https://login.gaijin.net in the bot\'s browser'))
  assert.ok(advice, warnings.join('\n'))
  assert.match(advice, /works until about 2026-10-12 20:52 UTC/)
})

test('a sign-in in progress through VNC neither warns nor delays the next attempt', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined)
  const { calls, clock } = sessionTransport({ renewals: ['signing-in', 'renewed'], adopt: true })

  assert.deepEqual(await emptyThenFull(), { empty: false })
  assert.equal(warn.mock.calls.some((call) => String(call.arguments[0]).includes('login.gaijin.net')), false)
  assert.equal(wtSessionStatus().lastRenewal, 'signing-in')

  // The next empty list (5 minutes later) renews at once: no 30-minute wait as after a failure.
  clock.now += 5 * 60_000
  calls.length = 0
  t.mock.method(console, 'log', () => undefined)
  assert.deepEqual(await emptyThenFull(), { empty: false })
  assert.deepEqual(calls, ['renew', 'slot'])
  assert.equal(wtSessionStatus().lastRenewal, 'renewed')
})

test('with no sign-in anywhere the session route moves to the browser', async (t) => {
  t.mock.method(console, 'warn', () => undefined)
  t.mock.method(console, 'log', () => undefined)
  const { calls } = sessionTransport({ renewals: ['signed-out'] })

  assert.deepEqual(await emptyThenFull(), { empty: false })

  assert.deepEqual(calls, ['renew', 'page', 'slot', 'adopt'])
  assert.deepEqual(wtTransportRoutes(), { '/en/api/replay': 'browser' })
})

test('a request that raced a renewal is retried with the new session, without another sign-in', async (t) => {
  t.mock.method(console, 'log', () => undefined)
  const { calls, clock } = sessionTransport({ renewals: ['renewed', 'renewed'] })
  await emptyThenFull()
  clock.now += 60_000

  assert.deepEqual(await emptyThenFull(), { empty: false })

  assert.equal(calls.filter((call) => call === 'renew').length, 1)
})

test('a failed sign-in is not repeated for 30 minutes', async (t) => {
  t.mock.method(console, 'warn', () => undefined)
  t.mock.method(console, 'log', () => undefined)
  const { calls, clock } = sessionTransport({ renewals: ['failed', 'renewed'] })
  await emptyThenFull()
  calls.length = 0

  // Past the 5-minute refresh pause: the other steps run, the sign-in does not.
  clock.now += 6 * 60_000
  await emptyThenFull()
  assert.deepEqual(calls, ['adopt', 'slot', 'clearance'])

  calls.length = 0
  clock.now += 25 * 60_000
  await emptyThenFull()
  // The reLogin address read for the first attempt is still fresh.
  assert.deepEqual(calls, ['renew', 'slot'])
})

test('the schedule renews a sign-in a day after it happened, or one of unknown age', async (t) => {
  t.mock.method(console, 'warn', () => undefined)
  t.mock.method(console, 'log', () => undefined)
  const now = Date.parse('2026-10-13T12:00:00Z')

  sessionTransport({ signedInAt: now - 2 * HOUR })
  assert.equal(await renewWtSessionIfDue(), 'skipped')
  assert.equal(wtSessionStatus().expiresAt, Math.floor((now - 2 * HOUR + WT_SESSION_LIFETIME_MS) / 1_000))

  sessionTransport({ signedInAt: now - 25 * HOUR, renewals: ['renewed'] })
  assert.equal(await renewWtSessionIfDue(), 'renewed')

  sessionTransport({ signedInAt: null, renewals: ['signed-out'] })
  assert.equal(await renewWtSessionIfDue(), 'signed-out')

  const unconfigured = sessionTransport({ signedInAt: null, configured: false })
  assert.equal(await renewWtSessionIfDue(), 'skipped')
  assert.deepEqual(unconfigured.calls, [])
})

test('the built-in reLogin address stands in for an unreadable page, read once a day', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined)
  const { calls, visited, clock } = sessionTransport({ renewals: ['signed-out', 'signed-out'], pageUrl: null })

  await renewWtSessionIfDue()
  clock.now += HOUR
  await renewWtSessionIfDue()

  assert.deepEqual(visited, [GAIJIN_RELOGIN_URL, GAIJIN_RELOGIN_URL])
  assert.equal(calls.filter((call) => call === 'page').length, 1)
  // The sign-in advice is not repeated within 6 hours.
  const advice = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('cannot renew itself'))
  assert.equal(advice.length, 1)
})
