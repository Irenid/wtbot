import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { PNG } from 'pngjs'
import { buildTacticalMap, buildTacticalMapSpec, composeTacticalMap, encodeMapImage } from '../tactical-map/build.js'
import { LABEL_FONT_FILE, type TacticalMapMeta } from '../tactical-map/spec.js'
import type { MapKind, Team } from '../tactical-map/model.js'
import { mergeSpawns } from '../tactical-map/render.js'
import { tacticalMapKeys } from '../wrpl/battle-assets.js'
import { findWarThunderGameDir } from '../wrpl/wt-fonts.js'

/**
 * Builds the tactical maps of the squadron missions from the game files and,
 * with --compare, scores each against its in-game snapshot
 * (data/maps/<map>__<mode>.png from wt-tools: RMSE over RGB, 0–255).
 * --kind air draws each mission's whole air map instead (no snapshots exist).
 *
 *   npm run maps:build -- [--db <copy.db>] [--mission gamedata/missions/….blk]…
 *     [--kind tank|air] [--team A|B] [--rank 32] [--size 1400] [--format png|jpeg]
 *     [--out dir] [--compare] [--game <WT dir>] [--threads N]
 *
 * Missions: --mission, else the distinct mission_settings of the database's
 * battles (DB_PATH or --db; a copy is safer next to the live bot).
 */

interface Job {
  mission: string
  missionName: string | null
}

interface WorkerInput {
  gameDir: string
  jobs: Job[]
  kind: MapKind
  team: Team
  rank: number
  size: number
  format: 'png' | 'jpeg'
  out: string
  compare: boolean
  fontDir: string
}

interface JobResult {
  mission: string
  ms: number
  file: string | null
  meta: Pick<TacticalMapMeta, 'level' | 'grid'> & { view: number[]; spawns: number; zones: number } | null
  reference: string | null
  rmse: number | null
  error: string | null
}

function referenceFor(missionName: string | null): string | null {
  const keys = missionName ? tacticalMapKeys(missionName) : null
  if (!keys) return null
  const file = path.join('data', 'maps', `${keys.mapKey}__${keys.modeKey}.png`)
  return existsSync(file) ? file : null
}

/** RMSE of our square render against the snapshot (cropped to the common top-left square). */
function rmseAgainst(ours: Buffer, referenceFile: string): number {
  const a = PNG.sync.read(ours)
  const b = PNG.sync.read(readFileSync(referenceFile))
  if (Math.abs(a.width - b.width) > 4) throw new Error(`size ${a.width} vs snapshot ${b.width}: render with --size ${b.width}`)
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  let sum = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4
      const j = (y * b.width + x) * 4
      for (let c = 0; c < 3; c++) sum += (a.data[i + c]! - b.data[j + c]!) ** 2
    }
  }
  return Math.sqrt(sum / (w * h * 3))
}

/** One mission's whole air map, drawn as the game draws it, with its spec's summary. */
function runAirJob(input: WorkerInput, job: Job, t0: number): JobResult {
  const spec = buildTacticalMapSpec({ gameDir: input.gameDir, mission: job.mission, balanceLevel: input.rank, kind: 'air', fontDir: input.fontDir })
  const image = composeTacticalMap(spec, {
    gameDir: input.gameDir,
    size: input.size,
    team: input.team,
    fontFile: path.resolve(input.fontDir, LABEL_FONT_FILE),
  })
  const stem = path.basename(job.mission).replace(/\.blk$/i, '')
  const file = path.join(input.out, `${stem}-air-${input.team}.${input.format === 'png' ? 'png' : 'jpg'}`)
  writeFileSync(file, encodeMapImage(image, input.format))
  const { icons: _icons, ...summary } = spec
  writeFileSync(file.replace(/\.(png|jpg)$/, '.json'), `${JSON.stringify(summary, null, 1)}\n`)
  return {
    mission: job.mission,
    ms: performance.now() - t0,
    file,
    meta: {
      level: spec.level,
      grid: spec.grid,
      view: [spec.view.x0, spec.view.z0, spec.view.x1, spec.view.z1].map(Math.round),
      spawns: mergeSpawns(spec.spawns).length,
      zones: spec.zones.length,
    },
    reference: null,
    rmse: null,
    error: null,
  }
}

