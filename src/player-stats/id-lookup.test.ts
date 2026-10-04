import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  findKnownPlayerMatches,
  getPlayerIdentityById,
  getPlayerIdentityByWtUserId,
  getSiteAliasIdentities,
  initDb,
  saveBattle,
  saveClanRatingSnapshots,
  savePlayerIdentity,
} from '../db/index.js'
import {
  WtUserIdResolver,
  type WtAccountCandidate,
  type WtUserIdLookupStep,
} from './id-lookup.js'

function members(...nicks: string[]): void {
  saveClanRatingSnapshots('=IDL=', nicks.map((nick, index) => ({ nick, rating: 1_000 + index })))
}

function battleWith(sessionId: string, players: ReadonlyArray<readonly [userId: string, nick: string]>): void {
  saveBattle({
    sessionId,
    sessionHex: sessionId.padStart(16, '0'),
    missionName: 'fixture',
    level: 'fixture',
    gameMode: null,
    battleType: null,
    environment: null,
    status: null,
    startTime: 1,
    durationSec: 600,
    endTimeMs: 600_000,
    teamWon: 1,
    gameVersion: null,
    missionSettings: null,
    players: players.map(([userId, nick]) => ({
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
    })),
    kills: [],
    chat: [],
    eventsBlob: Buffer.from('{}'),
  })
}

interface FakeStep extends WtUserIdLookupStep {
  calls: string[]
}

function step(
  source: string,
  answer: (nick: string) => WtAccountCandidate[] | Promise<WtAccountCandidate[]>,
  minIntervalMs = 0,
): FakeStep {
  const calls: string[] = []
  return {
    source,
    minIntervalMs,
    calls,
    find: async (nick) => {
      calls.push(nick)
      return answer(nick)
    },
  }
}

function failing(source: string): FakeStep {
  return step(source, () => {
    throw new Error(`${source} is down`)
  })
}

/** A clock that only sleeps move: lookups are instant. */
function clock() {
  const state = { now: 1_000_000, sleeps: [] as number[] }
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms)
      state.now += ms
    },
  }
}

