import { Events, type Client, type GuildMember, type VoiceState } from 'discord.js'
import {
  getVoiceClanTags,
  removeVoicePresence,
  syncVoicePresence,
  upsertVoicePresence,
  type VoicePresenceEntry,
} from '../db/index.js'
import { fetchRatingsForTags } from '../wrpl/clan-info.js'

/**
 * Следит, кто сидит в голосовых каналах, и держит снимок в таблице
 * voice_presence (дашборд читает её через /api/voice).
 *
 * Ник в игре достаётся из серверного ника участника — на клановых серверах
 * его обычно оформляют как «WTНик (Имя)», например «Venukbr (ИванЧай)»;
 * если скобок нет, ником в игре считается весь серверный ник.
 *
 * WT_VOICE_CHANNELS в .env ограничивает список каналов (id через запятую);
 * пусто — отслеживаются все голосовые каналы всех серверов бота.
 *
 * Раз в 10 минут для сидящих в каналах обновляются снимки ПКР их кланов
 * (клан ищется по прошлым снимкам ника — он появляется после первого
 * рендера боя клана командой /battle).
 */

const RATINGS_REFRESH_MS = 10 * 60_000
/** Принудительное обновление (кнопка на дашборде) — не чаще раза в 15 секунд */
const FORCE_THROTTLE_MS = 15_000
const MEMBER_FETCH_CONCURRENCY = 4

/** «Venukbr (ИванЧай)» → «Venukbr»; без скобок — весь ник целиком */
export function parseWtNick(displayName: string): string {
  const m = /^(.+?)\s*\(/.exec(displayName)
  return (m?.[1] ?? displayName).trim()
}

export interface VoiceTracker {
  /** Пересканировать каналы и принудительно освежить ПКР — для кнопки на дашборде */
  refresh(): Promise<{ players: number; clans: number }>
  /** Остановить таймеры/listeners и дождаться уже начатых REST-запросов. */
  stop(): Promise<void>
}

export function startVoiceTracker(client: Client, channelIds: string[]): VoiceTracker {
  const watched = new Set(channelIds)
  const active = new Set<Promise<unknown>>()
  let stopping = false
  const track = <T>(promise: Promise<T>): Promise<T> => {
    active.add(promise)
    promise.then(() => active.delete(promise), () => active.delete(promise))
    return promise
  }
  const isTracked = (channelId: string | null): channelId is string =>
    channelId !== null && (watched.size === 0 || watched.has(channelId))

  const entryFrom = (state: VoiceState, member: GuildMember): VoicePresenceEntry | null => {
    if (!isTracked(state.channelId)) return null
    const displayName = member.displayName || member.user.username
    return {
      guildId: state.guild.id,
      guildName: state.guild.name,
      channelId: state.channelId,
      channelName: state.channel?.name ?? state.channelId,
      userId: member.id,
      displayName,
      wtNick: parseWtNick(displayName),
    }
  }

  // Полный снимок: GUILD_CREATE приносит voice-стейты без участников,
  // поэтому недостающих подтягиваем ограниченно-параллельно через REST.
  const snapshot = async (): Promise<number> => {
    const states: VoiceState[] = []
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (isTracked(state.channelId)) states.push(state)
      }
    }

    const members = states.map((state) => state.member ?? null)
    const missing = states.flatMap((state, index) => (state.member ? [] : [index]))
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(MEMBER_FETCH_CONCURRENCY, missing.length) }, async () => {
        while (cursor < missing.length) {
          const missingIndex = missing[cursor]
          cursor += 1
          if (missingIndex === undefined) return
          const state = states[missingIndex]
          if (state) members[missingIndex] = await state.guild.members.fetch(state.id).catch(() => null)
        }
      }),
    )

    const entries: VoicePresenceEntry[] = []
    for (const [index, state] of states.entries()) {
      const member = members[index]
      if (!member || member.user.bot) continue
      const entry = entryFrom(state, member)
      if (entry) entries.push(entry)
    }
    syncVoicePresence(entries)
    return entries.length
  }

  // Снимки ПКР кланов сидящих в каналах; force — мимо кулдауна clan-info
  const refreshRatings = async (force: boolean): Promise<number> => {
    const tags = getVoiceClanTags()
    if (tags.length > 0) await fetchRatingsForTags(tags, { force })
    return tags.length
  }

  const readyHandler = (): void => {
    if (stopping) return
    void track(snapshot()).then((n) =>
      console.log(`[voice] Каналы под наблюдением: ${watched.size === 0 ? 'все' : watched.size}, сейчас в голосе: ${n}`),
    ).catch((error: unknown) => console.warn(`[voice] Не удалось получить начальный снимок: ${(error as Error).message}`))
  }
  if (client.isReady()) {
    readyHandler()
  } else {
    client.once(Events.ClientReady, readyHandler)
  }

  const voiceHandler = (oldState: VoiceState, newState: VoiceState): void => {
    if (stopping) return
    const member = newState.member ?? oldState.member
    if (!member || member.user.bot) return
    try {
      const entry = entryFrom(newState, member)
      if (entry) {
        upsertVoicePresence(entry)
      } else {
        removeVoicePresence(newState.guild.id, member.id)
      }
    } catch (err) {
      console.error('[voice] Не смог обновить присутствие:', err)
    }
  }
  client.on(Events.VoiceStateUpdate, voiceHandler)

  // Периодически освежаем ПКР кланов тех, кто сидит в каналах
  const timer = setInterval(() => {
    if (!stopping) void track(refreshRatings(false)).catch((err) => console.error('[voice] Не смог обновить рейтинги:', err))
  }, RATINGS_REFRESH_MS)
  timer.unref()

  // Принудительное обновление с дашборда — с троттлингом от спама кнопкой
  let lastForceAt = 0
  let refreshInFlight: Promise<{ players: number; clans: number }> | null = null
  const refresh = (): Promise<{ players: number; clans: number }> => {
    if (stopping) return Promise.resolve({ players: 0, clans: 0 })
    if (refreshInFlight) return refreshInFlight
    const run = track((async () => {
      const players = await snapshot()
      let clans = 0
      if (Date.now() - lastForceAt > FORCE_THROTTLE_MS) {
        lastForceAt = Date.now()
        clans = await refreshRatings(true)
      }
      return { players, clans }
    })())
    refreshInFlight = run
    const clear = (): void => {
      if (refreshInFlight === run) refreshInFlight = null
    }
    run.then(clear, clear)
    return run
  }
  return {
    refresh,
    async stop() {
      stopping = true
      clearInterval(timer)
      client.off(Events.ClientReady, readyHandler)
      client.off(Events.VoiceStateUpdate, voiceHandler)
      await Promise.allSettled([...active])
    },
  }
}
