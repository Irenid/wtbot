import { Resvg } from '@resvg/resvg-js'
import { ensureUnitIcons, loadMapBackground } from './battle-assets.js'
import type { ClanRating } from './clan-info.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'
import { ensureGameFonts, GAME_SYMBOLS_FAMILY } from './wt-fonts.js'

/**
 * Рендер таблицы результатов боя в PNG в стиле Boris Stats:
 * фон — скриншот карты (data/maps/, если положен) с затемнением,
 * шапка с картой/режимом/временем, две команды с клан-тегами,
 * флаги наций, состав (4F/3T/1AA), силуэты техники из датамайна,
 * значки платформ (@psn/@live), колонка личного кланового рейтинга
 * (⊛: дельта сверху, рейтинг снизу) и возд./назем./ассисты/захваты/смерти.
 * Отключившиеся игроки помечаются красным значком и словом Disconnected,
 * запись без строки результатов — «Unknown Player».
 *
 * Украшения клан-тегов (⚔, львы, пламя…) — box-drawing символы, которые
 * рисуются фирменным шрифтом игры (см. wt-fonts.ts); если шрифта нет,
 * подменяются ближайшим юникодом по DECOR_MAP.
 *
 * SVG собирается строками и растеризуется через resvg (без браузера).
 * Шрифты системные — Segoe UI + Microsoft YaHei, поэтому русские и
 * китайские ники рисуются нормально.
 */

const W = 1920
const ROW_H = 88
const TEAM_HEADER_H = 130
const CONTENT_TOP = 210

const CLASS_COLOR: Record<string, string> = {
  T: '#f0883e', // танк — оранжевый
  L: '#5bd6c0', // лёгкий — бирюзовый
  F: '#79c0ff', // самолёт — голубой
  H: '#7ee787', // вертолёт — зелёный
  AA: '#f2cc60', // ПВО — жёлтый
  '?': '#9aa2b1',
}
const CLASS_ORDER = ['F', 'H', 'T', 'L', 'AA'] as const

/** Левая команда — «золотая», правая — белая (как у Boris Stats) */
const TEAM_THEME = [
  { clan: '#f2cc60', player: '#f2e394' },
  { clan: '#ffffff', player: '#ffffff' },
]

const STAT_COLORS = ['#7ee787', '#7ee787', '#f2cc60', '#6cb6ff', '#ff7b72'] // возд, назем, ассист, захв, смерти
const ZERO_COLOR = '#d7dee8'
const FONTS = `Segoe UI, Segoe UI Symbol, Microsoft YaHei, Malgun Gothic, Yu Gothic UI, Arial, sans-serif`

/** Порядок наций как в игре — в нём же рисуем флаги */
const NATION_ORDER = ['usa', 'germany', 'ussr', 'britain', 'japan', 'china', 'italy', 'france', 'sweden', 'israel']

/**
 * Украшения клан-тегов: в реплее лежат box-drawing символы (U+253A…U+2560),
 * которые фирменный шрифт игры рисует спецглифами. Для текстов (Discord,
 * консоль) и рендера без шрифта игры подменяем на ближайший юникод —
 * соответствия сверены по глифам symbols_skyquake.ttf из клиента.
 */
const DECOR_MAP: Record<string, string> = {
  '┺': '▬', '┻': '▬', // плашки-полосы
  '┼': '≈', '┽': '≈', // волны
  '┾': '⚑', '┿': '⚑', // флажки
  '╀': '◈', // ромб
  '╁': '🔥', '╂': '🔥', // пламя
  '╃': '🔥', '╄': '🔥', // перья пламени
  '╆': '⋙', '╇': '⋘', // тройные шевроны-крылья
  '╈': '≣', '╉': '≣', // стопки полос
  '╊': '≋', '╋': '≋', // наклонные полосы
  '╌': '💣', // бомба
  '╍': '⚡', '╎': '⚡', // молнии
  '╏': '✚', // крест с лучами
  '═': '🦁', '║': '🦁', // львы
  '╒': '🪓', '╓': '🪓', // алебарды
  '╔': '»', '╕': '«', // шевроны
  '╖': '⚔', // скрещённые мечи
  '╛': '♜', // башня
  '╜': '✊', // кулак
  '╝': '🪓', // двусторонний топор
  '╞': '🪖', '╟': '🪖', // солдаты
}

