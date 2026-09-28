import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fetchReplayPart } from './replay-cache.js'
import { configureReplayUrlPolicy } from './replay-url-policy.js'

// Локальный HTTP-сервер теста: http и 127.0.0.1 разрешены только явной инъекцией.
configureReplayUrlPolicy({ allowInsecureForTests: true })

test('live replay overtakes queued background fetches without bypassing limiter', async () => {
  const fixture = Buffer.alloc(1234)
  fixture.set([0xe5, 0xac, 0x00, 0x10])
  const requested: string[] = []
  const server = createServer((request, response) => {
    requested.push(request.url ?? '')
    response.writeHead(200, {
      'content-length': String(fixture.byteLength),
      'content-type': 'application/octet-stream',
    })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    await Promise.all([
      fetchReplayPart(`${base}/background-one/0000.wrpl`, {
        cacheDirectory: null,
        priority: 'background',
      }),
      fetchReplayPart(`${base}/background-two/0000.wrpl`, {
        cacheDirectory: null,
        priority: 'background',
      }),
      fetchReplayPart(`${base}/live/0000.wrpl`, {
        cacheDirectory: null,
        priority: 'live',
      }),
    ])
    assert.deepEqual(requested, [
      '/background-one/0000.wrpl',
      '/live/0000.wrpl',
      '/background-two/0000.wrpl',
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('promoted replay updates priority while waiting for the shared fetch slot', async () => {
  const fixture = Buffer.alloc(1234)
  fixture.set([0xe5, 0xac, 0x00, 0x10])
  const requested: string[] = []
  let resolveFirstRequest: (() => void) | null = null
  const firstRequest = new Promise<void>((resolve) => { resolveFirstRequest = resolve })
  const server = createServer((request, response) => {
    requested.push(request.url ?? '')
    if (requested.length === 1) resolveFirstRequest?.()
    response.writeHead(200, {
      'content-length': String(fixture.byteLength),
      'content-type': 'application/octet-stream',
    })
    response.end(fixture)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const first = fetchReplayPart(`${base}/background-one/0000.wrpl`, {
      cacheDirectory: null,
      priority: 'background',
    })
    // Если загрузка упадёт до запроса, тест должен упасть, а не ждать вечно.
    await Promise.race([firstRequest, first.then(() => undefined)])
    const second = fetchReplayPart(`${base}/background-two/0000.wrpl`, {
      cacheDirectory: null,
      priority: 'background',
    })
    let promotedPriority: 'background' | 'live' = 'background'
    const promoted = fetchReplayPart(`${base}/promoted/0000.wrpl`, {
      cacheDirectory: null,
      priority: () => promotedPriority,
    })
    promotedPriority = 'live'
    await Promise.all([first, second, promoted])
    assert.deepEqual(requested, [
      '/background-one/0000.wrpl',
      '/promoted/0000.wrpl',
      '/background-two/0000.wrpl',
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
