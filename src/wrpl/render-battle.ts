import { ensureUnitIcons, loadMapBackground } from './battle-assets.js'
import type { BattlePsr } from './battle-psr.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'
import { ensureGameFlags } from './game-flags.js'
import { ensureGameFonts, GAME_SYMBOLS_FAMILY } from './wt-fonts.js'
import { runWorkerTask, transferableBuffer, transferableCopy, type WorkerPriority } from '../workers/pool.js'

/**
 * The battle results table as PNG, in the style of Boris Stats: the map
 * screenshot (data/maps/, when present) darkened as the background, a header
 * with map, mode and time, two teams with squadron tags, nation flags, the
 * composition (4F/3T/1AA), datamine vehicle silhouettes, platform marks
 * (@psn/@live), the PSR column (⊛: the battle's points above, PSR after it
 * below; battle-psr.ts) and air/ground kills, assists, captures, deaths. A
 * disconnected player gets a red mark and the word Disconnected, a row without
 * results — "Unknown Player".
 *
 * Squadron tag decorations (⚔, lions, flames…) are box-drawing characters
 * that the game's own font draws (wt-fonts.ts); without it they become the
 * nearest Unicode by DECOR_MAP.
 *
 * The SVG is built from strings and rasterized by resvg (no browser) with the
 * fonts of workers/render-fonts.ts.
 */

const W = 1920
const ROW_H = 88
const TEAM_HEADER_H = 130
const CONTENT_TOP = 210
const TEAM_WIDTH = W / 2
const TEAM_SIDE_PADDING = 32

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
// Room for the widest usual PSR, so a long nickname does not run into the
// number in the next column. A trimToWidth unit is about 24 px.
const NAME_RATING_GAP_PX = 56
const NAME_UNIT_PX = 24

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

/** Убирает только игровые рамки клан-тега, сохраняя обычные дефисы и знаки. */
export function stripClanDecorators(tag: string): string {
  return [...tag].filter((ch) => !DECOR_RE.test(ch)).join('')
}

/**
 * Короткое читаемое имя клана для подписей на карте: без игровой рамки и
 * внешних ASCII-разделителей, но с сохранением знаков внутри самого имени.
 */
export function clanDisplayName(tag: string): string {
  const stripped = stripClanDecorators(tag).trim()
  const display = stripped.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return display || stripped
}

/**
 * Клан-тег без украшений — только ядро из букв и цифр в нижнем регистре.
 * В реплее тег обёрнут символами рамок (╊xFUBx╋, -AURI-, ═Astrx║), поэтому
 * для сравнения (например, с настройкой WT_CLAN_TAG) берём лишь ядро.
 */
export function plainClanTag(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
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
      out +=
        `<tspan ` +
        `font-family="${GAME_SYMBOLS_FAMILY}" ` +
        `font-weight="400" ` +
        `font-style="normal">` +
        `${esc(ch)}` +
        `</tspan>`
    } else {
      plain += ch
    }
  }
  flush()
  return out
}

/** What the PSR column draws of a player's BattlePsr. */
export type PsrColumnEntry = Pick<BattlePsr, 'psr' | 'change'>

export interface BattleImageInput {
  /** " [Conquest #1] Fire Arc", as the site gives it */
  missionName: string
  header: WrplHeader
  results: ReplayResults
  dict: VehicleDict
  /** PSR by user id (battle-psr.ts): a player missing from the map gets a dash; no map — an empty column */
  psr?: Map<string, PsrColumnEntry>
  /** The winning team (a results team; cachedBattleMeta) or null */
  winnerTeam?: number | null
}

/** The whole numbers the table shows: PSR rounded as the site does, points as the guides' tables (0 — no points line). */
export function psrLabel(entry: PsrColumnEntry): { psr: number; change: number } {
  return { psr: Math.round(entry.psr), change: entry.change === null ? 0 : Number(entry.change.toFixed(0)) }
}

export interface BattleAssets {
  unitIcons: Map<string, string>
  mapImage: string | null
  gameFlags?: Map<string, string>
  /** Подключён ли фирменный шрифт игры для украшений тегов */
  gameFont: boolean
}

