/**
 * /scout reply text: plain English for players who do not know the model
 * (memory: short, no abbreviations or emojis), read at a glance mid-battle —
 * the setup first, then the players grouped by the class they will most
 * likely spawn, one line each. Pure: Discord limits are enforced here, the
 * command only wraps the result in an embed.
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
const GROUP_TITLES: Record<ScoutClass | 'unknown', string> = {
  F: 'Aircraft',
  H: 'Helicopters',
  T: 'Tanks',
  L: 'Light tanks',
  AA: 'Anti-air',
  unknown: 'Vehicle unknown',
}
const CLASS_ORDER: readonly ScoutClass[] = ['F', 'H', 'T', 'L', 'AA']
/** Second and third vehicles below this chance are left out of a player's line. */
const MIN_ALTERNATIVE_CHANCE = 0.1
/** "New vehicle" (not seen from the player at this BR) is shown from this chance. */
const MIN_UNSEEN_CHANCE = 0.1
/** A play chance is shown below this; mid-session nearly everyone is above it. */
const SHOW_PLAY_CHANCE_BELOW = 0.9
/** Players below this chance are not listed. */
const MIN_PLAYER_CHANCE = 0.05
const MAX_BENCH = 10
const MAX_FIELD = 1024
const MAX_DESCRIPTION = 4096
const MAX_EMBED = 6000

/** A squadron tag without the game font's frame (`╍Nrst╎` → `Nrst`): outside the game the frame is boxes. */
export function plainTag(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}]/gu, '')
}

/** A vehicle name without the game font's nation and premium marks (`▄M163`, `␗T-26`, private-use glyphs). */
export function plainVehicleName(name: string): string {
  const plain = name.replace(/[␀-⓿▀-➿-]/gu, '').trim()
  return plain === '' ? name : plain
}

/** "Nrst North_Steel", or the tag alone when the name repeats it. */
export function squadronLabel(displayTag: string, name: string | null): string {
  const tag = plainTag(displayTag) || displayTag
  return name && name.toLowerCase() !== tag.toLowerCase() ? `${tag} ${name}` : tag
}

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
  return parts.length > 0 ? parts.join(' · ') : 'nobody'
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** Red: mid-session, the prediction is firm; grey: after a break or no data, a guess. */
export const SCOUT_COLOR_SESSION = 0xc0392b
export const SCOUT_COLOR_GUESS = 0x7f8c8d

export interface ScoutEmbedText {
  color: number
  title: string
  description: string
  fields: { name: string; value: string }[]
}

function playerLine(player: ScoutPlayerPrediction, report: ScoutReport): string {
  const name = (id: string) => plainVehicleName(vehicleInfo(report.vehicles, id).name)
  const nick = `**${escapeMarkdown(player.nick)}**`
  const plays = player.playChance < SHOW_PLAY_CHANCE_BELOW ? ` (plays ${percent(player.playChance)})` : ''
  const [best, ...rest] = player.vehicles
  if (player.battlesAtCap === 0 || !best) return `${nick}${plays}: no battles at this BR yet`
  const parts = [`${name(best.vehicleId)} ${percent(best.chance)}`]
  for (const vehicle of rest.slice(0, 2)) if (vehicle.chance >= MIN_ALTERNATIVE_CHANCE) parts.push(`${name(vehicle.vehicleId)} ${percent(vehicle.chance)}`)
  if (player.unseenChance >= MIN_UNSEEN_CHANCE) parts.push(`new vehicle ${percent(player.unseenChance)}`)
  return `${nick}${plays}: ${parts.join(', ')}`
}

function likelyClass(player: ScoutPlayerPrediction, report: ScoutReport): ScoutClass | 'unknown' {
  const best = player.vehicles[0]
  if (player.battlesAtCap === 0 || !best) return 'unknown'
  const cls = vehicleInfo(report.vehicles, best.vehicleId).cls
  return cls === '?' ? 'unknown' : cls
}

export function formatScoutReport(report: ScoutReport): ScoutEmbedText {
  const { squadron, prediction } = report
  const title = clip(squadronLabel(squadron.displayTag, squadron.name), 256)
  const group = prediction.primary
  if (!group || prediction.lastBattleEnd === null) {
    return { color: SCOUT_COLOR_GUESS, title, description: 'No battles stored in the last two weeks, so there is nothing to predict from.', fields: [] }
  }
  const lines: string[] = []
  if (group.regime === 'session') {
    lines.push(`Last battle <t:${group.anchor.endTime}:R>, mid-session: the same players will most likely play.`)
  } else {
    lines.push(
      `Last battle <t:${group.anchor.endTime}:R>, nothing in the last ${SESSION_GAP_SEC / 60} minutes:`
      + ' the players are a guess from who played recently at this time of day.',
    )
  }
  if (report.hint) {
    lines.push(report.hint.matched
      ? `Showing the group of **${escapeMarkdown(report.hint.nick)}**.`
      : `**${escapeMarkdown(report.hint.nick)}** is not in their recent battles, so this is their latest group.`)
  }
  const brText = prediction.maxBr === null ? '' : ` at BR ${prediction.maxBr.toFixed(1)}`
  lines.push(`Based on ${prediction.battlesAtCap} of their battles${brText}.`, '')
  const [top, ...others] = group.setup.compositions
  if (top) {
    lines.push('**Most likely setup**', `${compositionText(top.counts)} — ${percent(top.chance)}`)
    for (const other of others) lines.push(`${compositionText(other.counts)} — ${percent(other.chance)}`)
    lines.push('')
  }
  const air = group.setup.expected.F + group.setup.expected.H
  lines.push(`**Air:** ${air.toFixed(1)} expected, at least one ${percent(group.setup.airChance)}`)
  const description = clip(lines.join('\n'), MAX_DESCRIPTION)

  // The likely eight, grouped by the class of their most likely vehicle.
  const team = group.players.slice(0, TEAM_SIZE)
  const fields: { name: string; value: string }[] = []
  for (const cls of [...CLASS_ORDER, 'unknown'] as const) {
    const members = team.filter((player) => likelyClass(player, report) === cls)
    if (members.length === 0) continue
    fields.push({
      name: `${GROUP_TITLES[cls]} · ${members.length}`,
      value: clip(members.map((player) => playerLine(player, report)).join('\n'), MAX_FIELD),
    })
  }
  const bench = group.players.slice(TEAM_SIZE).filter((player) => player.playChance >= MIN_PLAYER_CHANCE)
  if (bench.length > 0) {
    fields.push({
      name: 'Could also play',
      value: clip(
        bench.slice(0, MAX_BENCH).map((player) => `${escapeMarkdown(player.nick)} ${percent(player.playChance)}`).join(', ')
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
        + '\nIf you face them, run /scout again with one of these nicks in `player`.',
        MAX_FIELD,
      ),
    })
  }
  // An embed holds 6,000 characters in all: the last fields go first.
  const size = () => title.length + description.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  while (fields.length > 0 && size() > MAX_EMBED) fields.pop()
  return { color: group.regime === 'session' ? SCOUT_COLOR_SESSION : SCOUT_COLOR_GUESS, title, description, fields: fields.slice(0, 25) }
}
