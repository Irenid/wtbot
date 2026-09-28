/**
 * Счётчик таймаутов выполнения CPU-задачи по ключу (бой, анонс).
 *
 * Перегрузка пула не должна расходовать попытки ingest/announce, поэтому
 * EXEC_TIMEOUT считается scheduling-ошибкой. Но задача, которая
 * детерминированно не укладывается в таймаут (повреждённый реплей,
 * патологический рендер), тогда повторялась бы вечно, каждый раз занимая
 * worker на весь таймаут и заставляя пул пересоздавать его. После `limit`
 * таймаутов подряд вызывающий считает её обычной ошибкой.
 */
export class ExecTimeoutBudget {
  private readonly counts = new Map<string, number>()
  private readonly limit: number
  private readonly maxKeys: number

  constructor(limit: number, maxKeys = 1_000) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit должен быть положительным целым')
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError('maxKeys должен быть положительным целым')
    this.limit = limit
    this.maxKeys = maxKeys
  }

  /** Регистрирует таймаут; true — лимит исчерпан (счётчик ключа сбрасывается). */
  register(key: string): boolean {
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.delete(key)
    if (count >= this.limit) return true
    this.counts.set(key, count)
    // Ключи задач, которые больше не вернулись, не копятся бесконечно.
    while (this.counts.size > this.maxKeys) {
      const oldest = this.counts.keys().next().value
      if (oldest === undefined) break
      this.counts.delete(oldest)
    }
    return false
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0
  }

  /** Успешное выполнение: следующая серия таймаутов считается заново. */
  clear(key: string): void {
    this.counts.delete(key)
  }
}
