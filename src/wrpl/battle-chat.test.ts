import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBattleChat } from './battle-chat.js'
import type { ReplayEvents, SlotPlayer } from './replay-events.js'

const slot = (userId: string, name: string, clanTag: string): SlotPlayer => ({ slot: 0, userId, name, clanTag, title: '', team: 1 })
const events = (players: SlotPlayer[], senders: string[]): ReplayEvents => ({
  teamWon: 0,
  players,
  kills: [],
  damage: [],
  chat: senders.map((sender, i) => ({ time: (61 + i) * 1000, sender, channel: 0, message: 'go' })),
  units: [],
  zones: [],
  endTime: 0,
  errors: [],
})

test('a sender the game left without a tag gets the tag of the results row', () => {
  const text = formatBattleChat(
    events([slot('1', 'Alpha', ''), slot('2', 'Bravo', '=AAA='), slot('3', 'Charlie', '')], ['Alpha', 'Bravo', 'Charlie']),
    [
      { userId: '1', clanTag: '=AAA=' },
      { userId: '2', clanTag: '=AAA=' },
      { userId: '3', clanTag: '' },
    ],
  )
  assert.equal(text, ['[1:01] [TEAM] [=AAA=] Alpha: go', '[1:02] [TEAM] [=AAA=] Bravo: go', '[1:03] [TEAM] Charlie: go'].join('\n'))
})

test('a battle without chat says so', () => {
  assert.equal(formatBattleChat(events([], []), []), 'Nobody wrote in the chat in this battle.')
})
