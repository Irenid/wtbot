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
 * Tracks who sits in voice channels and keeps the snapshot in table
 * voice_presence (the player board and /api/voice read it).
 *
 * The WT nick comes from the member's server nickname, usually written
 * «WTNick (Name)», e.g. «Venukbr (ИванЧай)»; without brackets the whole
 * nickname is the WT nick.
 *
 * WT_VOICE_CHANNELS limits the channels (comma-separated IDs); empty — every
 * voice channel the bot can view on every server it is in. A channel hidden
 * from the bot is never tracked: the board would show the regiment who sits
 * in a staff or newcomer room. Overwrite and role changes re-read the snapshot.
 *
 * Every 10 minutes the PSR snapshots of the squadrons of everyone in voice are
 * refreshed (a squadron is found from the nick's past snapshots, which appear
 * after the first /battle render of a battle of that squadron).
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

export interface VoiceTrackerOptions {
  /** Вызывается после изменения сохранённого voice-снимка. */
  onPresenceChange?: () => void | Promise<void>
}

export function startVoiceTracker(
  client: Client,
  channelIds: string[],
  options: VoiceTrackerOptions = {},
): VoiceTracker {
  const watched = new Set(channelIds)
  const active = new Set<Promise<unknown>>()
  let stopping = false
  const track = <T>(promise: Promise<T>): Promise<T> => {
    active.add(promise)
    promise.then(() => active.delete(promise), () => active.delete(promise))
    return promise
  }
  /** The state's channel ID while it is tracked, else null. */
  const trackedChannel = (state: VoiceState): string | null => {
    const id = state.channelId
    if (id === null || (watched.size > 0 && !watched.has(id))) return null
    // false only for a cached channel the bot lacks View Channel in.
    return state.channel?.viewable === false ? null : id
  }

  const notifyPresenceChange = (): void => {
    if (stopping || options.onPresenceChange === undefined) return
    try {
      const result = options.onPresenceChange()
      if (result !== undefined) {
        void track(Promise.resolve(result)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[voice] не удалось уведомить подписчика снимка: ${message}`)
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[voice] не удалось уведомить подписчика снимка: ${message}`)
    }
  }

  const entryFrom = (state: VoiceState, member: GuildMember): VoicePresenceEntry | null => {
    const channelId = trackedChannel(state)
    if (channelId === null) return null
    const displayName = member.displayName || member.user.username
    return {
      guildId: state.guild.id,
      guildName: state.guild.name,
      channelId,
      channelName: state.channel?.name ?? channelId,
      userId: member.id,
      displayName,
      wtNick: parseWtNick(displayName),
    }
  }

  // A full snapshot: GUILD_CREATE brings voice states without members, so the
  // missing ones are fetched over REST, MEMBER_FETCH_CONCURRENCY at a time.
  const snapshot = async (): Promise<number> => {
    const states: VoiceState[] = []
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (trackedChannel(state) !== null) states.push(state)
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
    const syncResult = syncVoicePresence(entries)
    if (syncResult.updated > 0 || syncResult.removed > 0) notifyPresenceChange()
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
      notifyPresenceChange()
    } catch (err) {
      console.error('[voice] Не смог обновить присутствие:', err)
    }
  }
  client.on(Events.VoiceStateUpdate, voiceHandler)

  // Overwrites and the bot's roles decide which channels are viewable. A burst
  // of updates (a role reorder edits every role) runs one snapshot, then one more.
  let resnapshotRunning = false
  let resnapshotAgain = false
  const resnapshot = (): void => {
    if (stopping) return
    if (resnapshotRunning) {
      resnapshotAgain = true
      return
    }
    resnapshotRunning = true
    void track(snapshot()).catch((error: unknown) => {
      console.warn(`[voice] snapshot after a permission change failed: ${(error as Error).message}`)
    }).finally(() => {
      resnapshotRunning = false
      if (resnapshotAgain) {
        resnapshotAgain = false
        resnapshot()
      }
    })
  }
  client.on(Events.ChannelUpdate, resnapshot)
  client.on(Events.GuildRoleUpdate, resnapshot)

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
      client.off(Events.ChannelUpdate, resnapshot)
      client.off(Events.GuildRoleUpdate, resnapshot)
      await Promise.allSettled([...active])
    },
  }
}