/** Диапазон, который в игре отдан под украшения тегов (fonts.dynfont.blk) */
const DECOR_RE = /[─-◿]/

/** Тег с юникод-заменами украшений — для текстов вне картинки (Discord, сайт, консоль) */
export function decorateTag(tag: string): string {
  return [...tag].map((ch) => DECOR_MAP[ch] ?? ch).join('')
}

/**
 * SVG-разметка клан-тега: украшения — отдельными tspan со шрифтом игры
 * (глифы как в игре), остальной текст — обычным стеком. Без шрифта игры —
 * юникод-замены из DECOR_MAP. Используется и хитмапой (легенда команд).
 */
export function tagMarkup(tag: string, gameFont: boolean): string {
  if (!gameFont) return esc(decorateTag(tag))
  let out = ''
  let plain = ''
  const flush = (): void => {
    if (plain) out += esc(plain)
    plain = ''
  }
  for (const ch of tag) {
    if (DECOR_RE.test(ch)) {
      flush()
      out += `<tspan font-family="${GAME_SYMBOLS_FAMILY}">${esc(ch)}</tspan>`
    } else {
      plain += ch
    }
  }
  flush()
  return out
}

export interface BattleImageInput {
  /** " [Conquest #1] Fire Arc" — как отдаёт сайт */
  missionName: string
  header: WrplHeader
  results: ReplayResults
  dict: VehicleDict
  /** ПКР и дельта по никам (см. clan-info.ts); нет карты — колонка с прочерками */
  ratings?: Map<string, ClanRating>
}

interface BattleAssets {
  unitIcons: Map<string, string>
  mapImage: string | null
  /** Подключён ли фирменный шрифт игры для украшений тегов */
  gameFont: boolean
}

export async function renderBattleImage(input: BattleImageInput): Promise<Buffer> {
  const rosters = buildRosters(input.results)
  const iconIds = rosters
    .flat()
    .filter((p) => !isDisconnected(p))
    .flatMap((p) => (p.vehicles[0] ? [p.vehicles[0]] : []))
  const unitIcons = await ensureUnitIcons(iconIds)
  const mapImage = loadMapBackground(input.header.level)
  const fontFiles = await ensureGameFonts()
  const svg = buildBattleSvg(input, { unitIcons, mapImage, gameFont: fontFiles.length > 0 })
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, fontFiles, defaultFontFamily: 'Segoe UI' },
  })
  return resvg.render().asPng()
}

/** Отключился: нет строки результатов (пустое имя) или ни одной машины в бою */
function isDisconnected(p: ReplayPlayerResult): boolean {
  return p.name === '' || p.vehicles.length === 0
}

/** Кланы, состав и игроки по командам — для текста рядом с картинкой */
export interface TeamSummary {
  /** Тег с юникод-украшениями — для Discord и консоли */
  clan: string | null
  /** Сырой тег из реплея (украшения как есть) — ключ для словаря кланов */
  rawTag: string | null
  composition: string
  players: string[]
}

export function summarizeTeams(results: ReplayResults, dict: VehicleDict): TeamSummary[] {
  return buildRosters(results).map((roster) => {
    const counts = classCounts(roster, dict)
    const composition = CLASS_ORDER.filter((cls) => counts.get(cls))
      .map((cls) => `${counts.get(cls)}${cls}`)
      .join('/')
    const clan = mostCommon(roster.map((r) => r.clanTag).filter((t) => t !== ''))
    return {
      clan: clan !== undefined ? decorateTag(clan) : null,
      rawTag: clan ?? null,
      composition,
      players: roster.filter((p) => p.name !== '').map((p) => splitPlatform(p.name).name),
    }
  })
}

