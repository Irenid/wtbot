import assert from 'node:assert/strict'
import test from 'node:test'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { buildServer } from './index.js'
import { DASHBOARD_PATH } from './routes/pages.js'

const deps = {
  getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
  refreshVoice: async () => ({ players: 0, clans: 0 }),
  playerStats: {
    lookup: () => ({ status: 'not_found' as const }),
  },
}

test('large responses are compressed in the encoding the client accepts, with a weak ETag that answers 304', async () => {
  const app = buildServer(deps)
  try {
    const plain = await app.inject({ method: 'GET', url: DASHBOARD_PATH })
    assert.equal(plain.statusCode, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.ok(plain.rawPayload.byteLength > 1024, 'the dashboard page is over the 1 KiB threshold')

    const brotli = await app.inject({ method: 'GET', url: DASHBOARD_PATH, headers: { 'accept-encoding': 'br' } })
    assert.equal(brotli.headers['content-encoding'], 'br')
    assert.equal(brotliDecompressSync(brotli.rawPayload).toString('utf8'), plain.body)
    assert.ok(brotli.rawPayload.byteLength < plain.rawPayload.byteLength / 2)

    const gzip = await app.inject({ method: 'GET', url: DASHBOARD_PATH, headers: { 'accept-encoding': 'gzip' } })
    assert.equal(gzip.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(gzip.rawPayload).toString('utf8'), plain.body)

    const etag = plain.headers['etag']
    assert.equal(typeof etag, 'string')
    assert.match(String(etag), /^W\//)
    // The tag names the content, whatever the encoding.
    assert.equal(gzip.headers['etag'], etag)
    const repeat = await app.inject({
      method: 'GET',
      url: DASHBOARD_PATH,
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(etag) },
    })
    assert.equal(repeat.statusCode, 304)
    assert.equal(repeat.rawPayload.byteLength, 0)
  } finally {
    await app.close()
  }
})

test('small responses stay uncompressed', async () => {
  const app = buildServer(deps)
  try {
    const health = await app.inject({ method: 'GET', url: '/health', headers: { 'accept-encoding': 'br, gzip' } })
    assert.equal(health.statusCode, 200)
    assert.equal(health.headers['content-encoding'], undefined)
  } finally {
    await app.close()
  }
})

test('a compressed request body is not inflated', async () => {
  const app = buildServer(deps)
  try {
    const plain = await app.inject({
      method: 'POST',
      url: '/api/voice/refresh',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    assert.equal(plain.statusCode, 200)
    // The same JSON gzipped: read as is, so the parser refuses it.
    const gzipped = await app.inject({
      method: 'POST',
      url: '/api/voice/refresh',
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      payload: gzipSync('{}'),
    })
    assert.equal(gzipped.statusCode, 400)
  } finally {
    await app.close()
  }
})
