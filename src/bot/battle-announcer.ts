import type { Client } from 'discord.js'
import { config } from '../config.js'
import {
  getBattleClanTags,
  getBattleIngestState,
  getBotState,
  getMaxItemId,
  getPendingAnnounce,
  hasBattle,
  markAnnounce,
  nextAnnounceBaseline,
  setBotState,
  type StoredItem,
} from '../db/index.js'
import { INGEST_MAX_ATTEMPTS } from '../wrpl/ingest.js'
import { plainClanTag } from '../wrpl/render-battle.js'
import { isWorkerPoolSchedulingError } from '../workers/pool.js'
import { queueWinnerUpdate, renderBattlePost } from './commands/battle.js'

/**
 * Автоанонс боёв: раз в 20 секунд смотрит, не принёс ли парсер wt-replays
 * новых записей, и постит каждую в канал WT_BATTLES_CHANNEL тем же
 * сообщением, что и /battle (картинка + кнопки материалов), с фоновым
 * обновлением отметки победителя.
 *
 * Статус каждого боя хранится отдельно (таблица announce_state): отправлен
 * или нет, сколько было попыток. Поэтому упавший анонс ретраится в
 * следующие тики, а не теряется, — и при этом битая запись после лимита
 * попыток пропускается, не блокируя очередь. baseline в bot_state — только
 * стартовая отметка: при первом запуске = текущий максимум (историю не
 * выливаем), дальше двигается за уже разобранными боями.
 *
 * Фильтр по клану: если задан WT_CLAN_TAG, анонсим только бои с этим кланом.
 * Клан-тег есть лишь внутри реплея, поэтому берём его из battle_players
 * (быстрый запрос по индексу idx_bp_clan) — то есть после разбора боя
 * воркером ingest. Пока бой не разобран, анонс ждёт следующего тика (бой не
 * теряется); если ingest бой не осилил (части ушли с CDN и т.п.) — пропускаем,
 * чтобы не ждать вечно. Плюс такого решения: анонсер рисует только «свои»
 * бои и берёт их из БД без скачивания реплея.
 */

const BASELINE_KEY = 'battles:lastAnnouncedId'
const TICK_MS = 20_000
/** Сколько раз пытаться заанонсить бой, прежде чем пропустить его */
const MAX_ATTEMPTS = 3
/** Клан для фильтра (ядро тега без украшений); пусто — анонсим все бои */
const TARGET_CLAN = plainClanTag(config.clanTag)
let announceTimer: NodeJS.Timeout | null = null
let activeTick: Promise<void> | null = null
let stopping = false

