import assert from 'node:assert/strict'
import test from 'node:test'
import { isChallengeResponse, looksCleared, preferHostCookies } from './wt-challenge.js'

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

test('из пары cookie побеждает host-cookie независимо от порядка', () => {
  assert.deepEqual(
    preferHostCookies([
      { name: 'identity_sid', value: 'domain', domain: '.warthunder.com' },
      { name: 'identity_sid', value: 'host', domain: 'warthunder.com' },
      { name: 'cf_clearance', value: 'clearance', domain: '.warthunder.com' },
    ]),
    [
      { name: 'identity_sid', value: 'host' },
      { name: 'cf_clearance', value: 'clearance' },
    ],
  )
  assert.deepEqual(
    preferHostCookies([
      { name: 'identity_sid', value: 'host', domain: 'warthunder.com' },
      { name: 'identity_sid', value: 'domain', domain: '.warthunder.com' },
    ]),
    [{ name: 'identity_sid', value: 'host' }],
  )
})
