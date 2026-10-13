import assert from 'node:assert/strict'
import test from 'node:test'
import { applySetCookies, withSession } from './wt-cookies.js'

const NOW = Date.parse('2026-10-13T12:00:00Z')

function jar(): Map<string, string> {
  return new Map([
    ['identity_id', '42'],
    ['identity_token', 'tok-1'],
    ['identity_sid', 'sid-1'],
    ['language', 'en'],
  ])
}

test('applySetCookies follows the rotation and deletions of the jar session', () => {
  const { next, changed } = applySetCookies(jar(), [
    'identity_sid=sid-2; Path=/; Max-Age=1209600; Secure; HttpOnly',
    'language=ru; Path=/',
    'proposed_lang=; Path=/; Max-Age=0',
    'tracking=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ], true, NOW)
  assert.equal(changed, true)
  assert.equal(next.get('identity_sid'), 'sid-2')
  assert.equal(next.get('language'), 'ru')
  assert.equal(next.has('proposed_lang'), false)
  assert.equal(next.has('tracking'), false)
})

test('applySetCookies keeps the jar session against a response to a replaced one', () => {
  const { next, changed } = applySetCookies(jar(), [
    'identity_sid=old-session-sid; Path=/',
    'identity_token=; Path=/; Max-Age=0',
    'language=ru; Path=/',
  ], false, NOW)
  assert.equal(changed, true)
  assert.equal(next.get('identity_sid'), 'sid-1')
  assert.equal(next.get('identity_token'), 'tok-1')
  assert.equal(next.get('language'), 'ru')
})

test('applySetCookies reports no change for the values the jar has', () => {
  assert.equal(applySetCookies(jar(), ['identity_sid=sid-1; Path=/'], true, NOW).changed, false)
  assert.equal(applySetCookies(jar(), ['broken header'], true, NOW).changed, false)
})

test('withSession swaps every identity_* cookie and keeps the rest', () => {
  const next = withSession(jar(), [
    { name: 'identity_id', value: '42' },
    { name: 'identity_token', value: 'tok-2' },
    { name: 'language', value: 'de' },
  ])
  assert.deepEqual(Object.fromEntries(next), { language: 'en', identity_id: '42', identity_token: 'tok-2' })
})
