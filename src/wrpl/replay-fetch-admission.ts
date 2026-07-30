export interface ReplayFetchAdmissionSnapshot {
  enabled: boolean
  minIntervalMs: number
  maxIntervalMs: number
  currentIntervalMs: number
  consecutiveSuccesses: number
  rateLimitEvents: number
  increases: number
  decreases: number
}

const SUCCESS_WINDOW = 32

export class ReplayFetchAdmission {
  private enabled: boolean
  private currentIntervalMs: number
  private consecutiveSuccesses = 0
  private rateLimitEvents = 0
  private increases = 0
  private decreases = 0

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxIntervalMs = 2_000,
    enabled = false,
  ) {
    this.enabled = enabled
    this.currentIntervalMs = minIntervalMs
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.currentIntervalMs = this.minIntervalMs
    this.consecutiveSuccesses = 0
  }

  intervalMs(): number {
    return this.currentIntervalMs
  }

  recordRateLimit(): void {
    this.rateLimitEvents += 1
    this.consecutiveSuccesses = 0
    if (!this.enabled) return
    const increased = Math.max(
      this.currentIntervalMs + 50,
      Math.ceil(this.currentIntervalMs * 1.25),
    )
    const next = Math.min(this.maxIntervalMs, increased)
    if (next === this.currentIntervalMs) return
    this.currentIntervalMs = next
    this.increases += 1
  }

  recordSuccess(): void {
    if (!this.enabled) return
    this.consecutiveSuccesses += 1
    if (this.consecutiveSuccesses < SUCCESS_WINDOW) return
    this.consecutiveSuccesses = 0
    const next = Math.max(
      this.minIntervalMs,
      Math.floor(this.currentIntervalMs * 0.9),
    )
    if (next === this.currentIntervalMs) return
    this.currentIntervalMs = next
    this.decreases += 1
  }

  snapshot(): ReplayFetchAdmissionSnapshot {
    return {
      enabled: this.enabled,
      minIntervalMs: this.minIntervalMs,
      maxIntervalMs: this.maxIntervalMs,
      currentIntervalMs: this.currentIntervalMs,
      consecutiveSuccesses: this.consecutiveSuccesses,
      rateLimitEvents: this.rateLimitEvents,
      increases: this.increases,
      decreases: this.decreases,
    }
  }
}
