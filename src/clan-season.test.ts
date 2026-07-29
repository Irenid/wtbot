import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAN_SEASON_SCHEDULES, stageAt } from './clan-season.js'

test('расписание сезона переключает БР на точных границах этапов', () => {
  const season = CLAN_SEASON_SCHEDULES[0]!
  assert.equal(stageAt(season, season.stages[0]!.startsAt)?.maxBr, 14.7)
  assert.equal(stageAt(season, season.stages[1]!.startsAt)?.maxBr, 12.0)
  assert.equal(stageAt(season, season.stages[3]!.startsAt)?.maxBr, 9.7)
  assert.equal(stageAt(season, season.endsAt), null)
})
