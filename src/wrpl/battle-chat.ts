import { botText, type Locale } from '../i18n/index.js'
import type { ReplayEvents } from './replay-events.js'
import type { ReplayPlayerResult } from './replay.js'
import { decorateTag } from './render-battle.js'

/**
 * The chat as text lines. A sender's tag comes from the results rows, which
 * hold the tags the game left out (squadron-tags.ts), then from the ECS slot.
 */
export function formatBattleChat(
  events: ReplayEvents,
  players: readonly Pick<ReplayPlayerResult, 'userId' | 'clanTag'>[],
  locale?: Locale,
): string {
  const t = botText(locale).chat
  if (events.chat.length === 0) return t.empty
  const tagOf = new Map(players.map((player) => [player.userId, player.clanTag]))
  const clanOf = new Map(events.players.map((slot) => [slot.name, tagOf.get(slot.userId) || slot.clanTag]))
  return events.chat
    .map((message) => {
      const seconds = Math.floor(message.time / 1000)
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      const clan = clanOf.get(message.sender)
      const sender = clan ? `[${decorateTag(clan)}] ${message.sender}` : message.sender
      const channel = t.channels[message.channel] ?? t.unknownChannel(message.channel)
      return `[${time}] [${channel}] ${sender}: ${message.message}`
    })
    .join('\n')
}
