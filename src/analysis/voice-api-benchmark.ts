import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  closeDb,
  getCommandStats,
  getIngestStats,
  getItemStats,
  getVoiceDashboardRows,
  getPlayerBattleStats,
  getPlayerRating,
  getVoicePresence,
  initDb,
  recordCommandUse,
  saveBattle,
  saveClanRatingSnapshots,
  saveItems,
  syncVoicePresence,
  type BattleInput,
  type VoicePresenceEntry,
} from '../db/index.js'
import { buildServer } from '../web/index.js'
import { decorateTag } from '../wrpl/render-battle.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'

const DEFAULT_RUNS = 100
const WARMUP_RUNS = 10
const ROW_COUNTS = [0, 10, 50, 200] as const

interface TimingSummary {
  p50Ms: number
  p95Ms: number
  meanMs: number
}

interface BenchmarkResult {
  rows: number
  batched: TimingSummary
  nPlusOne: TimingSummary
  p95Speedup: number | null
}

function cliNumber(prefix: string, fallback: number): number {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${prefix}<N> должен быть целым числом от 1 до 10000`)
  }
  return value
}

function percentile(sorted: number[], value: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0
}

function round(value: number, digits = 3): number {
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

function summarize(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  }
}

function player(index: number) {
  const nick = `benchmark-player-${index}`
  return {
    userId: `user-${index}`,
    nick: index % 4 === 0 ? `${nick}@live` : nick,
    clanTag: 'BENCH',
    team: (index % 2) + 1,
    kills: 0,
    groundKills: 0,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 0,
    deaths: 0,
    captureZone: 0,
    damageZone: 0,
    score: index,
    awardDamage: 0,
    teamKills: 0,
    squadId: -1,
    vehicle: null,
    vehicles: [],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

function battle(session: number, rows: number): BattleInput {
  return {
    sessionId: `benchmark-session-${session}`,
    sessionHex: `benchmark-${session}`,
    missionName: 'benchmark',
    level: 'benchmark',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime: 1_700_000_000 + session,
    durationSec: 0,
    endTimeMs: 0,
    teamWon: 0,
    gameVersion: null,
    missionSettings: null,
    players: Array.from({ length: rows }, (_, index) => player(index)),
    kills: [],
    chat: [],
    eventsBlob: Buffer.alloc(0),
  }
}

function seed(rows: number): void {
  const voice: VoicePresenceEntry[] = Array.from({ length: rows }, (_, index) => ({
    guildId: 'benchmark-guild',
    guildName: 'Benchmark',
    channelId: `channel-${Math.floor(index / 10)}`,
    channelName: `Канал ${Math.floor(index / 10)}`,
    userId: `user-${index}`,
    displayName: `Игрок ${index}`,
    wtNick: `benchmark-player-${index}`,
  }))
  const firstSync = syncVoicePresence(voice)
  assert.equal(firstSync.updated, rows)
  const repeatedSync = syncVoicePresence(voice)
  assert.deepEqual(repeatedSync, { updated: 0, removed: 0, unchanged: rows })

  const firstRatings = voice.map((entry, index) => ({
    nick: index % 3 === 0 ? `${entry.wtNick}@psn` : entry.wtNick,
    rating: 1_000 + index,
  }))
  const lastRatings = firstRatings.map((entry) => ({ ...entry, rating: entry.rating + 1 }))
  saveClanRatingSnapshots('BENCH', firstRatings)
  saveClanRatingSnapshots('BENCH', lastRatings)

  for (let session = 0; session < 3; session += 1) saveBattle(battle(session, rows))
}

function verifyLegacyMigration(): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtbot-voice-benchmark-'))
  const dbPath = path.join(directory, 'legacy.db')
  try {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE clan_rating_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_tag TEXT NOT NULL,
        nick TEXT NOT NULL,
        rating INTEGER NOT NULL,
        seen_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO clan_rating_snapshots (clan_tag, nick, rating) VALUES ('BENCH', 'legacy-player@psn', 1234);

      CREATE TABLE voice_presence (
        guild_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        wt_nick TEXT NOT NULL,
        joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (guild_id, user_id)
      );
      INSERT INTO voice_presence
        (guild_id, guild_name, channel_id, channel_name, user_id, display_name, wt_nick)
      VALUES ('guild', 'Guild', 'channel', 'Channel', 'user', 'Legacy', 'legacy-player');

      CREATE TABLE battles (session_id TEXT PRIMARY KEY, start_time INTEGER NOT NULL);
      INSERT INTO battles (session_id, start_time) VALUES ('legacy-session', 1700000000);
      CREATE TABLE battle_players (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nick TEXT NOT NULL,
        clan_tag TEXT NOT NULL DEFAULT '',
        team INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
      INSERT INTO battle_players (session_id, user_id, nick, clan_tag, team)
      VALUES ('legacy-session', 'user', 'legacy-player@live', 'BENCH', 1);
    `)
    legacy.close()

    initDb(dbPath)
    const [row] = getVoiceDashboardRows()
    assert.equal(row?.wtNickBase, 'legacy-player')
    assert.equal(row?.rating, 1234)
    assert.equal(row?.battles, 1)
    closeDb()
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
}

