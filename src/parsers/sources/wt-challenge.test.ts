import assert from 'node:assert/strict'
import test from 'node:test'
import {
  freshestCookies,
  isChallengeResponse,
  looksCleared,
  planBrowserSession,
  sameCookieValues,
  staleDuplicateCookies,
} from './wt-challenge.js'

test('проверкой считается только 403 с признаками Cloudflare', () => {
  assert.equal(
    isChallengeResponse({
      status: 403,
      url: 'https://warthunder.com/en/community/userinfo/?nick=Venukbr',
      headers: { 'cf-mitigated': 'challenge' },
    }),
    true,
  )
  assert.equal(
    isChallengeResponse({
      status: 403,
      url: 'https://warthunder.com/en/?__cf_chl_rt_tk=abc',
      headers: {},
    }),
    true,
  )
  // Обычный запрет доступа не должен запускать прохождение проверки.
  assert.equal(isChallengeResponse({ status: 403, url: 'https://warthunder.com/en/', headers: {} }), false)
  // Заголовок приходит и на успешных ответах — сам по себе он ничего не значит.
  assert.equal(
    isChallengeResponse({ status: 200, url: 'https://warthunder.com/en/', headers: { 'cf-mitigated': 'challenge' } }),
    false,
  )
  assert.equal(isChallengeResponse({ status: 404, url: 'https://warthunder.com/en/', headers: {} }), false)
})

test('страница считается чистой только без маркеров проверки и с содержимым', () => {
  const clean = {
    url: 'https://warthunder.com/en/community/searchplayers?name=',
    title: 'War Thunder — Search Players',
    bodyLength: 4_000,
    challengeMarkup: false,
  }
  assert.equal(looksCleared(clean), true)
  assert.equal(looksCleared({ ...clean, url: 'https://warthunder.com/en/?__cf_chl_rt_tk=x' }), false)
  assert.equal(looksCleared({ ...clean, title: 'Just a moment...' }), false)
  assert.equal(looksCleared({ ...clean, challengeMarkup: true }), false)
  // Пустая страница — типичное промежуточное состояние проверки.
  assert.equal(looksCleared({ ...clean, bodyLength: 12 }), false)
})

test('из одноимённых cookie побеждает самая свежая, при равном сроке — host-cookie', () => {
  // Session-копия от прежнего seed и ротированная сервером доменная cookie.
  const seeded = { name: 'identity_sid', value: 'old', domain: 'warthunder.com', path: '/', expires: -1 }
  const rotated = { name: 'identity_sid', value: 'new', domain: '.warthunder.com', path: '/', expires: 1_791_800_000 }
  const clearance = { name: 'cf_clearance', value: 'clearance', domain: '.warthunder.com', path: '/', expires: 1_800_000_000 }
  for (const order of [[seeded, rotated, clearance], [rotated, seeded, clearance]]) {
    assert.deepEqual(freshestCookies(order), [
      { name: 'identity_sid', value: 'new' },
      { name: 'cf_clearance', value: 'clearance' },
    ])
    assert.deepEqual(staleDuplicateCookies(order), [seeded])
  }
  assert.deepEqual(
    freshestCookies([
      { name: 'identity_id', value: 'domain', domain: '.warthunder.com' },
      { name: 'identity_id', value: 'host', domain: 'warthunder.com' },
    ]),
    [{ name: 'identity_id', value: 'host' }],
  )
})

test('sameCookieValues сравнивает наборы cookies без учёта порядка', () => {
  const sid = { name: 'identity_sid', value: 'a' }
  const id = { name: 'identity_id', value: '1' }
  assert.equal(sameCookieValues([sid, id], [id, sid]), true)
  assert.equal(sameCookieValues([], []), true)
  assert.equal(sameCookieValues([sid], [{ name: 'identity_sid', value: 'b' }]), false)
  assert.equal(sameCookieValues([sid], [sid, id]), false)
})

test('planBrowserSession: the browser gets the jar session only while it carries it', () => {
  const signedIn = (token: string, sid: string) => [
    { name: 'identity_id', value: '42' },
    { name: 'identity_token', value: token },
    { name: 'identity_sid', value: sid },
  ]
  const jar = signedIn('jar', 'sid-1')
  const own = signedIn('vnc', 'sid-9')
  // Carrier: the same session stays; another sign-in is kept, then replaced.
  assert.deepEqual(planBrowserSession(true, jar, jar), { stash: false, clear: false, push: false })
  assert.deepEqual(planBrowserSession(true, [], jar), { stash: false, clear: false, push: true })
  assert.deepEqual(planBrowserSession(true, own, jar), { stash: true, clear: true, push: true })
  // The jar has no session: the browser's own one is not wiped.
  assert.deepEqual(planBrowserSession(true, own, []), { stash: false, clear: false, push: false })
  // The direct path carries the session: the browser is anonymous, a jar copy goes without being kept.
  assert.deepEqual(planBrowserSession(false, jar, jar), { stash: false, clear: true, push: false })
  assert.deepEqual(planBrowserSession(false, own, jar), { stash: true, clear: true, push: false })
  assert.deepEqual(planBrowserSession(false, [], jar), { stash: false, clear: false, push: false })
})

test('planBrowserSession keeps only another signed-in session, never an anonymous or stale copy', () => {
  const jar = [
    { name: 'identity_id', value: '42' },
    { name: 'identity_token', value: 'jar' },
    { name: 'identity_sid', value: 'sid-2' },
  ]
  const anonymous = [{ name: 'identity_sid', value: 'anon' }]
  // The jar's own sign-in with an identity_sid the jar has since rotated.
  const staleCopy = jar.map((cookie) => (cookie.name === 'identity_sid' ? { ...cookie, value: 'sid-1' } : cookie))
  assert.deepEqual(planBrowserSession(true, anonymous, jar), { stash: false, clear: true, push: true })
  assert.deepEqual(planBrowserSession(false, anonymous, jar), { stash: false, clear: true, push: false })
  assert.deepEqual(planBrowserSession(true, staleCopy, jar), { stash: false, clear: true, push: true })
  assert.deepEqual(planBrowserSession(false, staleCopy, jar), { stash: false, clear: true, push: false })
})
