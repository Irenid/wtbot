import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unpackVromfs } from './vromfs.js'

/**
 * Фирменный шрифт War Thunder для украшений клан-тегов.
 *
 * Украшения (⚔, львы, пламя и т.п.) — это обычные box-drawing символы
 * (U+2530…U+2560), которые игра рисует спецглифами из ttfs/symbols_skyquake.ttf
 * (диапазоны прописаны в fonts.dynfont.blk). Достаём этот TTF из
 * ui/fonts.vromfs.bin установленной игры и подключаем к resvg — украшения
 * на картинках выглядят ровно как в игре.
 *
 * Кэш: data/fonts/symbols_skyquake.ttf (одноразово). Если игры на машине
 * нет — можно скопировать файл руками с другой машины или задать путь
 * к игре в WT_GAME_DIR; без шрифта рендер заменяет украшения юникодом
 * (DECOR_MAP в render-battle.ts).
 */

export const GAME_SYMBOLS_FAMILY = 'symbols_skyquake'

const CACHE_FILE = './data/fonts/symbols_skyquake.ttf'
const FONT_IN_VROMFS = 'ttfs/symbols_skyquake.ttf'

let cachedPaths: string[] | null = null
let attempted = false

/** Пути к TTF для resvg (пустой массив — шрифта нет, работает фолбэк) */
export async function ensureGameFonts(): Promise<string[]> {
  if (cachedPaths) return cachedPaths
  if (existsSync(CACHE_FILE)) {
    cachedPaths = [path.resolve(CACHE_FILE)]
    return cachedPaths
  }
  // Одна попытка распаковки за процесс: не найдена игра — не долбимся в диск
  if (attempted) return []
  attempted = true

  const gameDir = findGameDir()
  if (!gameDir) {
    console.warn('[fonts] Клиент War Thunder не найден — украшения клан-тегов будут юникодом (см. WT_GAME_DIR в .env)')
    return []
  }
  const vromfs = path.join(gameDir, 'ui', 'fonts.vromfs.bin')
  if (!existsSync(vromfs)) {
    console.warn(`[fonts] Нет файла ${vromfs} — украшения клан-тегов будут юникодом`)
    return []
  }
  try {
    const files = unpackVromfs(readFileSync(vromfs))
    const font = files.find((f) => f.name === FONT_IN_VROMFS)
    if (!font) throw new Error(`в контейнере нет ${FONT_IN_VROMFS}`)
    await mkdir(path.dirname(CACHE_FILE), { recursive: true })
    await writeFile(CACHE_FILE, font.data)
    console.log(`[fonts] Шрифт игры извлечён: ${CACHE_FILE} (${font.data.length} байт) — теги рисуются как в игре`)
    cachedPaths = [path.resolve(CACHE_FILE)]
    return cachedPaths
  } catch (err) {
    console.warn(`[fonts] Не удалось распаковать шрифты игры: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/** Каталог игры: WT_GAME_DIR из .env → библиотеки Steam → типовые пути Gaijin */
function findGameDir(): string | null {
  const fromEnv = process.env['WT_GAME_DIR']
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates: string[] = []
  for (const steam of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    try {
      // "path"  "D:\\SteamLibrary" — вытаскиваем все библиотеки
      for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) {
        candidates.push(path.join(m[1]!.replace(/\\\\/g, '\\'), 'steamapps', 'common', 'War Thunder'))
      }
    } catch {
      // повреждённый vdf — просто пропускаем
    }
  }
  candidates.push(
    'C:\\Games\\WarThunder',
    'C:\\Games\\War Thunder',
    'D:\\Games\\WarThunder',
    'D:\\WarThunder',
  )
  return candidates.find((c) => existsSync(path.join(c, 'ui', 'fonts.vromfs.bin'))) ?? null
}
