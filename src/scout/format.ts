/**
 * /scout reply text: plain words for players who do not know the model
 * (short, no abbreviations or emojis), read at a glance mid-battle — the air
 * chance first, then the players grouped by the class they will most likely
 * spawn, one line each. How the chances are made stays out of the reply
 * (docs/opponent-scouting.md); a line explains only what the reader can act
 * on (a later screenshot, a reply that updates). The words come from the
 * bot's catalog (English unless the caller passes another). Pure: Discord
 * limits are enforced here, the command only wraps the result in an embed.
 */

import { escapeMarkdown } from 'discord.js'
import { botText, type BotText } from '../i18n/index.js'
import { vehicleInfo, type VehicleDict } from '../wrpl/vehicles.js'
import { SESSION_GAP_SEC, TEAM_SIZE, type ScoutClass, type ScoutPlayerPrediction, type ScoutSetup, type VehicleChance } from './model.js'
import type { ScoutImageReport, ScoutReport } from './report.js'

const CLASS_ORDER: readonly ScoutClass[] = ['F', 'H', 'T', 'L', 'AA']
/** Second and third vehicles below this chance are left out of a player's line. */
const MIN_ALTERNATIVE_CHANCE = 0.1
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

/** "Nrst North_Steel"; the tag alone when the name repeats it, the name alone when it starts with the tag (-BLOB1- "BLOB1 CZ-SK comunity"). */
export function squadronLabel(displayTag: string, name: string | null): string {
  const tag = plainTag(displayTag) || displayTag
  if (!name) return tag
  const lower = name.toLowerCase()
  const key = tag.toLowerCase()
  if (lower === key) return tag
  return lower.startsWith(key) && !/^[\p{L}\p{N}]/u.test(name.slice(tag.length)) ? name : `${tag} ${name}`
}

/** A chance as a whole percent; never 0% or 100%: the model is never sure. */
export function percent(chance: number): string {
  if (chance < 0.01) return '<1%'
  if (chance > 0.99) return '>99%'
  return `${Math.round(chance * 100)}%`
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
 * "nick (plays 84%) — **T-54 (1949)** (93%) · ZSU-37-2 (16%)": the likeliest
 * vehicle bold, then up to two more. Seen before at this BR or guessed from
 * what squadrons take at it, a vehicle reads alike: its chance says how sure
 * the guess is. The chance stands in brackets, as names end in numbers
 * ("TPK 6.41", "AMX-13 DCA 40").
 */
function playerLine(player: ScoutPlayerPrediction, vehicles: VehicleDict, t: BotText, fakeName: string | null = null): string {
  const name = (id: string) => escapeMarkdown(plainVehicleName(vehicleInfo(vehicles, id).name))
  const plays = player.playChance < SHOW_PLAY_CHANCE_BELOW ? ` (${t.scout.plays(percent(player.playChance))})` : ''
  const nick = escapeMarkdown(player.nick)
  const who = `${fakeName === null ? nick : t.scout.anonymousGuess(nick, escapeMarkdown(fakeName))}${plays}`
  const [best, ...rest] = [...player.vehicles, ...player.newVehicles].sort(byChance)
  // Without battles at this BR, a guess this weak names nothing.
  if (!best || (player.battlesAtCap === 0 && best.chance < MIN_ALTERNATIVE_CHANCE)) return `${who} — ${t.scout.noBattlesAtBr}`
  const others = rest.slice(0, 2).filter((vehicle) => vehicle.chance >= MIN_ALTERNATIVE_CHANCE)
  const chance = (vehicle: VehicleChance) => `(${percent(vehicle.chance)})`
  const parts = [`**${name(best.vehicleId)}** ${chance(best)}`, ...others.map((vehicle) => `${name(vehicle.vehicleId)} ${chance(vehicle)}`)]
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
  lines.push(t.scout.basedOn(prediction.battlesAtCap, brText(prediction.maxBr)), '', airLine(group.setup, t))
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

/**
 * The setup as one figure, the calibrated chance of air: whether to take
 * anti-air. The class counts show in the groups' titles. The likeliest
 * composition stays out: right for 45% of teams at best (backtest), it said
 * 8% in a reply with four players new at the BR (2026-10-23).
 */
const airLine = (setup: ScoutSetup, t: BotText): string => t.scout.air(percent(setup.airChance))

/** Players grouped by the class of their most likely vehicle, one line each; `anonymous` — the one guessed behind a fake name. */
function classFields(
  players: readonly ScoutPlayerPrediction[],
  vehicles: VehicleDict,
  t: BotText,
  anonymous: { userId: string; fakeName: string } | null = null,
): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = []
  for (const cls of [...CLASS_ORDER, 'unknown'] as const) {
    const members = players.filter((player) => likelyClass(player, vehicles) === cls)
    if (members.length === 0) continue
    fields.push({
      name: `${t.scout.groups[cls]} · ${members.length}`,
      value: clip(members.map((player) => playerLine(player, vehicles, t, player.userId === anonymous?.userId ? anonymous.fakeName : null)).join('\n'), MAX_FIELD),
    })
  }
  return fields
}

/**
 * The reply to a scoreboard screenshot: the air chance, then the enemies by
 * class, unread rows in a field of their own. Flags and kill columns change
 * the chances, not the text; without flags a line asks for a later screenshot.
 */
export function formatScoutImageReport(report: ScoutImageReport, t: BotText = botText()): ScoutEmbedText {
  const title = clip(report.squadron ? squadronLabel(report.squadron.displayTag, report.squadron.name) : t.scout.enemyTeam, 256)
  const { prediction } = report
  const lines = [airLine(prediction.setup, t)]
  const { read, rowsWithout } = report.enemyFlags
  if (!prediction.flags && read === 0) {
    const total = report.recognised + (report.anonymous ? 1 : 0) + report.unread.length
    lines.push(rowsWithout === null ? t.scout.spawnFirst : rowsWithout >= total ? t.scout.noneSpawned : t.scout.flagsUnread)
  }
  if (report.statShark.pending) lines.push(t.scout.statSharkPending)
  const fields = classFields(prediction.players, report.vehicles, t, report.anonymous)
  if (report.unread.length > 0) {
    fields.push({
      name: t.scout.notRecognised(report.unread.length),
      value: clip(report.unread.map((text) => `"${escapeMarkdown(text)}"`).join('\n'), MAX_FIELD),
    })
  }
  return fitEmbed({ color: SCOUT_COLOR_SESSION, title, description: clip(lines.join('\n'), MAX_DESCRIPTION), fields })
}
