import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  CLAN_FULL_CRAWL_KEY,
  closeDb,
  getSquadronFigures,
  getSquadronLeaderboardPlace,
  getSquadronResults,
  initDb,
  saveBattle,
  saveClanLeaderboard,
  setBotState,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import { botText } from '../i18n/index.js'
import { squadronStanding, standingText } from './commands/battle.js'

const DAY = Date.UTC(2026, 9, 14) / 1_000
const HOUR = 3_600
const WLILY = '┾WLILY┿'
const NATOE = '╝NATOe╝'

function player(userId: string, clanTag: string, team: number): BattlePlayerInput {
  return {
    userId, nick: `p${userId}`, clanTag, team,
    kills: 0, groundKills: 0, navalKills: 0, aiKills: 0, aiGroundKills: 0, assists: 0, deaths: 0,
    captureZone: 0, damageZone: 0, score: 0, awardDamage: 0, teamKills: 0, squadId: 4096,
    vehicle: null, vehicles: [], disconnected: false, slot: null, title: null, autoSquad: null,
  }
}

function battle(sessionId: string, startTime: number, teamWon: number, players: BattlePlayerInput[]): BattleInput {
  return {
    sessionId, sessionHex: sessionId.padStart(16, '0'), missionName: 'test', level: 'test',
    gameMode: null, battleType: null, environment: null, status: null,
    startTime, durationSec: 900, endTimeMs: 0, teamWon, gameVersion: null, missionSettings: null,
    players, kills: [], chat: [], eventsBlob: Buffer.from('test'),
  }
}

/** Two players of `ours` in team `team`, two of NATOe in the other. */
function squadronBattle(sessionId: string, startTime: number, teamWon: number, ours: string, team: number): BattleInput {
  const other = team === 1 ? 2 : 1
  return battle(sessionId, startTime, teamWon, [
    player(`${sessionId}1`, ours, team), player(`${sessionId}2`, ours, team),
    player(`${sessionId}3`, NATOE, other), player(`${sessionId}4`, NATOE, other),
  ])
}

const LEADERBOARD_ROW = { name: 'WLILY', rating: 1_000, members: 20, battles: 100, wins: 60 }

test('a squadron\'s day record counts each decided battle once, inside the period only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-squadron-results-'))
  const dbPath = path.join(root, 'results.db')
  try {
    initDb(dbPath, { allowCreate: true })
    saveBattle(squadronBattle('11', DAY - HOUR, 1, WLILY, 1)) // the day before
    saveBattle(squadronBattle('12', DAY + 14 * HOUR, 1, WLILY, 1)) // won
    saveBattle(squadronBattle('13', DAY + 15 * HOUR, 1, WLILY, 2)) // lost
    saveBattle(squadronBattle('14', DAY + 16 * HOUR, 0, WLILY, 1)) // winner unknown
    saveBattle(squadronBattle('15', DAY + 18 * HOUR, 2, WLILY, 2)) // after the bound
    // A player without a team (0) is no second team of the squadron.
    saveBattle(battle('16', DAY + 17 * HOUR, 2, [
      player('161', WLILY, 2), player('162', WLILY, 0), player('163', NATOE, 1),
    ]))

    assert.deepEqual(getSquadronResults(WLILY, DAY, DAY + 17 * HOUR), { wins: 2, losses: 1 })
    assert.deepEqual(getSquadronResults(NATOE, DAY, DAY + 17 * HOUR), { wins: 1, losses: 2 })
    assert.deepEqual(getSquadronResults('-NONE-', DAY, DAY + 17 * HOUR), { wins: 0, losses: 0 })
    closeDb()

    // The day's battles drive the join (getSquadronResults): never the tag's whole history.
    const reader = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const plan = reader.prepare(`
        EXPLAIN QUERY PLAN
        SELECT
          COUNT(DISTINCT CASE WHEN b.team_won = bp.team THEN b.session_id END) AS wins,
          COUNT(DISTINCT CASE WHEN b.team_won > 0 AND b.team_won <> bp.team THEN b.session_id END) AS losses
        FROM battles b CROSS JOIN battle_players bp
        WHERE b.start_time >= ? AND b.start_time <= ?
          AND bp.clan_tag = ? AND bp.session_id = b.session_id AND bp.team > 0
      `).all(DAY, DAY + 17 * HOUR, WLILY) as { detail: string }[]
      const searches = plan.map((row) => row.detail).filter((detail) => detail.startsWith('SEARCH'))
      assert.match(searches[0] ?? '', /^SEARCH b USING (?:COVERING )?INDEX idx_battles_start/)
      assert.match(searches[1] ?? '', /^SEARCH bp USING (?:INDEX idx_bp_clan_session|PRIMARY KEY) \(.*session_id=\?/)
    } finally {
      reader.close()
    }
  } finally {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the leaderboard place is the table\'s own number, hidden once the last full crawl missed the squadron', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([{ tag: WLILY, position: 105, ...LEADERBOARD_ROW }], DAY + 14 * HOUR)
    assert.deepEqual(getSquadronLeaderboardPlace(WLILY), { place: 105, readAt: DAY + 14 * HOUR })
    assert.equal(getSquadronLeaderboardPlace('┾WLILY'), null, 'only the tag as decorated in replays')

    setBotState(CLAN_FULL_CRAWL_KEY, String(DAY + 14 * HOUR))
    assert.equal(getSquadronLeaderboardPlace(WLILY)?.place, 105, 'read by the last full crawl')
    setBotState(CLAN_FULL_CRAWL_KEY, String(DAY + 20 * HOUR))
    assert.equal(getSquadronLeaderboardPlace(WLILY), null, 'missed by a later full crawl: disbanded or at zero')
  } finally {
    closeDb()
  }
})

