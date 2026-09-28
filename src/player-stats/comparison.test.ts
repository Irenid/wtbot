import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getPlayerIdentityByWtUserId,
  initDb,
  saveBattle,
  savePlayerIdentity,
} from '../db/index.js'
import { resolveKnownPlayer } from './comparison.js'

function replayPlayer(userId: string, nick: string) {
  return {
    userId,
    nick,
    clanTag: '',
    team: 1,
    kills: 0,
    groundKills: 0,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 0,
    deaths: 0,
    captureZone: 0,
    damageZone: 0,
    score: 0,
    awardDamage: 0,
    teamKills: 0,
    squadId: -1,
    vehicle: null,
    vehicles: [],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
  }
}

function saveReplay(sessionId: string, players: ReturnType<typeof replayPlayer>[]): void {
  saveBattle({
    sessionId,
    sessionHex: sessionId.padStart(16, '0'),
    missionName: 'fixture',
    level: 'fixture',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime: 100,
    durationSec: 0,
    endTimeMs: 0,
    teamWon: 0,
    gameVersion: null,
    missionSettings: null,
    players,
    kills: [],
    chat: [],
    eventsBlob: Buffer.from('{}'),
  })
}

function nickOnlyIdentity(nick: string) {
  return savePlayerIdentity({
    wtUserId: null,
    canonicalNick: nick,
    platform: null,
    aliases: [{
      source: 'voice',
      externalId: null,
      nick,
      seenAt: 10,
      matchMethod: 'exact_nick',
      matchConfidence: 'medium',
    }],
  })
}

test('появившийся WT user id усыновляет существующую nick-only identity', () => {
  initDb(':memory:')
  try {
    // Игрок сначала стал identity по нику (voice), а потом попал в реплей с user id.
    const early = nickOnlyIdentity('Pilot')
    saveReplay('1', [replayPlayer('555', 'Pilot')])

    const resolved = resolveKnownPlayer('Pilot')
    assert.equal(resolved.status, 'ok')
    assert.ok(resolved.status === 'ok')
    assert.equal(resolved.identity.id, early.id, 'снимки прежней identity должны остаться достижимы')
    assert.equal(resolved.identity.wtUserId, '555')
    assert.equal(getPlayerIdentityByWtUserId('555')?.id, early.id)
  } finally {
    closeDb()
  }
})

test('несколько nick-only identity одного ника не сливаются автоматически', () => {
  initDb(':memory:')
  try {
    const first = nickOnlyIdentity('Twin')
    const second = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'Twin-second',
      platform: null,
      aliases: [{
        source: 'clan-rating',
        externalId: null,
        nick: 'Twin',
        seenAt: 20,
        matchMethod: 'exact_nick',
        matchConfidence: 'medium',
      }],
    })
    assert.notEqual(first.id, second.id)
    saveReplay('2', [replayPlayer('777', 'Twin')])

    const resolved = resolveKnownPlayer('Twin')
    assert.equal(resolved.status, 'ambiguous')
    assert.equal(getPlayerIdentityByWtUserId('777'), null, 'неоднозначный ник не должен получить user id')
  } finally {
    closeDb()
  }
})
