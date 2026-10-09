// Scores the /scout screenshots the bot answered against their battles once
// stored: `npm run scout:outcomes -- <copy.db> [data/scout-images]`. Each
// record (src/bot/scout-images.ts) is matched to the enemy team holding most of
// its recognised players among battles that started within MATCH_BEFORE_SEC
// before the post (or MATCH_AFTER_SEC after: a screenshot of the loading
// screen); a battle stored before the post is skipped (its vehicles were
// already in the history). Prints counts only: the records hold Discord IDs and
// nicks, never publish them.
// Read-only; never point it at the live data/wtbot.db while the bot writes it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { VehicleDict } from '../wrpl/vehicles.js'

/** Squadron battles last p50 334 s, at most 25 min: a screenshot is posted during the battle it shows. */
const MATCH_BEFORE_SEC = 45 * 60
const MATCH_AFTER_SEC = 5 * 60
/** The first spawn comes ~29.5 s after the replay starts (docs/opponent-scouting.md). */
const FIRST_SPAWN_SEC = 29.5

interface RecordedOption { vehicleId: string; chance: number; new: boolean }
interface RecordedPrediction {
  model: string
  players: { userId: string; battlesAtCap: number; options: RecordedOption[]; unseenChance: number }[]
  unread: number
  setup: { compositions: { counts: Record<string, number>; chance: number }[]; airChance: number }
  statShark: { players: number; pending: boolean }
}
interface ScoutRecord {
  postedAt?: string
  receivedAt: string
  read?: { status: string; enemies?: { userId: string }[]; unread?: string[] }
  prediction?: RecordedPrediction
  predictionUpdated?: RecordedPrediction
}

function recordFiles(root: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(root)) {
    const full = path.join(root, name)
    if (statSync(full).isDirectory()) files.push(...recordFiles(full))
    else if (name.endsWith('.json') && name !== 'truth.json') files.push(full)
  }
  return files.sort()
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '–')
const MOMENT_BUCKETS = ['before the first spawn', '0–60 s', '60–180 s', '180 s and later'] as const
const momentBucket = (seconds: number): string => MOMENT_BUCKETS[seconds < 0 ? 0 : seconds < 60 ? 1 : seconds < 180 ? 2 : 3]

