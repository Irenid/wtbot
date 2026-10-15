import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAN_SEASON_SCHEDULES, STAGE_SWITCH_DELAY_SEC, stageAt, validateClanSeasonSchedules, type ClanSeasonSchedule } from './clan-season.js'
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

test('the season schedule rejects gaps, overlaps and incomplete stages', () => {
  assert.doesNotThrow(() => validateClanSeasonSchedules(CLAN_SEASON_SCHEDULES))
  assert.doesNotThrow(() => validateClanSeasonSchedules([schedule([[0, 10], [10, 20]])]))
  assert.throws(() => validateClanSeasonSchedules([schedule([[0, 9], [10, 20]])]), /gap or overlap/)
  assert.throws(() => validateClanSeasonSchedules([schedule([[0, 10], [10, 15]])]), /last stage/)
  assert.throws(() => validateClanSeasonSchedules([schedule([[5, 20]])]), /gap or overlap/)
  assert.throws(
    () => validateClanSeasonSchedules([schedule([[0, 20]]), { ...schedule([[10, 30]], 10, 30), id: 'next' }]),
    /overlaps season/,
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

test('a stage\'s max BR plays from 14:00 UTC of its first day: that day\'s night window keeps the previous cap', () => {
  const { stages, endsAt } = CLAN_SEASON_SCHEDULES[0]!
  const switchAt = (index: number) => stages[index]!.startsAt + STAGE_SWITCH_DELAY_SEC
  assert.equal(new Date(switchAt(0) * 1_000).toISOString(), '2026-07-01T14:00:00.000Z')
  assert.equal(stageAt(stages, stages[0]!.startsAt + 3 * 3600), null, 'the season\'s first night window: none of its stages yet')
  assert.equal(stageAt(stages, switchAt(0))?.maxBr, 14.7)
  assert.equal(stageAt(stages, switchAt(1) - 1)?.maxBr, 14.7)
  assert.equal(stageAt(stages, switchAt(1))?.maxBr, 12.0)
  assert.equal(stageAt(stages, stages[3]!.startsAt + 3 * 3600)?.maxBr, 10.7, 'the 01:00–07:00 UTC window of week 4\'s first day')
  assert.equal(stageAt(stages, switchAt(3))?.maxBr, 9.7)
  assert.equal(stageAt(stages, endsAt + 3 * 3600)?.maxBr, 4.7, 'the last cap plays on into the next day\'s night window')
  assert.equal(stageAt(stages, endsAt + STAGE_SWITCH_DELAY_SEC), null)
})