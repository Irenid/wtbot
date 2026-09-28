import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { EcsParser, ECS_CONSTRUCT_PREFIX_VERSION, type ComponentHashMaps } from './ecs.js'
import { extractReplayEvents, packetStreamCodec } from './replay-events.js'

const emptyMaps: ComponentHashMaps = {
  componentNames: new Map(),
  dataComponents: new Map(),
  componentParsers: new Map(),
  dataComponentParsers: new Map(),
} as unknown as ComponentHashMaps

/** Блок construct одной сущности по новому шаблону без компонентов. */
function constructBlock(prefix: number | null, templateId = 0x01): Buffer {
  const name = templateId === 0x01 ? 'test' : 'next'
  return Buffer.from([
    templateId,
    name.length, ...Buffer.from(name), // имя шаблона
    0x00, 0x00, // число компонентов шаблона
    ...(prefix === null ? [] : [prefix]), // байт формата 2.59
    0x00, // сколько компонентов пришло
  ])
}

/** Пакет типа 6 (0x24) с одной сущностью (EID 1). */
function constructPacket(prefix: number | null): Buffer {
  const block = constructBlock(prefix)
  return Buffer.from([0x24, 0x00, 0x05, 0x00, block.length, ...block])
}

/** Пакет с двумя сущностями: EID 1 и EID 2. */
function twoEntityPacket(first: Buffer, second: Buffer): Buffer {
  return Buffer.from([0x24, 0x01, 0x05, 0x00, first.length, ...first, 0x09, 0x00, second.length, ...second])
}

test('поток пакетов 2.59 распознаётся как zstd, прежние реплеи — как zlib', () => {
  assert.equal(packetStreamCodec(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])), 'zstd')
  assert.equal(packetStreamCodec(Buffer.from([0x78, 0x01, 0x00, 0x44])), 'zlib')
  assert.equal(packetStreamCodec(Buffer.from([0x28, 0xb5])), 'zlib')
})

test('construct ECS: байт формата читается только с версии 2.59 и должен быть нулевым', () => {
  const legacy = new EcsParser(emptyMaps)
  legacy.useReplayVersion(ECS_CONSTRUCT_PREFIX_VERSION - 1)
  legacy.parsePacket(constructPacket(null))
  assert.equal(legacy.mgr.entities.get(1)?.template, 'test')

  const current = new EcsParser(emptyMaps)
  current.useReplayVersion(ECS_CONSTRUCT_PREFIX_VERSION)
  current.parsePacket(constructPacket(0))
  assert.equal(current.mgr.entities.get(1)?.template, 'test')

  // Сбой одной сущности записывается, но не обрывает пакет: сущность
  // остаётся (без компонентов), следующая в том же пакете разбирается.
  const unknown = new EcsParser(emptyMaps)
  unknown.useReplayVersion(ECS_CONSTRUCT_PREFIX_VERSION)
  unknown.parsePacket(twoEntityPacket(constructBlock(1), constructBlock(0, 0x02)))
  assert.match(unknown.entityErrors[0] ?? '', /неизвестный байт формата 0x1/)
  assert.equal(unknown.mgr.entities.get(1)?.template, 'test')
  assert.equal(unknown.mgr.entities.get(2)?.template, 'next')
})

test('реплей, у которого не распаковалась ни одна часть, — ошибка, а не пустой бой', () => {
  const part = Buffer.from(readFileSync('benchmarks/fixtures/replays/06feb0d100099a2e/0002.wrpl'))
  // Портим начало сжатого потока: ни zlib, ни zstd.
  const headerSettings = part.readUInt16LE(748)
  part.fill(0x00, 1234 + headerSettings, 1234 + headerSettings + 8)
  assert.throws(() => extractReplayEvents([part], emptyMaps), /не распакован ни в одной части/)
})
