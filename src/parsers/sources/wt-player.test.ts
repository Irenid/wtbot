import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePlayerProfilePageHtml, PlayerNotFoundError, PlayerSchemaError } from './wt-player.js'

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`

test('a profile page yields the nickname shown by the site', () => {
  const parsed = parsePlayerProfilePageHtml(
    page('<div class="user-profile"><div class="user-profile__data-nick">ТУМ4Н</div></div>'),
    'ТУМ4Н',
  )
  assert.equal(parsed.profile.nickname, 'ТУМ4Н')
})

test('only the site saying "not found" makes a profile not found', () => {
  assert.throws(
    () => parsePlayerProfilePageHtml(page('<div class="user-profile"><h1>Player not found</h1></div>'), 'Ghost'),
    PlayerNotFoundError,
  )
  assert.throws(
    () => parsePlayerProfilePageHtml(page('<div class="user-profile"></div><p>Игрок не найден</p>'), 'Ghost'),
    PlayerNotFoundError,
  )
  assert.throws(() => parsePlayerProfilePageHtml(page('<p>User not found</p>'), 'Ghost'), PlayerNotFoundError)
})

test('a profile block without a nickname is a schema error, not a missing player', () => {
  assert.throws(
    () => parsePlayerProfilePageHtml(page('<div class="user-profile"><ul><li>Level 100</li></ul></div>'), 'Venukbr'),
    PlayerSchemaError,
  )
})