function runJobs(input: WorkerInput): JobResult[] {
  return input.jobs.map((job) => {
    const t0 = performance.now()
    try {
      if (input.kind === 'air') return runAirJob(input, job, t0)
      const reference = input.compare ? referenceFor(job.missionName) : null
      // A snapshot's viewer team is unknown: score both perspectives and keep the closer one.
      const teams: Team[] = reference ? ['A', 'B'] : [input.team]
      const candidates = teams.map((team) => {
        const built = buildTacticalMap({
          gameDir: input.gameDir,
          mission: job.mission,
          team,
          balanceLevel: input.rank,
          size: input.size,
          format: input.compare ? 'png' : input.format,
          fontDir: input.fontDir,
        })
        return { team, built, rmse: reference ? rmseAgainst(built.image, reference) : null }
      })
      const best = candidates.reduce((a, b) => ((b.rmse ?? Infinity) < (a.rmse ?? Infinity) ? b : a))
      const built = best.built
      const stem = path.basename(job.mission).replace(/\.blk$/i, '')
      const file = path.join(input.out, `${stem}-${best.team}.${built.mime === 'image/png' ? 'png' : 'jpg'}`)
      writeFileSync(file, built.image)
      writeFileSync(file.replace(/\.(png|jpg)$/, '.json'), `${JSON.stringify(built.meta, null, 1)}\n`)
      return {
        mission: job.mission,
        ms: performance.now() - t0,
        file,
        meta: {
          level: built.meta.level,
          grid: built.meta.grid,
          view: [built.meta.view.x0, built.meta.view.z0, built.meta.view.x1, built.meta.view.z1].map(Math.round),
          spawns: built.meta.spawns.length,
          zones: built.meta.zones.length,
        },
        reference,
        rmse: best.rmse,
        error: null,
      }
    } catch (error) {
      return { mission: job.mission, ms: performance.now() - t0, file: null, meta: null, reference: null, rmse: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const gameDir = option(args, '--game') ?? await findWarThunderGameDir()
  if (!gameDir) throw new Error('War Thunder not found: pass --game or set WT_GAME_DIR')
  const compare = args.includes('--compare')
  const kind = (option(args, '--kind') ?? 'tank') as MapKind
  if (kind !== 'tank' && kind !== 'air') throw new Error('--kind is tank or air')
  if (kind === 'air' && compare) throw new Error('--compare scores ground maps: wt-tools has no air snapshots')
  const team = (option(args, '--team') ?? 'A') as Team
  if (team !== 'A' && team !== 'B') throw new Error('--team is A or B')
  const rank = Number(option(args, '--rank') ?? 32)
  const size = Number(option(args, '--size') ?? (compare ? 1153 : 1400))
  const format = (option(args, '--format') ?? 'png') as 'png' | 'jpeg'
  const out = option(args, '--out') ?? path.join('data', 'maps', 'game', 'export')
  mkdirSync(out, { recursive: true })

  let jobs: Job[]
  const explicit = args.flatMap((arg, i) => (args[i - 1] === '--mission' ? [arg] : []))
  if (explicit.length > 0) {
    jobs = explicit.map((mission) => ({ mission: mission.toLowerCase(), missionName: null }))
  } else {
    const db = new DatabaseSync(option(args, '--db') ?? process.env['DB_PATH'] ?? 'data/wtbot.db', { readOnly: true })
    const rows = db.prepare(`
      SELECT mission_settings AS mission, mission_name AS name, COUNT(*) AS n
      FROM battles WHERE mission_settings IS NOT NULL GROUP BY 1, 2 ORDER BY 1, n DESC
    `).all() as { mission: string; name: string }[]
    db.close()
    const byMission = new Map<string, string>()
    for (const row of rows) if (!byMission.has(row.mission)) byMission.set(row.mission, row.name)
    jobs = [...byMission].map(([mission, missionName]) => ({ mission, missionName }))
  }
  const threads = Math.max(1, Math.min(jobs.length, Number(option(args, '--threads') ?? Math.max(1, availableParallelism() - 2))))
  const chunks: Job[][] = Array.from({ length: threads }, () => [])
  jobs.forEach((job, i) => chunks[i % threads]!.push(job))
  const t0 = performance.now()
  const results = (await Promise.all(chunks.map((chunk) => new Promise<JobResult[]>((resolve, reject) => {
    const input: WorkerInput = { gameDir, jobs: chunk, kind, team, rank, size, format, out, compare, fontDir: path.join('data', 'fonts') }
    const worker = new Worker(new URL(import.meta.url), { workerData: input })
    worker.once('message', resolve)
    worker.once('error', reject)
  })))).flat()

  results.sort((a, b) => (b.rmse ?? -1) - (a.rmse ?? -1))
  for (const r of results) {
    const where = r.meta ? `view ${r.meta.view.join(',')} step ${r.meta.grid.step} zones ${r.meta.zones} bases ${r.meta.spawns}` : r.error
    console.log(`${r.rmse === null ? '     -' : r.rmse.toFixed(2).padStart(6)}  ${path.basename(r.mission).padEnd(36)} ${Math.round(r.ms)} ms  ${where}`)
  }
  const scored = results.filter((r) => r.rmse !== null).map((r) => r.rmse!).sort((a, b) => a - b)
  const failed = results.filter((r) => r.error !== null).length
  console.log(`${results.length} missions, ${failed} failed, ${((performance.now() - t0) / 1000).toFixed(1)} s on ${threads} threads → ${out}`)
  if (scored.length > 0) {
    const median = scored[Math.floor(scored.length / 2)]!
    console.log(`snapshot RMSE: median ${median.toFixed(2)}, ≤ 12: ${scored.filter((v) => v <= 12).length} of ${scored.length}`)
  }
  if (failed > 0) process.exitCode = 1
}

if (isMainThread) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
} else {
  parentPort!.postMessage(runJobs(workerData as WorkerInput))
}
