import { closeWtBrowser } from '../parsers/sources/wt-browser.js'
import { fetchStatSharkBundle } from '../player-stats/statshark-client.js'
import { normalizeStatSharkBundle } from '../player-stats/statshark-normalizer.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function main(): Promise<void> {
  const playerId = process.argv[2]?.trim() || '82922922'
  try {
    const bundle = await fetchStatSharkBundle(playerId)
    const normalized = normalizeStatSharkBundle(bundle)
    const profile = record(bundle.profile)
    const vehicles = profile['Vehicles']
    const vehicleHistory = record(bundle.vehicleHistory)
    console.log(JSON.stringify({
      ok: true,
      playerId: normalized.playerId,
      nick: normalized.nick,
      sourceUpdatedAt: normalized.sourceUpdatedAt,
      totals: normalized.stats.totals.length,
      vehicles: normalized.stats.vehicles.length,
      currentVehicleRowsByMode: Array.isArray(vehicles)
        ? vehicles.map((rows) => Array.isArray(rows) ? rows.length : null)
        : null,
      vehicleHistorySnapshotsByMode: Object.fromEntries(
        Object.entries(vehicleHistory).map(([mode, snapshots]) => [
          mode,
          Array.isArray(snapshots) ? snapshots.length : null,
        ]),
      ),
      leaderboardHistorySnapshots: Array.isArray(bundle.leaderboardHistory)
        ? bundle.leaderboardHistory.length
        : null,
      globalVehicleInfoEntries: Object.keys(record(bundle.vehicleInfo)).length,
    }, null, 2))
  } finally {
    await closeWtBrowser()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
