/**
 * /scout reply text: plain English for players who do not know the model
 * (memory: short, no abbreviations or emojis), read at a glance mid-battle —
 * the setup first, then the players grouped by the class they will most
 * likely spawn, one line each. Pure: Discord limits are enforced here, the
 * command only wraps the result in an embed.
 */

import { escapeMarkdown } from 'discord.js'
import { vehicleInfo, type VehicleDict } from '../wrpl/vehicles.js'
import { SESSION_GAP_SEC, TEAM_SIZE, type ScoutClass, type ScoutPlayerPrediction, type ScoutSetup, type VehicleChance } from './model.js'
import type { ScoutImageReport, ScoutReport } from './report.js'

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

const FLAG_NAMES: Record<string, string> = {
  usa: 'USA',
  ussr: 'USSR',
  britain: 'Great Britain',
  gdr: 'East Germany',
  republic_china: 'Republic of China',
  uae: 'UAE',
}

/** A flag's country in plain English: `usa_modern` → "USA", `south_africa` → "South Africa". */
export function flagName(icon: string): string {
  const base = icon.replace(/_(modern|early|kingdom|empire|weimar_republic|1963_1991)$/u, '')
  return FLAG_NAMES[base] ?? base.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
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

const byChance = (a: VehicleChance, b: VehicleChance): number => b.chance - a.chance || a.vehicleId.localeCompare(b.vehicleId)

/**
 * "nick (plays 84%) — **T-54 (1949) 93%** · ZSU-37-2 16%": the most likely
 * vehicle is the bold part. A vehicle not seen from the player at this BR
 * (the guess from what squadrons take at it) is marked "new".
 */
function playerLine(player: ScoutPlayerPrediction, vehicles: VehicleDict): string {
  const name = (id: string) => escapeMarkdown(plainVehicleName(vehicleInfo(vehicles, id).name))
  const plays = player.playChance < SHOW_PLAY_CHANCE_BELOW ? ` (plays ${percent(player.playChance)})` : ''
  const who = `${escapeMarkdown(player.nick)}${plays}`
  const fresh = new Set(player.newVehicles.map((vehicle) => vehicle.vehicleId))
  const [best, ...rest] = [...player.vehicles, ...player.newVehicles].sort(byChance)
  const others = rest.slice(0, 2).filter((vehicle) => vehicle.chance >= MIN_ALTERNATIVE_CHANCE)
  if (player.battlesAtCap === 0) {
    if (!best || best.chance < MIN_ALTERNATIVE_CHANCE) return `${who} — no battles at this BR yet`
    const guesses = [`**${name(best.vehicleId)} ${percent(best.chance)}**`, ...others.map((vehicle) => `${name(vehicle.vehicleId)} ${percent(vehicle.chance)}`)]
    return `${who} — no battles at this BR yet, likely ${guesses.join(' · ')}`
  }
  if (!best) return `${who} — no battles at this BR yet`
  const label = (vehicle: VehicleChance) => `${name(vehicle.vehicleId)}${fresh.has(vehicle.vehicleId) ? ' (new)' : ''} ${percent(vehicle.chance)}`
  const shown = [best, ...others]
  const parts = [`**${label(best)}**`, ...others.map(label)]
  const named = shown.filter((vehicle) => fresh.has(vehicle.vehicleId)).reduce((sum, vehicle) => sum + vehicle.chance, 0)
  const unnamed = player.unseenChance - named
  if (unnamed >= MIN_UNSEEN_CHANCE) parts.push(`${named > 0 ? 'other new vehicle' : 'new vehicle'} ${percent(unnamed)}`)
  return `${who} — ${parts.join(' · ')}`
}

/** The class of the most likely vehicle; for a player without battles at this BR, the class the guesses agree on half the time. */
function likelyClass(player: ScoutPlayerPrediction, vehicles: VehicleDict): ScoutClass | 'unknown' {
  const options = [...player.vehicles, ...player.newVehicles].sort(byChance)
  if (player.battlesAtCap === 0) {
    const byClass = new Map<ScoutClass, number>()
    for (const vehicle of options) {
      const cls = vehicleInfo(vehicles, vehicle.vehicleId).cls
      if (cls !== '?') byClass.set(cls, (byClass.get(cls) ?? 0) + vehicle.chance)
    }
    const top = [...byClass].sort((a, b) => b[1] - a[1])[0]
    return top && top[1] >= 0.5 ? top[0] : 'unknown'
  }
  const best = options[0]
  if (!best) return 'unknown'
  const cls = vehicleInfo(vehicles, best.vehicleId).cls
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
  lines.push(...setupLines(group.setup))
  const description = clip(lines.join('\n'), MAX_DESCRIPTION)
  const fields = classFields(group.players.slice(0, TEAM_SIZE), report.vehicles)
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
  return fitEmbed({ color: group.regime === 'session' ? SCOUT_COLOR_SESSION : SCOUT_COLOR_GUESS, title, description, fields })
}

/** An embed holds 6,000 characters and 25 fields in all: the last fields go first. */
function fitEmbed(text: ScoutEmbedText): ScoutEmbedText {
  const fields = text.fields.slice(0, 25)
  const size = () => text.title.length + text.description.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  while (fields.length > 0 && size() > MAX_EMBED) fields.pop()
  return { ...text, fields }
}

function setupLines(setup: ScoutSetup): string[] {
  const lines: string[] = []
  const [top, ...others] = setup.compositions
  if (top) {
    lines.push('**Most likely setup**', `${compositionText(top.counts)} — ${percent(top.chance)}`)
    for (const other of others) lines.push(`${compositionText(other.counts)} — ${percent(other.chance)}`)
    lines.push('')
  }
  const air = setup.expected.F + setup.expected.H
  lines.push(`**Air:** ${air.toFixed(1)} expected, at least one ${percent(setup.airChance)}`)
  return lines
}

/** Players grouped by the class of their most likely vehicle, one line each. */
function classFields(players: readonly ScoutPlayerPrediction[], vehicles: VehicleDict): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = []
  for (const cls of [...CLASS_ORDER, 'unknown'] as const) {
    const members = players.filter((player) => likelyClass(player, vehicles) === cls)
    if (members.length === 0) continue
    fields.push({
      name: `${GROUP_TITLES[cls]} · ${members.length}`,
      value: clip(members.map((player) => playerLine(player, vehicles)).join('\n'), MAX_FIELD),
    })
  }
  return fields
}

