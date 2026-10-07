import assert from 'node:assert/strict'
import test from 'node:test'
import * as psr from './psr.js'

test('the bot and the guides compute PSR by the same rule', async () => {
  // The guides' copy (frontend/src/lib/psr.ts) lives outside rootDir: loaded at run time.
  const guideUrl = new URL('../frontend/src/lib/psr.ts', import.meta.url)
  const guide = (await import(guideUrl.href)) as Pick<
    typeof psr,
    'PSR_K' | 'PSR_REFERENCE' | 'PSR_SCALE' | 'PSR_MIN_LOSS' | 'holdWinRate' | 'winPoints' | 'lossPoints'
  >

  assert.deepEqual(
    [guide.PSR_K, guide.PSR_REFERENCE, guide.PSR_SCALE, guide.PSR_MIN_LOSS],
    [psr.PSR_K, psr.PSR_REFERENCE, psr.PSR_SCALE, psr.PSR_MIN_LOSS],
  )
  for (let value = 0; value <= 3000; value += 7.5) {
    assert.equal(guide.holdWinRate(value), psr.holdWinRate(value))
    assert.equal(guide.winPoints(value), psr.winPoints(value))
    assert.equal(guide.lossPoints(value), psr.lossPoints(value))
  }
})

test('points match the figures the guides quote', () => {
  // "Up to 780 a win gives +32 and a loss −1, at 1500 it is +16 and −16, at 2000 +2 and −30."
  assert.equal(Math.round(psr.winPoints(780)), 32)
  assert.equal(Math.round(psr.winPoints(781)), 31)
  assert.equal(psr.lossPoints(780), 1)
  assert.equal(psr.winPoints(1500), 16)
  assert.equal(psr.lossPoints(1500), 16)
  assert.equal(Math.round(psr.winPoints(2000)), 2)
  assert.equal(Math.round(psr.lossPoints(2000)), 30)
})

test('a battle never takes PSR below 0, and the inverse undoes it', () => {
  assert.equal(psr.psrAfterBattle(0, false), 0)
  assert.equal(psr.psrAfterBattle(0.4, false), 0)
  assert.equal(psr.psrAfterBattle(0, true), 32 * (1 - psr.holdWinRate(0)))
  assert.equal(psr.psrBeforeBattle(0, false), 0)

  for (const before of [0, 1, 37.5, 780, 903, 1300, 1500, 1846.25, 2400]) {
    for (const won of [true, false]) {
      const after = psr.psrAfterBattle(before, won)
      if (after === 0) continue
      assert.ok(Math.abs(psr.psrBeforeBattle(after, won) - before) < 1e-9, `${before} ${won}`)
    }
  }
})
