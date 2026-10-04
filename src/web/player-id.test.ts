import assert from 'node:assert/strict'
import test from 'node:test'
import type { WtUserIdLookupResult } from '../player-stats/id-lookup.js'
import { buildServer } from './index.js'

function deps(resolve?: (nick: string) => Promise<WtUserIdLookupResult>) {
  return {
    getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
    refreshVoice: async () => ({ players: 0, clans: 0 }),
    playerStats: { lookup: () => ({ status: 'not_found' as const }) },
    ...(resolve === undefined ? {} : { playerIdLookup: { resolve } }),
  }
}

function lookupRequest(nick: unknown, ip = '127.0.0.1') {
  return {
    method: 'POST' as const,
    url: '/api/player-id',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ nick }),
  }
}

test('POST /api/player-id answers every lookup outcome without caching', async () => {
  const answers: Record<string, WtUserIdLookupResult> = {
    Found: { status: 'found', wtUserId: '9001' },
    Missing: { status: 'not_found' },
    Twin: { status: 'ambiguous' },
    Nobody: { status: 'unknown_player' },
    Crowd: { status: 'busy' },
    Broken: { status: 'error', error: 'companion search: HTTP 500' },
  }
  const asked: string[] = []
  const app = buildServer(deps(async (nick) => {
    asked.push(nick)
    return answers[nick] ?? { status: 'not_found' }
  }))
  try {
    const found = await app.inject(lookupRequest(' Found '))
    assert.equal(found.statusCode, 200)
    assert.equal(found.headers['cache-control'], 'no-store')
    assert.deepEqual(found.json(), { ok: true, status: 'found', wtUserId: '9001' })
    assert.deepEqual((await app.inject(lookupRequest('Missing'))).json(), { ok: true, status: 'not_found', wtUserId: null })
    assert.deepEqual((await app.inject(lookupRequest('Twin'))).json(), { ok: true, status: 'ambiguous', wtUserId: null })

    const unknown = await app.inject(lookupRequest('Nobody'))
    assert.equal(unknown.statusCode, 404)
    assert.equal(unknown.json().code, 'PLAYER_NOT_FOUND')
    const busy = await app.inject(lookupRequest('Crowd'))
    assert.equal(busy.statusCode, 503)
    assert.equal(busy.headers['retry-after'], '10')
    assert.equal(busy.json().code, 'BUSY')
    const broken = await app.inject(lookupRequest('Broken'))
    assert.equal(broken.statusCode, 502)
    assert.equal(broken.json().code, 'LOOKUP_FAILED')
    // The source's error stays in the log.
    assert.doesNotMatch(broken.body, /HTTP 500/)

    // Empty, a control character, 65 characters, missing; a number becomes its string, as for /api/player-stats.
    for (const invalid of ['', 'bad\u0007nick', 'x'.repeat(65), undefined]) {
      assert.equal((await app.inject(lookupRequest(invalid))).statusCode, 400)
    }
    const blank = await app.inject(lookupRequest('   '))
    assert.equal(blank.statusCode, 400)
    assert.equal(blank.json().code, 'INVALID_PLAYER')
    assert.deepEqual(asked, ['Found', 'Missing', 'Twin', 'Nobody', 'Crowd', 'Broken'])
  } finally {
    await app.close()
  }
})

test('POST /api/player-id is off without a resolver and rate-limited per IP', async () => {
  const disabled = buildServer(deps())
  const app = buildServer(deps(async () => ({ status: 'not_found' })))
  try {
    const off = await disabled.inject(lookupRequest('Found'))
    assert.equal(off.statusCode, 503)
    assert.equal(off.json().code, 'DISABLED')

    // Ten lookups a minute per IP; another IP keeps its own window.
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await app.inject(lookupRequest(`Member${index}`, '192.0.2.1'))).statusCode, 200)
    }
    const limited = await app.inject(lookupRequest('Member10', '192.0.2.1'))
    assert.equal(limited.statusCode, 429)
    assert.ok(Number(limited.headers['retry-after']) >= 1)
    assert.equal(limited.json().code, 'RATE_LIMITED')
    assert.equal((await app.inject(lookupRequest('Member10', '192.0.2.2'))).statusCode, 200)
  } finally {
    await disabled.close()
    await app.close()
  }
})

test('POST /api/player-id answers pending when a lookup outlasts the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: (result: WtUserIdLookupResult) => void
  const app = buildServer(deps(() => new Promise((resolve) => { finish = resolve })))
  try {
    const response = app.inject(lookupRequest('Slow'))
    // Let the handler start its wait before the clock moves.
    for (let turn = 0; turn < 20 && finish === undefined; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.ok(finish !== undefined)
    t.mock.timers.tick(15_000)
    const pending = await response
    assert.equal(pending.statusCode, 202)
    assert.deepEqual(pending.json(), { ok: true, status: 'pending', wtUserId: null })
    finish({ status: 'not_found' })
  } finally {
    t.mock.timers.reset()
    await app.close()
  }
})