export async function renderBattleImage(
  input: BattleImageInput,
  priority: WorkerPriority = 'interactive',
): Promise<Buffer> {
  const rosters = buildRosters(input.results)
  const iconIds = rosters
    .flat()
    .filter((p) => !isDisconnected(p))
    .flatMap((p) => shownVehicles(p).slice(0, 1))
  const [unitIcons, mapImage, fontFiles, gameFlags] = await Promise.all([
    ensureUnitIcons(iconIds),
    loadMapBackground(input.header.level),
    ensureGameFonts(priority),
    ensureGameFlags(priority),
  ])
  const wireIcons: [string, ArrayBuffer][] = [...unitIcons].map(([id, data]) => [id, transferableCopy(data)])
  const wireMap = mapImage
    ? { mime: mapImage.mime, data: transferableBuffer(mapImage.data) }
    : null
  const transferList = wireIcons.map(([, data]) => data)
  if (wireMap) transferList.push(wireMap.data)
  const png = await runWorkerTask(
    {
      kind: 'render-scoreboard',
      input: {
        input,
        assets: {
          unitIcons: wireIcons,
          mapImage: wireMap,
          gameFont: fontFiles.length > 0,
          gameFlags: [...gameFlags],
          fontFiles,
        },
      },
    },
    { priority, transferList },
  )
  return Buffer.from(png)
}

/** No results row (empty name) or no lineup, and no bot played the slot. */
function isDisconnected(p: ReplayPlayerResult): boolean {
  return (p.name === '' || p.vehicles.length === 0) && !p.botUserId
}

/** What the player drove (player-events.ts); the lineup when the events have no tracks. */
export function shownVehicles(p: Pick<ReplayPlayerResult, 'vehicles' | 'playedVehicles'>): string[] {
  return p.playedVehicles ?? p.vehicles
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
  { missionName, header, results, dict, psr, winnerTeam }: BattleImageInput,
  assets: BattleAssets = { unitIcons: new Map(), mapImage: null, gameFlags: new Map(), gameFont: false },
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
    // Разделители с растворяющимися краями — аккуратнее сплошных линий
    `<linearGradient id="sepH" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.6"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>`,
    `</linearGradient>`,
    `<linearGradient id="sepV" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>`,
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
    text(W / 2, 148, `[${esc(mode)}] · ${dateStr} · бой ${dur}`, 34, '#dbe3ec', 'middle'),
    `<rect x="200" y="${CONTENT_TOP - 28}" width="${W - 400}" height="2" fill="url(#sepH)"/>`,
    // Разделитель команд
    `<rect x="${W / 2 - 1}" y="${CONTENT_TOP + 10}" width="2" height="${H - 90 - (CONTENT_TOP + 10)}" fill="url(#sepV)"/>`,
  )

  rosters.forEach((roster, i) => {
    const theme = TEAM_THEME[Math.min(i, TEAM_THEME.length - 1)]!
    const won = winnerTeam != null && winnerTeam > 0 && roster[0]?.team === winnerTeam
    parts.push(renderTeam(roster, i * TEAM_WIDTH + TEAM_SIDE_PADDING, CONTENT_TOP, dict, theme, assets, i, won, psr))
  })

  parts.push(text(W / 2, H - 26, `Match ID: ${header.sessionId}`, 30, '#aab4c0', 'middle'))
  parts.push('</svg>')
  return parts.join('\n')
}

