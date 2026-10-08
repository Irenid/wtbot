import assert from 'node:assert/strict'
import test from 'node:test'
import { fillSquadronTags, type SquadronTagPlayer } from './squadron-tags.js'

/** A squadron-battle player: team 1 carries marker 4096, team 2 — 4097. */
const player = (userId: string, team: number, clanTag: string, squadId = 4095 + team): SquadronTagPlayer => ({
  userId,
  clanTag,
  team,
  squadId,
})
const tags = (players: readonly SquadronTagPlayer[]): string[] => players.map((p) => p.clanTag)

test('an untagged player of a squadron-battle team gets the team tag; bots and team 0 stay as recorded', () => {
  const players = [
    player('1', 1, '╖TEHb╖'),
    player('2', 1, ''),
    player('3', 1, '╖TEHb╖'),
    player('-13', 1, '', 4096), // a bot slot
    player('4', 0, '', 4096), // never loaded in, team not resolved
    player('5', 2, '-AURI-'),
    player('6', 2, ''),
  ]
  fillSquadronTags(players)
  assert.deepEqual(tags(players), ['╖TEHb╖', '╖TEHb╖', '╖TEHb╖', '', '', '-AURI-', '-AURI-'])
})

test('decorations of one squadron: the most frequent tag, a tie the smaller one in any order', () => {
  const frequent = [player('1', 1, '=5XC='), player('2', 1, '┺5XC┻'), player('3', 1, '┺5XC┻'), player('4', 1, '')]
  fillSquadronTags(frequent)
  assert.equal(frequent[3]!.clanTag, '┺5XC┻')

  const tie = (first: string, second: string): string => {
    const players = [player('1', 1, first), player('2', 1, second), player('3', 1, '')]
    fillSquadronTags(players)
    return players[2]!.clanTag
  }
  assert.equal(tie('-DEX-', '┾DEX┿'), '-DEX-')
  assert.equal(tie('┾DEX┿', '-DEX-'), '-DEX-')
})

test('no fill without one squadron or without the squadron-battle marker', () => {
  const twoSquadrons = [player('1', 1, '=AAA='), player('2', 1, '=BBB='), player('3', 1, '')]
  // A random battle: platoons and solo players carry different squad ids.
  const random = [player('1', 1, '=AAA=', 12), player('2', 1, '', 12), player('3', 1, '', -1)]
  // Every player in one squad, but not the team's marker.
  const offMarker = [player('1', 1, '=AAA=', 4097), player('2', 1, '', 4097)]
  const noTags = [player('1', 2, ''), player('2', 2, '')]
  for (const players of [twoSquadrons, random, offMarker, noTags]) {
    const before = tags(players)
    fillSquadronTags(players)
    assert.deepEqual(tags(players), before)
  }
})

test('one team off its marker does not stop the other team', () => {
  const players = [player('1', 1, '=AAA='), player('2', 1, '', 1000), player('3', 2, '=BBB='), player('4', 2, '')]
  fillSquadronTags(players)
  assert.deepEqual(tags(players), ['=AAA=', '', '=BBB=', '=BBB='])
})
