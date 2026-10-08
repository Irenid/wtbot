/**
 * The flag templates for /scout pictures (flags.ts): drawn once in a worker
 * from the game's flags (game-flags.ts) and kept, ~0.5 MB copied into each
 * screenshot task. Null — no game files (WT_GAME_DIR): flags are not read and
 * the chances come from the players' battles alone.
 */

import { ensureAllGameFlags } from '../wrpl/game-flags.js'
import { runWorkerTask, type WorkerPriority } from '../workers/pool.js'
import type { WireFlagTemplates } from '../workers/protocol.js'

let pack: Promise<WireFlagTemplates | null> | null = null

export function ensureFlagTemplates(priority: WorkerPriority = 'interactive'): Promise<WireFlagTemplates | null> {
  pack ??= ensureAllGameFlags(priority)
    .then(async (svgs) => {
      if (svgs.size === 0) {
        // No game files or a failed read: ensureAllGameFlags paces its own retries.
        pack = null
        return null
      }
      const templates = await runWorkerTask({ kind: 'render-flag-templates', input: { svgs: [...svgs] } }, { priority, timeoutMs: 30_000 })
      return templates.icons.length > 0 ? templates : null
    })
    .catch((error: unknown) => {
      console.warn(`[scout] Flag templates unavailable: ${error instanceof Error ? error.message : String(error)}`)
      pack = null
      return null
    })
  return pack
}