/** The reply to a scoreboard screenshot: the enemy team as read, its likely vehicles and setup. */
export function formatScoutImageReport(report: ScoutImageReport): ScoutEmbedText {
  const title = clip(report.squadron ? squadronLabel(report.squadron.displayTag, report.squadron.name) : 'Enemy team', 256)
  const { prediction } = report
  const lines = [`Read from the screenshot: ${report.recognised} of ${report.recognised + report.unread.length} enemy players.`]
  if (prediction.lastTogether) {
    lines.push(`Last played together <t:${prediction.lastTogether.endTime}:R>.`)
  }
  const brText = prediction.maxBr === null ? '' : ` at BR ${prediction.maxBr.toFixed(1)}`
  const { read, rowsWithout } = report.enemyFlags
  if (prediction.flags) {
    const names = [...new Set(prediction.flags.icons.map(flagName))].join(', ')
    lines.push(`Vehicle chances come from each player's own battles${brText} and the flags above their team: ${names}.`)
    if (rowsWithout) {
      lines.push(`${rowsWithout === 1 ? '1 enemy shows' : `${rowsWithout} enemies show`} no flag (not spawned yet or destroyed): their chances rest on their battles alone.`)
    }
  } else if (read > 0) {
    lines.push(`Vehicle chances come from each player's own battles${brText}.`)
  } else if (rowsWithout !== null && rowsWithout >= report.recognised + report.unread.length) {
    lines.push(`Vehicle chances come from each player's own battles${brText}. No enemy is in a vehicle yet: a screenshot after they spawn shows their flags and sharpens the guess.`)
  } else if (rowsWithout !== null) {
    lines.push(`Vehicle chances come from each player's own battles${brText}. The flags above their team were not read: a screenshot showing them sharpens the guess.`)
  } else {
    lines.push(`Vehicle chances come from each player's own battles${brText}. A screenshot after they spawn shows their flags and sharpens the guess.`)
  }
  const guessed = prediction.players.some((player) => player.newVehicles.some((vehicle) => vehicle.chance >= MIN_ALTERNATIVE_CHANCE))
  if (guessed) {
    const shark = report.statShark.players > 0 ? ` and their battles on StatShark (${report.statShark.players} ${report.statShark.players === 1 ? 'player' : 'players'})` : ''
    lines.push(`A vehicle not seen from a player at this BR (new) is guessed from what squadrons take at it${shark}.`)
  }
  if (report.statShark.pending) lines.push('Checking their battles on StatShark: this reply updates in a minute or two.')
  lines.push('', ...setupLines(prediction.setup))
  const fields = classFields(prediction.players, report.vehicles)
  if (report.unread.length > 0) {
    fields.push({
      name: `Not recognised · ${report.unread.length}`,
      value: clip(report.unread.map((text) => `"${escapeMarkdown(text)}"`).join('\n'), MAX_FIELD),
    })
  }
  return fitEmbed({ color: SCOUT_COLOR_SESSION, title, description: clip(lines.join('\n'), MAX_DESCRIPTION), fields })
}