function resolverOf(steps: WtUserIdLookupStep[], time = clock()): WtUserIdResolver {
  return new WtUserIdResolver({ steps, now: time.now, sleep: time.sleep, log: () => undefined })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('a known nick without an id links the single exact account of the first source listing it', async () => {
  initDb(':memory:')
  try {
    members('Formula7')
    // A prefix list: other nicks and other cases of the prefix are not the player.
    const companion = step('companion-profile', () => [
      { wtUserId: '9002', nick: 'Formula70' },
      { wtUserId: '9001', nick: 'formula7' },
    ])
    const replayApi = step('wt-players', () => [])
    const resolver = resolverOf([companion, replayApi])

    assert.deepEqual(await resolver.resolve(' Formula7 '), { status: 'found', wtUserId: '9001' })
    assert.deepEqual(replayApi.calls, [])
    // The source spells the account; the roster links by its own exact spelling.
    assert.equal(getPlayerIdentityByWtUserId('9001')?.canonicalNick, 'formula7')
    assert.deepEqual(getSiteAliasIdentities(['Formula7', 'formula7']).map((row) => row.wtUserId), ['9001', '9001'])
    assert.ok(findKnownPlayerMatches('FORMULA7').some((match) => match.wtUserId === '9001'))

    // Stored: the next lookup is local.
    assert.deepEqual(await resolver.resolve('FORMULA7'), { status: 'found', wtUserId: '9001' })
    assert.deepEqual(companion.calls, ['Formula7'])
  } finally {
    closeDb()
  }
})

test('the next source answers when one fails or omits the nick', async () => {
  initDb(':memory:')
  try {
    members('Wingman')
    const companion = failing('companion-profile')
    const prefixOnly = step('prefix', () => [{ wtUserId: '501', nick: 'Wingman2' }])
    const replayApi = step('wt-players', () => [{ wtUserId: '502', nick: 'Wingman' }])
    const resolver = resolverOf([companion, prefixOnly, replayApi])

    assert.deepEqual(await resolver.resolve('Wingman'), { status: 'found', wtUserId: '502' })
    assert.deepEqual([companion.calls, prefixOnly.calls, replayApi.calls], [['Wingman'], ['Wingman'], ['Wingman']])
    assert.ok(findKnownPlayerMatches('Wingman').some((match) =>
      match.origin === 'alias' && match.source === 'wt-players' && match.wtUserId === '502'))
  } finally {
    closeDb()
  }
})

test('several accounts, bot ids and unknown nicks link nothing', async () => {
  initDb(':memory:')
  try {
    members('Twin', 'Ghost', 'Reused')
    battleWith('reused', [['602', 'Reused'], ['603', 'reused']])
    const source = step('companion-profile', (nick) => {
      if (nick === 'Twin') return [{ wtUserId: '1', nick: 'Twin' }, { wtUserId: '2', nick: 'twin' }]
      return [{ wtUserId: '-5', nick }, { wtUserId: '0', nick }, { wtUserId: 'x1', nick }]
    })
    const resolver = resolverOf([source])

    // Arbitrary input never reaches a source.
    assert.deepEqual(await resolver.resolve('Nobody'), { status: 'unknown_player' })
    // Two accounts in local replays: no request either.
    assert.deepEqual(await resolver.resolve('Reused'), { status: 'ambiguous' })
    assert.deepEqual(source.calls, [])

    assert.deepEqual(await resolver.resolve('Twin'), { status: 'ambiguous' })
    assert.equal(getPlayerIdentityByWtUserId('1'), null)
    assert.equal(getPlayerIdentityByWtUserId('2'), null)
    assert.deepEqual(await resolver.resolve('Twin'), { status: 'ambiguous' })

    assert.deepEqual(await resolver.resolve('Ghost'), { status: 'not_found' })
    assert.deepEqual(source.calls, ['Twin', 'Ghost'])
  } finally {
    closeDb()
  }
})

test('no account is cached for hours, failures for minutes', async () => {
  initDb(':memory:')
  try {
    members('Missing', 'Flaky')
    const time = clock()
    const empty = step('empty', () => [])
    const down = failing('down')
    const resolver = resolverOf([down, empty], time)

    // One source failed, the other answered: no account.
    assert.deepEqual(await resolver.resolve('Missing'), { status: 'not_found' })
    assert.deepEqual(await resolver.resolve('Missing'), { status: 'not_found' })
    assert.deepEqual(empty.calls, ['Missing'])
    time.state.now += 12 * 3_600_000
    await resolver.resolve('Missing')
    assert.deepEqual(empty.calls, ['Missing', 'Missing'])

    const allDown = failing('down-too')
    const failingResolver = resolverOf([down, allDown], time)
    const failed = await failingResolver.resolve('Flaky')
    assert.equal(failed.status, 'error')
    assert.match(failed.status === 'error' ? failed.error : '', /down is down; down-too: down-too is down/)
    await failingResolver.resolve('Flaky')
    assert.deepEqual(allDown.calls, ['Flaky'])
    time.state.now += 5 * 60_000
    await failingResolver.resolve('Flaky')
    assert.deepEqual(allDown.calls, ['Flaky', 'Flaky'])
  } finally {
    closeDb()
  }
})

test('a nick-only identity takes the id; an identity of the id keeps its nick', async () => {
  initDb(':memory:')
  try {
    const voiceOnly = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'Voicer',
      platform: null,
      aliases: [{ source: 'voice', externalId: null, nick: 'Voicer', seenAt: 1, matchMethod: 'exact_nick', matchConfidence: 'medium' }],
    })
    const renamed = savePlayerIdentity({ wtUserId: '7002', canonicalNick: 'OldName', platform: null })
    members('NewName')
    const companion = step('companion-profile', (nick) => [{ wtUserId: nick === 'Voicer' ? '7001' : '7002', nick }])
    const resolver = resolverOf([companion])

    assert.deepEqual(await resolver.resolve('Voicer'), { status: 'found', wtUserId: '7001' })
    assert.equal(getPlayerIdentityById(voiceOnly.id)?.wtUserId, '7001')

    assert.deepEqual(await resolver.resolve('NewName'), { status: 'found', wtUserId: '7002' })
    assert.equal(getPlayerIdentityById(renamed.id)?.canonicalNick, 'OldName')
    assert.deepEqual(getSiteAliasIdentities(['NewName']).map((row) => row.identityId), [renamed.id])

    // An id already in the replays: no request, the nick-only identity adopts it.
    const pilot = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'Pilot',
      platform: null,
      aliases: [{ source: 'voice', externalId: null, nick: 'Pilot', seenAt: 1, matchMethod: 'exact_nick', matchConfidence: 'medium' }],
    })
    battleWith('pilot', [['7003', 'Pilot']])
    assert.deepEqual(await resolver.resolve('pilot'), { status: 'found', wtUserId: '7003' })
    assert.equal(getPlayerIdentityById(pilot.id)?.wtUserId, '7003')
    assert.deepEqual(companion.calls, ['Voicer', 'NewName'])
  } finally {
    closeDb()
  }
})

