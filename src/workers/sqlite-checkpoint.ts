export const SQLITE_CHECKPOINT_INTERVAL_MS = 60_000
export const SQLITE_CHECKPOINT_COMMIT_INTERVAL = 32

export class SqliteCheckpointSchedule {
  private commitsSinceCheckpoint = 0
  private lastCheckpointAtMs: number

  constructor(nowMs = Date.now()) {
    this.lastCheckpointAtMs = nowMs
  }

  recordCommit(nowMs = Date.now()): boolean {
    this.commitsSinceCheckpoint += 1
    return this.isDue(nowMs)
  }

  isDue(nowMs = Date.now()): boolean {
    return (
      this.commitsSinceCheckpoint >= SQLITE_CHECKPOINT_COMMIT_INTERVAL ||
      nowMs - this.lastCheckpointAtMs >= SQLITE_CHECKPOINT_INTERVAL_MS
    )
  }

  markCheckpoint(nowMs = Date.now()): void {
    this.commitsSinceCheckpoint = 0
    this.lastCheckpointAtMs = nowMs
  }

  snapshot(): { commitsSinceCheckpoint: number; lastCheckpointAtMs: number } {
    return {
      commitsSinceCheckpoint: this.commitsSinceCheckpoint,
      lastCheckpointAtMs: this.lastCheckpointAtMs,
    }
  }
}
