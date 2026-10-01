export type IngestOutcome =
  | 'ok'
  | 'no_parts'
  | 'expired'
  | 'error'
  | 'cancelled'
  | 'deferred'

/**
 * Полный выбранный batch означает, что за ним, вероятно, остался backlog.
 * Немедленно продолжаем только после реального прогресса: deferred/cancelled
 * не должны превращать занятый CPU pool или shutdown в busy loop.
 */
export function shouldContinueIngestImmediately(
  selectedCount: number,
  selectionLimit: number,
  outcomes: readonly IngestOutcome[],
  stopping: boolean,
): boolean {
  if (stopping || selectedCount < selectionLimit || outcomes.length === 0) return false
  return outcomes.some((outcome) => outcome !== 'deferred' && outcome !== 'cancelled')
}

/**
 * Свежий бой сайт показывает раньше, чем все его части выложены на CDN: они
 * появляются по одной, примерно раз в 1,3 минуты после конца боя (Last-Modified
 * частей, 2026-10-01). 404 в это время значит «часть ещё не выложена», а не
 * «ушла с CDN»: бой ждёт повтор без расхода попыток. Окно считается от конца
 * боя (от первого показа, если конец неизвестен или позже показа), поэтому
 * старый бой из бэклога с 404 сразу становится expired.
 */
export const PART_UPLOAD_GRACE_MS = 60 * 60_000
const PART_RETRY_STEP_MS = 60_000
const PART_RETRY_MAX_MS = 3 * 60_000

export class ReplayPartWaitList {
  private readonly entries = new Map<string, { retries: number; notBeforeMs: number; untilMs: number }>()

  /**
   * Отмечает 404 части боя. Возвращает задержку до повтора или null, если
   * окно выкладки прошло и части, значит, ушли с CDN.
   */
  defer(sessionId: string, battleEndMs: number | null, firstSeenAtMs: number, nowMs: number): number | null {
    const untilMs = Math.min(battleEndMs ?? firstSeenAtMs, firstSeenAtMs) + PART_UPLOAD_GRACE_MS
    if (nowMs >= untilMs) {
      this.entries.delete(sessionId)
      return null
    }
    const retries = (this.entries.get(sessionId)?.retries ?? 0) + 1
    const delayMs = Math.min(PART_RETRY_STEP_MS * retries, PART_RETRY_MAX_MS)
    this.entries.set(sessionId, { retries, notBeforeMs: nowMs + delayMs, untilMs })
    return delayMs
  }

  /** Повтор боя ещё не наступил — выборка очереди его пропускает. */
  isWaiting(sessionId: string, nowMs: number): boolean {
    return (this.entries.get(sessionId)?.notBeforeMs ?? 0) > nowMs
  }

  /**
   * Сколько боёв ждут повтора: выборка очереди берёт столько строк сверх
   * лимита, чтобы ждущие свежие бои не вытесняли остальные. Записи с
   * прошедшим окном удаляются.
   */
  waitingCount(nowMs: number): number {
    let count = 0
    for (const [sessionId, entry] of this.entries) {
      if (entry.untilMs <= nowMs) this.entries.delete(sessionId)
      else if (entry.notBeforeMs > nowMs) count += 1
    }
    return count
  }
}

/** Запас на расхождение времени боя по реплею и по записи сайта, с. */
const FINAL_RESULTS_SLACK_SEC = 10

/**
 * Финальные ли итоги боя в разобранных частях. Финальные пишутся в последнюю
 * часть и обычно со статусом, в части 0001 лежат промежуточные (~95 с) без
 * статуса. Бой без исхода (по времени) пишет финальные итоги тоже без
 * статуса, но их время не меньше длительности по записи сайта: запись ловит
 * бой не позже его конца (на 40 тыс. боёв timePlayed больше неё на 2–384 с).
 * Без длительности по записи итоги без статуса считаются промежуточными.
 */
export function hasFinalReplayResults(
  results: { status: string; timePlayed: number },
  listedDurationSec: number | null,
): boolean {
  if (results.status) return true
  return listedDurationSec !== null && results.timePlayed >= listedDurationSec - FINAL_RESULTS_SLACK_SEC
}