export function buildBattleSvg(
  { missionName, header, results, dict, ratings }: BattleImageInput,
  assets: BattleAssets = { unitIcons: new Map(), mapImage: null, gameFont: false },
): string {
  // " [Conquest #1] Fire Arc" → режим и имя карты
  const m = /^\s*\[(.+?)\]\s*(.+)$/.exec(missionName.trim())
  const mode = m?.[1] ?? header.battleType
  const mapName = m?.[2] ?? missionName.trim()

  const rosters = buildRosters(results)
  const maxRows = Math.max(...rosters.map((r) => r.length), 1)
  const H = CONTENT_TOP + TEAM_HEADER_H + maxRows * ROW_H + 70

  const startDate = new Date(header.startTime * 1000)
  const dateStr =
    `${startDate.getUTCFullYear()}-${p2(startDate.getUTCMonth() + 1)}-${p2(startDate.getUTCDate())} ` +
    `${p2(startDate.getUTCHours())}:${p2(startDate.getUTCMinutes())} UTC`
  const dur = `${p2(Math.floor(results.timePlayed / 60))}:${p2(Math.floor(results.timePlayed % 60))}`

  const parts: string[] = []
  parts.push(
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#141a26"/><stop offset="1" stop-color="#0c1017"/>`,
    `</linearGradient>`,
    `<linearGradient id="topfade" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#05070b" stop-opacity="0.75"/><stop offset="1" stop-color="#05070b" stop-opacity="0"/>`,
    `</linearGradient>`,
    `<linearGradient id="botfade" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#05070b" stop-opacity="0"/><stop offset="1" stop-color="#05070b" stop-opacity="0.7"/>`,
    `</linearGradient>`,
    `</defs>`,
  )

  // Фон: скриншот карты с затемнением или тёмный градиент
  if (assets.mapImage) {
    parts.push(
      `<image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" href="${assets.mapImage}"/>`,
      `<rect width="${W}" height="${H}" fill="#0a0e14" fill-opacity="0.42"/>`,
      `<rect width="${W}" height="${CONTENT_TOP}" fill="url(#topfade)"/>`,
      `<rect y="${H - 100}" width="${W}" height="100" fill="url(#botfade)"/>`,
    )
  } else {
    parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`)
  }

  parts.push(
    // Заголовок
    text(W / 2, 92, esc(mapName), 66, '#ffffff', 'middle', 600),
    text(W / 2, 148, `[${esc(mode)}] - ${dateStr} (${dur})`, 34, '#dbe3ec', 'middle'),
    `<line x1="200" y1="182" x2="${W - 200}" y2="182" stroke="#ffffff" stroke-opacity="0.7" stroke-width="2"/>`,
    // Разделитель команд
    `<line x1="${W / 2}" y1="${CONTENT_TOP + 10}" x2="${W / 2}" y2="${H - 80}" stroke="#ffffff" stroke-opacity="0.45" stroke-width="2"/>`,
  )

  rosters.forEach((roster, i) => {
    const theme = TEAM_THEME[Math.min(i, TEAM_THEME.length - 1)]!
    parts.push(renderTeam(roster, i === 0 ? 60 : W / 2 + 60, dict, theme, assets, i, ratings))
  })

  parts.push(text(W / 2, H - 26, `Match ID: ${header.sessionId}`, 30, '#aab4c0', 'middle'))
  parts.push('</svg>')
  return parts.join('\n')
}

function renderTeam(
  roster: ReplayPlayerResult[],
  ox: number,
  dict: VehicleDict,
  theme: { clan: string; player: string },
  assets: BattleAssets,
  teamIndex: number,
  ratings?: Map<string, ClanRating>,
): string {
  const parts: string[] = []
  // Первая колонка — личный клановый рейтинг (⊛), дальше статистика боя
  const ratingX = ox + 490
  const statX = [584, 656, 728, 800, 872].map((v) => ox + v)

  // Клан-тег: украшения рисует шрифт игры (или юникод-замены без него)
  const clan = mostCommon(roster.map((r) => r.clanTag).filter((t) => t !== ''))
  const teamNo = roster[0]?.team ?? teamIndex + 1
  const clanLabel = clan !== undefined ? tagMarkup(clan, assets.gameFont) : esc(`Команда ${teamNo}`)
  parts.push(text(ox + 10, CONTENT_TOP + 52, clanLabel, 46, theme.clan, 'start', 600))

  // Состав: (4F/3T/1AA) — по первой машине каждого игрока
  const counts = classCounts(roster, dict)
  const compo: string[] = []
  for (const cls of CLASS_ORDER) {
    const n = counts.get(cls)
    if (n) compo.push(`<tspan fill="${CLASS_COLOR[cls]}">${n}${cls}</tspan>`)
  }
  parts.push(
    `<text x="${ox + 10}" y="${CONTENT_TOP + 94}" font-family="${FONTS}" font-size="30" fill="#c6cfda">(${compo.join(
      '<tspan fill="#c6cfda">/</tspan>',
    )})</text>`,
  )

  // Флаги наций команды — по машинам игроков, в игровом порядке
  const nations = [...new Set(roster.map((p) => vehicleInfo(dict, p.vehicles[0] ?? '').country))]
    .filter((c) => c !== '?')
    .sort((a, b) => NATION_ORDER.indexOf(a) - NATION_ORDER.indexOf(b))
    .slice(0, 6)
  const flagsRight = statX[4]! + 18
  nations.forEach((country, i) => {
    parts.push(flagSvg(flagsRight - (nations.length - i) * 46, CONTENT_TOP + 8, country, `fl${teamIndex}_${i}`))
  })

  // Значки колонок: рейтинг, возд, назем, ассисты, захваты, смерти
  parts.push(iconStarCircle(ratingX - 14, CONTENT_TOP + 58, 28, '#e6edf3'))
  const icons = [iconPlane, iconTank, iconStar, iconDiamond, iconSkull]
  icons.forEach((icon, i) => {
    parts.push(icon(statX[i]! - 14, CONTENT_TOP + 58, 28, '#e6edf3'))
  })

  // Игроки
  roster.forEach((p, row) => {
    const y = CONTENT_TOP + TEAM_HEADER_H + row * ROW_H
    const disconnected = isDisconnected(p)
    const firstId = p.vehicles[0] ?? ''
    const first = vehicleInfo(dict, firstId)
    const color = CLASS_COLOR[first.cls] ?? CLASS_COLOR['?']!

    // Силуэт машины из датамайна; отключившимся — красный значок,
    // остальным без силуэта — значок класса
    const icon = assets.unitIcons.get(firstId)
    if (disconnected) {
      parts.push(iconDisconnect(ox + 26, y + 10, 46))
    } else if (icon) {
      parts.push(
        `<image x="${ox}" y="${y + 6}" width="96" height="56" preserveAspectRatio="xMidYMid meet" href="${icon}"/>`,
      )
    } else {
      const classIcon = first.cls === 'F' ? iconPlane : first.cls === 'H' ? iconHeli : iconTank
      parts.push(classIcon(ox + 24, y + 12, 48, color))
    }

    // Платформа (@psn/@live) → значок перед ником
    const { name, platform } = splitPlatform(p.name)
    let nameX = ox + 112
    if (platform === 'live') {
      parts.push(iconXbox(nameX, y + 12, 27, '#dfe6ee'))
      nameX += 36
    } else if (platform === 'psn') {
      parts.push(iconPs(nameX, y + 12, 27, '#dfe6ee'))
      nameX += 36
    }
    parts.push(text(nameX, y + 36, esc(trimToWidth(name || 'Unknown Player', 20)), 34, theme.player))

    // Под ником: техника или пометка отключения
    if (disconnected) {
      parts.push(text(ox + 112, y + 70, 'Disconnected', 26, '#9aa2b1'))
    } else {
      const extra = p.vehicles.length > 1 ? ` +${p.vehicles.length - 1}` : ''
      parts.push(text(ox + 112, y + 70, esc(trimToWidth(first.name, 26)) + extra, 26, color))
    }

    // Личный клановый рейтинг: дельта за бой сверху, текущее значение снизу
    const rating = name ? ratings?.get(p.name) ?? ratings?.get(name) : undefined
    if (rating) {
      if (rating.delta !== null && rating.delta !== 0) {
        const up = rating.delta > 0
        parts.push(
          text(ratingX, y + 24, `${up ? '+' : '−'}${Math.abs(rating.delta)}`, 22, up ? '#7ee787' : '#ff7b72', 'middle', 600),
        )
      }
      parts.push(text(ratingX, y + 56, String(rating.rating), 30, '#ffffff', 'middle', 600))
    } else if (ratings) {
      parts.push(text(ratingX, y + 48, '—', 30, ZERO_COLOR, 'middle'))
    }

    // Статистика: возд, назем, ассисты, захваты, смерти
    const vals = [p.kills, p.groundKills, p.assists, p.captureZone, p.deaths]
    vals.forEach((v, i) => {
      const c = v > 0 ? STAT_COLORS[i]! : ZERO_COLOR
      parts.push(text(statX[i]!, y + 48, String(Math.max(v, 0)), 36, c, 'middle', 600))
    })
  })

  return parts.join('\n')
}

// ---------- общая логика команд ----------

/**
 * Люди без ботов, сгруппированы по командам, внутри — по очкам.
 * Первой (слева, «золотой») идёт команда с большей суммой очков — как у
 * Boris Stats; честного признака победителя в results-BLK нет.
 * Экспортируется для консольной таблицы (battle-summary) — порядок команд
 * всюду одинаковый и совпадает с summarizeTeams.
 */
export function buildRosters(results: ReplayResults): ReplayPlayerResult[][] {
  const humans = results.players.filter((p) => !p.name.startsWith('coop/'))
  const known = humans.filter((p) => p.team >= 0)
  const teams = [...new Set(known.map((p) => p.team))].sort()
  const rosters = teams.map((t) => known.filter((p) => p.team === t).sort((a, b) => b.score - a.score))

  // Отключившиеся без строки результатов (team неизвестен): клановые бои
  // идут 8×8, так что дописываем их в неполную команду; при равных
  // размерах команду не угадать — такую запись не показываем.
  for (const ghost of humans.filter((p) => p.team < 0)) {
    const sizes = rosters.map((r) => r.length)
    const min = Math.min(...sizes)
    const smaller = rosters.filter((r) => r.length === min)
    if (smaller.length === 1) smaller[0]!.push(ghost)
  }

  const total = (r: ReplayPlayerResult[]): number => r.reduce((acc, p) => acc + Math.max(p.score, 0), 0)
  return rosters.sort((a, b) => total(b) - total(a))
}

function classCounts(roster: ReplayPlayerResult[], dict: VehicleDict): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of roster) {
    const cls = vehicleInfo(dict, p.vehicles[0] ?? '').cls
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }
  return counts
}

/** «Name@psn» → имя без суффикса + платформа (консольные игроки) */
function splitPlatform(raw: string): { name: string; platform: 'psn' | 'live' | null } {
  const m = /^(.+)@(psn|live|epic)$/i.exec(raw.trim())
  if (!m) return { name: raw, platform: null }
  const suffix = m[2]!.toLowerCase()
  return { name: m[1]!, platform: suffix === 'psn' || suffix === 'live' ? suffix : null }
}

// ---------- примитивы ----------

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  anchor: 'start' | 'middle' = 'start',
  weight = 400,
): string {
  return `<text x="${x}" y="${y}" font-family="${FONTS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${content}</text>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** CJK-символы шире латиницы примерно вдвое — режем по «полуширинам» */
function trimToWidth(s: string, units: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
    if (used + w > units) return out + '…'
    out += ch
    used += w
  }
  return out
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

const p2 = (n: number): string => String(n).padStart(2, '0')

// ---------- флаги наций (38×24) ----------

function flagSvg(x: number, y: number, country: string, uid: string): string {
  return (
    `<g transform="translate(${x} ${y})">` +
    `<clipPath id="${uid}"><rect width="38" height="24" rx="3"/></clipPath>` +
    `<g clip-path="url(#${uid})">${flagInner(country)}</g>` +
    `<rect width="38" height="24" rx="3" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1"/>` +
    `</g>`
  )
}

function flagInner(country: string): string {
  switch (country) {
    case 'usa': {
      let s = `<rect width="38" height="24" fill="#ffffff"/>`
      const sh = 24 / 13
      for (let i = 0; i < 13; i += 2) s += `<rect y="${(i * sh).toFixed(2)}" width="38" height="${sh.toFixed(2)}" fill="#b22234"/>`
      return s + `<rect width="16" height="11.1" fill="#3c3b6e"/>`
    }
    case 'ussr':
      // Красное полотнище, звезда и серп — чтобы не путать с Китаем
      return (
        `<rect width="38" height="24" fill="#cd0000"/>` +
        `<polygon points="${starPoints(9, 5.2, 2.6)}" fill="#ffd700"/>` +
        `<path d="M12.6 15.4 A5 5 0 1 1 13.6 9.2" stroke="#ffd700" stroke-width="1.7" fill="none"/>` +
        `<path d="M6.2 16.8 L13.4 9.6" stroke="#ffd700" stroke-width="1.7"/>`
      )
    case 'germany':
      return (
        `<rect width="38" height="8" fill="#111111"/>` +
        `<rect y="8" width="38" height="8" fill="#dd0000"/>` +
        `<rect y="16" width="38" height="8" fill="#ffce00"/>`
      )
    case 'britain':
      return (
        `<rect width="38" height="24" fill="#012169"/>` +
        `<path d="M0 0 L38 24 M38 0 L0 24" stroke="#ffffff" stroke-width="4.6"/>` +
        `<path d="M0 0 L38 24 M38 0 L0 24" stroke="#c8102e" stroke-width="1.8"/>` +
        `<path d="M19 0 V24 M0 12 H38" stroke="#ffffff" stroke-width="7.4"/>` +
        `<path d="M19 0 V24 M0 12 H38" stroke="#c8102e" stroke-width="4.2"/>`
      )
    case 'japan':
      return `<rect width="38" height="24" fill="#ffffff"/><circle cx="19" cy="12" r="7" fill="#bc002d"/>`
    case 'china': {
      let s = `<rect width="38" height="24" fill="#de2910"/><polygon points="${starPoints(6.5, 7, 4.2)}" fill="#ffde00"/>`
      for (const [sx, sy] of [[13, 2.6], [15.2, 5.4], [15.2, 8.8], [13, 11.6]] as const) {
        s += `<polygon points="${starPoints(sx, sy, 1.4)}" fill="#ffde00"/>`
      }
      return s
    }
    case 'italy':
      return (
        `<rect width="12.7" height="24" fill="#009246"/>` +
        `<rect x="12.7" width="12.7" height="24" fill="#ffffff"/>` +
        `<rect x="25.4" width="12.6" height="24" fill="#ce2b37"/>`
      )
    case 'france':
      return (
        `<rect width="12.7" height="24" fill="#002395"/>` +
        `<rect x="12.7" width="12.7" height="24" fill="#ffffff"/>` +
        `<rect x="25.4" width="12.6" height="24" fill="#ed2939"/>`
      )
    case 'sweden':
      return (
        `<rect width="38" height="24" fill="#006aa7"/>` +
        `<rect x="11" width="5.5" height="24" fill="#fecc00"/>` +
        `<rect y="9.2" width="38" height="5.5" fill="#fecc00"/>`
      )
    case 'israel':
      return (
        `<rect width="38" height="24" fill="#ffffff"/>` +
        `<rect y="2.4" width="38" height="3.4" fill="#0038b8"/>` +
        `<rect y="18.2" width="38" height="3.4" fill="#0038b8"/>` +
        `<polygon points="19,6.4 23.8,14.6 14.2,14.6" fill="none" stroke="#0038b8" stroke-width="1.4"/>` +
        `<polygon points="19,17.6 14.2,9.4 23.8,9.4" fill="none" stroke="#0038b8" stroke-width="1.4"/>`
      )
    default:
      return `<rect width="38" height="24" fill="#58637a"/><text x="19" y="17" font-family="${FONTS}" font-size="14" fill="#ffffff" text-anchor="middle">?</text>`
  }
}

function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

// ---------- значки (viewBox 24×24, масштабируются под size) ----------

function iconGroup(x: number, y: number, size: number, inner: string): string {
  const k = size / 24
  return `<g transform="translate(${x} ${y}) scale(${k})">${inner}</g>`
}

function iconPlane(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<path fill="${fill}" d="M12 1 L14.2 8.6 L23 12.6 L14.4 12.4 L13.4 19.4 L16.6 22.6 L12 21 L7.4 22.6 L10.6 19.4 L9.6 12.4 L1 12.6 L9.8 8.6 Z"/>`,
  )
}

function iconHeli(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<line x1="2" y1="5" x2="20" y2="5" stroke="${fill}" stroke-width="2"/>` +
      `<rect x="10" y="5" width="2" height="5" fill="${fill}"/>` +
      `<ellipse cx="10.5" cy="14" rx="7.5" ry="4.5" fill="${fill}"/>` +
      `<rect x="16" y="12.7" width="7" height="2.2" fill="${fill}"/>` +
      `<rect x="21.5" y="9.5" width="1.6" height="6" fill="${fill}"/>`,
  )
}

function iconTank(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<rect x="7" y="7.5" width="9" height="5.5" rx="1.2" fill="${fill}"/>` +
      `<rect x="14.5" y="8.8" width="8.5" height="2" fill="${fill}"/>` +
      `<rect x="2" y="13" width="20" height="7" rx="3.5" fill="${fill}"/>`,
  )
}

/** Звезда в круге — колонка личного кланового рейтинга (как у Boris) */
function iconStarCircle(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<circle cx="12" cy="12" r="10.4" fill="none" stroke="${fill}" stroke-width="1.9"/>` +
      `<polygon fill="${fill}" points="${starPoints(12, 12, 6.4)}"/>`,
  )
}

