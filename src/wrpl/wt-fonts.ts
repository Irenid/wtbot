import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic as writeAtomic } from '../atomic-file.js'
import { mapConcurrent } from '../concurrency.js'
import {
  runWorkerTask,
  transferableBuffer,
  type WorkerPriority,
  type WorkerTaskControl,
} from '../workers/pool.js'

/** Фирменный шрифт War Thunder для украшений клан-тегов. */

export const GAME_SYMBOLS_FAMILY = 'symbols_skyquake'

const CACHE_FILE = './data/fonts/symbols_skyquake.ttf'
const GAME_DIR_PROBE_CONCURRENCY = 8
let cachedPaths: string[] | null = null
let fontPromise: Promise<string[]> | null = null
let retryAfter = 0
let fontPriority: WorkerPriority = 'normal'
let fontControl: WorkerTaskControl | null = null

/** Пути к TTF для Resvg. Чтение VROMFS асинхронно, распаковка — в CPU worker. */
export function ensureGameFonts(priority: WorkerPriority = 'normal'): Promise<string[]> {
  if (cachedPaths) return Promise.resolve(cachedPaths)
  if (retryAfter > Date.now()) return Promise.resolve([])
  if (fontPromise) {
    promoteFont(priority)
    return fontPromise
  }
  fontPriority = priority
  fontPromise = loadGameFonts()
    .then(({ paths, definitive }) => {
      if (definitive) cachedPaths = paths
      else retryAfter = Date.now() + 60_000
      return paths
    })
    .finally(() => {
      fontPromise = null
      fontControl = null
    })
  return fontPromise
}

/** Повышает уже запущенную распаковку, когда её результат стал нужен интерактивной задаче. */
export function promoteGameFontLoad(priority: WorkerPriority): void {
  promoteFont(priority)
}

async function loadGameFonts(): Promise<{ paths: string[]; definitive: boolean }> {
  if (await exists(CACHE_FILE)) return { paths: [path.resolve(CACHE_FILE)], definitive: true }

  const gameDir = await findWarThunderGameDir()
  if (!gameDir) {
    console.warn('[fonts] Клиент War Thunder не найден — украшения клан-тегов будут юникодом (см. WT_GAME_DIR в .env)')
    return { paths: [], definitive: true }
  }
  const vromfsFile = path.join(gameDir, 'ui', 'fonts.vromfs.bin')
  try {
    const vromfs = transferableBuffer(await readFile(vromfsFile))
    const font = await runWorkerTask(
      { kind: 'extract-game-font', input: { vromfs } },
      {
        priority: fontPriority,
        transferList: [vromfs],
        timeoutMs: 90_000,
        onControl: (control) => {
          fontControl = control
          control.promote(fontPriority)
        },
      },
    )
    if (!font) throw new Error('в контейнере нет ttfs/symbols_skyquake.ttf')
    await writeAtomic(CACHE_FILE, new Uint8Array(font))
    console.log(`[fonts] Шрифт игры извлечён: ${CACHE_FILE} (${font.byteLength} байт) — теги рисуются как в игре`)
    return { paths: [path.resolve(CACHE_FILE)], definitive: true }
  } catch (error) {
    console.warn(`[fonts] Не удалось распаковать шрифты игры: ${error instanceof Error ? error.message : String(error)}`)
    return { paths: [], definitive: false }
  }
}

function promoteFont(priority: WorkerPriority): void {
  const order: WorkerPriority[] = ['interactive', 'normal', 'background']
  if (order.indexOf(priority) >= order.indexOf(fontPriority)) return
  fontPriority = priority
  fontControl?.promote(priority)
}

export async function findWarThunderGameDir(): Promise<string | null> {
  const fromEnv = process.env['WT_GAME_DIR']
  if (fromEnv && await exists(path.join(fromEnv, 'ui', 'fonts.vromfs.bin'))) return fromEnv

  const candidates: string[] = []
  const steamRoots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
  const steamLibraries = await Promise.all(
    steamRoots.map(async (steam): Promise<string | null> => {
      const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf')
      try {
        return await readFile(vdf, 'utf8')
      } catch {
        return null
      }
    }),
  )
  for (const text of steamLibraries) {
    if (text !== null) {
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        candidates.push(path.join(match[1]!.replace(/\\\\/g, '\\'), 'steamapps', 'common', 'War Thunder'))
      }
    }
  }
  candidates.push(
    'C:\\Games\\WarThunder',
    'C:\\Games\\War Thunder',
    'D:\\Games\\WarThunder',
    'D:\\WarThunder',
  )
  const uniqueCandidates = [...new Set(candidates)]
  const available = await mapConcurrent(
    uniqueCandidates,
    GAME_DIR_PROBE_CONCURRENCY,
    (candidate) => exists(path.join(candidate, 'ui', 'fonts.vromfs.bin')),
  )
  return uniqueCandidates.find((_, index) => available[index]) ?? null
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
}
