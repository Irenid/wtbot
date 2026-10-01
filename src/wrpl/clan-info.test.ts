import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { closeDb, getClanRosterRefreshedAt, initDb, saveClanRatingSnapshots, upsertClans } from '../db/index.js'
import {
  ClanPageHttpError,
  fetchClanMembers,
  fetchRatingsForTags,
  resetClanInfoState,
} from './clan-info.js'

// Кулдауны и пауза claninfo живут в модуле — каждый тест начинает с чистого листа.
// Очередь warthunder.com без интервала: иначе каждый запрос теста ждал бы 1,5 с.
beforeEach(() => {
  resetClanInfoState({ wait: async () => undefined, defer: () => undefined })
})

test('fetchClanMembers берёт слот общей очереди warthunder.com, а 429 откладывает её', async () => {
  const originalFetch = globalThis.fetch
  const events: string[] = []
  resetClanInfoState({
    wait: async () => {
      events.push('слот')
    },
    defer: (delayMs) => {
      events.push(`пауза ${delayMs}`)
    },
  })
  globalThis.fetch = async () => {
    events.push('запрос')
    return new Response('', { status: 429, headers: { 'retry-after': '7' } })
  }

  try {
    await assert.rejects(
      fetchClanMembers('Clan'),
      (error: unknown) => error instanceof ClanPageHttpError && error.status === 429,
    )
    assert.deepEqual(events, ['слот', 'запрос', 'пауза 7000'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchClanMembers читает ПКР участника внутри noindex-обёртки', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(`
      <div class="squadrons-members__grid-item">
        <a href="en/community/userinfo/?nick=TelaR">TelaR</a>
      </div>
      <div class="squadrons-members__grid-item">781</div>

      <div class="squadrons-members__grid-item">
        <noindex><div class="robots-nocontent">
          <a href="en/community/userinfo/?nick=Nick_Vidishok">Nick_Vidishok</a>
        </div></noindex>
      </div>
      <div class="squadrons-members__grid-item">935</div>
    `)

  try {
    assert.deepEqual(await fetchClanMembers('--ATB--'), [
      { nick: 'TelaR', rating: 781 },
      { nick: 'Nick_Vidishok', rating: 935 },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchRatingsForTags в cachedOnly-режиме возвращает сохранённые ПКР и дельту без сети', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('сеть не должна использоваться')
  }
  initDb(':memory:')

  try {
    saveClanRatingSnapshots('CLAN', [{ nick: 'Player', rating: 100 }])
    saveClanRatingSnapshots('CLAN', [{ nick: 'Player', rating: 125 }])

    const ratings = await fetchRatingsForTags(['CLAN'], { cachedOnly: true })

    assert.deepEqual(ratings.get('Player'), { rating: 125, delta: 25 })
  } finally {
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('fetchRatingsForTags сохраняет ранее загруженные ПКР при сетевой ошибке', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 503 })
  initDb(':memory:')

  try {
    upsertClans([{ tag: 'CLAN', name: 'Clan' }])
    saveClanRatingSnapshots('CLAN', [{ nick: 'Player', rating: 125 }])

    const ratings = await fetchRatingsForTags(['CLAN'])

    assert.deepEqual(ratings.get('Player'), { rating: 125, delta: null })
  } finally {
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('fetchRatingsForTags запускает запросы двух кланов параллельно', async () => {
  const originalFetch = globalThis.fetch
  let releaseFirst!: () => void
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/ClanA')) await holdFirst
    const nick = url.endsWith('/ClanA') ? 'PlayerA' : 'PlayerB'
    return new Response(`
      <div class="squadrons-members">
        <a href="en/community/userinfo/?nick=${nick}">${nick}</a>
        <div class="squadrons-members__grid-item">500</div>
      </div>
    `)
  }
  initDb(':memory:')

  try {
    upsertClans([
      { tag: 'A', name: 'ClanA' },
      { tag: 'B', name: 'ClanB' },
    ])

    const ratingsPromise = fetchRatingsForTags(['A', 'B'])
    // Запрос стартует после слота очереди; второй клан не ждёт ответа первого.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 2)
    releaseFirst()
    const ratings = await ratingsPromise

    assert.equal(ratings.get('PlayerA')?.rating, 500)
    assert.equal(ratings.get('PlayerB')?.rating, 500)
  } finally {
    releaseFirst()
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('fetchRatingsForTags не повторяет запрос клана, чья страница не открылась', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('', { status: 503 })
  }
  initDb(':memory:')

  try {
    upsertClans([{ tag: 'CLAN', name: 'Clan' }])
    saveClanRatingSnapshots('CLAN', [{ nick: 'Player', rating: 125 }])

    await fetchRatingsForTags(['CLAN'])
    const ratings = await fetchRatingsForTags(['CLAN'])
    assert.equal(calls, 1, 'повторный рендер в пределах паузы не должен идти в сеть')
    assert.deepEqual(ratings.get('Player'), { rating: 125, delta: null })

    await fetchRatingsForTags(['CLAN'], { force: true })
    assert.equal(calls, 2, 'принудительное обновление идёт в сеть и во время паузы')
  } finally {
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('fetchRatingsForTags ставит страницы кланов на паузу после 404 у трёх кланов подряд', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('', { status: 404 })
  }
  initDb(':memory:')

  try {
    upsertClans([
      { tag: 'A', name: 'ClanA' },
      { tag: 'B', name: 'ClanB' },
      { tag: 'C', name: 'ClanC' },
      { tag: 'D', name: 'ClanD' },
    ])
    saveClanRatingSnapshots('D', [{ nick: 'Stored', rating: 900 }])

    await fetchRatingsForTags(['A', 'B', 'C'])
    assert.equal(calls, 3)
    const ratings = await fetchRatingsForTags(['D'])

    assert.equal(calls, 3, 'во время паузы страницы кланов не запрашиваются')
    assert.equal(ratings.get('Stored')?.rating, 900, 'ПКР берётся из сохранённых снимков')
    assert.equal(warnings.filter((line) => line.includes('страницы кланов отдают 404')).length, 1)
  } finally {
    console.warn = originalWarn
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('getClanRosterRefreshedAt отдаёт время последнего обхода claninfo по ядру тега', () => {
  initDb(':memory:')
  try {
    const before = Math.floor(Date.now() / 1_000)
    saveClanRatingSnapshots('-AVR-', [{ nick: 'One', rating: 100 }, { nick: 'Two', rating: 90 }])
    const refreshed = getClanRosterRefreshedAt(['[AVR]', '╍AVR╎', '[NONE]', '***'])
    // Украшения тега не важны: ростер хранится по ядру.
    assert.ok((refreshed.get('[AVR]') ?? 0) >= before)
    assert.equal(refreshed.get('╍AVR╎'), refreshed.get('[AVR]'))
    assert.equal(refreshed.has('[NONE]'), false)
    assert.equal(refreshed.has('***'), false)
    assert.equal(getClanRosterRefreshedAt([]).size, 0)
  } finally {
    closeDb()
  }
})
