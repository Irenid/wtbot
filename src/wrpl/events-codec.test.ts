import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { compressEventsJson, inflateEventsBlob, isGzipEventsBlob, isZstdEventsBlob } from './events-codec.js'

const json = Buffer.from(JSON.stringify({ teamWon: 1, kills: [{ time: 1 }], units: [] }), 'utf8')

test('новые блобы событий — zstd и распаковываются обратно', () => {
  const blob = compressEventsJson(json)
  assert.ok(isZstdEventsBlob(blob))
  assert.ok(!isGzipEventsBlob(blob))
  assert.deepEqual(inflateEventsBlob(blob), json)
})

test('старые gzip-блобы читаются, в том числе из Uint8Array со смещением', () => {
  const gzip = gzipSync(json)
  assert.ok(isGzipEventsBlob(gzip))
  const padded = new Uint8Array(gzip.byteLength + 3)
  padded.set(gzip, 3)
  assert.deepEqual(inflateEventsBlob(padded.subarray(3)), json)
})

test('незнакомый формат блоба — ошибка, а не пустые события', () => {
  assert.throws(() => inflateEventsBlob(new Uint8Array([1, 2, 3, 4])), /Неизвестный формат events_blob/)
  assert.throws(() => inflateEventsBlob(new Uint8Array()), /Неизвестный формат events_blob/)
})