function renderTeam(
  roster: ReplayPlayerResult[],
  ox: number,
  contentTop: number,
  dict: VehicleDict,
  theme: { clan: string; player: string },
  assets: BattleAssets,
  teamIndex: number,
  won: boolean,
  psr?: Map<string, PsrColumnEntry>,
): string {
  const parts: string[] = []
  // The first column is the personal squadron rating (⊛), then battle stats
  const ratingX = ox + 490
  const statX = [584, 656, 728, 800, 872].map((v) => ox + v)
  const titleBaseline = contentTop + 52
  const metaBaseline = contentTop + 94
  const metaIconTop = contentTop + 68
  const flagsTop = titleBaseline - 30

  // Clan tag: the game font draws the decorations (Unicode stand-ins without it).
  const clan = mostCommon(roster.map((r) => r.clanTag).filter((t) => t !== ''))
  const teamNo = roster[0]?.team ?? teamIndex + 1
  const clanText = clan !== undefined ? clan : `Team ${teamNo}`
  const clanLabel = tagMarkup(clanText, assets.gameFont)
  parts.push(text(ox + 10, titleBaseline, clanLabel, 46, theme.clan, 'start', 600))
  if (won) {
    const victoryLabel =
      `<tspan fill-opacity="0">${clanLabel}</tspan>` +
      `<tspan dx="18" dy="-4" fill="#f2cc60" font-size="28" font-weight="700">Victory</tspan>`
    parts.push(text(ox + 10, titleBaseline, victoryLabel, 46, theme.clan, 'start', 600))
  }

  // Composition (4F/3T/1AA): each player's first driven vehicle
  const counts = classCounts(roster, dict)
  const compo: string[] = []
  for (const cls of CLASS_ORDER) {
    const n = counts.get(cls)
    if (n) compo.push(`<tspan fill="${CLASS_COLOR[cls]}">${n}${cls}</tspan>`)
  }
  parts.push(
    `<text x="${ox + 10}" y="${metaBaseline}" font-family="${FONTS}" font-size="30" fill="#c6cfda">(${compo.join(
      '<tspan fill="#c6cfda">/</tspan>',
    )})</text>`,
  )

  // Team nation flags, from the same vehicles, in the game's nation order
  const nations = [...new Set(roster.map((p) => vehicleInfo(dict, shownVehicles(p)[0] ?? '').country))]
    .filter((c) => c !== '?')
    .sort((a, b) => NATION_ORDER.indexOf(a) - NATION_ORDER.indexOf(b))
    .slice(0, 6)
  const flagsRight = statX[4]! + 18
  nations.forEach((country, i) => {
    parts.push(
      flagSvg(
        flagsRight - (nations.length - i) * 46,
        flagsTop,
        country,
        `fl${teamIndex}_${i}`,
        assets.gameFlags,
      ),
    )
  })

  // Column icons: rating, air, ground, assists, captures, deaths
  parts.push(iconStarCircle(ratingX - 14, metaIconTop, 28, '#e6edf3'))
  const icons = [
    (x: number, y: number, size: number, fill: string) => iconPlane(x, y, size, fill, assets.gameFont),
    (x: number, y: number, size: number, fill: string) => iconTank(x, y, size, fill, assets.gameFont),
    (x: number, y: number, size: number, fill: string) => iconStar(x, y, size, fill, assets.gameFont),
    (x: number, y: number, size: number, fill: string) => iconDiamond(x, y, size, fill, assets.gameFont),
    (x: number, y: number, size: number, fill: string) => iconSkull(x, y, size, fill, assets.gameFont),
  ]
  icons.forEach((icon, i) => {
    const size = i < 2 ? 42 : 28
    parts.push(icon(statX[i]! - size / 2, metaIconTop - (size - 28) / 2, size, '#e6edf3'))
  })

  // Players
  roster.forEach((p, row) => {
    const y = contentTop + TEAM_HEADER_H + row * ROW_H
    const disconnected = isDisconnected(p)
    const shown = shownVehicles(p)
    const firstId = shown[0] ?? ''
    const first = vehicleInfo(dict, firstId)
    const color = CLASS_COLOR[first.cls] ?? CLASS_COLOR['?']!

    // The datamine silhouette; a red mark when disconnected, the class icon
    // without a silhouette, nothing when the player never spawned
    const icon = assets.unitIcons.get(firstId)
    if (disconnected) {
      parts.push(iconDisconnect(ox + 26, y + 10, 46))
    } else if (icon) {
      parts.push(
        `<image x="${ox}" y="${y + 6}" width="96" height="56" preserveAspectRatio="xMidYMid meet" href="${icon}"/>`,
      )
    } else if (firstId !== '') {
      const classIcon =
        first.cls === 'F'
          ? (x: number, y2: number, size: number, fill: string) => iconPlane(x, y2, size, fill, assets.gameFont)
          : first.cls === 'H'
            ? iconHeli
            : (x: number, y2: number, size: number, fill: string) => iconTank(x, y2, size, fill, assets.gameFont)
      parts.push(classIcon(ox + 24, y + 12, 48, color))
    }

    // Platform (@psn/@live) → an icon before the nickname. The vehicle line
    // keeps its column and does not follow the icon.
    const { name, platform } = splitPlatform(p.name)
    const vehicleX = ox + 112
    let nameX = vehicleX
    if (platform === 'live') {
      parts.push(iconXbox(nameX, y + 12, 27, '#dfe6ee'))
      nameX += 36
    } else if (platform === 'psn') {
      parts.push(iconPs(nameX, y + 12, 27, '#dfe6ee'))
      nameX += 36
    }
    const defaultNameWidth = platform ? 18 : 20
    const nameWidth = psr
      ? Math.max(
          1,
          Math.min(defaultNameWidth, Math.floor(Math.max(0, ratingX - nameX - NAME_RATING_GAP_PX) / NAME_UNIT_PX)),
        )
      : defaultNameWidth
    const displayName = esc(trimToWidth(name || 'Unknown Player', nameWidth))
    if (psr) {
      const clipId = `player-name-${teamIndex}-${row}`
      parts.push(
        `<clipPath id="${clipId}"><rect x="${nameX}" y="${y + 2}" width="${Math.max(0, ratingX - NAME_RATING_GAP_PX - nameX)}" height="44"/></clipPath>`,
        text(nameX, y + 36, displayName, 34, theme.player, 'start', 400, ` clip-path="url(#${clipId})"`),
      )
    } else {
      parts.push(text(nameX, y + 36, displayName, 34, theme.player))
    }

    // Under the nickname: the vehicles, a disconnect note or a dash (never spawned).
    // A bot slot played for the player: its vehicles, marked "bot".
    if (disconnected) {
      parts.push(text(vehicleX, y + 70, 'Disconnected', 26, '#9aa2b1'))
    } else if (firstId === '') {
      parts.push(text(vehicleX, y + 70, '—', 26, '#9aa2b1'))
    } else {
      const extra = shown.length > 1 ? ` +${shown.length - 1}` : ''
      const bot = p.botUserId ? '<tspan fill="#9aa2b1"> · bot</tspan>' : ''
      parts.push(text(vehicleX, y + 70, esc(trimToWidth(first.name, bot ? 20 : 26)) + extra + bot, 26, color))
    }

    // PSR: the battle's points above, PSR after the battle below (before it while the winner is unknown)
    const entry = psr?.get(p.userId)
    if (entry) {
      const label = psrLabel(entry)
      if (label.change !== 0) {
        const up = label.change > 0
        parts.push(
          text(ratingX, y + 24, `${up ? '+' : '−'}${Math.abs(label.change)}`, 22, up ? '#7ee787' : '#ff7b72', 'middle', 600),
        )
      }
      parts.push(text(ratingX, y + 56, String(label.psr), 30, '#ffffff', 'middle', 600))
    } else if (psr) {
      parts.push(text(ratingX, y + 48, '—', 30, ZERO_COLOR, 'middle'))
    }

    // Stats: air, ground, assists, captures, deaths
    const vals = [p.kills, p.groundKills, p.assists, p.captureZone, p.deaths]
    vals.forEach((v, i) => {
      const c = v > 0 ? STAT_COLORS[i]! : ZERO_COLOR
      parts.push(text(statX[i]!, y + 48, String(Math.max(v, 0)), 36, c, 'middle', 600))
    })
  })

  return parts.join('\n')
}

