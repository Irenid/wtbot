import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchClanMembers } from './clan-info.js'

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
