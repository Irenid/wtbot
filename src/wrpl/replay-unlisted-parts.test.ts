import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import test from 'node:test'
import { replayPartUrlAt, withUnlistedReplayParts } from './replay.js'
import { configureReplayUrlPolicy } from './replay-url-policy.js'

// Локальный HTTP-сервер теста: http и 127.0.0.1 разрешены только явной инъекцией.
configureReplayUrlPolicy({ allowInsecureForTests: true })

async function withCdn(
  handler: (url: string, headers: IncomingHttpHeaders) => number,
  run: (base: string, requests: { url: string; range: string | undefined }[]) => Promise<void>,
): Promise<void> {
  const requests: { url: string; range: string | undefined }[] = []
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    requests.push({ url, range: request.headers.range })
    const status = handler(url, request.headers)
    response.writeHead(status, { 'content-type': 'application/octet-stream' })
    response.end(status < 300 ? Buffer.from([0xe5]) : undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}`, requests)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

test('replayPartUrlAt строит ссылку на часть по образцу и отклоняет чужой шаблон', () => {
  assert.equal(
    replayPartUrlAt('https://cdn.example.net/0a1b2c3d4e5f/0003.wrpl', 12),
    'https://cdn.example.net/0a1b2c3d4e5f/0012.wrpl',
  )
  assert.equal(
    replayPartUrlAt('https://cdn.example.net/0a1b2c3d4e5f/0000.wrpl?sig=1', 1),
    'https://cdn.example.net/0a1b2c3d4e5f/0001.wrpl?sig=1',
  )
  assert.equal(replayPartUrlAt('https://cdn.example.net/0a1b2c3d4e5f/replay.bin', 1), null)
  assert.equal(replayPartUrlAt('не URL', 1), null)
  assert.equal(replayPartUrlAt('https://cdn.example.net/0a/0000.wrpl', 256), null)
  assert.equal(replayPartUrlAt('https://cdn.example.net/0a/0000.wrpl', -1), null)
})

test('withUnlistedReplayParts дописывает части после устаревшего partsCount', async () => {
  // На CDN шесть частей, а запись сайта знает только три.
  await withCdn((url) => (/\/000[0-5]\.wrpl$/.test(url) ? 206 : 404), async (base, requests) => {
    const listed = [0, 1, 2].map((index) => `${base}/0a1b2c3d4e5f/000${index}.wrpl`)
    const urls = await withUnlistedReplayParts(listed)
    assert.deepEqual(urls, [0, 1, 2, 3, 4, 5].map((index) => `${base}/0a1b2c3d4e5f/000${index}.wrpl`))
    // Проверяются только части после известных, по одному байту, до первой отсутствующей.
    assert.deepEqual(requests.map((request) => request.url), [3, 4, 5, 6].map((index) => `/0a1b2c3d4e5f/000${index}.wrpl`))
    assert.ok(requests.every((request) => request.range === 'bytes=0-0'))
  })
})

test('withUnlistedReplayParts без новых частей оставляет список, а сбой проверки пробрасывает', async () => {
  await withCdn(() => 404, async (base, requests) => {
    const listed = [`${base}/0a1b2c3d4e5f/0000.wrpl`]
    assert.deepEqual(await withUnlistedReplayParts(listed), listed)
    assert.equal(requests.length, 1)
  })
  // Без ответа CDN неизвестно, полон ли список: старый бой иначе сразу стал бы expired.
  await withCdn(() => 503, async (base) => {
    await assert.rejects(withUnlistedReplayParts([`${base}/0a1b2c3d4e5f/0000.wrpl`]), /HTTP 503 при проверке/)
  })
  assert.deepEqual(await withUnlistedReplayParts([]), [])
})

test('withUnlistedReplayParts повторяет проверку после 429', async () => {
  let limited = false
  await withCdn((url) => {
    if (url.endsWith('/0001.wrpl') && !limited) {
      limited = true
      return 429
    }
    return url.endsWith('/0001.wrpl') ? 206 : 404
  }, async (base, requests) => {
    const urls = await withUnlistedReplayParts([`${base}/0a1b2c3d4e5f/0000.wrpl`])
    assert.deepEqual(urls, [`${base}/0a1b2c3d4e5f/0000.wrpl`, `${base}/0a1b2c3d4e5f/0001.wrpl`])
    assert.deepEqual(requests.map((request) => request.url), [
      '/0a1b2c3d4e5f/0001.wrpl',
      '/0a1b2c3d4e5f/0001.wrpl',
      '/0a1b2c3d4e5f/0002.wrpl',
    ])
  })
})

test('withUnlistedReplayParts пробрасывает отмену', async () => {
  await withCdn(() => 206, async (base) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      withUnlistedReplayParts([`${base}/0a1b2c3d4e5f/0000.wrpl`], { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
  })
})
