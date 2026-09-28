import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectFreshReplays,
  type ReplayCollectionDeps,
  type WtListResponse,
  type WtReplay,
} from './wt-replays.js'

function replay(index: number, startTime = 1_000 - index): WtReplay {
  return {
    sessionId: String(index),
    missionName: ` Mission ${index} `,
    startTime,
    endTime: startTime + 600,
    url: `https://cdn.example/${index}`,
    gameVersion: '1.0',
    gameType: 'clanBattle',
    gameMode: 'realistic',
    statisticGroup: 'clan',
    partsCount: 1,
    players: {},
  }
}

function page(items: WtReplay[], total = items.length): WtListResponse {
  return { items, count: items.length, total_count: total }
}

function collectionDeps(
  pages: readonly WtListResponse[],
  known: ReadonlySet<string> = new Set(),
): { deps: ReplayCollectionDeps; requestedPages: number[] } {
  const requestedPages: number[] = []
  return {
    requestedPages,
    deps: {
      hasCookie: () => true,
      async fetchPage(pageNumber) {
        requestedPages.push(pageNumber)
        const response = pages[pageNumber - 1]
        if (response === undefined) throw new Error(`Нет fixture для страницы ${pageNumber}`)
        return response
      },
      async fetchParts() {
        throw new Error('fetchParts не должен вызываться в fixture')
      },
      isKnownReplay: (sessionId) => known.has(sessionId),
      retryFirstPage: (request) => request(),
    },
  }
}

test('wt-replays останавливается на последней неполной странице', async () => {
  const fixture = collectionDeps([page([replay(1), replay(2), replay(3)], 3)])
  const result = await collectFreshReplays(
    { maxPages: 50, stopAtKnown: true, fetchDetails: false },
    fixture.deps,
  )
  assert.deepEqual(fixture.requestedPages, [1])
  assert.equal(result.pagesRead, 1)
  assert.equal(result.hitCap, false)
  assert.deepEqual(result.items.map((item) => item.externalId), ['1', '2', '3'])
})

test('wt-replays сообщает достижение page cap', async () => {
  const fixture = collectionDeps([
    page(Array.from({ length: 20 }, (_, index) => replay(index + 1)), 100),
    page(Array.from({ length: 20 }, (_, index) => replay(index + 21)), 100),
  ])
  const result = await collectFreshReplays(
    { maxPages: 2, stopAtKnown: false, fetchDetails: false },
    fixture.deps,
  )
  assert.deepEqual(fixture.requestedPages, [1, 2])
  assert.equal(result.pagesRead, 2)
  assert.equal(result.items.length, 40)
  assert.equal(result.hitCap, true)
})

test('wt-replays останавливается на странице с известным боем', async () => {
  const fixture = collectionDeps(
    [page(Array.from({ length: 20 }, (_, index) => replay(index + 1)), 100)],
    new Set(['5']),
  )
  const result = await collectFreshReplays(
    { maxPages: 50, stopAtKnown: true, fetchDetails: false },
    fixture.deps,
  )
  assert.deepEqual(fixture.requestedPages, [1])
  assert.equal(result.items.length, 19)
  assert.equal(result.items.some((item) => item.externalId === '5'), false)
  assert.equal(result.hitCap, false)
})

test('wt-replays применяет date cutoff до сохранения items', async () => {
  const fixture = collectionDeps([
    page(Array.from({ length: 20 }, (_, index) => replay(index + 1, 200 - index)), 100),
  ])
  const result = await collectFreshReplays(
    { maxPages: 50, stopAtKnown: false, sinceTs: 190, fetchDetails: false },
    fixture.deps,
  )
  assert.deepEqual(fixture.requestedPages, [1])
  assert.deepEqual(result.items.map((item) => item.data['startTime']), [
    200, 199, 198, 197, 196, 195, 194, 193, 192, 191, 190,
  ])
  assert.equal(result.hitCap, false)
})

test('wt-replays отбрасывает записи API, не прошедшие runtime-схему', async () => {
  const broken = [
    { ...replay(2), sessionId: '../../etc' },
    { ...replay(3), partsCount: '7' },
    { ...replay(4), missionName: null },
    null,
  ] as unknown as WtReplay[]
  const fixture = collectionDeps([page([replay(1), ...broken], 5)])
  const result = await collectFreshReplays(
    { maxPages: 50, stopAtKnown: true, fetchDetails: false },
    fixture.deps,
  )
  assert.deepEqual(result.items.map((item) => item.externalId), ['1'])
  assert.equal(result.rejected, 4)
})

test('wt-replays отклоняет ответ API неожиданного формата', async () => {
  const fixture = collectionDeps([{ items: 'nope', count: 0, total_count: 1 } as unknown as WtListResponse])
  await assert.rejects(
    collectFreshReplays({ maxPages: 50, stopAtKnown: true, fetchDetails: false }, fixture.deps),
    /неожиданный формат ответа Replay API/,
  )
})
