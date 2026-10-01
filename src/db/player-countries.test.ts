import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeDb,
  getLatestPlayerExternalStats,
  initDb,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
} from './index.js'

test('нации игрока сохраняются вместе со snapshot и читаются в порядке страницы', () => {
  initDb(':memory:')
  try {
    const identity = savePlayerIdentity({
      wtUserId: null,
      canonicalNick: 'Pilot',
      platform: null,
      aliases: [{
        source: 'official-profile',
        externalId: 'Pilot',
        nick: 'Pilot',
        seenAt: 1_790_000_000,
        matchMethod: 'exact_nick',
        matchConfidence: 'medium',
      }],
    })
    const snapshot = (countries: { country: string; vehicles: number | null; eliteVehicles: number | null; medals: number | null }[]) =>
      savePlayerExternalSnapshot({
        identityId: identity.id,
        source: 'official-profile',
        sourcePlayerId: 'Pilot',
        nick: 'Pilot',
        fetchedAt: 1_790_000_000,
        sourceUpdatedAt: null,
        status: 'ok',
        rawJson: JSON.stringify({ countries }),
        parserVersion: 'test',
        error: null,
        normalized: { totals: [], vehicles: [], countries },
      })

    snapshot([
      { country: 'USSR', vehicles: 210, eliteVehicles: 42, medals: 14 },
      { country: 'USA', vehicles: 184, eliteVehicles: 57, medals: null },
    ])
    const stats = getLatestPlayerExternalStats(identity.id, 'official-profile')
    assert.deepEqual(stats?.countries.map(({ snapshotId: _snapshotId, ...row }) => row), [
      { country: 'USSR', vehicles: 210, eliteVehicles: 42, medals: 14 },
      { country: 'USA', vehicles: 184, eliteVehicles: 57, medals: null },
    ])

    assert.throws(
      () => snapshot([
        { country: 'USA', vehicles: 1, eliteVehicles: 0, medals: 0 },
        { country: 'USA', vehicles: 2, eliteVehicles: 0, medals: 0 },
      ]),
      /countries\[1\]/,
    )
  } finally {
    closeDb()
  }
})
