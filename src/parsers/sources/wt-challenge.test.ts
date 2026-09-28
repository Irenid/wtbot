import assert from 'node:assert/strict'
import test from 'node:test'
import { freshestCookies, isChallengeResponse, looksCleared, staleDuplicateCookies } from './wt-challenge.js'

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
