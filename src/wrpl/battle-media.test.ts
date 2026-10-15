import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, initDb } from '../db/index.js'
import { battleBalanceLevel, battleMaxBr, publishedArtifacts } from './battle-media.js'

test('battleBalanceLevel: the night window of a stage\'s first day still plays the previous cap', () => {
  initDb(':memory:')
  try {
    // The built-in season: BR 8.7 until 2026-08-05, then 7.3 (balance levels 23 and 19: other airfields).
    const day = Date.parse('2026-08-05T00:00:00Z') / 1_000
    assert.equal(battleBalanceLevel(day - 6 * 3600), 23)
    assert.equal(battleBalanceLevel(day + 3 * 3600), 23, 'the 01:00–07:00 UTC window')
    assert.equal(battleBalanceLevel(day + 15 * 3600), 19, 'the 14:00 UTC window')
    assert.equal(battleBalanceLevel(Date.parse('2030-01-01T00:00:00Z') / 1_000), 32, 'outside the known stages')
    assert.equal(battleMaxBr(day + 3 * 3600), 8.7, 'the battle post\'s max BR')
    assert.equal(battleMaxBr(Date.parse('2030-01-01T00:00:00Z') / 1_000), null)
  } finally {
    closeDb()
  }
})

test('publishedArtifacts: each language keeps its own list of cached media', () => {
  assert.deepEqual(publishedArtifacts(undefined, 'en', ['chat', 'log'], false), { en: ['log', 'chat'] })
  assert.deepEqual(
    publishedArtifacts({ en: ['log'], ru: ['chat'] }, 'en', ['heatmap-ground'], false),
    { en: ['log', 'heatmap-ground'], ru: ['chat'] },
    'a lazy artifact joins its language\'s list',
  )
  assert.deepEqual(
    publishedArtifacts({ en: ['log', 'chat'], ru: ['log'] }, 'en', ['heatmap-air'], true),
    { en: ['heatmap-air'], ru: ['log'] },
    'a full bundle replaces only its language\'s list',
  )
})
