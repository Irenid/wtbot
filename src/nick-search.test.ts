import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedNickIndex, foldNick, NickIndex, prepareNickQuery, rankNicks, scoreNick, switchLayout } from './nick-search.js'

/** [edits, kind, literal, layout] or null. */
const score = (query: string, nick: string) => {
  const result = scoreNick(prepareNickQuery(query), nick)
  return result && [result.edits, result.kind, result.literal, result.layout]
}

test('a nick folds to Latin look-alikes, letters and digits', () => {
  assert.equal(foldNick('Zоroaster'), 'zoroaster') // Cyrillic о
  assert.equal(foldNick('__Blеssеd__'), 'blessed') // Cyrillic е
  assert.equal(foldNick('ВеТеРоК'), 'betepok')
  assert.equal(foldNick('Zefix_7@psn'), 'zefix7')
  assert.equal(foldNick('Loupák'), 'loupak')
  assert.equal(foldNick('ёлка'), foldNick('Елка'))
  assert.equal(foldNick('山田 妖精'), '山田妖精')
})

test('a query switches to the other keyboard layout', () => {
  assert.equal(switchLayout('ghbdtn'), 'привет')
  assert.equal(switchLayout('зшдще'), 'pilot')
  assert.equal(switchLayout('pilotпилот'), null)
  assert.equal(switchLayout('1488'), null)
})

test('a nick matches whole, by its start or inside, with edits by query length', () => {
  assert.deepEqual(score('Pilot', 'pilot'), [0, 0, true, false])
  assert.deepEqual(score('zoroaster', 'Zоroaster'), [0, 0, false, false])
  assert.deepEqual(score('pilo', 'Pilot42'), [0, 1, true, false])
  assert.deepEqual(score('pilot', 'xX_Pilot_Xx'), [0, 2, true, false])
  assert.deepEqual(score('pilto', 'Pilot'), [1, 0, false, false]) // an adjacent swap is one edit
  assert.deepEqual(score('pilto', 'Pilot_2008'), [1, 1, false, false])
  assert.deepEqual(score('leclerk', 'Char1es_Leclerc'), [1, 2, false, false])
  assert.deepEqual(score('vovnazmje', 'Vovanzmej'), [2, 0, false, false])
  assert.deepEqual(score('vovanzmeq', 'Vovanzmejx'), [1, 1, false, false]) // its start in 1 edit beats the whole in 2
  assert.equal(score('vovnazmjee', 'Vovanzmej'), null) // 3 edits
  assert.equal(score('pil', 'pol'), null) // under 4 characters: exact only
  assert.equal(score('1488', '1489'), null) // digits: another number, not a typo
  assert.equal(score('pilto', 'xx_pilot_xx'), null) // inside a nick: edits from 6 characters
  assert.deepEqual(score('ящкщфыеук', 'Zоroaster'), [0, 0, false, true])
})

test('nicks rank by match; equal matches keep their order', () => {
  assert.deepEqual(
    rankNicks('pilot', ['Tank', 'Plot', 'Pilto', 'xX_Pilot_Xx', 'Pilot_2008', 'Pi_lot', 'Pilot']),
    ['Pilot', 'Pi_lot', 'Pilot_2008', 'xX_Pilot_Xx', 'Plot', 'Pilto'],
  )
  assert.deepEqual(rankNicks(' ', ['b', 'a']), ['b', 'a'])
})

test('the index ranks by match, then battles, and returns keys as stored', () => {
  const index = new NickIndex([
    { key: 'pilot_2008', battles: 3 },
    { key: 'pilot_ace', battles: 9 },
    { key: 'pilot', battles: 1 },
    { key: 'john ', battles: 5 },
    { key: 'tank', battles: 50 },
  ])
  assert.equal(index.size, 5)
  assert.deepEqual(index.find(prepareNickQuery('pilot'), 3).map((hit) => hit.key), ['pilot', 'pilot_ace', 'pilot_2008'])
  assert.deepEqual(index.find(prepareNickQuery('john'), 5).map((hit) => hit.key), ['john '])
})

test('a worker reuses the index of one database', () => {
  let loads = 0
  const load = () => {
    loads += 1
    return [{ key: 'pilot', battles: 1 }]
  }
  const first = cachedNickIndex('nick-search-test-a.db', load)
  assert.equal(cachedNickIndex('nick-search-test-a.db', load), first)
  assert.equal(loads, 1)
  assert.notEqual(cachedNickIndex('nick-search-test-b.db', load), first)
  assert.equal(loads, 2)
})
