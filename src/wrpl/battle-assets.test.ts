import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureTacticalMap, ensureUnitIcons, ensureWeaponSeekers, tacticalMapKeys } from './battle-assets.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])

/** Runs `body` in an empty working directory with `fetch` answering by `respond`. */
async function withSandbox(
  respond: (url: string) => Response,
  body: (urls: string[]) => Promise<void>,
): Promise<void> {
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-assets-'))
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    return respond(url)
  }) as typeof fetch
  try {
    process.chdir(root)
    await body(urls)
  } finally {
    process.chdir(previousCwd)
    globalThis.fetch = previousFetch
    rmSync(root, { recursive: true, force: true })
  }
}

test('unit icons are fetched by the lowercase datamine name and keyed by the game id', async () => {
  await withSandbox(() => new Response(PNG), async (urls) => {
    const icons = await ensureUnitIcons(['germ_leopard_I', 'germ_flakpz_1a2_Gepard'])
    assert.deepEqual([...icons.keys()].sort(), ['germ_flakpz_1a2_Gepard', 'germ_leopard_I'])
    assert.deepEqual(urls.map((url) => url.slice(url.lastIndexOf('/') + 1)).sort(), [
      'germ_flakpz_1a2_gepard.png',
      'germ_leopard_i.png',
    ])
    assert.ok(existsSync(path.join('data', 'unit-icons', 'germ_leopard_i.png')))

    // The second call is served from the cache.
    await ensureUnitIcons(['germ_leopard_I'])
    assert.equal(urls.length, 2)
  })
})

test('a unit icon 404 is retried once its miss marker expires', async () => {
  await withSandbox(() => new Response('', { status: 404 }), async (urls) => {
    assert.equal((await ensureUnitIcons(['new_tank'])).size, 0)
    const miss = path.join('data', 'unit-icons', 'new_tank.miss')
    assert.ok(existsSync(miss))
    await ensureUnitIcons(['new_tank'])
    assert.equal(urls.length, 1, 'a fresh marker skips the request')

    const dayAgo = new Date(Date.now() - 25 * 3600 * 1000)
    utimesSync(miss, dayAgo, dayAgo)
    await ensureUnitIcons(['new_tank'])
    assert.equal(urls.length, 2, 'an expired marker retries')
  })
})

test('mission names match wt-tools keys that keep "-", "()" and drop diacritics', async () => {
  assert.deepEqual(tacticalMapKeys('[Conquest #4] Battle of Hürtgen Forest'), {
    mapKey: 'battle_of_hurtgen_forest',
    modeKey: 'conquest-4',
  })

  const entry = (map: string, mode: string) => ({ image: `${map}_${mode}_map.png`, size: 1600, tile_size: 225 })
  await withSandbox(() => new Response(PNG), async (urls) => {
    mkdirSync(path.join('data', 'maps'), { recursive: true })
    writeFileSync(path.join('data', 'maps', 'wt-tools-manifest.json'), JSON.stringify({
      'ardennes_(winter)': { 'conquest-1': entry('ardennes_(winter)', 'conquest-1') },
      'test-site_2271': { 'domination-1': entry('test-site_2271', 'domination-1') },
    }))

    assert.ok(await ensureTacticalMap('[Conquest #1] Ardennes (winter)'))
    assert.ok(await ensureTacticalMap('[Domination #1] Test Site-2271'))
    assert.deepEqual(urls.map((url) => decodeURIComponent(new URL(url).pathname)), [
      '/wt-map-files/maps/ardennes_(winter)/conquest-1/ardennes_(winter)_conquest-1_map.png',
      '/wt-map-files/maps/test-site_2271/domination-1/test-site_2271_domination-1_map.png',
    ])

    assert.equal(await ensureTacticalMap('[Domination #1] White Rock Fortress'), null)
    assert.equal(urls.length, 2, 'a map absent from the manifest is not requested')
  })
})

test('missile seekers are read from the lowercase datamine file and keyed by the event id', async () => {
  const igla = JSON.stringify({ rocket: { guidance: { opticalSeeker: { rangeBand0: [0, 0] } } } })
  await withSandbox((url) => url.endsWith('/su_9m39.blkx') ? new Response(igla) : new Response('', { status: 404 }), async (urls) => {
    mkdirSync('data')
    // Written by the old mixed-case lookup, which got a 404.
    writeFileSync(path.join('data', 'weapons.json'), JSON.stringify({ su_9M39: 'none' }))
    const seekers = await ensureWeaponSeekers(['su_9M39', 'su_9m39', 'shell_x'])
    assert.deepEqual([...seekers].sort(), [['su_9M39', 'ir'], ['su_9m39', 'ir']])
    assert.deepEqual(urls.map((url) => url.slice(url.lastIndexOf('/') + 1)).sort(), ['shell_x.blkx', 'su_9m39.blkx'])
    assert.deepEqual(JSON.parse(readFileSync(path.join('data', 'weapons.json'), 'utf8')), { su_9m39: 'ir', shell_x: 'none' })
  })
})
