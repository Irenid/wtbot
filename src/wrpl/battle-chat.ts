import type { ReplayEvents } from './replay-events.js'
import { decorateTag } from './render-battle.js'

const CHANNEL_LABEL = ['TEAM', 'ALL', 'SQUAD', 'DM']

export function formatBattleChat(events: ReplayEvents): string {
  if (events.chat.length === 0) return 'В этом бою никто не писал в чат.'
  const clanOf = new Map(events.players.map((player) => [player.name, player.clanTag]))
  return events.chat
    .map((message) => {
      const seconds = Math.floor(message.time / 1000)
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      const clan = clanOf.get(message.sender)
      const sender = clan ? `[${decorateTag(clan)}] ${message.sender}` : message.sender
      return `[${time}] [${CHANNEL_LABEL[message.channel] ?? '?'}] ${sender}: ${message.message}`
    })
    .join('\n')
}
