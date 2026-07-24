export const PLAYER_IDENTITY_MATCH_METHODS = ['user_id', 'exact_nick', 'manual'] as const
export type PlayerIdentityMatchMethod = (typeof PLAYER_IDENTITY_MATCH_METHODS)[number]

export const PLAYER_IDENTITY_MATCH_CONFIDENCES = ['high', 'medium', 'low'] as const
export type PlayerIdentityMatchConfidence = (typeof PLAYER_IDENTITY_MATCH_CONFIDENCES)[number]

export const PLAYER_EXTERNAL_SNAPSHOT_STATUSES = [
  'ok',
  'private',
  'not_found',
  'rate_limited',
  'schema_error',
  'error',
] as const
export type PlayerExternalSnapshotStatus = (typeof PLAYER_EXTERNAL_SNAPSHOT_STATUSES)[number]

export type PlayerStatsFailureStatus = Exclude<PlayerExternalSnapshotStatus, 'ok'>

export interface PlayerReference {
  source: string
  sourcePlayerId: string | null
  wtUserId: string | null
  nick: string
  platform: string | null
}

/** Результат provider-а до source-specific нормализации. */
export interface RawPlayerStats {
  player: PlayerReference
  fetchedAt: number
  sourceUpdatedAt: number | null
  status: PlayerExternalSnapshotStatus
  rawJson: string | null
  error: string | null
  /** Уже проверенные строки; null для любого неуспешного статуса. */
  normalized: NormalizedPlayerStats | null
}

export interface PlayerStatsProvider {
  readonly source: string
  resolvePlayer(nick: string): Promise<PlayerReference[]>
  fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats>
  /** Прерывает незавершённые запросы при shutdown; повторное закрытие безопасно. */
  close?(): void | Promise<void>
}

/** Ошибка provider-а до того, как появился RawPlayerStats (например, при resolve). */
export class PlayerStatsProviderFailure extends Error {
  constructor(
    readonly status: PlayerStatsFailureStatus,
    message: string,
    readonly rawJson: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PlayerStatsProviderFailure'
  }
}

export interface NormalizedPlayerExternalTotal {
  gameType: string | null
  mode: string | null
  category: string | null
  battles: number | null
  victories: number | null
  defeats: number | null
  timePlayedSec: number | null
  respawns: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

export interface NormalizedPlayerExternalVehicle {
  gameType: string | null
  mode: string | null
  vehicleId: string
  flyouts: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
  timePlayedSec: number | null
}

export interface NormalizedPlayerStats {
  totals: readonly NormalizedPlayerExternalTotal[]
  vehicles: readonly NormalizedPlayerExternalVehicle[]
}

export interface PlayerExternalTotal extends NormalizedPlayerExternalTotal {
  snapshotId: number
}

export interface PlayerExternalVehicle extends NormalizedPlayerExternalVehicle {
  snapshotId: number
}

export interface PlayerIdentityAliasInput {
  source: string
  externalId: string | null
  nick: string
  seenAt: number
  matchMethod: PlayerIdentityMatchMethod
  matchConfidence: PlayerIdentityMatchConfidence
}

export interface SavePlayerIdentityInput {
  /** Для обновления уже выбранной identity; без id автоматический поиск идёт только по wtUserId. */
  identityId?: number
  wtUserId: string | null
  canonicalNick: string
  /** undefined сохраняет прежнюю платформу, null явно оставляет её неизвестной. */
  platform?: string | null
  aliases?: readonly PlayerIdentityAliasInput[]
}

export interface PlayerIdentity {
  id: number
  wtUserId: string | null
  canonicalNick: string
  platform: string | null
  createdAt: number
  updatedAt: number
}

export interface PlayerIdentityAlias {
  identityId: number
  source: string
  externalId: string | null
  nick: string
  nickBase: string
  firstSeenAt: number
  lastSeenAt: number
  matchMethod: PlayerIdentityMatchMethod
  matchConfidence: PlayerIdentityMatchConfidence
}

export interface PlayerExternalSnapshotInput {
  identityId: number
  source: string
  sourcePlayerId: string | null
  nick: string | null
  fetchedAt: number
  sourceUpdatedAt: number | null
  status: PlayerExternalSnapshotStatus
  /** Сериализованный исходный JSON provider-а без нормализации. */
  rawJson: string | null
  parserVersion: string
  error: string | null
  /** При наличии сохраняется с raw snapshot в той же SQLite-транзакции. */
  normalized?: NormalizedPlayerStats | null
}

export interface PlayerExternalSnapshot {
  id: number
  identityId: number
  source: string
  sourcePlayerId: string | null
  nick: string | null
  fetchedAt: number
  /** Последняя проверка того же неизменившегося ответа. */
  lastCheckedAt: number
  sourceUpdatedAt: number | null
  status: PlayerExternalSnapshotStatus
  rawJson: string | null
  contentHash: string | null
  parserVersion: string
  error: string | null
}

/** Метаданные snapshot для hot read-path; большой raw_json читается отдельно. */
export type PlayerExternalSnapshotMeta = Omit<PlayerExternalSnapshot, 'rawJson'>

export interface SavePlayerExternalSnapshotResult {
  snapshot: PlayerExternalSnapshot
  /** false означает, что совпавшему snapshot обновили только lastCheckedAt. */
  created: boolean
}

export interface PlayerExternalStats {
  snapshot: PlayerExternalSnapshotMeta
  totals: PlayerExternalTotal[]
  vehicles: PlayerExternalVehicle[]
}

export interface PlayerStatsCacheResult {
  stats: PlayerExternalStats | null
  stale: boolean
  refreshQueued: boolean
  lastCheck: PlayerExternalSnapshotMeta | null
  nextRetryAt: number | null
}

export interface PlayerStatsServiceMetrics {
  requests: number
  queued: number
  skippedFresh: number
  skippedBackoff: number
  started: number
  succeeded: number
  failed: number
  byStatus: Record<PlayerExternalSnapshotStatus, number>
}
