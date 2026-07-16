import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
 * Тактические карты для хитмап — снимки игровой карты с wt-tools.app
 * (открытый бакет wt-map-files: 62 карты × все режимы). Картинка режима
 * покрывает ровно battleArea миссии (проверено по координатам зон), так
 * что привязка к миру точная. Кэш — data/maps/, качается один раз.
 *
 * Фон таблицы результатов — скриншот в data/maps/<level>.jpg|png
 * (кладётся руками); нет файла — рендер рисует тёмный градиент.
 */

const ICONS_DIR = './data/unit-icons'
const MAPS_DIR = './data/maps'
const ICONS_BASE =
  'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/atlases.vromfs.bin_u/units'
const WTTOOLS_MANIFEST_URL = 'https://wt-tools.app/manifest.json'
const WTTOOLS_MAPS_BASE = 'https://storage.googleapis.com/wt-map-files/maps'
const MANIFEST_FILE = path.join(MAPS_DIR, 'wt-tools-manifest.json')
const MANIFEST_TTL_MS = 7 * 24 * 3600 * 1000

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

// ---------- ГСН ракет (для значков причины смерти на хитмапе) ----------

export type MissileSeeker = 'ir' | 'sarh' | 'arh'

const WEAPONS_FILE = './data/weapons.json'
const ROCKETGUNS_BASE =
  'https://raw.githubusercontent.com/gszabi99/War-Thunder-Datamine/master/aces.vromfs.bin_u/gamedata/weapons/rocketguns'

/**
 * Тип ГСН по id оружия из события убийства: ИК / полуактивная РЛ /
 * активная РЛ. Ракеты авиации описаны в rocketguns/<id>.blkx датамайна
 * (radarSeeker.active → АРЛ, radarSeeker → ПАРЛ, opticalSeeker → ИК);
 * снаряды, пули и ЗУР зениток отдельных файлов не имеют — для них в
 * кэш пишется "none" и в ответ они не попадают. Кэш — data/weapons.json.
 */
export async function ensureWeaponSeekers(ids: string[]): Promise<Map<string, MissileSeeker>> {
  let cache: Record<string, string> = {}
  if (existsSync(WEAPONS_FILE)) {
    try {
      cache = JSON.parse(readFileSync(WEAPONS_FILE, 'utf8')) as Record<string, string>
    } catch {
      cache = {}
    }
  }
  const unique = [...new Set(ids.filter((id) => /^[a-z0-9_.-]+$/i.test(id)))]
  const missing = unique.filter((id) => !(id in cache))

  await Promise.all(
    missing.map(async (id) => {
      try {
        const res = await fetch(`${ROCKETGUNS_BASE}/${id}.blkx`)
        if (!res.ok) {
          if (res.status === 404) cache[id] = 'none'
          return
        }
        const blk = (await res.json()) as {
          rocket?: { guidance?: { radarSeeker?: { active?: unknown }; opticalSeeker?: unknown } }
        }
        const guidance = blk.rocket?.guidance
        cache[id] =
          guidance?.radarSeeker ? (guidance.radarSeeker.active === true ? 'arh' : 'sarh')
          : guidance?.opticalSeeker ? 'ir'
          : 'none'
      } catch {
        // сеть недоступна — не кэшируем, попробуем в другой раз
      }
    }),
  )
  if (missing.some((id) => id in cache)) {
    mkdirSync(path.dirname(WEAPONS_FILE), { recursive: true })
    writeFileSync(WEAPONS_FILE, JSON.stringify(cache))
  }

  const seekers = new Map<string, MissileSeeker>()
  for (const id of unique) {
    const s = cache[id]
    if (s === 'ir' || s === 'sarh' || s === 'arh') seekers.set(id, s)
  }
  return seekers
}

// ---------- тактические карты (wt-tools.app) ----------

interface WtToolsManifest {
  [mapKey: string]: { [modeKey: string]: { image: string; size: number; tile_size: number } }
}