/** Красный кружок с перечёркнутой вилкой — игрок отключился */
function iconDisconnect(x: number, y: number, size: number): string {
  return iconGroup(
    x,
    y,
    size,
    `<circle cx="12" cy="12" r="11" fill="#c93a3a"/>` +
      `<g transform="rotate(45 12 12)" fill="#ffffff">` +
      `<rect x="9.4" y="6.2" width="5.2" height="5.6" rx="1.1"/>` +
      `<rect x="10.2" y="3.2" width="1.3" height="3"/>` +
      `<rect x="12.5" y="3.2" width="1.3" height="3"/>` +
      `<rect x="11.35" y="11.8" width="1.3" height="3.4"/>` +
      `<rect x="11.35" y="17" width="1.3" height="3.6"/>` +
      `</g>`,
  )
}

function iconStar(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<polygon fill="${fill}" points="12,1.5 14.9,8.4 22.4,9 16.7,13.9 18.4,21.2 12,17.3 5.6,21.2 7.3,13.9 1.6,9 9.1,8.4"/>`,
  )
}

function iconDiamond(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<rect x="6.3" y="6.3" width="11.4" height="11.4" fill="none" stroke="${fill}" stroke-width="2.4" transform="rotate(45 12 12)"/>` +
      `<circle cx="12" cy="12" r="2" fill="${fill}"/>`,
  )
}

