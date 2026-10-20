import { afterEach, describe, expect, it, vi } from 'vitest'
import { SiteApiError, fetchBattles, fetchVehicleDict } from './api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API errors', () => {
  it('a JSON error answer keeps its status, code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { ok: false, code: 'RATE_LIMITED', error: 'slow down', retryAfterSec: 30 })))
    const error = await fetchBattles({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SiteApiError)
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'slow down' })
  })

  it('an error page that is not JSON becomes ERROR with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
    await expect(fetchBattles({})).rejects.toMatchObject({ status: 502, code: 'ERROR', message: 'HTTP 502' })
  })

  it('a 200 without a JSON body is a failure, not data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(fetchBattles({})).rejects.toMatchObject({ status: 200, code: 'BAD_RESPONSE' })
  })
})

describe('battle list query', () => {
  it('passes only the given filters and the exclusive bound', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, { ok: true, battles: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchBattles({})
    await fetchBattles({ clan: 'A B', limit: 50, to: 1_790_000_001 })
    await fetchBattles({ player: '123', to: 0 })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/battles',
      '/api/battles?clan=A+B&limit=50&to=1790000001',
      '/api/battles?player=123&to=0',
    ])
  })
})

describe('vehicle dictionary', () => {
  it('a failed load is not kept: the next call asks again, a success is kept', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(503, { ok: false, code: 'BUSY', error: 'busy' }))
      .mockResolvedValueOnce(json(200, { ok: true, vehicles: { t_34: { name: 'T-34', cls: 'T', country: 'ussr' } } }))
    vi.stubGlobal('fetch', fetchMock)
    // The failing screen gets an empty dictionary: ids stay readable instead of an error.
    expect(await fetchVehicleDict()).toEqual({})
    expect(await fetchVehicleDict()).toEqual({ t_34: { name: 'T-34', cls: 'T', country: 'ussr' } })
    expect(await fetchVehicleDict()).toEqual({ t_34: { name: 'T-34', cls: 'T', country: 'ussr' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