// ---------- shared team logic ----------

/**
 * Humans without bots, grouped by team, sorted by score within a team. The
 * team with the larger score total goes first (left, "gold"), as in Boris
 * Stats: results-BLK has no honest winner flag. Exported for the console
 * table (battle-summary): the team order is the same everywhere and matches
 * summarizeTeams.
 */
export function buildRosters(results: ReplayResults): ReplayPlayerResult[][] {
  const humans = results.players.filter((p) => !p.name.startsWith('coop/'))
  const known = humans.filter((p) => p.team > 0)
  const teams = [...new Set(known.map((p) => p.team))].sort()
  const rosters = teams.map((t) => known.filter((p) => p.team === t).sort((a, b) => b.score - a.score))

  // Team unknown (≤ 0 after player-events.ts): squadron battles are 8×8, so
  // such a player joins the smaller team; with equal sizes the team cannot be
  // guessed and the row is not shown.
  for (const ghost of humans.filter((p) => p.team <= 0)) {
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
    const cls = vehicleInfo(dict, shownVehicles(p)[0] ?? '').cls
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
  attributes = '',
): string {
  return `<text x="${x}" y="${y}" font-family="${FONTS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${attributes}>${content}</text>`
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

function flagSvg(
  x: number,
  y: number,
  country: string,
  uid: string,
  gameFlags?: Map<string, string>,
): string {
  const native = gameFlags?.get(country)
  if (native) return nativeFlagSvg(x, y, native, uid)
  return (
    `<g transform="translate(${x} ${y})">` +
    `<clipPath id="${uid}"><rect width="38" height="24" rx="3"/></clipPath>` +
    `<g clip-path="url(#${uid})">${flagInner(country)}</g>` +
    `<rect width="38" height="24" rx="3" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1"/>` +
    `</g>`
  )
}

function nativeFlagSvg(x: number, y: number, raw: string, uid: string): string {
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(raw, 'utf8').toString('base64')}`
  return (
    `<g transform="translate(${x} ${y})">` +
    `<clipPath id="${uid}"><rect width="38" height="24" rx="3"/></clipPath>` +
    `<image width="38" height="24" preserveAspectRatio="xMidYMid meet" href="${dataUri}" clip-path="url(#${uid})"/>` +
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
      return (
        `<rect width="38" height="24" fill="#cd0000"/>` +
        `<polygon points="${starPoints(8, 6.2, 2.8)}" fill="#ffd700"/>` +
        `<text x="21.5" y="18.5" font-family="Segoe UI Symbol, Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#ffd700" text-anchor="middle">☭</text>`
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

function iconPlane(x: number, y: number, size: number, fill: string, gameFont = false): string {
  if (gameFont) return gameClassIcon(x, y, size, fill, '\u25ad')
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

function iconTank(x: number, y: number, size: number, fill: string, gameFont = false): string {
  if (gameFont) return gameClassIcon(x, y, size, fill, '\u25ae')
  return iconGroup(
    x,
    y,
    size,
    `<rect x="7" y="7.5" width="9" height="5.5" rx="1.2" fill="${fill}"/>` +
      `<rect x="14.5" y="8.8" width="8.5" height="2" fill="${fill}"/>` +
      `<rect x="2" y="13" width="20" height="7" rx="3.5" fill="${fill}"/>`,
  )
}

function gameClassIcon(x: number, y: number, size: number, fill: string, glyph: string): string {
  return iconGroup(
    x,
    y,
    size,
    `<text x="12" y="20" font-family="${GAME_SYMBOLS_FAMILY}" font-size="23" font-weight="400" fill="${fill}" text-anchor="middle">${glyph}</text>`,
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

function iconStar(x: number, y: number, size: number, fill: string, gameFont = false): string {
  if (gameFont) return gameClassIcon(x, y, size, fill, '\u25b1')
  return iconGroup(
    x,
    y,
    size,
    `<polygon fill="${fill}" points="12,1.5 14.9,8.4 22.4,9 16.7,13.9 18.4,21.2 12,17.3 5.6,21.2 7.3,13.9 1.6,9 9.1,8.4"/>`,
  )
}

function iconDiamond(x: number, y: number, size: number, fill: string, gameFont = false): string {
  if (gameFont) return gameClassIcon(x, y, size, fill, '\u25b3')
  return iconGroup(
    x,
    y,
    size,
    `<rect x="6.3" y="6.3" width="11.4" height="11.4" fill="none" stroke="${fill}" stroke-width="2.4" transform="rotate(45 12 12)"/>` +
      `<circle cx="12" cy="12" r="2" fill="${fill}"/>`,
  )
}

function iconSkull(x: number, y: number, size: number, fill: string, gameFont = false): string {
  if (gameFont) return gameClassIcon(x, y, size, fill, '\u258a')
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
