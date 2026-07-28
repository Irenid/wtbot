import assert from 'node:assert/strict'
import {
  closeDb,
  disablePlayerStatBoard,
  getPlayerStatBoard,
  getWtPlayerSnapshotAtOrBefore,
  initDb,
  recordParseResult,
  saveItems,
  savePlayerStatBoard,
  updatePlayerStatBoardPublication,
  type ParsedItem,
  type StoredItem,
} from '../db/index.js'
import { renderPlayerBoard, type PlayerBoardEntry } from '../bot/player-board.js'

const nowSec = Math.floor(Date.now() / 1000)

function makeItem(completedMissions: string, victories: string): ParsedItem {
  return {
    externalId: '12345',
    title: 'SmokePlayer',
    data: {
      profile: {
        nickname: 'SmokePlayer',
        clan: 'TEST',
        level: 100,
        registrationDate: '01.01.2020',
        avatar: null,
      },
      statistics: {
        arcade: {
          Statistics: 'Arcade battles',
          Victories: victories,
          'Completed missions': completedMissions,
          'Victories/battles ratio': '50%',
          Deaths: '10',
          'Air targets destroyed': '4',
          'Ground targets destroyed': '5',
          'Naval targets destroyed': '1',
        },
        realistic: {},
        simulation: {},
      },
      replayIdentity: null,
      replayCount: 2,
      replays: [],
    },
  }
}

try {
  initDb(':memory:')
  const first = makeItem('100', '50')
  assert.deepEqual(saveItems('wt-players', [first]), { changed: 1, unchanged: 0 })
  recordParseResult('wt-players', true, 'smoke', null)

  const snapshot = getWtPlayerSnapshotAtOrBefore('12345', 'SmokePlayer', nowSec + 1)
  assert.ok(snapshot)
  assert.equal(snapshot.nickname, 'SmokePlayer')

  savePlayerStatBoard('guild-1', 'channel-1', 'message-1', 'a'.repeat(64))
  assert.equal(getPlayerStatBoard('guild-1')?.enabled, true)
  updatePlayerStatBoardPublication('guild-1', 'message-2', 'b'.repeat(64))
  assert.equal(getPlayerStatBoard('guild-1')?.messageId, 'message-2')
  assert.equal(disablePlayerStatBoard('guild-1'), true)
  assert.equal(getPlayerStatBoard('guild-1')?.enabled, false)

  const previousData = JSON.parse(JSON.stringify(first.data)) as Record<string, unknown>
  const previousStatistics = previousData['statistics'] as Record<string, unknown>
  const previousArcade = previousStatistics['arcade'] as Record<string, unknown>
  previousArcade['Completed missions'] = '88'
  previousArcade['Victories'] = '44'
  const current: StoredItem = {
    id: 1,
    source: 'wt-players',
    externalId: first.externalId,
    title: first.title,
    data: first.data,
    updatedAt: nowSec,
    analysis: null,
  }
  const entry: PlayerBoardEntry = {
    item: current,
    baselineData: previousData,
    baselineAt: nowSec - 100,
  }
  const render = renderPlayerBoard(
    [entry],
    { source: 'wt-players', ok: true, summary: 'smoke', error: null, parsedAt: nowSec },
    nowSec,
  )
  const rendered = JSON.stringify(render.payload)
  assert.match(rendered, /\+12\/24ч/)
  assert.match(rendered, /\+6\/24ч/)
  assert.equal(render.contentHash.length, 64)
  assert.equal(
    renderPlayerBoard(
      [entry],
      { source: 'wt-players', ok: true, summary: 'smoke', error: null, parsedAt: nowSec },
      nowSec,
    ).contentHash,
    render.contentHash,
  )

  console.log('player-board smoke: OK')
} catch (error) {
  console.error('player-board smoke: FAIL', error)
  process.exitCode = 1
} finally {
  closeDb()
}
