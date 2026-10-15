import assert from 'node:assert/strict'
import test from 'node:test'

// Before config.ts loads (dotenv keeps a variable that is already set).
process.env['WT_BOT_LOCALE'] = 'ru'
const { closeDb, initDb } = await import('../db/index.js')
const { guildLocale, saveGuildLocale } = await import('./locale.js')

test('WT_BOT_LOCALE is the language of servers without a /language choice', () => {
  initDb(':memory:', { allowCreate: true })
  try {
    assert.equal(guildLocale('g1', 'en-US'), 'ru', 'over the server\'s Discord language')
    assert.equal(guildLocale(null), 'ru')
    saveGuildLocale('g1', 'en')
    assert.equal(guildLocale('g1', 'ru'), 'en', 'the choice wins')
  } finally {
    closeDb()
  }
})
