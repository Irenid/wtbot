import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAN_SEASON_SCHEDULES, stageAt, validateClanSeasonSchedules, type ClanSeasonSchedule } from './clan-season.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, initDb } from './db/index.js'

function schedule(stages: [number, number][], startsAt = 0, endsAt = 20): ClanSeasonSchedule {
  return {
    id: 'test',
    name: 'test',
    startsAt,
    endsAt,
    stages: stages.map(([from, to], index) => ({ week: index + 1, startsAt: from, endsAt: to, maxBr: 10 })),
  }
}

test('расписание сезонов отклоняет дыры, перекрытия и неполные этапы', () => {
  assert.doesNotThrow(() => validateClanSeasonSchedules(CLAN_SEASON_SCHEDULES))
  assert.doesNotThrow(() => validateClanSeasonSchedules([schedule([[0, 10], [10, 20]])]))
  assert.throws(() => validateClanSeasonSchedules([schedule([[0, 9], [10, 20]])]), /дыра или перекрытие/)
  assert.throws(() => validateClanSeasonSchedules([schedule([[0, 10], [10, 15]])]), /последний этап/)
  assert.throws(() => validateClanSeasonSchedules([schedule([[5, 20]])]), /дыра или перекрытие/)
  assert.throws(
    () => validateClanSeasonSchedules([schedule([[0, 20]]), { ...schedule([[10, 30]], 10, 30), id: 'next' }]),
    /пересекается/,
  )
})

test('seed сезона удаляет из SQLite этапы, которых больше нет в расписании', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wtbot-season-'))
  const dbPath = path.join(dir, 'season.db')
  const season = CLAN_SEASON_SCHEDULES[0]!
  const stageCount = () => {
    const database = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return (database.prepare('SELECT COUNT(*) AS n FROM clan_season_stages WHERE season_id = ?')
        .get(season.id) as { n: number }).n
    } finally {
      database.close()
    }
  }
  try {
    initDb(dbPath, { allowCreate: true })
    closeDb()
    // Этап, которого нет в расписании (например, его удалили из кода).
    const database = new DatabaseSync(dbPath)
    database.prepare(
      'INSERT INTO clan_season_stages (season_id, week, starts_at, ends_at, max_br) VALUES (?, ?, ?, ?, ?)',
    ).run(season.id, season.stages.length + 1, season.endsAt, season.endsAt + 60, 3.3)
    database.close()
    assert.equal(stageCount(), season.stages.length + 1)
    initDb(dbPath)
    closeDb()
    assert.equal(stageCount(), season.stages.length)
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('расписание сезона переключает БР на точных границах этапов', () => {
  const season = CLAN_SEASON_SCHEDULES[0]!
  assert.equal(stageAt(season, season.stages[0]!.startsAt)?.maxBr, 14.7)
  assert.equal(stageAt(season, season.stages[1]!.startsAt)?.maxBr, 12.0)
  assert.equal(stageAt(season, season.stages[3]!.startsAt)?.maxBr, 9.7)
  assert.equal(stageAt(season, season.endsAt), null)
})