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
import { battlePsr, estimatePsr, psrColumn, type PsrBattle, type PsrEstimate } from './battle-psr.js'

const HOUR = 3_600
const base = Date.UTC(2026, 9, 7, 15) / 1_000
/** Minutes and seconds after `base`. */
const at = (minutes: number, seconds = 0): number => base + minutes * 60 + seconds

test('a real session: the page lags, the chain between readings decides what each one counts', () => {
  // One player on 2026-10-07 from 15:00 UTC, names dropped. The 16:09:42 read
  // already counts the win that ended 33 s before it: only that gives 1707.
  const battles: PsrBattle[] = [
    { endAt: at(10, 6), won: false, enemyPsr: null },
    { endAt: at(17, 5), won: false, enemyPsr: null },
    { endAt: at(20, 38), won: true, enemyPsr: null },
    { endAt: at(25, 57), won: true, enemyPsr: null },
    { endAt: at(43, 26), won: true, enemyPsr: null },
    { endAt: at(48, 20), won: true, enemyPsr: null },
    { endAt: at(54, 51), won: true, enemyPsr: null },
    { endAt: at(62, 26), won: false, enemyPsr: null },
    { endAt: at(69, 9), won: true, enemyPsr: null },
    { endAt: at(77, 32), won: true, enemyPsr: null },
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

  const before = estimatePsr(battles, readings, 9, base - 24 * HOUR)?.before ?? null
  assert.equal(before, 1707)
  // Two wins later the page showed 1721: within the rounding of the 1707 read.
  assert.ok(Math.abs(psrAfterBattle(psrAfterBattle(before, true), true) - 1721) < 1)
})

test('a read right after the battle may lack the previous battle: the chain adds it', () => {
  const battles: PsrBattle[] = [
    { endAt: at(0), won: true, enemyPsr: null },
    { endAt: at(6), won: true, enemyPsr: null },
  ]
  const settled = { at: at(-20), psr: 1500 }
  // The read at the announcement either lacks the first win or counts it: 16 points apart.
  for (const shown of [1500, 1516]) {
    assert.equal(estimatePsr(battles, [settled, { at: at(6, 30), psr: shown }], 1, null)?.before, 1516, `page ${shown}`)
  }
})

test('a reading that already counts the battle is walked back', () => {
  const estimate = estimatePsr([{ endAt: at(0), won: true, enemyPsr: null }], [{ at: at(20), psr: 1516 }], 0, null)
  assert.ok(estimate !== null && Math.abs(estimate.before - 1500) < 1e-9)
  // That reading counts exactly this battle: the page's own PSR after it.
  assert.equal(estimate.siteAfter, 1516)
  assert.equal(estimate.siteBefore, null)
})

test('readings on both sides of the battle give the page\'s PSR before and after it', () => {
  const battles: PsrBattle[] = [{ endAt: at(0), won: true, enemyPsr: null }]
  const estimate = estimatePsr(battles, [{ at: at(-20), psr: 1500 }, { at: at(20), psr: 1517 }], 0, null)
  assert.deepEqual(estimate, { before: 1500, siteBefore: 1500, siteAfter: 1517 })
})

test('a read that also counts the next battle gives this one no page value once that battle is stored', () => {
  // Wins ending at 0 and 7 min; the 16-min read counts both: 1500 + 16 + 15.3.
  const readings = [{ at: at(-20), psr: 1500 }, { at: at(16), psr: 1531 }]
  const first = { endAt: at(0), won: true, enemyPsr: null }
  const stored = estimatePsr([first, { endAt: at(7), won: true, enemyPsr: null }], readings, 0, null)
  assert.deepEqual(stored, { before: 1500, siteBefore: 1500, siteAfter: null })
  assert.deepEqual(psrColumn(stored!, true, 1500), { psr: 1516, change: 16, formulaMiss: null })
  // Not stored yet, the next battle cannot take the read: the path pins it on this one, so the
  // recheck computes PSR_RECHECK_STORE_WAIT_SEC after its read. The points stay this battle's.
  const unstored = estimatePsr([first], readings, 0, null)
  assert.deepEqual(unstored, { before: 1500, siteBefore: 1500, siteAfter: 1531 })
  assert.deepEqual(psrColumn(unstored!, true, 1500), { psr: 1531, change: 16, formulaMiss: 15 })
})

test('an earlier battle counts with its enemy team\'s average PSR', () => {
  const battles: PsrBattle[] = [
    { endAt: at(0), won: true, enemyPsr: 1800 },
    { endAt: at(10), won: true, enemyPsr: null },
  ]
  // A win at 1700 over a team averaging 1800 gives +20.5, over a team at 1500 or less +7.7.
  const before = estimatePsr(battles, [{ at: at(-20), psr: 1700 }], 1, null)?.before
  assert.equal(before, psrAfterBattle(1700, true, 1800))
  assert.ok(Math.abs(before! - 1720.5) < 0.1)
})

test('the column takes the page\'s PSR after the battle, and its change only past the page\'s rounding', () => {
  const estimate = (before: number, siteBefore: number | null, siteAfter: number | null): PsrEstimate =>
    ({ before, siteBefore, siteAfter })
  // The page rounds both readings: 1500 → 1517 is the formula's +16 within a point.
  assert.deepEqual(psrColumn(estimate(1500, 1500, 1517), true, 1500), { psr: 1517, change: 16, formulaMiss: 1 })
  // The formula misses the battle: the page's own change.
  assert.deepEqual(psrColumn(estimate(1500, 1500, 1519), true, 1500), { psr: 1519, change: 19, formulaMiss: 3 })
  // Beyond PAGE_MISS_MAX the page holds another battle too: the formula's points, still counted as a miss.
  assert.deepEqual(psrColumn(estimate(1500, 1500, 1528), true, 1500), { psr: 1528, change: 16, formulaMiss: 12 })
  // So does a page that drops over a win: +1.7 by the formula, not the page's -1.
  const win = psrColumn(estimate(2000, 2000, 1999), true, 1500)
  assert.equal(win.psr, 1999)
  assert.ok(Math.abs(win.change! - 1.7) < 0.05 && Math.abs(win.formulaMiss! + 2.7) < 0.05)
  // Without a reading isolating the battle the change stays the formula's.
  assert.deepEqual(psrColumn(estimate(1500, null, 1528), true, 1500), { psr: 1528, change: 16, formulaMiss: null })
  assert.deepEqual(psrColumn(estimate(1500, 1500, null), false, 1500), { psr: 1484, change: -16, formulaMiss: null })
  // A loss to a stronger team costs less.
  assert.equal(Math.round(psrColumn(estimate(1500, 1500, null), false, 1800).change!), -5)
  assert.deepEqual(psrColumn(estimate(1500, null, null), null, 1500), { psr: 1500, change: null, formulaMiss: null })
})

test('the season start anchors a new player: the first win shows within seconds', () => {
  const battles: PsrBattle[] = [
    { endAt: at(0), won: true, enemyPsr: null },
    { endAt: at(11), won: true, enemyPsr: null },
  ]
  const readings = [{ at: at(0, 28), psr: 32 }]
  // PSR 0 at the season start: 32 already counts the first win, though it ended 28 s before the read.
  assert.equal(estimatePsr(battles, readings, 1, base - 24 * HOUR)?.before, 32)
  // Without the anchor the read time alone says the win is not counted yet.
  assert.equal(Math.round(estimatePsr(battles, readings, 1, null)!.before), 64)
})

test('a season-start chain that misses the first reading by more than a battle is ignored', () => {
  // The database lacks this player's earlier battles: from 0 the chain cannot reach 1500.
  const battles: PsrBattle[] = [
    { endAt: at(-20), won: true, enemyPsr: null },
    { endAt: at(0), won: true, enemyPsr: null },
  ]
  assert.equal(estimatePsr(battles, [{ at: at(0, 30), psr: 1500 }], 1, base - 24 * HOUR)?.before, 1500)
})

test('no reading within an hour after the battle and none before it: no PSR', () => {
  assert.equal(estimatePsr([{ endAt: at(0), won: true, enemyPsr: null }], [{ at: at(61), psr: 1516 }], 0, null), null)
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

    assert.deepEqual(battlePsr({ ...input, winnerTeam: 1 }), new Map([['7', { psr: 1516, change: 16, formulaMiss: null }]]))
    assert.deepEqual(battlePsr({ ...input, winnerTeam: null }), new Map([['7', { psr: 1500, change: null, formulaMiss: null }]]))

    // The enemy team averages 1800 by its players' PSR before the battle: a win at 1500 gives +27.
    saveClanRatingSnapshots('=TST=', [{ nick: 'Pilot', rating: 1500 }, { nick: 'Stranger', rating: 1800 }])
    const strong = battlePsr({ ...input, winnerTeam: 1 })
    const pilot = strong.get('7')!
    assert.equal(pilot.change, psrAfterBattle(1500, true, 1800) - 1500)
    assert.equal(Math.round(pilot.change!), 27)
    // Stranger has no stored battles: their reading is their PSR before it.
    assert.equal(strong.get('8')!.psr, psrAfterBattle(1800, false, 1500))
  } finally {
    closeDb()
  }
})
