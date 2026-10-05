import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import {
  closeDb,
  getClanRosterRefreshedAt,
  getSiteClanRosterDetails,
  initDb,
  saveClanRatingSnapshots,
  upsertClans,
} from '../db/index.js'
import {
  ClanPageHttpError,
  fetchClanMembers,
  fetchRatingsForTags,
  lookupUnknownClanTags,
  parseClanEntryDate,
  resetClanInfoState,
  setClanTagLookup,
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
      { nick: 'TelaR', rating: 781, activity: null, role: null, joinedAt: null },
      { nick: 'Nick_Vidishok', rating: 935, activity: null, role: null, joinedAt: null },
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

test('fetchClanMembers читает активность, роль и дату вступления, а ростер их сохраняет', async () => {
  const originalFetch = globalThis.fetch
  const cell = (value: string, mobileHidden = false) =>
    `<div class="squadrons-members__grid-item${mobileHidden ? ' global__mobile-hidden' : ''}"> ${value} </div>`
  globalThis.fetch = async () =>
    new Response(`<div class="squadrons-members__table">
      ${cell('num.')}${cell('Player')}${cell('Personal clan rating')}${cell('Activity')}
      ${cell('Role', true)}${cell('Date of entry', true)}
      ${cell('1')}<div class="squadrons-members__grid-item">
        <noindex><div class="robots-nocontent"><a href="en/community/userinfo/?nick=Boss">Boss</a></div></noindex>
      </div>${cell('1779')}${cell('1440')}${cell('Commander', true)}${cell('01.11.2023', true)}
      ${cell('2')}<div class="squadrons-members__grid-item"><a href="en/community/userinfo/?nick=Rookie">Rookie</a></div>
      ${cell('0')}${cell('963')}${cell('Private', true)}${cell('31.02.2022', true)}
      ${cell('3')}<div class="squadrons-members__grid-item"><a href="en/community/userinfo/?nick=Second">Second</a></div>
      ${cell('1532')}${cell('3960')}${cell('clan/deputy', true)}${cell('06.06.2026', true)}
    </div>`)
  initDb(':memory:')

  try {
    const members = await fetchClanMembers('Clan')
    assert.deepEqual(members, [
      { nick: 'Boss', rating: 1779, activity: 1440, role: 'Commander', joinedAt: Date.UTC(2023, 10, 1) / 1_000 },
      // Несуществующая дата — null, остальное читается.
      { nick: 'Rookie', rating: 0, activity: 963, role: 'Private', joinedAt: null },
      // The deputy's role comes as the untranslated key.
      { nick: 'Second', rating: 1532, activity: 3960, role: 'Deputy', joinedAt: Date.UTC(2026, 5, 6) / 1_000 },
    ])
    saveClanRatingSnapshots('[CLAN]', members)
    assert.deepEqual(getSiteClanRosterDetails('clan').get('Boss'), {
      role: 'Commander',
      joinedAt: Date.UTC(2023, 10, 1) / 1_000,
      activity: 1440,
    })
  } finally {
    closeDb()
    globalThis.fetch = originalFetch
  }
})

test('parseClanEntryDate принимает только настоящую дату вида ДД.ММ.ГГГГ', () => {
  assert.equal(parseClanEntryDate('26.05.2021'), Date.UTC(2021, 4, 26) / 1_000)
  assert.equal(parseClanEntryDate('01.01.1970'), null)
  assert.equal(parseClanEntryDate('2021-05-26'), null)
  assert.equal(parseClanEntryDate('29.02.2023'), null)
})

test('lookupUnknownClanTags: one lookup for concurrent callers, a retry only after the cooldown', async () => {
  initDb(':memory:')
  const calls: string[][] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  setClanTagLookup(async (tags) => {
    calls.push([...tags])
    await held
    upsertClans([{ tag: 'NEW', name: 'New Clan' }])
  })

  try {
    upsertClans([{ tag: 'OLD', name: 'Old Clan' }])
    const first = lookupUnknownClanTags(['NEW', 'OLD', ''])
    const second = lookupUnknownClanTags(['NEW'])
    // Another tag waits for the running lookup, then starts its own.
    const third = lookupUnknownClanTags(['GONE'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [['NEW']])
    release()
    await Promise.all([first, second, third])
    assert.deepEqual(calls, [['NEW'], ['GONE']])
    // GONE is still unknown, NEW is found: nothing to look up before the cooldown ends.
    await lookupUnknownClanTags(['GONE', 'NEW'])
    assert.deepEqual(calls, [['NEW'], ['GONE']])
  } finally {
    closeDb()
  }
})

test('a failed squadron lookup does not throw, and its retries back off', async () => {
  const originalWarn = console.warn
  const originalNow = Date.now
  const warnings: string[] = []
  console.warn = (message: string) => {
    warnings.push(message)
  }
  let now = originalNow()
  Date.now = () => now
  initDb(':memory:')
  let calls = 0
  setClanTagLookup(async () => {
    calls += 1
    if (calls === 1) throw new Error('leaderboard down')
  })

  try {
    await lookupUnknownClanTags(['X'])
    assert.match(warnings.join('\n'), /squadron lookup failed: leaderboard down/)
    await lookupUnknownClanTags(['X'])
    assert.equal(calls, 1, 'no retry within 15 min')
    now += 16 * 60_000
    await lookupUnknownClanTags(['X'])
    assert.equal(calls, 2)
    assert.match(warnings.join('\n'), /not found on the leaderboard, next lookup: X in 30 min/)
    now += 16 * 60_000
    await lookupUnknownClanTags(['X'])
    assert.equal(calls, 2, 'the second miss waits 30 min')
    now += 15 * 60_000
    await lookupUnknownClanTags(['X'])
    assert.equal(calls, 3)
  } finally {
    Date.now = originalNow
    console.warn = originalWarn
    closeDb()
  }
})

test('a squadron lookup names a new squadron, then fetchRatingsForTags reads its PSR', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (input) => {
    urls.push(String(input))
    return new Response(`
      <div class="squadrons-members">
        <a href="en/community/userinfo/?nick=Chud">Chud</a>
        <div class="squadrons-members__grid-item">1450</div>
      </div>
    `)
  }
  initDb(':memory:')
  setClanTagLookup(async () => {
    upsertClans([{ tag: '[P00R]', name: 'POOR' }])
  })

  try {
    // Without the lookup an unknown tag has no name, so no claninfo request.
    assert.equal((await fetchRatingsForTags(['[P00R]'])).size, 0)
    assert.deepEqual(urls, [])

    await lookupUnknownClanTags(['[P00R]'])
    const ratings = await fetchRatingsForTags(['[P00R]'])
    assert.deepEqual(ratings.get('Chud'), { rating: 1450, delta: null })
    assert.deepEqual(urls, ['https://warthunder.com/en/community/claninfo/POOR'])
  } finally {
    closeDb()
    globalThis.fetch = originalFetch
  }
})
