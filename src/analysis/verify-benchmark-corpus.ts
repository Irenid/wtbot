import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  CpuWorkerPool,
  transferableCopy,
} from '../workers/pool.js'
import type { ParsedBattleResult } from '../workers/protocol.js'
import { readCachedEcsHashesJson } from '../wrpl/ecs.js'
import { inflateEventsBlob } from '../wrpl/events-codec.js'

interface CorpusFile {
  name: string
  bytes: number
  sha256: string
}

interface SuccessExpectation {
  outcome: 'success'
  sessionIdHex: string
  inputBytes: number
  /** Размер и хэш JSON событий, а не сжатого блоба: эталон не зависит от кодека. */
  eventsJsonBytes: number
  eventsJsonSha256: string
  players: number
  kills: number
  chatCount: number
  trajectories: number
  airTrajectories: number
}

interface ErrorExpectation {
  outcome: 'error'
  errorIncludes: string
}

interface CorpusCase {
  id: string
  category: string
  directory: string
  files: CorpusFile[]
  expected: SuccessExpectation | ErrorExpectation
}

interface CorpusManifest {
  schemaVersion: number
  hashAlgorithm: string
  cases: CorpusCase[]
}

const manifestPath = path.resolve(process.argv[2] ?? 'benchmarks/replay-corpus.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CorpusManifest
const runtimeReplayCacheRoot = path.resolve('data/replays')
assert.equal(manifest.schemaVersion, 1, 'Неподдерживаемая версия corpus manifest')
assert.equal(manifest.hashAlgorithm, 'sha256', 'Corpus должен использовать SHA-256')
assert.ok(manifest.cases.length > 0, 'Corpus manifest пуст')

const ecsHashesJson = await readCachedEcsHashesJson()
const pool = new CpuWorkerPool({ size: 1 })
const started = performance.now()
try {
  for (const corpusCase of manifest.cases) {
    await verifyCase(pool, corpusCase, ecsHashesJson)
  }
} finally {
  await pool.close()
}
console.log(
  `[corpus] проверено ${manifest.cases.length} сценария за ` +
    `${(performance.now() - started).toFixed(1)} мс`,
)

async function verifyCase(
  pool: CpuWorkerPool,
  corpusCase: CorpusCase,
  ecsHashesJson: string,
): Promise<void> {
  assert.ok(corpusCase.id.length > 0, 'У corpus case нет id')
  assert.ok(corpusCase.files.length > 0, `${corpusCase.id}: нет replay-файлов`)
  const directory = path.resolve(corpusCase.directory)
  assert.equal(
    isPathInside(runtimeReplayCacheRoot, directory),
    false,
    `${corpusCase.id}: fixed corpus нельзя хранить в очищаемом data/replays`,
  )
  const actualNames = (await readdir(directory))
    .filter((name) => /\.wrpl$/i.test(name))
    .sort()
  const expectedNames = corpusCase.files.map((file) => file.name)
  assert.deepEqual(actualNames, expectedNames, `${corpusCase.id}: состав replay-файлов изменился`)

  const sourceBuffers: Buffer[] = []
  let inputBytes = 0
  for (const expectedFile of corpusCase.files) {
    const file = await readFile(path.join(directory, expectedFile.name))
    assert.equal(file.byteLength, expectedFile.bytes, `${corpusCase.id}/${expectedFile.name}: размер`)
    assert.equal(sha256(file), expectedFile.sha256, `${corpusCase.id}/${expectedFile.name}: SHA-256`)
    inputBytes += file.byteLength
    sourceBuffers.push(file)
  }

  const parts = sourceBuffers.map(transferableCopy)
  try {
    const parsed = await pool.run(
      {
        kind: 'parse-battle',
        input: {
          parts,
          realNames: [],
          meta: {},
          ecsHashesJson,
        },
      },
      {
        priority: 'background',
        transferList: parts,
        timeoutMs: 180_000,
      },
    )
    assert.equal(
      corpusCase.expected.outcome,
      'success',
      `${corpusCase.id}: ожидалась ошибка, но replay разобран`,
    )
    assert.equal(
      parsed.battle.airUnitCount,
      corpusCase.expected.airTrajectories,
      `${corpusCase.id}: persisted air_unit_count`,
    )
    assert.equal(
      parsed.battle.chatCount,
      corpusCase.expected.chatCount,
      `${corpusCase.id}: persisted chat_count`,
    )
    assert.deepEqual(
      successDescriptor(parsed, inputBytes),
      corpusCase.expected,
      `${corpusCase.id}: нормализованный результат изменился`,
    )
    console.log(
      `[corpus] ${corpusCase.id} (${corpusCase.category}): ok · ` +
        `${formatMiB(inputBytes)} · ${parsed.summary.units} trajectories`,
    )
  } catch (error) {
    if (corpusCase.expected.outcome !== 'error') throw error
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(
      message.includes(corpusCase.expected.errorIncludes),
      `${corpusCase.id}: неожиданная ошибка: ${message}`,
    )
    console.log(`[corpus] ${corpusCase.id} (${corpusCase.category}): expected error · ${message}`)
  }
}

function successDescriptor(parsed: ParsedBattleResult, inputBytes: number): SuccessExpectation {
  const json = inflateEventsBlob(new Uint8Array(parsed.battle.eventsBlob))
  return {
    outcome: 'success',
    sessionIdHex: parsed.header.sessionIdHex,
    inputBytes,
    eventsJsonBytes: json.byteLength,
    eventsJsonSha256: sha256(json),
    players: parsed.results.players.length,
    kills: parsed.summary.kills,
    chatCount: parsed.summary.chat,
    trajectories: parsed.summary.units,
    airTrajectories: parsed.summary.airUnits,
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} МиБ`
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