/** " [Domination #2] North Holland" → { mapKey: "north_holland", modeKey: "domination-2" } */
export function tacticalMapKeys(missionName: string): { mapKey: string; modeKey: string } | null {
  // в item.title перед режимом стоит сложность — "[realistic] [Conquest #3] …"
  const cleaned = missionName.trim().replace(/^\[(arcade|realistic|simulation|hardcore)\]\s*/i, '')
  const m = /^\s*\[([a-zа-я ]+?)(?:\s*#(\d+))?\]\s*(.+)$/i.exec(cleaned)
  if (!m) return null
  const mode = m[1]!.trim().toLowerCase()
  const num = m[2] ?? '1'
  const mapKey = m[3]!
    .trim()
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!mapKey || !/^[a-z]+$/.test(mode)) return null
  return { mapKey, modeKey: `${mode}-${num}` }
}

/** Манифест wt-tools: кэш с обновлением раз в неделю; сбой сети → старый кэш */
async function loadWtToolsManifest(): Promise<WtToolsManifest | null> {
  const fresh = existsSync(MANIFEST_FILE) && Date.now() - statSync(MANIFEST_FILE).mtimeMs < MANIFEST_TTL_MS
  if (!fresh) {
    try {
      const res = await fetch(WTTOOLS_MANIFEST_URL)
      if (res.ok) {
        const body = await res.text()
        JSON.parse(body) // валидация до записи
        mkdirSync(MAPS_DIR, { recursive: true })
        writeFileSync(MANIFEST_FILE, body)
      }
    } catch {
      // нет сети — попробуем отдать старый кэш ниже
    }
  }
  if (!existsSync(MANIFEST_FILE)) return null
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as WtToolsManifest
  } catch {
    return null
  }
}

/**
 * Снимок игровой тактической карты для конкретного режима миссии
 * (data-URI PNG) или null, если карты/режима нет в коллекции.
 * Картинка покрывает ровно battleArea миссии — накладывать по нему.
 * Чужой режим не подставляем: на снимке запечены зоны и спавны,
 * для другой миссии они врут.
 */
export function ensureTacticalMap(missionName: string): Promise<string | null> {
  const keys = tacticalMapKeys(missionName)
  if (!keys) return Promise.resolve(null)
  // хитмапы наземки и авиации собираются параллельно — не качаем дважды
  const id = `${keys.mapKey}__${keys.modeKey}`
  let pending = inflightMaps.get(id)
  if (!pending) {
    pending = fetchTacticalMap(keys).finally(() => inflightMaps.delete(id))
    inflightMaps.set(id, pending)
  }
  return pending
}

const inflightMaps = new Map<string, Promise<string | null>>()

async function fetchTacticalMap(keys: { mapKey: string; modeKey: string }): Promise<string | null> {
  const file = path.join(MAPS_DIR, `${keys.mapKey}__${keys.modeKey}.png`)
  const miss = path.join(MAPS_DIR, `${keys.mapKey}__${keys.modeKey}.miss`)
  if (existsSync(file)) return toDataUri(readFileSync(file))
  if (existsSync(miss)) return null

  const manifest = await loadWtToolsManifest()
  const entry = manifest?.[keys.mapKey]?.[keys.modeKey]
  if (!entry) {
    if (manifest) {
      mkdirSync(MAPS_DIR, { recursive: true })
      writeFileSync(miss, '')
      console.log(`[maps] в коллекции wt-tools нет ${keys.mapKey}/${keys.modeKey} — хитмапа будет без карты`)
    }
    return null
  }
  try {
    const res = await fetch(`${WTTOOLS_MAPS_BASE}/${keys.mapKey}/${keys.modeKey}/${entry.image}`)
    if (!res.ok) {
      if (res.status === 404) writeFileSync(miss, '')
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(MAPS_DIR, { recursive: true })
    writeFileSync(file, buf)
    console.log(`[maps] тактическая карта ${keys.mapKey}/${keys.modeKey} сохранена (${Math.round(buf.length / 1024)} КБ)`)
    return toDataUri(buf)
  } catch {
    return null // сеть недоступна — в другой раз получится
  }
}