function main(): void {
  const [dbPath, root = 'data/scout-images'] = process.argv.slice(2)
  if (!dbPath) {
    console.error('Usage: npm run scout:outcomes -- <copy.db> [data/scout-images]')
    process.exit(1)
  }
  const dict = JSON.parse(readFileSync('data/wt-vehicles.json', 'utf8')) as VehicleDict
  const classOf = (id: string): string => dict[id]?.cls ?? '?'
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const teamOf = (userIds: readonly string[], from: number, to: number) => {
    if (userIds.length === 0) return undefined
    return db.prepare(`
      SELECT bp.session_id, bp.team, count(*) AS players, b.start_time, b.ingested_at
      FROM battle_players bp JOIN battles b ON b.session_id = bp.session_id
      WHERE bp.user_id IN (${userIds.map(() => '?').join(', ')}) AND b.start_time BETWEEN ? AND ?
      GROUP BY bp.session_id, bp.team
      ORDER BY players DESC, b.start_time DESC
      LIMIT 1
    `).get(...userIds, from, to) as { session_id: string; team: number; players: number; start_time: number; ingested_at: number } | undefined
  }
  const rosterOf = db.prepare('SELECT user_id, vehicle FROM battle_players WHERE session_id = ? AND team = ? AND user_id NOT LIKE \'-%\'')
  // The matcher knows players of the last 120 days stored by the post (src/scout/report.ts IMAGE_CANDIDATE_WINDOW_SEC).
  const storedBefore = db.prepare(`
    SELECT 1 FROM battle_players bp JOIN battles b ON b.session_id = bp.session_id
    WHERE bp.user_id = ? AND b.ingested_at <= ? AND b.start_time >= ? LIMIT 1
  `)

  const totals = { records: 0, matched: 0, skipped: 0, roster: 0, found: 0, falseFinds: 0, missedNew: 0, missedRead: 0 }
  const byMoment = new Map<string, { players: number; top1: number; top3: number; said: number; classHit: number; teams: number; setupHit: number }>()
  const models = new Map<string, number>()
  let sharkPlayers = 0
  for (const file of recordFiles(root)) {
    const record = JSON.parse(readFileSync(file, 'utf8')) as ScoutRecord
    if (record.read?.status !== 'ok' || !record.read.enemies?.length) continue
    totals.records += 1
    const posted = Math.floor(Date.parse(record.postedAt ?? record.receivedAt) / 1000)
    const ids = record.read.enemies.map((enemy) => enemy.userId)
    const battle = teamOf(ids, posted - MATCH_BEFORE_SEC, posted + MATCH_AFTER_SEC)
    const label = path.relative(root, file)
    if (!battle || battle.players < Math.min(4, ids.length)) {
      console.log(`${label}: no stored battle holds its enemies yet`)
      continue
    }
    if (battle.ingested_at <= posted) {
      totals.skipped += 1
      console.log(`${label}: its battle was stored before the post, skipped`)
      continue
    }
    totals.matched += 1
    const roster = new Map((rosterOf.all(battle.session_id, battle.team) as { user_id: string; vehicle: string | null }[]).map((row) => [row.user_id, row.vehicle]))
    const found = ids.filter((id) => roster.has(id)).length
    const missed = [...roster.keys()].filter((id) => !ids.includes(id))
    const missedNew = missed.filter((id) => !storedBefore.get(id, posted, posted - 120 * 86_400)).length
    totals.roster += roster.size
    totals.found += found
    totals.falseFinds += ids.length - found
    totals.missedNew += missedNew
    totals.missedRead += missed.length - missedNew
    const moment = posted - battle.start_time - FIRST_SPAWN_SEC
    let line = `${label}: battle ${moment >= 0 ? '+' : ''}${Math.round(moment)} s after the first spawn; enemies ${found} of ${roster.size} read`
      + `${ids.length > found ? `, ${ids.length - found} false` : ''}${missed.length > 0 ? `, ${missedNew} missed without a stored battle, ${missed.length - missedNew} misread` : ''}`
    const prediction = record.predictionUpdated ?? record.prediction
    if (prediction) {
      models.set(prediction.model, (models.get(prediction.model) ?? 0) + 1)
      sharkPlayers += prediction.statShark.players
      const bucket = momentBucket(moment)
      const tally = byMoment.get(bucket) ?? { players: 0, top1: 0, top3: 0, said: 0, classHit: 0, teams: 0, setupHit: 0 }
      byMoment.set(bucket, tally)
      let hits = 0
      let scored = 0
      for (const player of prediction.players) {
        const actual = roster.get(player.userId)
        if (!actual) continue
        const [first] = player.options
        scored += 1
        tally.players += 1
        if (first?.vehicleId === actual) hits += 1
        tally.top1 += first?.vehicleId === actual ? 1 : 0
        tally.top3 += player.options.some((option) => option.vehicleId === actual) ? 1 : 0
        tally.said += first?.chance ?? 0
        tally.classHit += first && classOf(first.vehicleId) === classOf(actual) ? 1 : 0
      }
      const counts: Record<string, number> = { F: 0, H: 0, T: 0, L: 0, AA: 0 }
      let classesKnown = true
      for (const vehicle of roster.values()) {
        const cls = vehicle ? classOf(vehicle) : '?'
        if (cls in counts) counts[cls]! += 1
        else classesKnown = false
      }
      const top = prediction.setup.compositions[0]
      if (top && classesKnown) {
        tally.teams += 1
        const hit = Object.keys(counts).every((cls) => (top.counts[cls] ?? 0) === counts[cls])
        tally.setupHit += hit ? 1 : 0
        line += `; setup ${hit ? 'right' : 'wrong'} (said ${pct(top.chance, 1)})`
      }
      line += `; first vehicle ${hits} of ${scored}`
    }
    console.log(line)
  }
  console.log(`\n${totals.records} records with enemies read, ${totals.matched} matched to a stored battle, ${totals.skipped} skipped (stored before the post)`)
  console.log(`reading: ${totals.found} of ${totals.roster} enemies (${pct(totals.found, totals.roster)}), ${totals.falseFinds} false; missed ${totals.missedNew} without a stored battle, ${totals.missedRead} misread`)
  for (const [bucket, t] of [...byMoment].sort((a, b) => MOMENT_BUCKETS.indexOf(a[0] as (typeof MOMENT_BUCKETS)[number]) - MOMENT_BUCKETS.indexOf(b[0] as (typeof MOMENT_BUCKETS)[number]))) {
    console.log(`prediction, ${bucket}: first vehicle ${pct(t.top1, t.players)} (said ${pct(t.said, t.players)}), among three ${pct(t.top3, t.players)}, class ${pct(t.classHit, t.players)} of ${t.players} players; most likely setup ${pct(t.setupHit, t.teams)} of ${t.teams} teams`)
  }
  if (models.size > 0) console.log(`models: ${[...models].map(([hash, n]) => `${hash} ×${n}`).join(', ')}; StatShark snapshots used ${sharkPlayers}`)
  db.close()
}

main()
