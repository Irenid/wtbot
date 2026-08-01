import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { findWarThunderGameDir } from './wt-fonts.js'
import { runWorkerTask, transferableBuffer, type WorkerPriority } from '../workers/pool.js'

export const GAME_FLAG_COUNTRIES = [
  'usa',
  'germany',
  'ussr',
  'britain',
  'japan',
  'china',
  'italy',
  'france',
  'sweden',
  'israel',
] as const

const ATLAS_FILE = 'ui/atlases.vromfs.bin'
let cachedFlags: Map<string, string> | null = null
let flagsPromise: Promise<Map<string, string>> | null = null

export function ensureGameFlags(priority: WorkerPriority = 'normal'): Promise<Map<string, string>> {
  if (cachedFlags) return Promise.resolve(cachedFlags)
  if (flagsPromise) return flagsPromise
  flagsPromise = loadGameFlags(priority)
    .then((flags) => {
      cachedFlags = flags
      return flags
    })
    .finally(() => {
      flagsPromise = null
    })
  return flagsPromise
}

async function loadGameFlags(priority: WorkerPriority): Promise<Map<string, string>> {
  const gameDir = await findWarThunderGameDir()
  if (!gameDir) return new Map()

  const vromfs = transferableBuffer(await readFile(path.join(gameDir, ATLAS_FILE)))
  const files = await runWorkerTask(
    { kind: 'extract-game-flags', input: { vromfs } },
    { priority, transferList: [vromfs], timeoutMs: 90_000 },
  )
  const supported = new Set<string>(GAME_FLAG_COUNTRIES)
  return new Map(files.filter(([country]) => supported.has(country)))
}
