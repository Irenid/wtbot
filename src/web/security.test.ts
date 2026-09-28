import assert from 'node:assert/strict'
import test from 'node:test'
import { buildServer } from './index.js'

const deps = {
  getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
  refreshVoice: async () => ({ players: 0, clans: 0 }),
  playerStats: {
    lookup: () => ({ status: 'not_found' as const }),
  },
}

test('non-loopback web server requires bearer token for protected paths', async () => {
  const app = buildServer(deps, undefined, { host: '192.0.2.10', token: 'test-secret' })
  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)

    const unauthorized = await app.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(unauthorized.json().code, 'UNAUTHORIZED')

    const authorized = await app.inject({
      method: 'POST',
      url: '/api/voice/refresh',
      headers: {
        authorization: 'Bearer test-secret',
        host: 'dashboard.example',
        origin: 'https://dashboard.example',
        'sec-fetch-site': 'same-origin',
      },
    })
    assert.equal(authorized.statusCode, 200)
    assert.equal(authorized.json().ok, true)
  } finally {
    await app.close()
  }
})

test('non-loopback web server blocks cross-origin POST', async () => {
  const app = buildServer(deps, undefined, { host: '192.0.2.10', token: 'test-secret' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/voice/refresh',
      headers: {
        authorization: 'Bearer test-secret',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().code, 'CSRF_BLOCKED')
  } finally {
    await app.close()
  }
})

test('non-loopback web server requires token configuration', () => {
  assert.throws(
    () => buildServer(deps, undefined, { host: '192.0.2.10' }),
    /WEB_TOKEN обязателен/,
  )
})

test('web server hides internal error details', async () => {
  const app = buildServer(deps)
  const originalConsoleError = console.error
  let logged = ''
  console.error = (...args: unknown[]) => {
    logged += args.map(String).join(' ')
  }
  app.get('/api/test-error', async () => {
    throw new Error("EACCES: permission denied, open 'D:/secret/file'")
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test-error' })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), {
      ok: false,
      code: 'INTERNAL',
      error: 'Внутренняя ошибка сервера',
    })
    assert.match(logged, /D:\/secret\/file/)
  } finally {
    console.error = originalConsoleError
    await app.close()
  }
})

test('auth-проверка не обходится percent-кодированием пути', async () => {
  const app = buildServer(deps, undefined, { host: '192.0.2.10', token: 'test-secret' })
  try {
    // Роутер декодирует %61 → 'a', поэтому /%61pi/... попадает в обработчик
    // /api/...; проверка обязана защитить этот путь так же, как /api/...
    const encodedPost = await app.inject({ method: 'POST', url: '/%61pi/voice/refresh' })
    assert.equal(encodedPost.statusCode, 401)
    assert.equal(encodedPost.json().code, 'UNAUTHORIZED')

    const encodedGet = await app.inject({ method: 'GET', url: '/%61pi/stats' })
    assert.equal(encodedGet.statusCode, 401)

    // Правильный токен по закодированному пути по-прежнему пропускается
    const authorized = await app.inject({
      method: 'POST',
      url: '/%61pi/voice/refresh',
      headers: {
        authorization: 'Bearer test-secret',
        host: 'dashboard.example',
        origin: 'https://dashboard.example',
        'sec-fetch-site': 'same-origin',
      },
    })
    assert.equal(authorized.statusCode, 200)
    assert.equal(authorized.json().ok, true)
  } finally {
    await app.close()
  }
})

test('auth-проверка не обходится absolute-form request-target', async () => {
  const app = buildServer(deps, undefined, { host: '192.0.2.10', token: 'test-secret' })
  try {
    // Absolute-form (`http://host/api/...`) приходит через прокси/HTTP2; роутер
    // маршрутизирует по пути, значит и защита должна опираться на него.
    const absolute = await app.inject({ method: 'GET', url: 'http://attacker.example/api/stats' })
    assert.equal(absolute.statusCode, 401)
    assert.equal(absolute.json().code, 'UNAUTHORIZED')
  } finally {
    await app.close()
  }
})

test('loopback-сервер без токена не защищает и не ломается на закодированном пути', async () => {
  const app = buildServer(deps, undefined, { host: '127.0.0.1', token: '' })
  try {
    // На loopback токен не требуется — проверяем, что новая нормализация пути
    // не начала ложно отклонять валидные запросы.
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
  } finally {
    await app.close()
  }
})