test('squadron figures are found by tag core, and the place goes stale after a later full crawl', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([{ tag: WLILY, position: 105, ...LEADERBOARD_ROW }], DAY + 14 * HOUR)
    assert.deepEqual(getSquadronFigures('wlily'), { members: LEADERBOARD_ROW.members, place: 105, averageRating: null })
    assert.equal(getSquadronFigures('nobody'), null)
    setBotState(CLAN_FULL_CRAWL_KEY, String(DAY + 20 * HOUR))
    assert.deepEqual(getSquadronFigures('wlily'), { members: LEADERBOARD_ROW.members, place: null, averageRating: null })
  } finally {
    closeDb()
  }
})

test('the standing line shows the place near the battle and the day\'s record up to it', () => {
  initDb(':memory:')
  try {
    saveClanLeaderboard([{ tag: WLILY, position: 37, ...LEADERBOARD_ROW }], DAY + 15 * HOUR)
    saveBattle(squadronBattle('21', DAY + 14 * HOUR, 1, WLILY, 1))
    saveBattle(squadronBattle('22', DAY + 15 * HOUR, 2, WLILY, 1))
    saveBattle(squadronBattle('23', DAY + 16 * HOUR, 1, WLILY, 1))

    const en = botText('en')
    assert.equal(squadronStanding(WLILY, DAY + 15 * HOUR, en), '#37 1W 1L')
    assert.equal(squadronStanding(WLILY, DAY + 16 * HOUR, en), '#37 2W 1L')
    // Two days later: today's place says nothing about that battle, the record still does.
    saveBattle(squadronBattle('24', DAY + 2 * 86_400 + 14 * HOUR, 1, WLILY, 1))
    assert.equal(squadronStanding(WLILY, DAY + 2 * 86_400 + 14 * HOUR, en), '1W 0L')
    assert.equal(squadronStanding(NATOE, DAY + 13 * HOUR, en), null, 'no place, no decided battle yet')
  } finally {
    closeDb()
  }
})

test('the standing\'s format', () => {
  const en = botText('en')
  const ru = botText('ru')
  assert.equal(standingText(37, { wins: 8, losses: 3 }, en), '#37 8W 3L')
  assert.equal(standingText(null, { wins: 1, losses: 1 }, en), '1W 1L')
  assert.equal(standingText(5, { wins: 0, losses: 0 }, en), '#5')
  assert.equal(standingText(null, { wins: 0, losses: 0 }, en), null)
  assert.equal(standingText(1, { wins: 21, losses: 5 }, ru), '#1 21В 5П')
  assert.equal(standingText(null, { wins: 2, losses: 0 }, ru), '2В 0П')
  assert.equal(standingText(null, { wins: 11, losses: 22 }, ru), '11В 22П')
})
