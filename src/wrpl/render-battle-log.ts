import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'
import { buildRosters, tagMarkup } from './render-battle.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'
import { GAME_SYMBOLS_FAMILY } from './wt-fonts.js'

/**
 * Battle Log — картинка с хронологией боя:
 * [мм:сс] убийца (техника) → глагол с иконкой → жертва (техника) · дистанция.
 *
 * Вёрстка колоночная, чтобы ничего не съезжало: блок убийцы прижат
 * text-anchor="end" к центральной колонке, блок жертвы — "start" от неё,
 * иконка с глаголом центрируются между ними; ручная оценка ширины текста
 * используется только внутри центрального блока. Событие без виновника
 * (разбился, загорелся) пишется в колонке убийцы как действующее лицо.
 *
 * События: уничтожения (череп, с дистанцией по позициям из события),
 * поджоги (пламя) и тяжёлые повреждения (гаечный ключ). Имена окрашены
 * цветом команды со скриншота результатов (левая «золотая» / правая
 * белая), ИИ-юниты (дроны и т.п.) — серым.
 */

const W = 1760
const CX = W / 2
const ROW_H = 46
const TOP = 236
/** Отступ колонок убийцы/жертвы от центра — место под иконку и глагол */
const MID_GAP = 158

const TEAM_COLOR = ['#f2cc60', '#ffffff']
const AI_COLOR = '#9aa2b1'
const VEHICLE_COLOR = '#8fa0b3'
const KIND_COLOR = { kill: '#ff7b72', fire: '#f0883e', severe: '#e3b341' } as const
const FONTS = `Segoe UI, Segoe UI Symbol, Microsoft YaHei, Malgun Gothic, Yu Gothic UI, Arial, sans-serif`

export interface BattleLogInput {
  missionName: string
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  dict: VehicleDict
}

interface LogSide {
  name: string
  color: string
  vehicle: string
}

interface LogRow {
  time: number
  kind: 'kill' | 'fire' | 'severe'
  left: LogSide | null
  right: LogSide
  /** Дистанция фрага в метрах (у уничтожений с обеими позициями) */
  distanceM: number | null
}

