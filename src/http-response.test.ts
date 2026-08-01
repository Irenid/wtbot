import assert from 'node:assert/strict'
import test from 'node:test'
import { readResponseBuffer } from './http-response.js'

function responseOf(chunks: string[], headers: Record<string, string>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers })
}

test('readResponseBuffer пишет identity body прямо в буфер Content-Length', async () => {
  const response = responseOf(['ab', 'cde', 'f'], {
    'content-length': '6',
    'content-encoding': 'identity',
  })
  assert.equal((await readResponseBuffer(response, 16, 'fixture')).toString('utf8'), 'abcdef')
})

test('readResponseBuffer отвергает несовпадение с identity Content-Length', async () => {
  await assert.rejects(
    readResponseBuffer(responseOf(['abc'], { 'content-length': '4' }), 16, 'short'),
    /тело 3 байт не совпадает с Content-Length 4/,
  )
  await assert.rejects(
    readResponseBuffer(responseOf(['abcde'], { 'content-length': '4' }), 16, 'long'),
    /тело больше Content-Length 4/,
  )
})

test('readResponseBuffer сохраняет chunk fallback для encoded body', async () => {
  const response = responseOf(['abc', 'def'], {
    'content-length': '3',
    'content-encoding': 'gzip',
  })
  assert.equal((await readResponseBuffer(response, 16, 'encoded')).toString('utf8'), 'abcdef')
})

test('readResponseBuffer проверяет Content-Length до чтения body', async () => {
  await assert.rejects(
    readResponseBuffer(responseOf(['abc'], { 'content-length': '3' }), 2, 'large'),
    /Content-Length 3 больше лимита 2/,
  )
})
