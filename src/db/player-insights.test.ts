import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getPlayerReplayInsights,
  initDb,
  saveBattle,
  type BattleInput,
  type BattleKillInput,
  type BattlePlayerInput,
} from './index.js'

function player(userId: string, nick: string, team: number, clanTag: string, vehicles: string[]): BattlePlayerInput {
  return {
    userId, nick, clanTag, team,
    kills: 0, groundKills: 0, navalKills: 0, aiKills: 0, aiGroundKills: 0, assists: 0, deaths: 0,
    captureZone: 0, damageZone: 0, score: 0, awardDamage: 0, teamKills: 0, squadId: -1,
    vehicle: vehicles[0] ?? null, vehicles, disconnected: false, slot: null, title: null, autoSquad: null,
  }
}

function kill(killerId: string, killerModel: string, victimId: string, victimModel: string, weapon: string): BattleKillInput {
  return { timeMs: 1, killerId, killerModel, victimId, victimModel, weapon, killerPos: null, victimPos: null }
}

function battle(
  sessionId: string,
  startTime: number,
  missionName: string,
  teamWon: number,
  players: BattlePlayerInput[],
  kills: BattleKillInput[],
): BattleInput {
  return {
    sessionId, sessionHex: sessionId.padStart(16, '0'), missionName, level: 'l', gameMode: null, battleType: null,
    environment: null, status: null, startTime, durationSec: 600, endTimeMs: 0, teamWon, gameVersion: null,
    missionSettings: null, players, kills, chat: [], eventsBlob: Buffer.from('x'),
  }
}

test('аналитика игрока по реплеям: карты, техника, кланы, напарники и соперники', () => {
  initDb(':memory:')
  try {
    // Бой 1: игрок 1 (клан TST) с напарником 2 против клана OPP (3 и 4), победа.
    saveBattle(battle('1', 1_000, 'Карта А', 1, [
      player('1', 'Pilot', 1, '=TST=', ['us_m1', 'f_16']),
      player('2', 'Mate', 1, '=TST=', ['us_m1']),
      player('3', 'Rival', 2, '╔OPP╕', ['ussr_t80']),
      player('4', 'Rival2', 2, '╔OPP╕', ['ussr_t80']),
    ], [
      kill('1', 'tankModels/us_m1', '3', 'tankModels/ussr_t80', 'shell_a'),
      kill('1', 'f_16', '4', 'tankModels/ussr_t80', 'bomb_b'),
      kill('3', 'tankModels/ussr_t80', '1', 'tankModels/us_m1', 'shell_c'),
      // Свой и дрон не считаются соперниками.
      kill('1', 'tankModels/us_m1', '2', 'tankModels/us_m1', 'shell_a'),
      kill('1', 'tankModels/us_m1', '', 'ucav_recon_micro', 'shell_a'),
    ]))
    // Бой 2: тот же напарник, против OPP, поражение, другая карта.
    saveBattle(battle('2', 2_000, 'Карта Б', 2, [
      player('1', 'Pilot', 1, '=TST=', ['us_m1']),
      player('2', 'Mate', 1, '=TST=', ['us_m1']),
      player('3', 'Rival', 2, '-OPP-', ['ussr_t80']),
      player('4', 'Rival2', 2, '-OPP-', ['ussr_t80']),
    ], [kill('3', 'tankModels/ussr_t80', '1', 'tankModels/us_m1', 'shell_c')]))
    // Бой 3: вне периода.
    saveBattle(battle('3', 10, 'Карта В', 1, [player('1', 'Pilot', 1, '=TST=', ['us_m1'])], []))

    const insights = getPlayerReplayInsights('1', 100, 5_000)
    assert.equal(insights.battles, 2)
    assert.equal(insights.capped, false)
    assert.deepEqual(insights.starts, [2_000, 1_000], 'от новых к старым')
    // При равном числе боёв порядок — как у боёв, от новых к старым.
    assert.deepEqual(insights.maps.map((map) => [map.mission, map.battles, map.wins, map.losses]), [
      ['Карта Б', 1, 0, 1],
      ['Карта А', 1, 1, 0],
    ])
    const m1 = insights.vehicles.find((vehicle) => vehicle.vehicleId === 'us_m1')
    assert.deepEqual(m1, { vehicleId: 'us_m1', battles: 2, wins: 1, kills: 3, deaths: 2 },
      'убийства и смерти по технике — включая своих и дрон в счёте фрагов машины')
    assert.deepEqual(insights.vehicles.find((vehicle) => vehicle.vehicleId === 'f_16'), {
      vehicleId: 'f_16', battles: 1, wins: 1, kills: 1, deaths: 0,
    })
    assert.deepEqual(insights.playedFor, [{ clanTag: '=TST=', battles: 2, wins: 1, losses: 1 }])
    assert.deepEqual(insights.opponents, [{ clanTag: '-OPP-', battles: 2, wins: 1, losses: 1 }],
      'ядро тега одно, показывается последний вариант украшений')
    assert.deepEqual(insights.teammates, [{ userId: '2', count: 2, wins: 1, nick: 'Mate' }])
    assert.deepEqual(insights.weapons, [{ weapon: 'shell_a', kills: 3 }, { weapon: 'bomb_b', kills: 1 }])
    assert.deepEqual(insights.victims, [{ vehicleId: 'ussr_t80', kills: 2 }])
    assert.deepEqual(insights.killers, [{ vehicleId: 'ussr_t80', kills: 2 }])
    assert.deepEqual(insights.preys, [{ userId: '3', nick: 'Rival', count: 1 }, { userId: '4', nick: 'Rival2', count: 1 }])
    assert.deepEqual(insights.nemeses, [{ userId: '3', nick: 'Rival', count: 2 }])

    assert.equal(getPlayerReplayInsights('404', 0, 5_000).battles, 0)
    assert.throws(() => getPlayerReplayInsights('Pilot', 0, 1), /numeric WT user id/)
  } finally {
    closeDb()
  }
})
