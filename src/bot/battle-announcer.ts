import type { Client, Message, SendableChannels } from 'discord.js'
import { subscribeBattleLifecycle } from '../battle-lifecycle.js'
import { config } from '../config.js'
import {
  getBattleClanTags,
  getBattleIngestState,
  getBattlePostSummary,
  getBotState,
  getMaxItemId,
  getPendingAnnounce,
  markAnnounce,
  nextAnnounceBaseline,
  setBotState,
  skipStaleAnnounce,
  type PendingAnnounceItem,
} from '../db/index.js'
import { INGEST_MAX_ATTEMPTS } from '../wrpl/ingest.js'
import { plainClanTag } from '../wrpl/render-battle.js'
import { isWorkerExecutionTimeout, isWorkerPoolSchedulingError } from '../workers/pool.js'
import { ExecTimeoutBudget } from '../workers/exec-timeout-budget.js'
import { battleAnnouncementDecision } from './battle-post-policy.js'
import { queueBattlePostUpdates, renderBattlePost } from './commands/battle.js'

/**
 * Автоанонс боёв ждёт durable ingest, затем сразу публикует готовый пост
 * с PNG и кнопками /battle. Предварительные текстовые сообщения не создаются.
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
/** Таймауты рендера подряд, после которых анонс считается обычной неудачной попыткой. */
const RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT = 3
const renderExecTimeouts = new ExecTimeoutBudget(RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT)
/** Клан для фильтра (ядро тега без украшений); пусто — анонсим все бои */
const TARGET_CLAN = plainClanTag(config.clanTag)
let announceTimer: NodeJS.Timeout | null = null
let activeTick: Promise<void> | null = null
let stopping = false
let unsubscribeLifecycle: (() => void) | null = null
let wakeRequested = false
let announceSweep = 0
const pendingMessages = new Map<number, Message>()

export function startBattleAnnouncer(client: Client): void {
  if (announceTimer) return
  if (!config.battlesChannelId) {
    console.log('[bot] WT_BATTLES_CHANNEL не задан — автоанонс боёв выключен')
    return
  }
  stopping = false
  wakeRequested = false
  announceSweep = 0
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
      if (config.announceMaxAgeHours > 0) {
        const cutoffSec = Math.floor(Date.now() / 1_000) - config.announceMaxAgeHours * 3_600
        const skipped = skipStaleAnnounce(baseline, MAX_ATTEMPTS, cutoffSec)
        if (skipped > 0) {
          console.log(`[bot] автоанонс: пропущено боёв старше ${config.announceMaxAgeHours} ч — ${skipped}`)
        }
      }
      announceSweep += 1
      const order = announceSweep % 8 === 0 ? 'oldest' : 'newest'
      const fresh = getPendingAnnounce(baseline, MAX_ATTEMPTS, 5, order)
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
        const summary = getBattlePostSummary(item.externalId)
        const readiness = battleAnnouncementDecision(
          (summary?.teamWon ?? 0) > 0,
          getBattleIngestState(item.externalId),
          INGEST_MAX_ATTEMPTS,
        )
        if (readiness === 'wait') continue
        if (readiness === 'skip') {
          await finishPendingWithError(channel, item, 'Реплей не удалось разобрать.')
          markAnnounce(item.id, 'ok')
          cleanupPending(item)
          continue
        }
        if (TARGET_CLAN) {
          const decision = clanDecision(item)
          // Не наш клан — помечаем решённым, не постим
          if (decision === 'skip') {
            await deletePendingMessage(channel, item)
            markAnnounce(item.id, 'ok')
            cleanupPending(item)
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
          let message: Message
          if (item.announceMessageId) {
            message = await pendingMessage(channel, item)
            await message.edit(post.payload)
          } else {
            message = await channel.send(post.payload)
          }
          markAnnounce(item.id, 'ok')
          renderExecTimeouts.clear(item.externalId)
          cleanupPending(item)
          queueBattlePostUpdates(post, (payload) => message.edit({ ...payload, attachments: [] }))
          console.log(`[bot] автоанонс боя ${item.externalId} (${item.title.trim()})`)
        } catch (err) {
          if (stopping) break
          // Рендер, который раз за разом не укладывается в таймаут, иначе
          // повторялся бы каждый тик вечно, занимая worker на весь таймаут.
          if (isWorkerExecutionTimeout(err) && renderExecTimeouts.register(item.externalId)) {
            markAnnounce(item.id, 'failed', `${err.message} (${RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT} раза подряд)`)
            console.error(`[bot] автоанонс ${item.externalId}: рендер ${RENDER_EXEC_TIMEOUTS_BEFORE_ATTEMPT} раза подряд превысил таймаут`)
            continue
          }
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
    if (stopping) return
    if (activeTick) {
      wakeRequested = true
      return
    }
    activeTick = tick()
      .catch((error: unknown) => {
        if (!stopping) console.error(`[bot] сбой тика автоанонса: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        activeTick = null
        if (wakeRequested && !stopping) {
          wakeRequested = false
          setImmediate(scheduleTick)
        }
      })
  }
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = subscribeBattleLifecycle(scheduleTick)
  scheduleTick()
  announceTimer = setInterval(scheduleTick, TICK_MS)
  announceTimer.unref()
}

export async function stopBattleAnnouncer(): Promise<void> {
  stopping = true
  unsubscribeLifecycle?.()
  unsubscribeLifecycle = null
  if (announceTimer) clearInterval(announceTimer)
  announceTimer = null
  await activeTick
}

async function pendingMessage(
  channel: SendableChannels,
  item: PendingAnnounceItem,
): Promise<Message> {
  const current = pendingMessages.get(item.id)
  if (current) return current
  if (!item.announceMessageId) throw new Error('у предварительного анонса отсутствует message_id')
  return await channel.messages.fetch(item.announceMessageId)
}

async function finishPendingWithError(
  channel: SendableChannels,
  item: PendingAnnounceItem,
  message: string,
): Promise<void> {
  if (!item.announceMessageId) return
  try {
    const pending = await pendingMessage(channel, item)
    await pending.edit({ content: `${message}\nMatch ID: \`${item.externalId}\``, components: [] })
  } catch (error) {
    console.warn(
      `[bot] не удалось обновить предварительный анонс ${item.externalId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function deletePendingMessage(
  channel: SendableChannels,
  item: PendingAnnounceItem,
): Promise<void> {
  if (!item.announceMessageId) return
  try {
    const pending = await pendingMessage(channel, item)
    await pending.delete()
  } catch (error) {
    console.warn(
      `[bot] не удалось удалить предварительный анонс ${item.externalId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function cleanupPending(item: PendingAnnounceItem): void {
  pendingMessages.delete(item.id)
}

const startTimeOf = (item: PendingAnnounceItem): number => {
  const t = (item.data as { startTime?: unknown } | null)?.startTime
  return typeof t === 'number' ? t : item.updatedAt
}

/**
 * Решение фильтра по клану для одного боя:
 *  send — наш клан участвовал, постим;
 *  skip — бой разобран, но нашего клана нет.
 */
function clanDecision(item: PendingAnnounceItem): 'send' | 'skip' {
  const tags = getBattleClanTags(item.externalId)
  if (tags.some((t) => plainClanTag(t) === TARGET_CLAN)) return 'send'
  return 'skip'
}
