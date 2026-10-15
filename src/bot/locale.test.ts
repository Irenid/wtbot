import assert from 'node:assert/strict'
import test from 'node:test'

// Before config.ts loads: no WT_BOT_LOCALE default (dotenv keeps a variable that is already set).
process.env['WT_BOT_LOCALE'] = ''
const { closeDb, initDb, setBotState } = await import('../db/index.js')
const { LOCALES } = await import('../i18n/index.js')
const { catalogLocale, channelLocale, discordLocales, guildLocale, saveGuildLocale, userLocale } = await import('./locale.js')

test('catalogLocale: a Discord locale maps to its exact catalog, else its language\'s', () => {
  assert.equal(catalogLocale('en-US'), 'en')
  assert.equal(catalogLocale('en-GB'), 'en')
  assert.equal(catalogLocale('ru'), 'ru')
  for (const missing of ['pt-BR', 'de', 'zh-CN', '', null, undefined]) assert.equal(catalogLocale(missing), null, String(missing))
})

test('discordLocales: every catalog reaches Discord\'s command localizations', () => {
  assert.deepEqual(discordLocales('en').sort(), ['en-GB', 'en-US'])
  assert.deepEqual(discordLocales('ru'), ['ru'])
  for (const locale of LOCALES) assert.ok(discordLocales(locale).length > 0, locale)
})

test('a server\'s language: its /language choice, else its Discord language, else English', () => {
  initDb(':memory:', { allowCreate: true })
  try {
    assert.equal(guildLocale('g1'), 'en')
    assert.equal(guildLocale('g1', 'ru'), 'ru')
    assert.equal(guildLocale('g1', 'de'), 'en', 'no catalog for the server\'s Discord language')
    assert.equal(guildLocale(null, 'ru'), 'ru')

    saveGuildLocale('g1', 'ru')
    assert.equal(guildLocale('g1', 'en-US'), 'ru', 'the choice wins over the Discord language')
    assert.equal(guildLocale('g2', 'en-US'), 'en', 'the choice is per server')

    setBotState('guild-locale:g3', 'xx')
    assert.equal(guildLocale('g3', 'ru'), 'ru', 'a stored language the bot no longer has is ignored')

    // Public replies follow the server; what one user sees follows that user's Discord language.
    assert.equal(channelLocale({ guildId: 'g1', guildLocale: 'en-US' }), 'ru')
    assert.equal(userLocale({ guildId: 'g1', guildLocale: 'en-US', locale: 'en-GB' }), 'en')
    assert.equal(userLocale({ guildId: 'g1', guildLocale: 'en-US', locale: 'de' }), 'ru', 'no catalog: the server\'s')
    assert.equal(userLocale({ guildId: null, guildLocale: null, locale: 'ru' }), 'ru', 'a DM')
  } finally {
    closeDb()
  }
})
