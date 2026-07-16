import type { Client } from 'discord.js'
import { config } from '../config.js'
import { getBotState, getItemsAfter, getMaxItemId, setBotState, type StoredItem } from '../db/index.js'
import { queueWinnerUpdate, renderBattlePost } from './commands/battle.js'

/**
 * Автоанонс боёв: раз в 20 секунд смотрит, не принёс ли парсер wt-replays
 * новых записей, и постит каждую в канал WT_BATTLES_CHANNEL тем же
 * сообщением, что и /battle (картинка + кнопки материалов), с фоновым
 * обновлением отметки победителя.
 *
 * Прогресс хранится в bot_state (id последней проанонсированной записи),
 * при первом запуске выставляется на текущий максимум — историю в канал
 * не выливаем. Отметка двигается до отправки: упавший анонс логируется
 * и не повторяется, чтобы не зациклиться на битой записи.
 */

const STATE_KEY = 'battles:lastAnnouncedId'
const TICK_MS = 20_000

export function startBattleAnnouncer(client: Client): void {
  if (!config.battlesChannelId) {
    console.log('[bot] WT_BATTLES_CHANNEL не задан — автоанонс боёв выключен')
    return
  }
  if (getBotState(STATE_KEY) === null) {
    setBotState(STATE_KEY, String(getMaxItemId('wt-replays')))
  }
  console.log(`[bot] автоанонс боёв включён (канал ${config.battlesChannelId}, каждые ${TICK_MS / 1000} с)`)

  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const lastId = Number(getBotState(STATE_KEY) ?? '0')
      const fresh = getItemsAfter('wt-replays', lastId, 5)
      if (fresh.length === 0) return

      const channel = await client.channels.fetch(config.battlesChannelId)
      if (!channel?.isSendable()) {
        console.warn('[bot] канал автоанонса недоступен или не текстовый — проверь WT_BATTLES_CHANNEL')
        return
      }

      // Отметка сдвигается до отправки: упавший анонс не зациклится
      setBotState(STATE_KEY, String(Math.max(...fresh.map((i) => i.id))))

      // Парсер вставляет страницу списка от новых к старым — постим в
      // хронологическом порядке боёв
      const ordered = [...fresh].sort((a, b) => startTimeOf(a) - startTimeOf(b))
      for (const item of ordered) {
        try {
          const post = await renderBattlePost(item)
          if (!post) {
            console.warn(`[bot] автоанонс ${item.externalId}: у записи нет ссылок на реплей`)
            continue
          }
          const message = await channel.send(post.payload)
          queueWinnerUpdate(post, (p) => message.edit(p))
          console.log(`[bot] автоанонс боя ${item.externalId} (${item.title.trim()})`)
        } catch (err) {
          console.error(`[bot] автоанонс ${item.externalId}: ${(err as Error).message}`)
        }
      }
    } finally {
      busy = false
    }
  }

  setInterval(() => void tick(), TICK_MS)
}

const startTimeOf = (item: StoredItem): number => {
  const t = (item.data as { startTime?: unknown } | null)?.startTime
  return typeof t === 'number' ? t : item.updatedAt
}
