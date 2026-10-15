import assert from 'node:assert/strict'
import test from 'node:test'
import { ANONYMOUS_WINDOWS_SEC, fakeFirstName, fakeFirstNames, guessAnonymous, looksAnonymous } from './anonymous.js'

const names = fakeFirstNames(['Abraham5625', 'Kazuhiko4134', 'Cassidy35', 'not a fake', 'smoke5112'])

test('anonymiser names are a listed first name and 1–4 digits', () => {
  assert.deepEqual([...names].sort(), ['Abraham', 'Cassidy', 'Kazuhiko'])
  assert.equal(fakeFirstName('Akiyuki61'), 'Akiyuki')
  assert.equal(fakeFirstName('kexik1234'), null)
  assert.equal(fakeFirstName('Abraham56250'), null)
  assert.equal(fakeFirstName('Abraham'), null)
  assert.equal(looksAnonymous('Abraham1', names), true)
  // The last word: the squadron tag may stay in front of it.
  assert.equal(looksAnonymous('-BLOB1- Kazuhiko977', names), true)
  // Shaped like a fake, but a real nick's name is not on the list.
  assert.equal(looksAnonymous('Smoke5112', names), false)
})

test('the lone fake row is the squadron\'s only recent anonymous player; ties and doubt give no guess', () => {
  const now = 10_000_000
  const recent = { userId: '1', nick: 'Otamanchikk', lastSeen: now - 3_600 }
  const older = { userId: '2', nick: 'Other', lastSeen: now - 2 * 86_400 }
  const unread = ['Loupak', 'Abraham5625']
  // The 6 h window holds one: the older candidate does not matter.
  assert.deepEqual(guessAnonymous(unread, names, [recent, older], new Set(), now), { index: 1, userId: '1', nick: 'Otamanchikk' })
  // Nobody in 6 h: the 3 days hold one.
  assert.deepEqual(guessAnonymous(unread, names, [older], new Set(), now), { index: 1, userId: '2', nick: 'Other' })
  // Two in the first window holding any: no guess.
  assert.equal(guessAnonymous(unread, names, [recent, { ...older, lastSeen: now - 60 }], new Set(), now), null)
  // A candidate recognised by their own nick on the screenshot is not hiding.
  assert.deepEqual(guessAnonymous(unread, names, [recent, older], new Set(['1']), now)?.userId, '2')
  // Beyond the last window, two fake rows, or none: no guess.
  assert.equal(guessAnonymous(unread, names, [{ ...older, lastSeen: now - ANONYMOUS_WINDOWS_SEC.at(-1)! - 1 }], new Set(), now), null)
  assert.equal(guessAnonymous(['Abraham5625', 'Cassidy35'], names, [recent], new Set(), now), null)
  assert.equal(guessAnonymous(['Loupak'], names, [recent], new Set(), now), null)
})
