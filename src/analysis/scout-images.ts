// Re-reads scoreboard screenshots (/scout by picture) and prints what each
// gives: rows, recognised enemies and allies, unread enemy rows, timings. The
// images the bot kept in data/scout-images/ are the test set for improving
// the reading: run it before and after a change.
// Run: npm run scout:images -- [files or folders; default data/scout-images]
// A truth.json in a given folder ({"<path relative to it>": {"enemies":
// [nicks], "allies": [nicks], "oneSide"?: true}}) scores each image: known
// players found on the right side, misses, false finds.
// Players are matched from DB_PATH (default data/wtbot.db), opened read-only.
// SCOUT_TESSERACT="docker run -i --rm --entrypoint tesseract wtbot:latest"
// runs OCR in the image (a host without its language data).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getScoutRecentPlayers } from '../db/index.js'
import { displayedNick, foldForMatch, indexPlayers, type NickMatch } from '../scout/nick-match.js'
import { OCR_PASSES } from '../scout/ocr.js'
import { readScoreboard, type ScoreboardReadResult } from '../scout/scoreboard-read.js'

interface Truth {
  enemies: string[]
  allies: string[]
  /** A crop of one team: the reading must not claim a side. */
  oneSide?: boolean
}

interface Target {
  file: string
  truth: Truth | null
}

function targets(target: string): Target[] {
  if (!statSync(target).isDirectory()) return [{ file: target, truth: null }]
  const truthFile = path.join(target, 'truth.json')
  const truth = existsSync(truthFile) ? JSON.parse(readFileSync(truthFile, 'utf8')) as Record<string, Truth> : {}
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort()
    .map((name) => ({ file: path.join(target, name), truth: truth[name.split(path.sep).join('/')] ?? null }))
}

const database = new DatabaseSync(process.env['DB_PATH'] ?? 'data/wtbot.db', { readOnly: true })
const players = indexPlayers(getScoutRecentPlayers(Math.floor(Date.now() / 1000) - 120 * 86_400, database))
database.close()
// Nick → the stored accounts it folds to (several may: "DYADYA_VLAD", "DYADYA_VLAD_").
const byFold = new Map<string, typeof players>()
for (const player of players) {
  const key = player.chars.join('')
  byFold.set(key, [...(byFold.get(key) ?? []), player])
}

/** Truth nicks the bot knows; a find counts when it is the account with that exact nick (else any folding alike). */
function score(nicks: readonly string[], finds: readonly NickMatch[]): { known: number; found: number; missed: string[]; wrong: NickMatch[] } {
  let known = 0
  const missed: string[] = []
  const ids = new Set<string>()
  for (const nick of nicks) {
    const accounts = byFold.get(foldForMatch(nick)) ?? []
    if (accounts.length === 0) continue
    known += 1
    const exact = accounts.filter((player) => displayedNick(player.nick) === nick)
    const want = new Set((exact.length > 0 ? exact : accounts).map((player) => player.userId))
    for (const player of accounts) ids.add(player.userId)
    if (!finds.some((match) => want.has(match.userId))) missed.push(nick)
  }
  return { known, found: known - missed.length, missed, wrong: finds.filter((match) => !ids.has(match.userId)) }
}

const tesseract = (process.env['SCOUT_TESSERACT'] ?? 'tesseract').split(' ').filter(Boolean)
const list = (process.argv.length > 2 ? process.argv.slice(2) : ['data/scout-images']).flatMap(targets)
// Each image runs one Tesseract process per pass (2 threads each).
const parallel = Math.max(1, Math.floor((availableParallelism() - 2) / (OCR_PASSES.length * 2)))
const results: { target: Target; read: ScoreboardReadResult | Error }[] = []
let next = 0
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < list.length) {
    const target = list[next]!
    next += 1
    const read = await readScoreboard(new Uint8Array(readFileSync(target.file)), players, tesseract).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    results.push({ target, read })
  }
}))
results.sort((a, b) => a.target.file.localeCompare(b.target.file))

const totals = { enemies: 0, unread: 0, known: 0, found: 0, wrong: 0, allyKnown: 0, allyFound: 0, allyWrong: 0 }
for (const { target, read } of results) {
  if (read instanceof Error) {
    console.log(`${target.file}: error ${read.message}`)
    continue
  }
  totals.enemies += read.enemies.length
  totals.unread += read.unread.length
  console.log(`${target.file}: ${read.status}, rows ${read.rows}, enemies ${read.enemies.length}, unread ${read.unread.length}, allies ${read.allies.length}`
    + ` (layout ${read.ms.layout.toFixed(0)} ms, OCR ${read.ms.ocr.toFixed(0)} ms, match ${read.ms.match.toFixed(0)} ms)`)
  if (read.enemies.length > 0) console.log(`  enemies: ${read.enemies.map((m) => `${m.nick} [${m.clanTag}]${m.distance > 0 ? ` ±${m.distance}` : ''}`).join(', ')}`)
  if (read.unread.length > 0) console.log(`  unread: ${read.unread.map((text) => JSON.stringify(text)).join(', ')}`)
  if (read.oneSide.length > 0) console.log(`  one side only: ${read.oneSide.map((m) => m.nick).join(', ')}`)
  const truth = target.truth
  if (!truth) continue
  if (truth.oneSide) {
    totals.wrong += read.enemies.length
    console.log(`  truth: one side wanted, ${read.status === 'one-side' ? 'ok' : 'WRONG'}`)
    continue
  }
  const enemies = score(truth.enemies, read.enemies)
  const allies = score(truth.allies, read.allies)
  totals.known += enemies.known
  totals.found += enemies.found
  totals.wrong += enemies.wrong.length
  totals.allyKnown += allies.known
  totals.allyFound += allies.found
  totals.allyWrong += allies.wrong.length
  console.log(`  truth: enemies ${enemies.found}/${enemies.known} known, allies ${allies.found}/${allies.known}`
    + (enemies.missed.length > 0 ? `; missed ${enemies.missed.join(', ')}` : '')
    + (enemies.wrong.length + allies.wrong.length > 0 ? `; FALSE ${[...enemies.wrong, ...allies.wrong].map((m) => m.nick).join(', ')}` : ''))
}
console.log(`${results.length} images: ${totals.enemies} enemies recognised, ${totals.unread} enemy rows unread`)
if (totals.known > 0) {
  console.log(`truth: enemies ${totals.found}/${totals.known} known found, allies ${totals.allyFound}/${totals.allyKnown}, false finds ${totals.wrong + totals.allyWrong}`)
}
