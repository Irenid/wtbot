import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getClanSeasonContext,
  getVoiceClanTags,
  getVoiceDashboardRows,
  initDb,
  saveBattle,
  saveClanRatingSnapshots,
  upsertVoicePresence,
  type BattleInput,
  type BattlePlayerInput,
} from './index.js'

function player(userId: string, nick: string, clanTag: string): BattlePlayerInput {
  return {
    userId, nick, clanTag, team: 1,
    kills: 0, groundKills: 0, navalKills: 0, aiKills: 0, aiGroundKills: 0, assists: 0, deaths: 0,
    captureZone: 0, damageZone: 0, score: 0, awardDamage: 0, teamKills: 0, squadId: -1,
    vehicle: null, vehicles: [], disconnected: false, slot: null, title: null, autoSquad: null,
  }
}

function battle(sessionId: string, startTime: number, players: BattlePlayerInput[]): BattleInput {
  return {
    sessionId, sessionHex: sessionId.padStart(16, '0'), missionName: 'm', level: 'l', gameMode: null,
    battleType: null, environment: null, status: null, startTime, durationSec: 600, endTimeMs: 0, teamWon: 1,
    gameVersion: null, missionSettings: null, players, kills: [], chat: [], eventsBlob: Buffer.from('x'),
  }
}

function inVoice(userId: string, channelId: string, wtNick: string): void {
  upsertVoicePresence({
    guildId: 'g', guildName: 'Guild', channelId, channelName: channelId, userId, displayName: `${wtNick} (name)`, wtNick,
  })
}

test('voice dashboard: season battles and PSR by base nick, voice clans', () => {
  initDb(':memory:')
  try {
    const season = getClanSeasonContext().season
    assert.ok(season, 'initDb seeds the built-in seasons')
    const base = Math.max(season.startsAt, Math.floor(Date.now() / 1_000) - 7_200)
    // The console suffix is dropped: Pilot@psn in battles is Pilot in voice.
    saveBattle(battle('1', base + 10, [player('1', 'Pilot@psn', '=TST='), player('2', 'Other', '=TST=')]))
    saveBattle(battle('2', base + 20, [player('1', 'Pilot@psn', '=TST=')]))
    // A battle before the season does not count.
    saveBattle(battle('3', season.startsAt - 60, [player('1', 'Pilot@psn', '=TST=')]))
    saveClanRatingSnapshots('=TST=', [{ nick: 'Pilot', rating: 100 }])
    saveClanRatingSnapshots('=TST=', [{ nick: 'Pilot', rating: 130 }])
    // A clan change has no delta: the ratings belong to different squadrons.
    saveClanRatingSnapshots('=OLD=', [{ nick: 'Mover', rating: 200 }])
    saveClanRatingSnapshots('=NEW=', [{ nick: 'Mover', rating: 150 }])
    saveClanRatingSnapshots('=OTH=', [{ nick: 'Other', rating: 50 }])
    inVoice('u1', 'c1', 'Pilot')
    inVoice('u2', 'c2', 'Mover')
    inVoice('u3', 'c3', 'Nobody')

    assert.deepEqual(
      getVoiceDashboardRows().map((row) => [row.wtNick, row.clanTag, row.rating, row.delta, row.battles, row.lastBattleAt]),
      [
        ['Pilot', '=TST=', 130, 30, 2, base + 20],
        ['Mover', '=NEW=', 150, null, 0, null],
        ['Nobody', null, null, null, 0, null],
      ],
    )
    // Latest clan of each voice member; Other is not in voice.
    assert.deepEqual(getVoiceClanTags(), ['=NEW=', '=TST='])
  } finally {
    closeDb()
  }
})
