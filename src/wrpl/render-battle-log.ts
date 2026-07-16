import { Resvg } from '@resvg/resvg-js'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult, ReplayResults, WrplHeader } from './replay.js'
import { buildRosters, decorateTag } from './render-battle.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'
import { ensureGameFonts } from './wt-fonts.js'

/**
 * Battle Log — картинка с хронологией боя в стиле Boris Stats:
 * [мм:сс] убийца (техника) → действие → жертва (техника).
 *
 * События: уничтожения (череп), поджоги (пламя) и тяжёлые повреждения
 * (гаечный ключ). Имена окрашены цветом команды со скриншота результатов
 * (левая «золотая» / правая белая), ИИ-юниты (дроны и т.п.) — серым.
 */

const W = 1560
const ROW_H = 46
const TOP = 150

const TEAM_COLOR = ['#f2cc60', '#ffffff']
const AI_COLOR = '#9aa2b1'
const VEHICLE_COLOR = '#8fa0b3'
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
}

const modelId = (model: string): string => model.replace(/^.*\//, '')

export async function renderBattleLogImage(input: BattleLogInput): Promise<Buffer> {
  const fontFiles = await ensureGameFonts()
  const svg = buildBattleLogSvg(input)
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, fontFiles, defaultFontFamily: 'Segoe UI' },
  })
  return resvg.render().asPng()
}

/** Собирает строки лога (по ним же строится и текстовый вариант) */
export function collectLogRows(input: BattleLogInput): LogRow[] {
  const { events, results, dict } = input

  // userId → цвет команды (по порядку ростеров со скриншота) и имя
  const teamOf = new Map<string, { p: ReplayPlayerResult; color: string }>()
  buildRosters(results).forEach((roster, ti) => {
    for (const p of roster) teamOf.set(p.userId, { p, color: TEAM_COLOR[Math.min(ti, 1)]! })
  })

  const side = (userId: string, model: string): LogSide | null => {
    const known = userId ? teamOf.get(userId) : undefined
    const vehicle = model ? vehicleInfo(dict, modelId(model)).name : ''
    if (known) {
      const clan = known.p.clanTag ? decorateTag(known.p.clanTag) + ' ' : ''
      const name = known.p.name.replace(/@(psn|live|epic)$/i, '')
      return { name: clan + name, color: known.color, vehicle }
    }
    if (!model) return null
    return { name: vehicle, color: AI_COLOR, vehicle: '' }
  }

  const rows: LogRow[] = []
  for (const k of events.kills) {
    const victim = side(k.victimId, k.victimModel)
    if (!victim) continue
    rows.push({ time: k.time, kind: 'kill', left: side(k.killerId, k.killerModel), right: victim })
  }
  for (const d of events.damage) {
    if (d.variant === 'critical' && !d.fire) continue // обычные криты не показываем — шумно
    const victim = side(d.victimId, d.victimModel)
    if (!victim) continue
    rows.push({
      time: d.time,
      kind: d.variant === 'critical' ? 'fire' : 'severe',
      left: side(d.offenderId, d.offenderModel),
      right: victim,
    })
  }
  rows.sort((a, b) => a.time - b.time)
  return rows
}

export function buildBattleLogSvg(input: BattleLogInput): string {
  const rows = collectLogRows(input)
  const shown = rows.slice(0, 70)
  const H = TOP + Math.max(shown.length, 1) * ROW_H + (rows.length > shown.length ? 50 : 0) + 90

  const m = /^\s*\[(.+?)\]\s*(.+)$/.exec(input.missionName.trim())
  const title = m ? `${m[2]} — Battle Log` : 'Battle Log'

  const parts: string[] = []
  parts.push(
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#161b24"/><stop offset="1" stop-color="#0b0e14"/>`,
    `</linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    text(W / 2, 66, esc(title), 46, '#ffffff', 'middle', 600),
    `<line x1="120" y1="100" x2="${W - 120}" y2="100" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2"/>`,
  )

  if (shown.length === 0) {
    parts.push(text(W / 2, TOP + 10, 'Событий не найдено', 32, '#9aa2b1', 'middle'))
  }

  shown.forEach((row, i) => {
    const y = TOP + i * ROW_H
    if (i % 2 === 1) {
      parts.push(`<rect x="60" y="${y - 32}" width="${W - 120}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.030"/>`)
    }
    parts.push(text(86, y, mmss(row.time), 27, '#7d8590'))

    let x = 190
    if (row.left) {
      parts.push(text(x, y, esc(row.left.name), 28, row.left.color, 'start', 600))
      x += width(row.left.name, 28) + 12
      if (row.left.vehicle) {
        parts.push(text(x, y, esc(`(${row.left.vehicle})`), 24, VEHICLE_COLOR))
        x += width(`(${row.left.vehicle})`, 24) + 16
      }
    }

    const icon = row.kind === 'kill' ? skull(x, y - 21) : row.kind === 'fire' ? flame(x, y - 22) : wrench(x, y - 21)
    parts.push(icon)
    x += 34
    const verb = row.kind === 'kill' ? 'destroyed' : row.kind === 'fire' ? 'set afire' : 'severely damaged'
    const verbColor = row.kind === 'kill' ? '#ff7b72' : row.kind === 'fire' ? '#f0883e' : '#e3b341'
    parts.push(text(x, y, verb, 25, verbColor))
    x += width(verb, 25) + 16

    parts.push(text(x, y, esc(row.right.name), 28, row.right.color, 'start', 600))
    x += width(row.right.name, 28) + 12
    if (row.right.vehicle) {
      parts.push(text(x, y, esc(`(${row.right.vehicle})`), 24, VEHICLE_COLOR))
    }
  })

  if (rows.length > shown.length) {
    parts.push(text(W / 2, TOP + shown.length * ROW_H + 14, `… ещё ${rows.length - shown.length} событий`, 26, '#7d8590', 'middle'))
  }

  parts.push(text(W / 2, H - 30, `Match ID: ${input.header.sessionId}`, 27, '#8b949e', 'middle'))
  parts.push('</svg>')
  return parts.join('\n')
}

// ---------- примитивы ----------

const mmss = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function text(x: number, y: number, content: string, size: number, fill: string, anchor: 'start' | 'middle' = 'start', weight = 400): string {
  return `<text x="${x}" y="${y}" font-family="${FONTS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${content}</text>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Оценка ширины строки для позиционирования следующего блока */
function width(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? size : size * 0.68
  return Math.round(w)
}

function skull(x: number, y: number): string {
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
