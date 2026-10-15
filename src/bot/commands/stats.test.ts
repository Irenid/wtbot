import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAN_SEASON_SCHEDULES } from '../../clan-season.js'
import { closeDb, getClanSeasonContext, initDb } from '../../db/index.js'
import { seasonText } from './stats.js'

test('/stats names the cap that plays and when the next one does, not the schedule\'s 00:00 UTC', () => {
  initDb(':memory:')
  try {
    const { stages, endsAt } = CLAN_SEASON_SCHEDULES[0]!
    const text = (sec: number) => seasonText(getClanSeasonContext(sec), sec)
    const week4 = stages[3]!.startsAt
    // Week 4's first night window still plays week 3's 10.7; 9.7 plays from 14:00 UTC.
    assert.equal(text(week4 + 3 * 3600), `week 3 · max BR 10.7 · max BR 9.7 <t:${week4 + 14 * 3600}:R>`)
    assert.equal(text(week4 + 15 * 3600), `week 4 · max BR 9.7 · max BR 8.7 <t:${stages[4]!.startsAt + 14 * 3600}:R>`)
    assert.equal(text(stages[0]!.startsAt + 3 * 3600), `between stages · max BR 14.7 <t:${stages[0]!.startsAt + 14 * 3600}:R>`)
    assert.equal(text(endsAt - 3600), `until the end of the season · max BR 4.7 · season ends <t:${endsAt}:R>`)
    assert.equal(text(endsAt + 3 * 3600), `season ended <t:${endsAt}:R>`)
  } finally {
    closeDb()
  }
})
