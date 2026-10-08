// Re-reads scoreboard screenshots (/scout by picture) and prints what each
// gives: rows, recognised enemies and allies, unread enemy rows, timings. The
// images the bot kept in data/scout-images/ are the test set for improving
// the reading: run it before and after a change.
// Run: npm run scout:images -- [files or folders; default data/scout-images]
// Players are matched from DB_PATH (default data/wtbot.db), opened read-only.
// SCOUT_TESSERACT="docker run -i --rm <image> tesseract" runs OCR elsewhere
// (a host without the rus/chi_sim language data).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getScoutRecentPlayers } from '../db/index.js'
import { indexPlayers } from '../scout/nick-match.js'
import { readScoreboard } from '../scout/scoreboard-read.js'

function images(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target]
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort()
    .map((name) => path.join(target, name))
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2)
  const files = (targets.length > 0 ? targets : ['data/scout-images']).flatMap(images)
  const database = new DatabaseSync(process.env['DB_PATH'] ?? 'data/wtbot.db', { readOnly: true })
  const players = indexPlayers(getScoutRecentPlayers(Math.floor(Date.now() / 1000) - 120 * 86_400, database))
  database.close()
  const tesseract = (process.env['SCOUT_TESSERACT'] ?? 'tesseract').split(' ').filter(Boolean)
  let enemies = 0
  let unread = 0
  for (const file of files) {
    try {
      const read = await readScoreboard(new Uint8Array(readFileSync(file)), players, tesseract)
      enemies += read.enemies.length
      unread += read.unread.length
      console.log(`${file}: ${read.status}, rows ${read.rows}, enemies ${read.enemies.length}, unread ${read.unread.length}, allies ${read.allies.length}`
        + ` (layout ${read.ms.layout.toFixed(0)} ms, OCR ${read.ms.ocr.toFixed(0)} ms, match ${read.ms.match.toFixed(0)} ms)`)
      if (read.enemies.length > 0) console.log(`  enemies: ${read.enemies.map((m) => `${m.nick} [${m.clanTag}]${m.distance > 0 ? ` ±${m.distance}` : ''}`).join(', ')}`)
      if (read.unread.length > 0) console.log(`  unread: ${read.unread.map((text) => JSON.stringify(text)).join(', ')}`)
      if (read.oneSide.length > 0) console.log(`  one side only: ${read.oneSide.map((m) => m.nick).join(', ')}`)
    } catch (error) {
      console.log(`${file}: error ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`${files.length} images: ${enemies} enemies recognised, ${unread} enemy rows unread`)
}

await main()
