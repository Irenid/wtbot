import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { resolveReplayPartUrls } from './replay.js'
import {
  configureReplayUrlPolicy,
  fetchReplayUrl,
  MAX_REPLAY_PARTS,
  replayUrlProblem,
} from './replay-url-policy.js'

const CDN = 'https://replays.cdn.example.net/06fea91100096f5a/'

function withPolicy(options: Parameters<typeof configureReplayUrlPolicy>[0], body: () => Promise<void> | void) {
  return async () => {
    configureReplayUrlPolicy(options)
    try {
      await body()
    } finally {
      configureReplayUrlPolicy({ allowedHosts: [], allowInsecureForTests: false })
    }
  }
}

test('политика URL отклоняет адреса, ведущие во внутреннюю сеть', withPolicy({}, () => {
  assert.equal(replayUrlProblem(`${CDN}0000.wrpl`, true), null)
  // http не отсекаем: формат ссылок CDN задаёт API, защиту дают проверки хоста.
  assert.equal(replayUrlProblem('http://replays.cdn.example.net/x/0000.wrpl', true), null)
  const rejected: [string, RegExp][] = [
    ['ftp://replays.cdn.example.net/x/0000.wrpl', /протокол ftp:/],
    ['https://127.0.0.1/x/0000.wrpl', /IP-адрес/],
    ['https://2130706433/x/0000.wrpl', /IP-адрес/],
    ['https://[::1]/x/0000.wrpl', /IP-адрес/],
    ['https://localhost/x/0000.wrpl', /локальный хост/],
    ['https://metadata/x/0000.wrpl', /локальный хост/],
    ['https://cdn.internal/x/0000.wrpl', /локальный хост/],
    ['https://user:pass@replays.cdn.example.net/x/0000.wrpl', /учётные данные/],
    ['https://replays.cdn.example.net:8443/x/0000.wrpl', /порт 8443/],
    ['https://replays.cdn.example.net/x/secret.json', /часть \.wrpl/],
    ['file:///etc/passwd', /протокол file:/],
  ]
  for (const [url, reason] of rejected) {
    assert.match(replayUrlProblem(url, true) ?? '', reason, url)
  }
}))

test('WT_REPLAY_HOSTS ограничивает хосты CDN только при скачивании', withPolicy({ allowedHosts: ['cdn.example.net'] }, () => {
  assert.equal(replayUrlProblem(`${CDN}0000.wrpl`, true), null)
  assert.equal(replayUrlProblem('https://cdn.example.net/a/0001.wrpl', true), null)
  assert.match(replayUrlProblem('https://evil.example.org/a/0000.wrpl', true) ?? '', /WT_REPLAY_HOSTS/)
  assert.match(replayUrlProblem('https://notcdn.example.net.evil.org/a/0000.wrpl', true) ?? '', /WT_REPLAY_HOSTS/)
  // Ошибка в allowlist не должна давать терминальный no_parts при разборе item.
  assert.equal(
    resolveReplayPartUrls({ url: 'https://other.example.org/06fea91100096f5a/', partsCount: 0 }).problem,
    null,
  )
}))

test('ссылки на части: предел числа частей и форма шаблона', withPolicy({}, () => {
  assert.deepEqual(resolveReplayPartUrls({ url: CDN, partsCount: 1 }), {
    urls: [`${CDN}0000.wrpl`, `${CDN}0001.wrpl`],
    problem: null,
  })
  for (const partsCount of [1.5, -1, Number.NaN, MAX_REPLAY_PARTS, 1_000_000]) {
    const resolution = resolveReplayPartUrls({ url: CDN, partsCount })
    assert.deepEqual(resolution.urls, [], String(partsCount))
    assert.match(resolution.problem ?? '', /число частей/)
  }
  assert.match(
    resolveReplayPartUrls({ url: 'https://127.0.0.1/06fea91100096f5a/', partsCount: 0 }).problem ?? '',
    /IP-адрес/,
  )
  assert.match(resolveReplayPartUrls({ url: `${CDN}?x=1`, partsCount: 0 }).problem ?? '', /без query/)
  const tooMany = Array.from({ length: MAX_REPLAY_PARTS + 1 }, (_, i) => `${CDN}${String(i).padStart(4, '0')}.wrpl`)
  assert.match(resolveReplayPartUrls({ replayParts: tooMany }).problem ?? '', /больше предела/)
  // Некорректный явный список не мешает корректному шаблону url + partsCount.
  assert.deepEqual(
    resolveReplayPartUrls({ replayParts: ['https://localhost/a/0000.wrpl'], url: CDN, partsCount: 0 }).urls,
    [`${CDN}0000.wrpl`],
  )
}))

test('перенаправление части проверяется той же политикой', withPolicy(
  { allowInsecureForTests: true, allowedHosts: ['127.0.0.1'] },
  async () => {
    const server = createServer((request, response) => {
      if (request.url === '/redirect-out/0000.wrpl') {
        response.writeHead(302, { location: 'http://localhost:9/0000.wrpl' }).end()
        return
      }
      if (request.url === '/redirect-in/0000.wrpl') {
        response.writeHead(302, { location: '/final/0000.wrpl' }).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const base = `http://127.0.0.1:${address.port}`
      await assert.rejects(
        fetchReplayUrl(`${base}/redirect-out/0000.wrpl`, AbortSignal.timeout(5_000)),
        /перенаправление части WRPL отклонено/,
      )
      const response = await fetchReplayUrl(`${base}/redirect-in/0000.wrpl`, AbortSignal.timeout(5_000))
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'ok')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
))
