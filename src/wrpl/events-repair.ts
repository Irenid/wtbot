import { isValidReplayChatChannel, type ReplayEvents } from './replay-events.js'

/**
 * Канонический вид событий боя перед записью — общий для ingest
 * (battle-transform.ts) и фоновой починки уже записанных боёв
 * (db/maintenance.ts, задача `repair-battle-events`). Аудит базы
 * 2026-10-02 (docs/database.md, "Data errors") нашёл в событиях:
 *
 * - отправителей чата под анонимными именами реплея (fakeName из записи
 *   Replay API), тогда как состав боя записан настоящими;
 * - точные дубли убийств (одна зенитка дважды в одну миллисекунду);
 *
 * и в боях, разобранных прежним кодом, ещё:
 *
 * - беззнаковые userId ботов (18446744073709551603 вместо −13);
 * - длинные сообщения чата, обрезанные однобайтовой длиной: первый символ —
 *   старший байт длины-varint, канал прочитан из середины текста;
 * - дробные координаты и время траекторий (до округления в разборе).
 */

type StoredEvents = Omit<ReplayEvents, 'errors'>

export interface EventsRepairCounts {
  /** Отправители чата: анонимное имя → настоящее. */
  chatNames: number
  /** Удалённые точные дубли убийств. */
  duplicateKills: number
  /** userId → знаковый (боты). */
  signedIds: number
  /** Сообщения чата без старшего байта длины в начале. */
  brokenChat: number
  /** Округлённые значения траекторий и позиций убийств. */
  roundedValues: number
}

const UINT64_SIGNED_FROM = 2n ** 63n

/** Беззнаковое представление отрицательного int64 → знаковое; остальное как есть. */
export function signedUserId(id: string): string {
  if (!/^\d{19,20}$/.test(id)) return id
  const value = BigInt(id)
  return value >= UINT64_SIGNED_FROM && value < 2n ** 64n ? BigInt.asIntN(64, value).toString(10) : id
}

/** Правила ingest: анонимные имена в чате и точные дубли убийств. */
export function canonicalizeReplayEvents(
  events: StoredEvents,
  fakeNames: ReadonlyMap<string, string>,
): Pick<EventsRepairCounts, 'chatNames' | 'duplicateKills'> {
  let chatNames = 0
  if (fakeNames.size > 0) {
    for (const message of events.chat) {
      const real = fakeNames.get(message.sender)
      if (real === undefined) continue
      message.sender = real
      chatNames += 1
    }
  }
  const seen = new Set<string>()
  const kills = events.kills.filter((kill) => {
    // Одна и та же жертва в одну миллисекунду в одной точке — повтор события.
    const key = JSON.stringify(kill)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const duplicateKills = events.kills.length - kills.length
  if (duplicateKills > 0) events.kills = kills
  return { chatNames, duplicateKills }
}

/** Для уже записанных боёв: правила ingest и исправления прежнего разбора. */
export function repairStoredEvents(
  events: StoredEvents,
  fakeNames: ReadonlyMap<string, string>,
): EventsRepairCounts & { changed: boolean } {
  let signedIds = 0
  const signed = (id: string): string => {
    const next = signedUserId(id)
    if (next !== id) signedIds += 1
    return next
  }
  for (const player of events.players) player.userId = signed(player.userId)
  for (const unit of events.units) unit.userId = signed(unit.userId)
  for (const kill of events.kills) {
    kill.killerId = signed(kill.killerId)
    kill.victimId = signed(kill.victimId)
  }
  for (const damage of events.damage) {
    damage.offenderId = signed(damage.offenderId)
    damage.victimId = signed(damage.victimId)
  }

  let brokenChat = 0
  for (const message of events.chat) {
    // Старший байт длины-varint (1–31 для сообщений до 4 КиБ) попал в
    // начало текста; хвост сообщения потерян, канал неизвестен. В ранних
    // блобах поля channelValid нет — признак считается по каналу, как при
    // записи строк battle_chat.
    const valid = message.channelValid ?? isValidReplayChatChannel(message.channel)
    if (valid || message.message === '') continue
    const first = message.message.charCodeAt(0)
    if (first < 1 || first > 31) continue
    message.message = message.message.slice(1)
    brokenChat += 1
  }

  let roundedValues = 0
  const round = (value: number): number => {
    const next = Math.round(value)
    if (next !== value) roundedValues += 1
    return next
  }
  for (const unit of events.units) {
    for (const point of unit.path) {
      point.t = round(point.t)
      point.x = round(point.x)
      point.y = round(point.y)
      point.z = round(point.z)
    }
  }
  for (const kill of events.kills) {
    for (const point of [kill.killerPos, kill.victimPos]) {
      if (!point) continue
      point.x = round(point.x)
      point.y = round(point.y)
      point.z = round(point.z)
    }
  }

  const canonical = canonicalizeReplayEvents(events, fakeNames)
  const counts = { ...canonical, signedIds, brokenChat, roundedValues }
  return { ...counts, changed: Object.values(counts).some((value) => value > 0) }
}