test('lookups start together but run one at a time, once per nick, paced per source', async () => {
  initDb(':memory:')
  try {
    members('Alpha', 'Bravo')
    const gates = new Map([['Alpha', deferred<void>()], ['Bravo', deferred<void>()]])
    let active = 0
    let maxActive = 0
    const time = clock()
    const source = step('companion-profile', async (nick) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gates.get(nick)?.promise
      active -= 1
      return [{ wtUserId: nick === 'Alpha' ? '11' : '12', nick }]
    }, 1_000)
    const resolver = resolverOf([source], time)

    const alpha = resolver.resolve('Alpha')
    const alphaAgain = resolver.resolve('alpha')
    const bravo = resolver.resolve('Bravo')
    assert.equal(alphaAgain, alpha)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(source.calls, ['Alpha'])

    gates.get('Bravo')?.resolve()
    gates.get('Alpha')?.resolve()
    assert.deepEqual(await Promise.all([alpha, alphaAgain, bravo]), [
      { status: 'found', wtUserId: '11' },
      { status: 'found', wtUserId: '11' },
      { status: 'found', wtUserId: '12' },
    ])
    assert.deepEqual(source.calls, ['Alpha', 'Bravo'])
    assert.equal(maxActive, 1)
    // The clock stood still: the second call waited the source's full interval.
    assert.deepEqual(time.state.sleeps, [1_000])
  } finally {
    closeDb()
  }
})

test('a full queue answers busy; stop ends queued lookups without a request', async () => {
  initDb(':memory:')
  try {
    const nicks = Array.from({ length: 34 }, (_, index) => `Member${index}`)
    members(...nicks)
    const gate = deferred<void>()
    const source = step('companion-profile', async () => {
      await gate.promise
      return []
    })
    const resolver = resolverOf([source])

    const queued = nicks.slice(0, 32).map((nick) => resolver.resolve(nick))
    assert.deepEqual(await resolver.resolve('Member32'), { status: 'busy' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(source.calls, ['Member0'])

    const stopped = resolver.stop()
    assert.deepEqual(await resolver.resolve('Member33'), { status: 'error', error: 'stopping' })
    gate.resolve()
    await stopped
    const results = await Promise.all(queued)
    assert.deepEqual(results[0], { status: 'not_found' })
    assert.ok(results.slice(1).every((result) => result.status === 'error' && result.error === 'stopping'))
    assert.deepEqual(source.calls, ['Member0'])
  } finally {
    closeDb()
  }
})
