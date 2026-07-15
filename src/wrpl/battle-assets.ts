import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Внешние ресурсы для картинки боя.
 *
 * Иконки техники — белые силуэты из датамайна игры
 * (atlases.vromfs.bin_u/units/<wpcost-id>.png, ~5–10 КБ каждая).
 * Скачиваются по мере надобности и кэшируются навсегда в data/unit-icons/.
 * Отсутствующие в датамайне id запоминаются пустым файлом *.miss,
 * чтобы не ходить на GitHub повторно.
 *
 * Фон карты — скриншот в data/maps/<level>.jpg|png (например
 * data/maps/avg_jungle.jpg). Надёжного онлайн-источника картинок карт нет,
 * поэтому файлы кладутся руками; нет файла — рендер рисует тёмный градиент.
 */

const ICONS_DIR = './data/unit-icons'
const MAPS_DIR = './data/maps'
const ICONS_BASE =
  'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/atlases.vromfs.bin_u/units'

/** "levels/avg_jungle.bin" → "avg_jungle" */
export function levelId(headerLevel: string): string {
  return headerLevel.replace(/^.*[/\\]/, '').replace(/\.bin$/i, '')
}

/** Возвращает id → data-URI силуэта; недоступные иконки в Map не попадают */
export async function ensureUnitIcons(ids: string[]): Promise<Map<string, string>> {
  mkdirSync(ICONS_DIR, { recursive: true })
  const icons = new Map<string, string>()
  const unique = [...new Set(ids.filter((id) => /^[a-z0-9_.-]+$/i.test(id)))]

  await Promise.all(
    unique.map(async (id) => {
      const file = path.join(ICONS_DIR, `${id}.png`)
      const miss = path.join(ICONS_DIR, `${id}.miss`)
      if (existsSync(file)) {
        icons.set(id, toDataUri(readFileSync(file)))
        return
      }
      if (existsSync(miss)) return
      try {
        const res = await fetch(`${ICONS_BASE}/${id}.png`)
        if (!res.ok) {
          // 404 — такой иконки в датамайне нет, запоминаем и не пробуем снова
          if (res.status === 404) writeFileSync(miss, '')
          return
        }
        const buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(file, buf)
        icons.set(id, toDataUri(buf))
      } catch {
        // сеть недоступна — просто рисуем без иконки, в другой раз получится
      }
    }),
  )
  return icons
}

/** Фон карты из data/maps/<level>.(jpg|jpeg|png) → data-URI или null */
export function loadMapBackground(headerLevel: string): string | null {
  const id = levelId(headerLevel)
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const file = path.join(MAPS_DIR, `${id}.${ext}`)
    if (!existsSync(file)) continue
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  }
  return null
}

function toDataUri(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`
}
