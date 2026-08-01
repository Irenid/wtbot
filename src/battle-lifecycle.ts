export type BattleLifecycleEvent =
  | { kind: 'discovered'; sessionIds: string[]; bulk: boolean }
  | { kind: 'committed'; sessionId: string }

type BattleLifecycleListener = (event: BattleLifecycleEvent) => void

const listeners = new Set<BattleLifecycleListener>()

export function subscribeBattleLifecycle(listener: BattleLifecycleListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitBattleLifecycle(event: BattleLifecycleEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error(
        `[battle-lifecycle] обработчик ${event.kind} завершился ошибкой: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