function iconSkull(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<circle cx="12" cy="10" r="8.2" fill="${fill}"/>` +
      `<rect x="8" y="14.5" width="8" height="7" rx="2" fill="${fill}"/>` +
      `<circle cx="9" cy="10" r="2.1" fill="#10151f"/>` +
      `<circle cx="15" cy="10" r="2.1" fill="#10151f"/>` +
      `<rect x="10.4" y="16.5" width="1.4" height="3.5" fill="#10151f"/>` +
      `<rect x="13" y="16.5" width="1.4" height="3.5" fill="#10151f"/>`,
  )
}

/** Xbox: круг с крестом (как ⓧ у Boris) */
function iconXbox(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<circle cx="12" cy="12" r="10" fill="none" stroke="${fill}" stroke-width="2.2"/>` +
      `<path d="M7.8 7.8 L16.2 16.2 M16.2 7.8 L7.8 16.2" stroke="${fill}" stroke-width="2.4" stroke-linecap="round"/>`,
  )
}

/** PlayStation: круг с «PS» */
function iconPs(x: number, y: number, size: number, fill: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<circle cx="12" cy="12" r="10" fill="none" stroke="${fill}" stroke-width="2.2"/>` +
      `<text x="12" y="16" font-family="${FONTS}" font-size="10" font-weight="700" fill="${fill}" text-anchor="middle">PS</text>`,
  )
}
