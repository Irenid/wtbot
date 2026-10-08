import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cachedNickIndex,
  foldNick,
  foldRead,
  foldSound,
  NickIndex,
  prepareNickQuery,
  rankNicks,
  scoreNick,
  switchLayout,
} from './nick-search.js'

/** [cost in quarter edits, kind, literal] or null. */
const score = (query: string, nick: string) => {
  const result = scoreNick(prepareNickQuery(query), nick)
  return result && [result.cost, result.kind, result.literal]
}

test('the look view folds look-alikes to Latin, letters and digits only', () => {
  assert.equal(foldNick('Zоroaster'), 'zoroaster') // Cyrillic о
  assert.equal(foldNick('__Blеssеd__'), 'blessed') // Cyrillic е
  assert.equal(foldNick('ВеТеРоК'), 'betepok')
  assert.equal(foldNick('ΛNDERS'), 'anders')
  assert.equal(foldNick('Zefix_7@psn'), 'zefix7')
  assert.equal(foldNick('Loupák'), 'loupak')
  assert.equal(foldNick('ёлка'), foldNick('Елка'))
  assert.equal(foldNick('山田 妖精'), '山田妖精')
})

test('the read view reads Latin look-alikes and volapuk as Russian', () => {
  assert.equal(foldRead('AKYJIA'), 'акула')
  assert.equal(foldRead('4ert_Ha_CB9I3u'), 'чертнасвязи')
  assert.equal(foldRead('AIIOSTOJI'), 'апостол')
  assert.equal(foldRead('BblMblCEJI'), 'вымысел')
  assert.equal(foldRead('Ветерок'), 'ветерок')
})

test('the sound view merges spellings of one sound', () => {
  assert.equal(foldSound('Ветерок'), foldSound('veterok'))
  assert.equal(foldSound('Хулиган'), foldSound('khuligan'))
  assert.equal(foldSound('Хулиган'), foldSound('huligan'))
  assert.equal(foldSound('Цапля'), foldSound('tsaplya'))
  assert.equal(foldSound('Цапля'), foldSound('caplja'))
  assert.equal(foldSound('Щука'), foldSound('shchuka'))
})

test('a query switches to the other keyboard layout', () => {
  assert.equal(switchLayout('ghbdtn'), 'привет')
  assert.equal(switchLayout('зшдще'), 'pilot')
  assert.equal(switchLayout('pilotпилот'), null)
  assert.equal(switchLayout('1488'), null)
})

test('a nick matches whole, by its start or inside, at a cost in quarter edits', () => {
  assert.deepEqual(score('Pilot', 'pilot'), [0, 0, true])
  assert.deepEqual(score('zoroaster', 'Zоroaster'), [0, 0, false])
  assert.deepEqual(score('pilo', 'Pilot42'), [0, 1, true])
  assert.deepEqual(score('pilot', 'xX_Pilot_Xx'), [0, 2, true])
  assert.deepEqual(score('pilto', 'Pilot'), [4, 0, false]) // an adjacent swap is one edit
  assert.deepEqual(score('pilto', 'Pilot_2008'), [4, 1, false])
  assert.deepEqual(score('vovnazmje', 'Vovanzmej'), [8, 0, false])
  assert.equal(score('vovanzmej', 'Vxvxnzmxj'), null) // 3 edits
  assert.equal(score('pil', 'pol'), null) // under 4 characters: no edits
  assert.equal(score('1488', '1489'), null) // digits: another number, not a typo
})

test('a letter typed for a lone digit is cheap; a digit for a letter, or within a number, is an edit', () => {
  assert.deepEqual(score('vadim', 'Vad1m'), [1, 0, false])
  assert.deepEqual(score('blockmonster', 'Bl0ckm0nst3rLP'), [3, 1, false])
  assert.deepEqual(score('vad1m', 'Vadim'), [4, 0, false])
  assert.deepEqual(score('pilot2009', 'pilot2008'), [4, 0, false])
})

test('another view or layout ranks an edit lower', () => {
  assert.deepEqual(score('акула', 'AKYJIA_N3_NKEN'), [4, 1, false])
  assert.deepEqual(score('veterok', 'Ветерок'), [4, 0, false])
  assert.deepEqual(score('зороастр', 'Zоroaster'), [8, 0, false])
  assert.deepEqual(score('ящкщфыеук', 'Zоroaster'), [4, 0, false])
  // A wrong layout and a typo at once.
  assert.deepEqual(score('ящкщфыук', 'Zоroaster'), [8, 0, false])
})

test('nicks rank by match; equal matches keep their order', () => {
  assert.deepEqual(
    rankNicks('pilot', ['Tank', 'Plot', 'Pilto', 'xX_Pilot_Xx', 'Pilot_B', 'Pilot_A', 'Pi_lot', 'Pilot']),
    ['Pilot', 'Pi_lot', 'Pilot_B', 'Pilot_A', 'xX_Pilot_Xx', 'Plot', 'Pilto'],
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