const modelId = (model: string): string => model.replace(/^.*\//, '')

/** Собирает строки лога в хронологическом порядке */
export function collectLogRows(input: BattleLogInput): LogRow[] {
  const { events, results, dict } = input

  // userId → цвет команды (по порядку ростеров со скриншота) и имя
  const teamOf = new Map<string, { p: ReplayPlayerResult; color: string }>()
  buildRosters(results).forEach((roster, ti) => {
    for (const p of roster) teamOf.set(p.userId, { p, color: TEAM_COLOR[Math.min(ti, 1)]! })
  })

  // Клан-тег в строках не пишем: команду кодирует цвет имени, а
  // противостояние тегов вынесено в шапку — имена не приходится резать
  const side = (userId: string, model: string): LogSide | null => {
    const known = userId ? teamOf.get(userId) : undefined
    const vehicle = model ? vehicleInfo(dict, modelId(model)).name : ''
    if (known) {
      return { name: known.p.name.replace(/@(psn|live|epic)$/i, ''), color: known.color, vehicle }
    }
    if (!model) return null
    return { name: vehicle, color: AI_COLOR, vehicle: '' }
  }

  const rows: LogRow[] = []
  for (const k of events.kills) {
    const victim = side(k.victimId, k.victimModel)
    if (!victim) continue
    const killer = k.killerId !== k.victimId ? side(k.killerId, k.killerModel) : null
    const distanceM =
      killer && k.killerPos && k.victimPos
        ? Math.round(Math.hypot(k.killerPos.x - k.victimPos.x, k.killerPos.z - k.victimPos.z))
        : null
    rows.push({ time: k.time, kind: 'kill', left: killer, right: victim, distanceM })
  }
  for (const d of events.damage) {
    if (d.variant === 'critical' && !d.fire) continue // обычные криты не показываем — шумно
    const victim = side(d.victimId, d.victimModel)
    if (!victim) continue
    rows.push({
      time: d.time,
      kind: d.variant === 'critical' ? 'fire' : 'severe',
      left: d.offenderId !== d.victimId ? side(d.offenderId, d.offenderModel) : null,
      right: victim,
      distanceM: null,
    })
  }
  rows.sort((a, b) => a.time - b.time)
  return rows
}

/** Глаголы: с виновником и без него (сам разбился/загорелся) */
const VERBS = {
  kill: ['уничтожил', 'разбился'],
  fire: ['поджёг', 'загорелся'],
  severe: ['тяжело повредил', 'тяжело повреждён'],
} as const

export function buildBattleLogSvg(input: BattleLogInput, gameFont = false): string {
  const rows = collectLogRows(input)
  const shown = rows.slice(0, 70)
  const moreH = rows.length > shown.length ? 50 : 0
  const H = TOP + Math.max(shown.length, 1) * ROW_H + moreH + 128

  const m = /^\s*\[(.+?)\]\s*(.+)$/.exec(input.missionName.trim())
  const mapName = m?.[2] ?? input.missionName.trim()
  const mode = m?.[1] ?? input.header.battleType
  const start = new Date(input.header.startTime * 1000)
  const dateStr =
    `${start.getUTCFullYear()}-${p2(start.getUTCMonth() + 1)}-${p2(start.getUTCDate())} ` +
    `${p2(start.getUTCHours())}:${p2(start.getUTCMinutes())} UTC`
  const dur = `${p2(Math.floor(input.results.timePlayed / 60))}:${p2(Math.floor(input.results.timePlayed % 60))}`

  const parts: string[] = []
  parts.push(
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#161b24"/><stop offset="1" stop-color="#0b0e14"/>`,
    `</linearGradient>`,
    `<linearGradient id="sepH" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    text(CX, 72, esc(mapName), 50, '#ffffff', 'middle', 600),
    text(CX, 118, `Battle Log · [${esc(mode)}] · ${dateStr} · бой ${dur}`, 28, '#aab4c0', 'middle'),
  )

  // Противостояние: теги команд в их цветах (в строках лога тегов нет)
  const rosters = buildRosters(input.results)
  const tagOf = (roster: ReplayPlayerResult[] | undefined, fallback: string): string => {
    const counts = new Map<string, number>()
    for (const p of roster ?? []) {
      if (p.clanTag) counts.set(p.clanTag, (counts.get(p.clanTag) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return top !== undefined ? tagMarkup(top, gameFont) : esc(fallback)
  }
  const leftTag = tagOf(rosters[0], 'Команда 1')
  const rightTag = tagOf(rosters[1], 'Команда 2')

  parts.push(
    `<text x="${CX - 95}" y="166" font-family="${FONTS}" font-size="32" ` +
    `font-weight="600" fill="${TEAM_COLOR[0]}" text-anchor="end">` +
    leftTag +
    `</text>`,

    `<text x="${CX}" y="166" font-family="${FONTS}" font-size="26" ` +
    `font-weight="400" fill="#6d7681" text-anchor="middle">против</text>`,

    `<text x="${CX + 95}" y="166" font-family="${FONTS}" font-size="32" ` +
    `font-weight="600" fill="${TEAM_COLOR[1]}" text-anchor="start">` +
    rightTag +
    `</text>`,

    `<rect x="170" y="190" width="${W - 340}" height="2" fill="url(#sepH)"/>`,
  )

  if (shown.length === 0) {
    parts.push(text(CX, TOP + 10, 'Событий не найдено', 32, '#9aa2b1', 'middle'))
  }

  shown.forEach((row, i) => {
    const y = TOP + i * ROW_H
    if (i % 2 === 1) {
      parts.push(`<rect x="56" y="${y - 32}" width="${W - 112}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.03"/>`)
    }
    parts.push(text(150, y, mmss(row.time), 26, '#7d8590', 'end'))

    const verb = VERBS[row.kind][row.left ? 0 : 1]
    if (row.left) {
      // убийца ← центр → жертва; блоки прижаты якорями, съехать нечему
      parts.push(sideText(row.left, CX - MID_GAP, y, 'end'))
      parts.push(centerBlock(row.kind, verb, y, gameFont))
      parts.push(sideText(row.right, CX + MID_GAP, y, 'start', row.distanceM))
    } else {
      // без виновника: жертва — действующее лицо в левой колонке
      parts.push(sideText(row.right, CX - MID_GAP, y, 'end'))
      parts.push(centerBlock(row.kind, verb, y, gameFont))
    }
  })

  if (rows.length > shown.length) {
    parts.push(text(CX, TOP + shown.length * ROW_H + 14, `… ещё ${rows.length - shown.length} событий`, 26, '#7d8590', 'middle'))
  }

  // Легенда значков и Match ID
  const legendY = H - 66
  const legendItems: [string, string][] = [
    [skull(0, -21, gameFont), 'уничтожение'],
    [flame(0, -22), 'поджог'],
    [wrench(0, -21), 'тяжёлое повреждение'],
  ]
  const itemW = (label: string): number => 34 + width(label, 22) + 46
  const totalW = legendItems.reduce((acc, [, label]) => acc + itemW(label), 0) - 46
  let lx = CX - totalW / 2
  for (const [icon, label] of legendItems) {
    parts.push(`<g transform="translate(${lx} ${legendY})">${icon}</g>`)
    parts.push(text(lx + 32, legendY, label, 22, '#8b949e'))
    lx += itemW(label)
  }
  parts.push(text(CX, H - 26, `Match ID: ${input.header.sessionId}`, 26, '#8b949e', 'middle'))
  parts.push('</svg>')
  return parts.join('\n')
}

// ---------- строки лога ----------

/**
 * Блок участника одной строкой с якорем: имя + серым техника (+ дистанция
 * у жертвы). Ширины подобраны под колонку, длинное обрезается.
 */
function sideText(s: LogSide, x: number, y: number, anchor: 'start' | 'end', distanceM: number | null = null): string {
  const name = trimU(s.name, 18)
  const vehicle = s.vehicle ? trimU(s.vehicle, 12) : ''
  // отступы между кусками — через dx: пробел в начале tspan SVG схлопывает
  return (
    `<text x="${x}" y="${y}" font-family="${FONTS}" font-size="28" font-weight="600" fill="${s.color}" text-anchor="${anchor}">` +
    esc(name) +
    (vehicle ? `<tspan font-size="22" font-weight="400" fill="${VEHICLE_COLOR}" dx="9">(${esc(vehicle)})</tspan>` : '') +
    (distanceM !== null && distanceM > 0 ? `<tspan font-size="22" font-weight="400" fill="#6d7681" dx="9">· ${distanceM} м</tspan>` : '') +
    `</text>`
  )
}

/** Иконка с глаголом, отцентрованные в средней колонке */
function centerBlock(kind: LogRow['kind'], verb: string, y: number, gameFont: boolean): string {
  const total = 34 + width(verb, 24)
  const x = CX - total / 2
  const icon = kind === 'kill' ? skull(x, y - 21, gameFont) : kind === 'fire' ? flame(x, y - 22) : wrench(x, y - 21)
  return icon + text(x + 34, y, verb, 24, KIND_COLOR[kind])
}

// ---------- примитивы ----------

const mmss = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const p2 = (n: number): string => String(n).padStart(2, '0')

function text(x: number, y: number, content: string, size: number, fill: string, anchor: 'start' | 'middle' | 'end' = 'start', weight = 400): string {
  return `<text x="${x}" y="${y}" font-family="${FONTS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${content}</text>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Оценка ширины строки — только для центрального блока и легенды */
function width(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? size : size * 0.68
  return Math.round(w)
}

/** Обрезка по «полуширинам»: CJK-символ считается за два */
function trimU(s: string, units: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
    if (used + w > units) return out + '…'
    out += ch
    used += w
  }
  return s
}

function skull(x: number, y: number, gameFont = false): string {
  if (gameFont) {
    return (
      `<g transform="translate(${x} ${y}) scale(0.95)">` +
      `<text x="12" y="20" font-family="${GAME_SYMBOLS_FAMILY}" font-size="23" fill="#e8ebee" text-anchor="middle">\u258a</text>` +
      `</g>`
    )
  }
  return (
    `<g transform="translate(${x} ${y}) scale(0.95)">` +
    `<circle cx="12" cy="10" r="8" fill="#e8ebee"/>` +
    `<rect x="8.2" y="14.4" width="7.6" height="6.6" rx="2" fill="#e8ebee"/>` +
    `<circle cx="9.2" cy="10" r="2" fill="#10151f"/><circle cx="14.8" cy="10" r="2" fill="#10151f"/>` +
    `<rect x="10.5" y="16.4" width="1.3" height="3.2" fill="#10151f"/><rect x="12.9" y="16.4" width="1.3" height="3.2" fill="#10151f"/>` +
    `</g>`
  )
}

function flame(x: number, y: number): string {
  return (
    `<g transform="translate(${x} ${y})">` +
    `<path d="M12 2 C14 7 19 9 19 15 A7 7 0 0 1 5 15 C5 10 9 8 9 4 C10.5 6 12 6.5 12 2 Z" fill="#f0883e"/>` +
    `<path d="M12 10 C13 12.5 15.4 13.6 15.4 16.6 A3.4 3.4 0 0 1 8.6 16.6 C8.6 14 11 13 12 10 Z" fill="#f8d47a"/>` +
    `</g>`
  )
}

function wrench(x: number, y: number): string {
  // гаечный ключ под 45°: кольцо с вырезом + ручка
  return (
    `<g transform="translate(${x} ${y}) rotate(45 12 12)" fill="#e3b341">` +
    `<path d="M12 2 A5 5 0 1 0 12 12 A5 5 0 0 0 12 2 Z M12 4.6 A2.4 2.4 0 1 1 12 9.4 A2.4 2.4 0 0 1 12 4.6 Z" fill-rule="evenodd"/>` +
    `<rect x="10.6" y="9" width="2.8" height="13" rx="1.4"/>` +
    `</g>`
  )
}
