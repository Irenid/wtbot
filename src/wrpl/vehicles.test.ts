import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeWorkerPool } from '../workers/pool.js'
import { buildVehicleDict, ensureVehicleDict } from './vehicles.js'

test('a stale vehicle dictionary keeps serving while a background rebuild adds new vehicles', async () => {
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-vehicles-'))
  const sources: Record<string, string> = {
    'units.csv': '"old_tank_shop";"Old Tank";\n"new_tank_shop";"New Tank";\n',
    'wpcost.blkx': JSON.stringify({
      old_tank: { unitClass: 'exp_tank', country: 'country_germany' },
      new_tank: { unitClass: 'exp_SPAA', country: 'country_usa' },
    }),
    'unittags.blkx': '{}',
  }
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    const body = sources[url.slice(url.lastIndexOf('/') + 1)]
    return body === undefined ? new Response('', { status: 404 }) : new Response(body)
  }) as typeof fetch
  try {
    process.chdir(root)
    mkdirSync('data')
    const cacheFile = path.join('data', 'wt-vehicles.json')
    writeFileSync(cacheFile, JSON.stringify({ old_tank: { name: 'Old Tank', cls: 'T', country: 'germany' } }))
    const weekAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    utimesSync(cacheFile, weekAgo, weekAgo)

    const first = await ensureVehicleDict()
    assert.deepEqual(Object.keys(first), ['old_tank'], 'the cached dictionary is served at once')
    assert.equal(urls.length, 0)

    // The next call notices the age and rebuilds without blocking.
    let current = await ensureVehicleDict()
    for (let i = 0; i < 300 && !current['new_tank']; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      current = await ensureVehicleDict()
    }
    assert.deepEqual(current['new_tank'], { name: 'New Tank', cls: 'AA', country: 'usa' })
    assert.equal(urls.length, 3)
    assert.ok(JSON.parse(readFileSync(cacheFile, 'utf8')).new_tank, 'the rebuild replaces the cache file')

    await ensureVehicleDict()
    assert.equal(urls.length, 3, 'a fresh dictionary is not rebuilt again')
  } finally {
    process.chdir(previousCwd)
    globalThis.fetch = previousFetch
    rmSync(root, { recursive: true, force: true })
    await closeWorkerPool()
  }
})

test('the operator flag is kept where it is not the tree nation', () => {
  const dict = buildVehicleDict(
    '"sw_k9_vidar_shop";"VIDAR";\n"sw_strv_103a_shop";"Strv 103A";\n"us_m247_shop";"M247";\n',
    JSON.stringify({
      sw_k9_vidar: { unitClass: 'exp_tank', country: 'country_sweden' },
      sw_strv_103a: { unitClass: 'exp_tank', country: 'country_sweden' },
      us_m247: { unitClass: 'exp_SPAA', country: 'country_usa' },
    }),
    JSON.stringify({
      sw_k9_vidar: { operatorCountry: 'country_norway' },
      sw_strv_103a: { operatorCountry: 'country_sweden' },
      us_m247: { operatorCountry: 'country_usa_modern' },
    }),
  )
  assert.deepEqual(dict['sw_k9_vidar'], { name: 'VIDAR', cls: 'T', country: 'sweden', operator: 'norway' })
  assert.deepEqual(dict['sw_strv_103a'], { name: 'Strv 103A', cls: 'T', country: 'sweden' })
  assert.equal(dict['us_m247']?.operator, 'usa_modern')
})
