import assert from 'node:assert/strict'
import test from 'node:test'
import { GUEST_RECENT_SEC, closestRosterNick, identify, type NickAccount } from './identify.js'
import { ratePlatoonPlayers, type RateReader } from './rate.js'

const NOW = 1_800_000_000
const roster = [{ nick: 'Venukbr' }, { nick: 'ЮрийГагарин' }, { nick: 'tank_master' }, { nick: 'tank_masters' }]
const account = (key: string, clanTag: string, startTime = NOW - 3600, userId = '42'): NickAccount =>
  ({ key, userId, nick: key, clanTag, startTime })

test('a roster nick, as written or with another case, is a member', () => {
  const accounts = new Map([['venukbr', account('venukbr', '┾WLILY┿')]])
  const found = identify('VENUKBR', 'wlily', roster, accounts, NOW)
  assert.deepEqual(found, { wtNick: 'VENUKBR', standing: 'member', rosterNick: 'Venukbr', guessed: false, wtUserId: '42' })
})

test('a typo finds the one roster nick it matches whole; two equal matches find none', () => {
  assert.equal(closestRosterNick('Venukb', roster), null, 'a prefix is not a whole match')
  assert.equal(closestRosterNick('Venukbrr', roster), 'Venukbr')
  assert.equal(closestRosterNick('ЮрийГагарн', roster), 'ЮрийГагарин')
  const guessed = identify('Venukbrr', 'wlily', roster, new Map(), NOW)
  assert.equal(guessed.standing, 'member')
  assert.equal(guessed.guessed, true)
  assert.equal(closestRosterNick('tank_mastera', roster), null, 'tank_master and tank_masters tie')
})

test('off the roster: the last battle\'s squadron decides; a nick never seen is unknown', () => {
  const accounts = new Map([
    ['newbie', account('newbie', '-WLILY-')],
    ['visitor', account('visitor', '=NW=')],
    ['oldtimer', account('oldtimer', '=NW=', NOW - GUEST_RECENT_SEC - 1)],
  ])
  assert.equal(identify('newbie', 'wlily', roster, accounts, NOW).standing, 'member')
  assert.equal(identify('visitor', 'wlily', roster, accounts, NOW).standing, 'guest')
  assert.equal(identify('oldtimer', 'wlily', roster, accounts, NOW).standing, 'unknown')
  assert.deepEqual(identify('ghost', 'wlily', roster, accounts, NOW), { wtNick: 'ghost', standing: 'unknown', rosterNick: null, guessed: false, wtUserId: null })
})

test('rating reads each found account\'s rows and the roster nick\'s PSR', () => {
  const requested: string[][] = []
  const reader: RateReader = {
    roster: () => roster,
    accounts: (keys) => keys.includes('venukbr') ? [account('venukbr', 'WLILY')] : [],
    rows: (userIds) => {
      requested.push([...userIds])
      return [{ userId: '42', startTime: NOW - 600, won: true, kills: 2, deaths: 0, assists: 1, vehicle: 'ussr_t_54_1947', lineup: '["ussr_t_54_1947","bad"' }]
    },
    stages: () => [{ startsAt: NOW - 86_400 * 3, endsAt: NOW + 86_400 * 4, maxBr: 6 }],
    ratings: (nicks) => nicks.includes('Venukbr') ? [{ nick: 'Venukbr', rating: 1500 }] : [],
  }
  const output = ratePlatoonPlayers({ clanCore: 'wlily', members: [{ userId: 'd1', wtNick: 'venukbr' }, { userId: 'd2', wtNick: 'ghost' }], now: NOW, seasonFrom: 0 }, reader)
  assert.equal(output.cap, 6)
  assert.deepEqual(requested, [['42']])
  const [venuk, ghost] = output.members
  assert.equal(venuk?.battles, 1)
  assert.equal(venuk?.capBattles, 1)
  assert.equal(venuk?.vehicle, 'ussr_t_54_1947', 'a broken lineup reads as empty')
  assert.equal(ghost?.identity.standing, 'unknown')
  assert.ok((venuk?.strength ?? 0) > (ghost?.strength ?? 0))
})
