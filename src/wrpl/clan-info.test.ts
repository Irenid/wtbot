import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, initDb, saveClanRatingSnapshots, upsertClans } from '../db/index.js'
import { fetchClanMembers, fetchRatingsForTags } from './clan-info.js'

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