export function startBattleAnnouncer(client: Client): void {
  if (announceTimer) return
  if (!config.battlesChannelId) {
    console.log('[bot] WT_BATTLES_CHANNEL не задан — автоанонс боёв выключен')
    return
  }
  stopping = false
  if (getBotState(BASELINE_KEY) === null) {
    setBotState(BASELINE_KEY, String(getMaxItemId('wt-replays')))
  }
  console.log(`[bot] автоанонс боёв включён (канал ${config.battlesChannelId}, каждые ${TICK_MS / 1000} с)`)
  console.log(
    TARGET_CLAN
      ? `[bot] анонс только боёв клана «${config.clanTag}»`
      : '[bot] анонс всех клановых боёв (WT_CLAN_TAG не задан)',
  )

  const tick = async (): Promise<void> => {
    if (stopping) return
    try {
      const baseline = Number(getBotState(BASELINE_KEY) ?? '0')
      const fresh = getPendingAnnounce(baseline, MAX_ATTEMPTS, 5)
      if (fresh.length === 0) return

      const channel = await client.channels.fetch(config.battlesChannelId)
      if (stopping) return
      if (!channel?.isSendable()) {
        console.warn('[bot] канал автоанонса недоступен или не текстовый — проверь WT_BATTLES_CHANNEL')
        return
      }

      // Постим в хронологическом порядке боёв (в очереди — по возрастанию id)
      const ordered = [...fresh].sort((a, b) => startTimeOf(a) - startTimeOf(b))
      for (const item of ordered) {
        if (stopping) break
        if (TARGET_CLAN) {
          const decision = clanDecision(item)
          // ждём разбора ingest — не помечаем, перепроверим на следующем тике
          if (decision === 'wait') continue
          // не наш клан (или бой не разобрать) — помечаем решённым, не постим
          if (decision === 'skip') {
            markAnnounce(item.id, 'ok')
            continue
          }
        }
        try {
          const post = await renderBattlePost(item, 'background')
          if (stopping) break
          if (!post) {
            // нет ссылок на реплей — считаем попыткой, после лимита пропустим
            markAnnounce(item.id, 'failed', 'нет ссылок на реплей')
            console.warn(`[bot] автоанонс ${item.externalId}: у записи нет ссылок на реплей`)
            continue
          }
          const message = await channel.send(post.payload)
          // Если сообщение уже ушло, фиксируем успех даже при SIGTERM: иначе
          // после рестарта оно отправится второй раз.
          markAnnounce(item.id, 'ok')
          if (!stopping) queueWinnerUpdate(post, (p) => message.edit(p))
          console.log(`[bot] автоанонс боя ${item.externalId} (${item.title.trim()})`)
        } catch (err) {
          if (stopping) break
          if (isWorkerPoolSchedulingError(err)) {
            console.warn(
              `[bot] автоанонс ${item.externalId}: CPU scheduler занят (${err.message}); попытка не расходуется`,
            )
            continue
          }
          // Отметка не сдвигается через бой: следующий тик попробует снова,
          // пока не выйдет или не кончатся попытки — анонс не теряется молча
          markAnnounce(item.id, 'failed', (err as Error).message)
          console.error(`[bot] автоанонс ${item.externalId}: ${(err as Error).message}`)
        }
      }

      // Сдвигаем baseline за решённые бои — окно сканирования не растёт
      if (!stopping) setBotState(BASELINE_KEY, String(nextAnnounceBaseline(baseline, MAX_ATTEMPTS)))
    } finally {
      // activeTick очищает scheduleTick после полного завершения.
    }
  }

  const scheduleTick = (): void => {
    if (stopping || activeTick) return
    activeTick = tick()
      .catch((error: unknown) => {
        if (!stopping) console.error(`[bot] сбой тика автоанонса: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        activeTick = null
      })
  }
  announceTimer = setInterval(scheduleTick, TICK_MS)
  announceTimer.unref()
}

export async function stopBattleAnnouncer(): Promise<void> {
  stopping = true
  if (announceTimer) clearInterval(announceTimer)
  announceTimer = null
  await activeTick
}

const startTimeOf = (item: StoredItem): number => {
  const t = (item.data as { startTime?: unknown } | null)?.startTime
  return typeof t === 'number' ? t : item.updatedAt
}

/**
 * Решение фильтра по клану для одного боя:
 *  send — наш клан участвовал, постим;
 *  skip — бой разобран, но нашего клана нет (или ingest его не осилил) — пропустить;
 *  wait — бой ещё не разобран воркером ingest, перепроверить на следующем тике.
 */
function clanDecision(item: StoredItem): 'send' | 'skip' | 'wait' {
  const tags = getBattleClanTags(item.externalId)
  if (tags.some((t) => plainClanTag(t) === TARGET_CLAN)) return 'send'
  // Теги есть (или строка боя есть) — бой разобран, нашего клана в нём нет
  if (tags.length > 0 || hasBattle(item.externalId)) return 'skip'
  // Ещё не разобран. Если ingest окончательно сдался — не ждём его вечно
  const ing = getBattleIngestState(item.externalId)
  const gaveUp =
    ing !== null &&
    (ing.status === 'expired' ||
      ing.status === 'no_parts' ||
      (ing.status === 'error' && ing.attempts >= INGEST_MAX_ATTEMPTS))
  return gaveUp ? 'skip' : 'wait'
}
