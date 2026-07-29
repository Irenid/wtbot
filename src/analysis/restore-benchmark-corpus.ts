import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetchReplayPart } from '../wrpl/replay-cache.js'
import { normalizeSessionId, replayPartUrls } from '../wrpl/replay.js'

interface CorpusFile {
  name: string
  bytes: number
  sha256: string
}

interface CorpusCase {
  id: string
  directory: string
  files: CorpusFile[]
}

interface CorpusManifest {
  schemaVersion: number
  hashAlgorithm: string
  cases: CorpusCase[]
}

interface ReplayItemData {
  replayParts?: string[] | null
  url?: string
  partsCount?: number
}

type RestoreSource = 'existing' | 'runtime-cache' | 'cdn'

const manifestPath = path.resolve(process.argv[2] ?? 'benchmarks/replay-corpus.json')
const databasePath = path.resolve(process.argv[3] ?? 'data/wtbot.db')
const fixtureRoot = path.resolve('benchmarks/fixtures/replays')
const runtimeCacheRoot = path.resolve('data/replays')

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[corpus:restore] ${redactUrls(message)}`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CorpusManifest
  assert.equal(manifest.schemaVersion, 1, 'Неподдерживаемая версия corpus manifest')
  assert.equal(manifest.hashAlgorithm, 'sha256', 'Corpus должен использовать SHA-256')

  let database: DatabaseSync | null = null
  const totals: Record<RestoreSource, number> = {
    existing: 0,
    'runtime-cache': 0,
    cdn: 0,
  }

  try {
    for (const corpusCase of manifest.cases) {
      const directory = path.resolve(corpusCase.directory)
      assert.ok(
        isPathInside(fixtureRoot, directory),
        `${corpusCase.id}: fixture directory вне benchmarks/fixtures/replays`,
      )
      const sessionId = path.basename(directory)
      assert.match(sessionId, /^[0-9a-f]{16}$/i, `${corpusCase.id}: некорректный session id`)
      await mkdir(directory, { recursive: true })

      let urlsByName: Map<string, string> | null = null
      for (const expectedFile of corpusCase.files) {
        assert.equal(
          path.basename(expectedFile.name),
          expectedFile.name,
          `${corpusCase.id}: имя fixture содержит путь`,
        )
        const target = path.join(directory, expectedFile.name)
        assert.ok(isPathInside(fixtureRoot, target), `${corpusCase.id}: target вне fixture root`)
        if (await isExpectedFile(target, expectedFile)) {
          totals.existing += 1
          continue
        }

        const runtimeCacheFile = path.join(runtimeCacheRoot, sessionId, expectedFile.name)
        let source: RestoreSource = 'runtime-cache'
        let data = await readExpectedFile(runtimeCacheFile, expectedFile)
        if (!data) {
          source = 'cdn'
          if (!urlsByName) {
            database ??= new DatabaseSync(databasePath, { readOnly: true })
            urlsByName = replayUrlsByName(database, sessionId)
          }
          const url = urlsByName.get(expectedFile.name.toLowerCase())
          assert.ok(url, `${corpusCase.id}/${expectedFile.name}: URL части отсутствует в item`)
          data = await fetchReplayPart(url, { cacheDirectory: null })
          assertExpectedData(data, expectedFile, `${corpusCase.id}/${expectedFile.name}`)
        }

        await writeAtomic(target, data)
        totals[source] += 1
        console.log(`[corpus:restore] ${corpusCase.id}/${expectedFile.name}: ${source}`)
      }
    }
  } finally {
    database?.close()
  }

  console.log(
    `[corpus:restore] готово: existing=${totals.existing}, ` +
      `runtime-cache=${totals['runtime-cache']}, cdn=${totals.cdn}`,
  )
}

function replayUrlsByName(database: DatabaseSync, sessionId: string): Map<string, string> {
  const externalId = normalizeSessionId(sessionId)
  const row = database
    .prepare('SELECT data FROM items WHERE source = ? AND external_id = ?')
    .get('wt-replays', externalId) as { data: string } | undefined
  assert.ok(row, `${sessionId}: item wt-replays не найден в SQLite`)
  const data = JSON.parse(row.data) as unknown
  assert.ok(data && typeof data === 'object', `${sessionId}: item data не является объектом`)
  const urls = replayPartUrls(data as ReplayItemData)
  assert.ok(urls.length > 0, `${sessionId}: item не содержит replay parts`)

  const result = new Map<string, string>()
  for (const url of urls) {
    const name = replayFileName(url)
    if (name) result.set(name.toLowerCase(), url)
  }
  return result
}

function replayFileName(rawUrl: string): string | null {
  try {
    return path.posix.basename(decodeURIComponent(new URL(rawUrl).pathname))
  } catch {
    return null
  }
}

async function isExpectedFile(file: string, expected: CorpusFile): Promise<boolean> {
  return (await readExpectedFile(file, expected)) !== null
}

async function readExpectedFile(file: string, expected: CorpusFile): Promise<Buffer | null> {
  let data: Buffer
  try {
    data = await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return hasExpectedData(data, expected) ? data : null
}

function assertExpectedData(data: Buffer, expected: CorpusFile, label: string): void {
  assert.equal(data.byteLength, expected.bytes, `${label}: неожиданный размер`)
  assert.equal(sha256(data), expected.sha256, `${label}: неожиданный SHA-256`)
}

function hasExpectedData(data: Buffer, expected: CorpusFile): boolean {
  return data.byteLength === expected.bytes && sha256(data) === expected.sha256
}

async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, data, { flag: 'wx' })
  try {
    await rm(target, { force: true })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function redactUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, '<redacted-url>')
}
