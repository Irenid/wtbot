import { describe, expect, it } from 'vitest'
import { mergeBattlePage, nextBattlesBound } from './battle-pages'

const battle = (sessionId: string, startTime: number) => ({ sessionId, startTime })

describe('battle list pages', () => {
  it('asks for the next page from one second after the oldest shown battle', () => {
    expect(nextBattlesBound([])).toBeNull()
    expect(nextBattlesBound([battle('3', 300), battle('2', 200)])).toBe(201)
  })

  it('keeps a battle that starts in the same second as the oldest shown one, once', () => {
    // The first page ended inside a second three battles share.
    const shown = [battle('9', 900), battle('8', 500), battle('7', 500)]
    expect(nextBattlesBound(shown)).toBe(501)
    // The API's answer for to=501: the second again, then older battles.
    const next = [battle('8', 500), battle('7', 500), battle('6', 500), battle('5', 400)]
    expect(mergeBattlePage(shown, next).map((entry) => entry.sessionId)).toEqual(['9', '8', '7', '6', '5'])
  })

  it('adds nothing for a page of repeats', () => {
    const shown = [battle('2', 200), battle('1', 100)]
    expect(mergeBattlePage(shown, [battle('1', 100)])).toEqual(shown)
  })
})
