import assert from 'node:assert/strict'
import test from 'node:test'
import { constants, gzipSync, zstdCompressSync } from 'node:zlib'
import {
  compressEventsJson,
  decodeEventsPayload,
  encodeEventsJson,
  inflateEventsBlob,
  isColumnarEventsBlob,
  isGzipEventsBlob,
  isZstdEventsBlob,
} from './events-codec.js'

/** Траектория как у разбора: целые t, x, y, z; постройка — одна точка подряд. */
function path(length: number, start: number, step: number) {
  return Array.from({ length }, (_, index) => ({
    t: 1_000 + index * 1_000,
    x: start + index * step,
    y: 100 - (index % 7),
    z: -start - index * 3,
  }))
}

const events = {
  teamWon: 1,
  players: [{ slot: 0, userId: '1', name: 'Pilot', clanTag: '╔TST╕', title: 'title_x', team: 1 }],
  kills: [{ time: 1, killerPos: { t: 1, x: 2, y: 3, z: 4 } }],
  damage: [],
  chat: [],
  units: [
    { userId: '1', model: 'tankModels/us_m1', source: 'ground', path: path(300, 5_000, 4) },
    { userId: '', model: 'structures/radar', source: 'ground', path: Array.from({ length: 90 }, (_, i) => ({ t: i * 500, x: 938, y: 102, z: -13434 })) },
    { userId: '2', model: 'f_16', source: 'air', path: path(500, -20_000, 160) },
  ],
  zones: [],
  endTime: 600_000,
}

test('новые блобы с траекториями — колоночный формат, восстановление байт в байт', () => {
  const json = JSON.stringify(events)
  const blob = encodeEventsJson(json)
  assert.ok(isColumnarEventsBlob(blob))
  assert.ok(!isZstdEventsBlob(blob) && !isGzipEventsBlob(blob), 'старый код блоб не примет за zstd или gzip')
  assert.equal(inflateEventsBlob(blob).toString('utf8'), json)
  assert.deepEqual(decodeEventsPayload(blob), events)
  assert.ok(blob.byteLength < compressEventsJson(Buffer.from(json, 'utf8')).byteLength, 'колонки меньше zstd-JSON')
  const padded = new Uint8Array(blob.byteLength + 5)
  padded.set(blob, 5)
  assert.equal(inflateEventsBlob(padded.subarray(5)).toString('utf8'), json, 'Uint8Array со смещением')
})

test('неподходящие траектории остаются как были, подходящие — колонками', () => {
  const mixed = {
    teamWon: 0,
    units: [
      { model: 'a', path: path(50, 10, 3) },
      { model: 'дробные', path: [{ t: 1, x: 0.5, y: 2, z: 3 }, { t: 2, x: 1.25, y: 2, z: 3 }] },
      { model: 'лишний ключ', path: [{ t: 1, x: 1, y: 2, z: 3, speed: 4 }] },
      { model: 'другой порядок', path: [{ x: 1, t: 1, y: 2, z: 3 }] },
      { model: 'огромные', path: [{ t: 1, x: 2 ** 41, y: 2, z: 3 }] },
      { model: 'пусто', path: [] },
      { model: 'без траектории' },
      { model: 'null', path: null },
      'не объект',
    ],
  }
  const json = JSON.stringify(mixed)
  const blob = encodeEventsJson(json)
  assert.ok(isColumnarEventsBlob(blob))
  assert.equal(inflateEventsBlob(blob).toString('utf8'), json)
  assert.deepEqual(decodeEventsPayload(blob), mixed)
})

test('без подходящих траекторий и на необычном входе пишется zstd-JSON того же текста', () => {
  for (const json of [
    JSON.stringify({ teamWon: 1, kills: [{ time: 1 }], units: [] }),
    JSON.stringify({ teamWon: 1 }),
    JSON.stringify([1, 2, 3]),
    // Путь-объект в исходных данных выглядел бы как колонки — проверка
    // байт в байт отправляет такой бой в zstd-JSON.
    JSON.stringify({ units: [{ path: { t: [1], x: [1], y: [1], z: [1] } }, { path: path(3, 1, 1) }] }),
    'не JSON',
  ]) {
    const blob = encodeEventsJson(json)
    assert.ok(isZstdEventsBlob(blob), json)
    assert.equal(inflateEventsBlob(blob).toString('utf8'), json)
  }
})

test('zstd-JSON и gzip прежних версий читаются', () => {
  const json = Buffer.from(JSON.stringify(events), 'utf8')
  for (const blob of [compressEventsJson(json), gzipSync(json)]) {
    assert.deepEqual(inflateEventsBlob(blob), json)
    assert.deepEqual(decodeEventsPayload(blob), events)
  }
  const gzip = gzipSync(json)
  const padded = new Uint8Array(gzip.byteLength + 3)
  padded.set(gzip, 3)
  assert.deepEqual(inflateEventsBlob(padded.subarray(3)), json)
})

test('незнакомый формат блоба — ошибка, а не пустые события', () => {
  assert.throws(() => inflateEventsBlob(new Uint8Array([1, 2, 3, 4])), /Неизвестный формат events_blob/)
  assert.throws(() => inflateEventsBlob(new Uint8Array()), /Неизвестный формат events_blob/)
  assert.throws(() => decodeEventsPayload(Buffer.from('WTEV')), /Неизвестный формат events_blob/, 'один заголовок без данных')
})

test('повреждённый колоночный блоб — ошибка, а не искажённые траектории', () => {
  const header = Buffer.from([0x57, 0x54, 0x45, 0x56, 0x01])
  const columnar = (document: unknown) => Buffer.concat([
    header,
    zstdCompressSync(Buffer.from(JSON.stringify(document), 'utf8'), {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    }),
  ])
  const cases: [unknown, RegExp][] = [
    [{ teamWon: 1 }, /нет массива units/],
    [{ units: [{ path: { t: [1], x: [1], y: [1] } }] }, /не массивы/],
    [{ units: [{ path: { t: [1, 2], x: [1], y: [1], z: [1] } }] }, /разной длины/],
    [{ units: [{ path: { t: [], x: [], y: [], z: [] } }] }, /разной длины/],
    [{ units: [{ path: { t: [1, null], x: [1, 1], y: [1, 1], z: [1, 1] } }] }, /не целое/],
    [{ units: [{ path: { t: [1, '2'], x: [1, 1], y: [1, 1], z: [1, 1] } }] }, /не целое/],
    [{ units: [{ path: { t: [0.5], x: [1], y: [1], z: [1] } }] }, /не целое/],
    [{ units: [{ path: { t: [2 ** 39, 2 ** 39], x: [1, 1], y: [1, 1], z: [1, 1] } }] }, /вне диапазона/],
  ]
  for (const [document, error] of cases) {
    assert.throws(() => decodeEventsPayload(columnar(document)), error, JSON.stringify(document))
  }
  assert.throws(() => decodeEventsPayload(Buffer.concat([header, Buffer.from('мусор')])))
})
