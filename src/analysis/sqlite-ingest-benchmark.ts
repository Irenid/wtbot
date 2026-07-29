import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BattleInput } from '../db/index.js'
import { closeDb, initDb } from '../db/index.js'
import { closeWorkerPool, runWorkerTask, transferableBuffer } from '../workers/pool.js'

const args = process.argv.slice(2)
const runs = integerOption('--runs=', 20, 5, 1_000)
const warmupRuns = integerOption('--warmup=', 5, 1, 100)
const jsonOption = args.find((arg) => arg.startsWith('--json='))
const jsonPath = jsonOption ? path.resolve(jsonOption.slice('--json='.length)) : null
const directory = await mkdtemp(path.join(tmpdir(), 'wtbot-sqlite-ingest-benchmark-'))
const dbPath = path.join(directory, 'wtbot.db')
const eventsBlobTemplate = randomBytes(128 * 1024)
const timings: number[] = []

try {
  initDb(dbPath, { allowCreate: true })
  closeDb()

  for (let index = 0; index < warmupRuns + runs; index += 1) {
    const sessionId = `sqlite-benchmark-${String(index).padStart(6, '0')}`
    const eventsBlob = transferableBuffer(Buffer.from(eventsBlobTemplate))
    const result = await runWorkerTask(
      {
        kind: 'persist-ingested-battle',
        input: {
          dbPath,
          sessionId,
          battle: {
            ...battleInput(sessionId, index),
            eventsBlob,
          },
        },
      },
      {
        priority: 'normal',
        transferList: [eventsBlob],
        timeoutMs: 60_000,
      },
    )
    if (index >= warmupRuns) timings.push(result.sqliteMs)
  }
  await closeWorkerPool()

  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM battles').get() as { count: number }
    assert.equal(row.count, warmupRuns + runs)
    const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string }
    assert.equal(quickCheck.quick_check, 'ok')
  } finally {
    database.close()
  }

  const sorted = timings.slice().sort((left, right) => left - right)
  const result = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    configuration: {
      warmupRuns,
      measuredRuns: runs,
      eventsBlobBytes: eventsBlobTemplate.byteLength,
      playersPerBattle: 16,
      killsPerBattle: 14,
    },
    sqliteMs: {
      min: sorted[0]!,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1)!,
      mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      values: timings,
    },
  }
  console.log(
    `[sqlite-ingest:bench] ${runs} боёв · p50/p95 ` +
      `${result.sqliteMs.p50.toFixed(1)}/${result.sqliteMs.p95.toFixed(1)} мс · ` +
      `max ${result.sqliteMs.max.toFixed(1)} мс`,
  )
  if (jsonPath) {
    await mkdir(path.dirname(jsonPath), { recursive: true })
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(`[sqlite-ingest:bench] JSON: ${jsonPath}`)
  }
} finally {
  closeDb()
  await closeWorkerPool().catch(() => undefined)
  await removeTemporaryDirectory(directory)
}

function battleInput(sessionId: string, index: number): Omit<BattleInput, 'eventsBlob'> {
  return {
    sessionId,
    sessionHex: (index + 1).toString(16).padStart(16, '0'),
    missionName: 'SQLite ingest benchmark',
    level: 'levels/benchmark.bin',
    gameMode: 'realistic',
    battleType: 'Domination',
    environment: 'day',
    status: 'ok',
    startTime: 1_700_000_000 + index,
    durationSec: 600,
    endTimeMs: 600_000,
    teamWon: index % 2 + 1,
    gameVersion: 'benchmark',
    missionSettings: null,
    players: Array.from({ length: 16 }, (_, playerIndex) => ({
      userId: `${index + 1}${String(playerIndex).padStart(3, '0')}`,
      nick: `Benchmark_${playerIndex}`,
      clanTag: playerIndex % 2 === 0 ? 'A' : 'B',
      team: playerIndex % 2 + 1,
      kills: playerIndex % 4,
      groundKills: playerIndex % 4,
      navalKills: 0,
      aiKills: 0,
      aiGroundKills: 0,
      assists: playerIndex % 3,
      deaths: 1,
      captureZone: 0,
      damageZone: 0,
      score: 1_000 + playerIndex,
      awardDamage: 0,
      teamKills: 0,
      squadId: 0,
      vehicle: 'benchmark_tank',
      vehicles: ['benchmark_tank'],
      disconnected: false,
      slot: playerIndex,
      title: null,
      autoSquad: null,
    })),
    kills: Array.from({ length: 14 }, (_, killIndex) => ({
      timeMs: killIndex * 10_000,
      killerId: `${index + 1}${String(killIndex % 16).padStart(3, '0')}`,
      killerModel: 'benchmark_tank',
      victimId: `${index + 1}${String((killIndex + 1) % 16).padStart(3, '0')}`,
      victimModel: 'benchmark_tank',
      weapon: 'benchmark_cannon',
      killerPos: { x: killIndex, y: 0, z: killIndex },
      victimPos: { x: -killIndex, y: 0, z: -killIndex },
    })),
    chat: [],
    airUnitCount: 0,
    chatCount: 0,
  }
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!
}

function integerOption(prefix: string, fallback: number, min: number, max: number): number {
  const option = args.find((arg) => arg.startsWith(prefix))
  if (!option) return fallback
  const value = Number(option.slice(prefix.length))
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} должен быть целым от ${min} до ${max}`)
  }
  return value
}

async function removeTemporaryDirectory(target: string): Promise<void> {
  const resolved = path.resolve(target)
  const parent = path.resolve(tmpdir()) + path.sep
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('wtbot-sqlite-ingest-benchmark-')) {
    throw new Error(`отказ удаления неожиданного benchmark path: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
