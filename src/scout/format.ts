/**
 * /scout reply text: plain words for players who do not know the model
 * (short, no abbreviations or emojis), read at a glance mid-battle — the
 * setup first, then the players grouped by the class they will most likely
 * spawn, one line each. The words come from the bot's catalog (English
 * unless the caller passes another). Pure: Discord limits are enforced here,
 * the command only wraps the result in an embed.
 */

import { escapeMarkdown } from 'discord.js'
import { botText, type BotText } from '../i18n/index.js'
import { vehicleInfo, type VehicleDict } from '../wrpl/vehicles.js'
import { SESSION_GAP_SEC, TEAM_SIZE, type ScoutClass, type ScoutPlayerPrediction, type ScoutSetup, type VehicleChance } from './model.js'
import type { ScoutImageReport, ScoutReport } from './report.js'

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

/** A flag's country: `usa_modern` → "USA", `south_africa` → "South Africa". */
export function flagName(icon: string, t: BotText = botText()): string {
  return t.scout.flag(icon.replace(/_(modern|early|kingdom|empire|weimar_republic|1963_1991)$/u, ''))
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

export function compositionText(counts: Record<ScoutClass, number>, t: BotText = botText()): string {
  const parts = CLASS_ORDER.filter((cls) => counts[cls] > 0).map((cls) => t.scout.classCount(cls, counts[cls]))
  return parts.length > 0 ? parts.join(' · ') : t.scout.nobody
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
function playerLine(player: ScoutPlayerPrediction, vehicles: VehicleDict, t: BotText): string {
  const name = (id: string) => escapeMarkdown(plainVehicleName(vehicleInfo(vehicles, id).name))
  const plays = player.playChance < SHOW_PLAY_CHANCE_BELOW ? ` (${t.scout.plays(percent(player.playChance))})` : ''
  const who = `${escapeMarkdown(player.nick)}${plays}`
  const fresh = new Set(player.newVehicles.map((vehicle) => vehicle.vehicleId))
  const [best, ...rest] = [...player.vehicles, ...player.newVehicles].sort(byChance)
  const others = rest.slice(0, 2).filter((vehicle) => vehicle.chance >= MIN_ALTERNATIVE_CHANCE)
  if (player.battlesAtCap === 0) {
    if (!best || best.chance < MIN_ALTERNATIVE_CHANCE) return `${who} — ${t.scout.noBattlesAtBr}`
    const guesses = [`**${name(best.vehicleId)} ${percent(best.chance)}**`, ...others.map((vehicle) => `${name(vehicle.vehicleId)} ${percent(vehicle.chance)}`)]
    return `${who} — ${t.scout.likely(guesses.join(' · '))}`
  }
  if (!best) return `${who} — ${t.scout.noBattlesAtBr}`
  const label = (vehicle: VehicleChance) =>
    `${name(vehicle.vehicleId)}${fresh.has(vehicle.vehicleId) ? ` (${t.scout.newMark})` : ''} ${percent(vehicle.chance)}`
  const shown = [best, ...others]
  const parts = [`**${label(best)}**`, ...others.map(label)]
  const named = shown.filter((vehicle) => fresh.has(vehicle.vehicleId)).reduce((sum, vehicle) => sum + vehicle.chance, 0)
  const unnamed = player.unseenChance - named
  if (unnamed >= MIN_UNSEEN_CHANCE) parts.push(named > 0 ? t.scout.otherNewVehicle(percent(unnamed)) : t.scout.newVehicle(percent(unnamed)))
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

export function formatScoutReport(report: ScoutReport, t: BotText = botText()): ScoutEmbedText {
  const { squadron, prediction } = report
  const title = clip(squadronLabel(squadron.displayTag, squadron.name), 256)
  const group = prediction.primary
  if (!group || prediction.lastBattleEnd === null) {
    return { color: SCOUT_COLOR_GUESS, title, description: t.scout.nothingStored, fields: [] }
  }
  const lines: string[] = []
  const last = `<t:${group.anchor.endTime}:R>`
  lines.push(group.regime === 'session' ? t.scout.lastBattleSession(last) : t.scout.lastBattleGuess(last, SESSION_GAP_SEC / 60))
  if (report.hint) {
    const nick = escapeMarkdown(report.hint.nick)
    lines.push(report.hint.matched ? t.scout.hintMatched(nick) : t.scout.hintMissed(nick))
  }
  lines.push(t.scout.basedOn(prediction.battlesAtCap, brText(prediction.maxBr)), '')
  lines.push(...setupLines(group.setup, t))
  const description = clip(lines.join('\n'), MAX_DESCRIPTION)
  const fields = classFields(group.players.slice(0, TEAM_SIZE), report.vehicles, t)
  for (const other of prediction.otherGroups.slice(0, 2)) {
    fields.push({
      name: t.scout.otherGroupTitle,
      value: clip(
        t.scout.otherGroup(`<t:${other.anchor.endTime}:R>`, other.nicks.map((nick) => escapeMarkdown(nick)).join(', ')),
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

/** The cap as the catalog's functions take it: "10.7", or null outside the known stages. */
const brText = (maxBr: number | null): string | null => (maxBr === null ? null : maxBr.toFixed(1))

function setupLines(setup: ScoutSetup, t: BotText): string[] {
  const lines: string[] = []
  const [top, ...others] = setup.compositions
  if (top) {
    lines.push(`**${t.scout.setupTitle}**`, `${compositionText(top.counts, t)} — ${percent(top.chance)}`)
    for (const other of others) lines.push(`${compositionText(other.counts, t)} — ${percent(other.chance)}`)
    lines.push('')
  }
  const air = setup.expected.F + setup.expected.H
  lines.push(t.scout.air(air.toFixed(1), percent(setup.airChance)))
  return lines
}

/** Players grouped by the class of their most likely vehicle, one line each. */
function classFields(players: readonly ScoutPlayerPrediction[], vehicles: VehicleDict, t: BotText): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = []
  for (const cls of [...CLASS_ORDER, 'unknown'] as const) {
    const members = players.filter((player) => likelyClass(player, vehicles) === cls)
    if (members.length === 0) continue
    fields.push({
      name: `${t.scout.groups[cls]} · ${members.length}`,
      value: clip(members.map((player) => playerLine(player, vehicles, t)).join('\n'), MAX_FIELD),
    })
  }
  return fields
}

/** The reply to a scoreboard screenshot: the enemy team as read, its likely vehicles and setup. */
export function formatScoutImageReport(report: ScoutImageReport, t: BotText = botText()): ScoutEmbedText {
  const title = clip(report.squadron ? squadronLabel(report.squadron.displayTag, report.squadron.name) : t.scout.enemyTeam, 256)
  const { prediction } = report
  const total = report.recognised + report.unread.length
  const lines = [t.scout.readFromScreenshot(report.recognised, total)]
  if (prediction.lastTogether) lines.push(t.scout.lastTogether(`<t:${prediction.lastTogether.endTime}:R>`))
  const br = brText(prediction.maxBr)
  const { read, rowsWithout } = report.enemyFlags
  if (prediction.flags) {
    lines.push(t.scout.chancesWithFlags(br, [...new Set(prediction.flags.icons.map((icon) => flagName(icon, t)))].join(', ')))
    if (rowsWithout) lines.push(t.scout.withoutFlag(rowsWithout))
  } else if (read > 0) {
    lines.push(t.scout.chancesOwn(br))
  } else if (rowsWithout !== null && rowsWithout >= total) {
    lines.push(t.scout.noneSpawned(br))
  } else if (rowsWithout !== null) {
    lines.push(t.scout.flagsUnread(br))
  } else {
    lines.push(t.scout.spawnFirst(br))
  }
  if (report.killsShown > 0) lines.push(t.scout.killsNarrow(report.killsShown))
  const guessed = prediction.players.some((player) => player.newVehicles.some((vehicle) => vehicle.chance >= MIN_ALTERNATIVE_CHANCE))
  if (guessed) lines.push(t.scout.newGuessed(report.statShark.players))
  if (report.statShark.pending) lines.push(t.scout.statSharkPending)
  lines.push('', ...setupLines(prediction.setup, t))
  const fields = classFields(prediction.players, report.vehicles, t)
  if (report.unread.length > 0) {
    fields.push({
      name: t.scout.notRecognised(report.unread.length),
      value: clip(report.unread.map((text) => `"${escapeMarkdown(text)}"`).join('\n'), MAX_FIELD),
    })
  }
  return fitEmbed({ color: SCOUT_COLOR_SESSION, title, description: clip(lines.join('\n'), MAX_DESCRIPTION), fields })
}