function verifyStatsCaches(): void {
  initDb(':memory:')
  try {
    const emptyCommands = getCommandStats()
    assert.equal(getCommandStats(), emptyCommands)
    recordCommandUse('benchmark', null, 'benchmark-user')
    const commands = getCommandStats()
    assert.notEqual(commands, emptyCommands)
    assert.equal(commands.total, 1)

    const emptyItems = getItemStats()
    const emptyIngest = getIngestStats()
    const item = { externalId: 'benchmark-item', title: 'Benchmark', data: { ok: true } }
    assert.equal(saveItems('wt-replays', [item]).changed, 1)
    const items = getItemStats()
    const ingest = getIngestStats()
    assert.notEqual(items, emptyItems)
    assert.notEqual(ingest, emptyIngest)
    assert.equal(items.total, 1)
    assert.equal(ingest.pending, 1)
    assert.equal(saveItems('wt-replays', [item]).changed, 0)
    assert.equal(getItemStats(), items)
    assert.equal(getIngestStats(), ingest)
  } finally {
    closeDb()
  }
}

function legacyVoicePayload() {
  const channels = new Map<
    string,
    {
      guildName: string
      channelName: string
      players: {
        displayName: string
        wtNick: string
        joinedAt: number
        clanTag: string | null
        rating: number | null
        delta: number | null
        battles: number
        lastBattleAt: number | null
      }[]
    }
  >()
  for (const row of getVoicePresence()) {
    const key = `${row.guildId}/${row.channelId}`
    let channel = channels.get(key)
    if (!channel) {
      channel = { guildName: row.guildName, channelName: row.channelName, players: [] }
      channels.set(key, channel)
    }
    const rating = getPlayerRating(row.wtNick)
    const battleStats = getPlayerBattleStats(row.wtNick)
    channel.players.push({
      displayName: row.displayName,
      wtNick: row.wtNick,
      joinedAt: row.joinedAt,
      clanTag: rating ? decorateTag(rating.clanTag) : null,
      rating: rating?.rating ?? null,
      delta: rating?.delta ?? null,
      battles: battleStats.battles,
      lastBattleAt: battleStats.lastBattleAt,
    })
  }
  return { channels: [...channels.values()] }
}

async function measure(url: string, runs: number): Promise<TimingSummary> {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 200)
  }

  const samples: number[] = []
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    const response = await app.inject({ method: 'GET', url })
    samples.push(performance.now() - started)
    assert.equal(response.statusCode, 200)
  }
  return summarize(samples)
}

const runs = cliNumber('--runs=', DEFAULT_RUNS)
verifyLegacyMigration()
verifyStatsCaches()
let refreshCalls = 0
const app = buildServer({
  getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
  refreshVoice: async () => {
    refreshCalls += 1
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    return { players: 0, clans: 0 }
  },
  playerStats: new PlayerStatsCoordinator({ externalService: null }),
})
app.get('/benchmark/voice-n-plus-one', async () => legacyVoicePayload())

const results: BenchmarkResult[] = []
try {
  await app.ready()
  const concurrentRefreshes = await Promise.all([
    app.inject({ method: 'POST', url: '/api/voice/refresh' }),
    app.inject({ method: 'POST', url: '/api/voice/refresh' }),
  ])
  assert.deepEqual(concurrentRefreshes.map((response) => response.statusCode), [200, 200])
  assert.equal(refreshCalls, 1)
  const rateLimitedRefresh = await app.inject({ method: 'POST', url: '/api/voice/refresh' })
  assert.equal(rateLimitedRefresh.statusCode, 429)

  for (const rows of ROW_COUNTS) {
    closeDb()
    initDb(':memory:')
    seed(rows)

    const batchedResponse = await app.inject({ method: 'GET', url: '/api/voice' })
    const legacyResponse = await app.inject({ method: 'GET', url: '/benchmark/voice-n-plus-one' })
    assert.deepEqual(batchedResponse.json(), legacyResponse.json())

    const batched = await measure('/api/voice', runs)
    const nPlusOne = await measure('/benchmark/voice-n-plus-one', runs)
    results.push({
      rows,
      batched,
      nPlusOne,
      p95Speedup: batched.p95Ms > 0 ? round(nPlusOne.p95Ms / batched.p95Ms, 2) : null,
    })
  }
} finally {
  await app.close()
  closeDb()
}

console.table(
  results.map((result) => ({
    rows: result.rows,
    'batch p50, ms': result.batched.p50Ms,
    'batch p95, ms': result.batched.p95Ms,
    'N+1 p50, ms': result.nPlusOne.p50Ms,
    'N+1 p95, ms': result.nPlusOne.p95Ms,
    'p95 speedup': result.p95Speedup,
  })),
)
console.log(JSON.stringify({ runs, warmupRuns: WARMUP_RUNS, results }, null, 2))
