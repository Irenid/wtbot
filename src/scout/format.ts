/**
 * /scout reply text: plain English for players who do not know the model
 * (memory: short, no abbreviations or emojis). Pure: Discord limits are
 * enforced here, the command only wraps the result in an embed.
 */

import { escapeMarkdown } from 'discord.js'
import { vehicleInfo } from '../wrpl/vehicles.js'
import { SESSION_GAP_SEC, TEAM_SIZE, type ScoutClass, type ScoutPlayerPrediction } from './model.js'
import type { ScoutReport } from './report.js'

const CLASS_NAMES: Record<ScoutClass, [string, string]> = {
  F: ['aircraft', 'aircraft'],
  H: ['helicopter', 'helicopters'],
  T: ['tank', 'tanks'],
  L: ['light tank', 'light tanks'],
  AA: ['anti-air', 'anti-air'],
}
const CLASS_ORDER: readonly ScoutClass[] = ['F', 'H', 'T', 'L', 'AA']
/** Vehicles below this chance are left out of a player's line. */
const MIN_VEHICLE_CHANCE = 0.03
/** Players below this chance are not listed. */
const MIN_PLAYER_CHANCE = 0.05
const MAX_BENCH = 10
const MAX_FIELD = 1024
const MAX_DESCRIPTION = 4096
const MAX_EMBED = 6000

/** A chance as a whole percent; never 0% or 100%: the model is never sure. */
export function percent(chance: number): string {
  if (chance < 0.01) return '<1%'
  if (chance > 0.99) return '>99%'
  return `${Math.round(chance * 100)}%`
}

export function compositionText(counts: Record<ScoutClass, number>): string {
  const parts = CLASS_ORDER.filter((cls) => counts[cls] > 0).map((cls) => {
    const [one, many] = CLASS_NAMES[cls]
    return `${counts[cls]} ${counts[cls] === 1 ? one : many}`
  })
  return parts.length > 0 ? parts.join(', ') : 'nobody'
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export interface ScoutEmbedText {
  title: string
  description: string
  fields: { name: string; value: string }[]
}

function playerLine(player: ScoutPlayerPrediction, report: ScoutReport, maxBr: string): string {
  const name = (id: string) => vehicleInfo(report.vehicles, id).name
  if (player.battlesAtCap === 0) {
    const lineup = player.lineup.length > 0 ? ` Last lineup: ${player.lineup.map(name).join(', ')}.` : ''
    return `No battles at ${maxBr} yet: any vehicle.${lineup}`
  }
  const shown = player.vehicles.filter((vehicle, index) => index === 0 || vehicle.chance >= MIN_VEHICLE_CHANCE).slice(0, 4)
  const parts = shown.map((vehicle) => `${name(vehicle.vehicleId)} ${percent(vehicle.chance)}`)
  if (player.unseenChance >= 0.05) parts.push(`another vehicle ${percent(player.unseenChance)}`)
  const listed = new Set(shown.map((vehicle) => vehicle.vehicleId))
  const rest = player.lineup.filter((id) => !listed.has(id)).map(name)
  return parts.join(' · ') + (rest.length > 0 ? `\nAlso in the lineup: ${rest.join(', ')}` : '')
}

export function formatScoutReport(report: ScoutReport): ScoutEmbedText {
  const { squadron, prediction } = report
  const title = clip(`${squadron.displayTag}${squadron.name ? ` ${squadron.name}` : ''}: next team`, 256)
  const maxBr = prediction.maxBr === null ? 'this BR' : `BR ${prediction.maxBr.toFixed(1)}`
  const group = prediction.primary
  if (!group || prediction.lastBattleEnd === null) {
    return {
      title,
      description: `No battles of ${escapeMarkdown(squadron.displayTag)} stored in the last two weeks, so there is nothing to predict from.`,
      fields: [],
    }
  }
  const lines: string[] = []
  if (group.regime === 'session') {
    lines.push(`Last battle <t:${group.anchor.endTime}:R>: they are mid-session, so the same players most likely play again.`)
  } else {
    lines.push(
      `Last battle <t:${group.anchor.endTime}:R>. Nothing in the last ${SESSION_GAP_SEC / 60} minutes, so the players below are a guess`
      + ' from who played recently and at this time of day.',
    )
  }
  lines.push(`${prediction.battlesAtCap} of their battles at ${maxBr} are stored.`)
  if (report.hint) {
    lines.push(report.hint.matched
      ? `Following the group of ${escapeMarkdown(report.hint.nick)}.`
      : `${escapeMarkdown(report.hint.nick)} is not in their battles of the last two weeks; showing their latest group.`)
  }
  const [top, ...others] = group.setup.compositions
  lines.push('')
  if (top) lines.push(`**Most likely setup:** ${compositionText(top.counts)} (${percent(top.chance)})`)
  for (const other of others) lines.push(`Or: ${compositionText(other.counts)} (${percent(other.chance)})`)
  const air = group.setup.expected.F + group.setup.expected.H
  lines.push(`**Aircraft and helicopters:** ${air.toFixed(1)} expected, at least one ${percent(group.setup.airChance)}`)
  const team = group.players.slice(0, TEAM_SIZE)
  const likely = new Map<string, number>()
  for (const player of team) {
    const best = player.vehicles[0]
    if (best && player.battlesAtCap > 0) likely.set(best.vehicleId, (likely.get(best.vehicleId) ?? 0) + 1)
  }
  if (likely.size > 0) {
    const list = [...likely]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => `${vehicleInfo(report.vehicles, id).name}${count > 1 ? ` ×${count}` : ''}`)
    lines.push(`**Likely vehicles:** ${list.join(', ')}`)
  }

  const fields = team.map((player) => ({
    name: clip(`${escapeMarkdown(player.nick)}: plays ${percent(player.playChance)}`, 256),
    value: clip(playerLine(player, report, maxBr), MAX_FIELD),
  }))
  const bench = group.players.slice(TEAM_SIZE).filter((player) => player.playChance >= MIN_PLAYER_CHANCE)
  if (bench.length > 0) {
    fields.push({
      name: 'Less likely to play',
      value: clip(
        bench.slice(0, MAX_BENCH).map((player) => `${escapeMarkdown(player.nick)} ${percent(player.playChance)}`).join(' · ')
        + (bench.length > MAX_BENCH ? ` and ${bench.length - MAX_BENCH} more` : ''),
        MAX_FIELD,
      ),
    })
  }
  for (const other of prediction.otherGroups.slice(0, 2)) {
    fields.push({
      name: 'Another group is playing at the same time',
      value: clip(
        `Last battle <t:${other.anchor.endTime}:R>: ${other.nicks.map((nick) => escapeMarkdown(nick)).join(', ')}.`
        + ' To scout it, run /scout again with a nick you see in `player`.',
        MAX_FIELD,
      ),
    })
  }
  const description = clip(lines.join('\n').trimEnd(), MAX_DESCRIPTION)
  // An embed holds 6,000 characters in all: the last fields go first.
  const kept = fields.slice(0, 25)
  const size = () => title.length + description.length + kept.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  while (kept.length > 0 && size() > MAX_EMBED) kept.pop()
  return { title, description, fields: kept }
}
