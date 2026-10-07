import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  initDb,
  saveBattle,
  saveClanRatingSnapshots,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import { psrAfterBattle } from '../psr.js'
import { battlePsr, psrBefore, type PsrBattle } from './battle-psr.js'

const HOUR = 3_600
const base = Date.UTC(2026, 9, 7, 15) / 1_000
/** Minutes and seconds after `base`. */
const at = (minutes: number, seconds = 0): number => base + minutes * 60 + seconds

test('a real session: the page lags, the chain between readings decides what each one counts', () => {
  // One player on 2026-10-07 from 15:00 UTC, names dropped. The 16:09:42 read
  // already counts the win that ended 33 s before it: only that gives 1707.
  const battles: PsrBattle[] = [
    { endAt: at(10, 6), won: false },
    { endAt: at(17, 5), won: false },
    { endAt: at(20, 38), won: true },
    { endAt: at(25, 57), won: true },
    { endAt: at(43, 26), won: true },
    { endAt: at(48, 20), won: true },
    { endAt: at(54, 51), won: true },
    { endAt: at(62, 26), won: false },
    { endAt: at(69, 9), won: true },
    { endAt: at(77, 32), won: true },
  ]
  const readings = [
    { at: at(10, 22), psr: 1736 },
    { at: at(26, 5), psr: 1694 },
    { at: at(46, 30), psr: 1702 },
    { at: at(55, 17), psr: 1717 },
    { at: at(69, 42), psr: 1707 },
    // The announcement's read, 28 s after the battle: the page has not counted it.
    { at: at(78, 0), psr: 1707 },
  ]

  const before = psrBefore(battles, readings, 9, base - 24 * HOUR)
  assert.equal(before, 1707)
  // Two wins later the page showed 1721: within the rounding of the 1707 read.
  assert.ok(Math.abs(psrAfterBattle(psrAfterBattle(before, true), true) - 1721) < 1)
})

test('a read right after the battle may lack the previous battle: the chain adds it', () => {
  const battles: PsrBattle[] = [
    { endAt: at(0), won: true },
    { endAt: at(6), won: true },
  ]
  const settled = { at: at(-20), psr: 1500 }
  // The read at the announcement either lacks the first win or counts it: 16 points apart.
  for (const shown of [1500, 1516]) {
    assert.equal(psrBefore(battles, [settled, { at: at(6, 30), psr: shown }], 1, null), 1516, `page ${shown}`)
  }
})

test('a reading that already counts the battle is walked back', () => {
  const before = psrBefore([{ endAt: at(0), won: true }], [{ at: at(20), psr: 1516 }], 0, null)
  assert.ok(before !== null && Math.abs(before - 1500) < 1e-9)
})

test('the season start anchors a new player: the first win shows within seconds', () => {
  const battles: PsrBattle[] = [
    { endAt: at(0), won: true },
    { endAt: at(11), won: true },
  ]
  const readings = [{ at: at(0, 28), psr: 32 }]
  // PSR 0 at the season start: 32 already counts the first win, though it ended 28 s before the read.
  assert.equal(psrBefore(battles, readings, 1, base - 24 * HOUR), 32)
  // Without the anchor the read time alone says the win is not counted yet.
  assert.equal(Math.round(psrBefore(battles, readings, 1, null)!), 64)
})

test('a season-start chain that misses the first reading by more than a battle is ignored', () => {
  // The database lacks this player's earlier battles: from 0 the chain cannot reach 1500.
  const battles: PsrBattle[] = [
    { endAt: at(-20), won: true },
    { endAt: at(0), won: true },
  ]
  assert.equal(psrBefore(battles, [{ at: at(0, 30), psr: 1500 }], 1, base - 24 * HOUR), 1500)
})

test('no reading within an hour after the battle and none before it: no PSR', () => {
  assert.equal(psrBefore([{ endAt: at(0), won: true }], [{ at: at(61), psr: 1516 }], 0, null), null)
})

function player(userId: string, nick: string, team: number): BattlePlayerInput {
  return {
    userId, nick, clanTag: '=TST=', team,
    kills: 0, groundKills: 0, navalKills: 0, aiKills: 0, aiGroundKills: 0, assists: 0, deaths: 0,
    captureZone: 0, damageZone: 0, score: 0, awardDamage: 0, teamKills: 0, squadId: -1,
    vehicle: null, vehicles: [], disconnected: false, slot: null, title: null, autoSquad: null,
  }
}

function battle(sessionId: string, startTime: number, durationSec: number, players: BattlePlayerInput[]): BattleInput {
  return {
    sessionId, sessionHex: sessionId.padStart(16, '0'), missionName: 'm', level: 'l', gameMode: null,
    battleType: null, environment: null, status: null, startTime, durationSec, endTimeMs: 0, teamWon: 1,
    gameVersion: null, missionSettings: null, players, kills: [], chat: [], eventsBlob: Buffer.from('x'),
  }
}

test('battlePsr reads the stored readings and battles; the page may list a console player without the suffix', () => {
  initDb(':memory:')
  try {
    const now = Math.floor(Date.now() / 1_000)
    // An earlier win 20 min before the read (the page counts it), then the battle drawn, 30 s before.
    saveBattle(battle('1', now - 25 * 60, 300, [player('7', 'Pilot@psn', 1)]))
    saveClanRatingSnapshots('=TST=', [{ nick: 'Pilot', rating: 1500 }])
    const players = [
      { userId: '7', name: 'Pilot@psn', clanTag: '=TST=', team: 1 },
      { userId: '8', name: 'Stranger', clanTag: '=TST=', team: 2 },
    ]
    const input = { sessionId: '2', startTime: now - 6 * 60, duration: 330, players }

    assert.deepEqual(battlePsr({ ...input, winnerTeam: 1 }), new Map([['7', { psr: 1516, change: 16 }]]))
    assert.deepEqual(battlePsr({ ...input, winnerTeam: null }), new Map([['7', { psr: 1500, change: null }]]))
  } finally {
    closeDb()
  }
})
