import {
  findKnownPlayerMatches,
  getLatestPlayerExternalCheck,
  getLatestPlayerExternalStats,
  getPlayerExternalStatsHistory,
  getPlayerIdentityById,
  getPlayerIdentityByWtUserId,
  getPlayerReplayStats,
  savePlayerIdentity,
  type KnownPlayerMatch,
  type PlayerReplayStats,
  type PlayerReplayStatsPeriod,
} from '../db/index.js'
import { OFFICIAL_PROFILE_SOURCE } from './normalizer.js'
import type { PlayerStatsService } from './service.js'
import type {
  NormalizedPlayerExternalCountry,
  NormalizedPlayerExternalTotal,
  NormalizedPlayerExternalVehicle,
  PlayerExternalSnapshotStatus,
  PlayerExternalStats,
  PlayerIdentity,
  PlayerStatsCacheResult,
} from './types.js'

const MAX_ACCOUNT_VEHICLES = 100
const MAX_ACCOUNT_TOTALS = 100
const MAX_REPLAY_VEHICLES = 100

export interface PlayerStatsLookupInput {
  player: string
  from?: number
  to?: number
}

export interface PlayerStatsLookupCandidate {
  nick: string
  wtUserId: string | null
  sources: string[]
}

export type PlayerStatsLookupResult =
  | { status: 'ok'; stats: PlayerStatsComparison }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: PlayerStatsLookupCandidate[] }

export interface PlayerExternalTotalDelta {
  gameType: string | null
  mode: string | null
  category: string | null
  battles: number | null
  victories: number | null
  defeats: number | null
  deaths: number | null
  timePlayedSec: number | null
  respawns: number | null
  airKills: number | null
  groundKills: number | null
  navalKills: number | null
}

export interface PlayerExternalVehicleDelta {
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

export interface PlayerExternalDelta {
  fromCheckedAt: number
  toCheckedAt: number
  totals: PlayerExternalTotalDelta[]
  vehicles: PlayerExternalVehicleDelta[]
}

export type PlayerAccountState =
  | 'fresh'
  | 'stale'
  | 'pending'
  | 'empty'
  | 'disabled'
  | 'disabled_cached'
  | Exclude<PlayerExternalSnapshotStatus, 'ok'>

export interface PlayerAccountStatsView {
  source: string
  enabled: boolean
  state: PlayerAccountState
  stale: boolean
  refreshQueued: boolean
  nextRetryAt: number | null
  lastCheckStatus: PlayerExternalSnapshotStatus | null
  error: string | null
  fetchedAt: number | null
  checkedAt: number | null
  sourceUpdatedAt: number | null
  totals: NormalizedPlayerExternalTotal[]
  totalCount: number
  totalsTruncated: boolean
  vehicles: NormalizedPlayerExternalVehicle[]
  vehicleCount: number
  vehiclesTruncated: boolean
  /** Техника и медали по нациям (профиль warthunder.com). */
  countries: NormalizedPlayerExternalCountry[]
  delta: PlayerExternalDelta | null
}

export interface PlayerStatsComparison {
  player: {
    wtUserId: string | null
    nick: string
    platform: string | null
  }
  period: {
    from: number | null
    to: number | null
  }
  /** Основной источник, сохранённый для обратной совместимости API/табло. */
  account: PlayerAccountStatsView
  /** Все настроенные account-источники; первым всегда идёт `account`. */
  accountSources: PlayerAccountStatsView[]
  replay: {
    source: 'wrpl'
    available: boolean
    userId: string | null
    stats: PlayerReplayStats | null
    vehicleCount: number
    vehiclesTruncated: boolean
  }
  comparison: {
    directlyComparable: false
    accountWinRate: number | null
    replayWinRate: number | null
    indicativeWinRateDifference: number | null
    vehicleOverlapCount: number
    note: string
  }
}

interface ComparisonContext {
  externalSource: string
  externalEnabled: boolean
  cache: PlayerStatsCacheResult
  history: readonly PlayerExternalStats[]
}

interface PlayerStatsCoordinatorOptions {
  /** Legacy-форма для одного источника. */
  externalService?: PlayerStatsService | null
  /** Несколько независимых provider/service с общей identity. */
  externalServices?: readonly PlayerStatsService[]
  externalSource?: string
}

type KnownPlayerResolution =
  | { status: 'ok'; identity: PlayerIdentity }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: PlayerStatsLookupCandidate[] }

function normalizedLookupText(value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error('Ник или WT user id не может быть пустым')
  if (normalized.length > 64) throw new RangeError('Ник или WT user id не может быть длиннее 64 символов')
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Ник или WT user id содержит управляющие символы')
  }
  return normalized
}

function normalizedPeriod(input: PlayerStatsLookupInput): PlayerReplayStatsPeriod {
  const period: PlayerReplayStatsPeriod = {}
  if (input.from !== undefined) {
    if (!Number.isSafeInteger(input.from) || input.from < 0) {
      throw new RangeError('from должен быть неотрицательным целым Unix-временем')
    }
    period.from = input.from
  }
  if (input.to !== undefined) {
    if (!Number.isSafeInteger(input.to) || input.to < 0) {
      throw new RangeError('to должен быть неотрицательным целым Unix-временем')
    }
    period.to = input.to
  }
  if (period.from !== undefined && period.to !== undefined && period.from > period.to) {
    throw new RangeError('from не может быть позже to')
  }
  return period
}

function platformFromNick(nick: string): string | null {
  return nick.match(/@(psn|live|epic)$/i)?.[1]?.toLowerCase() ?? null
}

function bestMatch(matches: readonly KnownPlayerMatch[]): KnownPlayerMatch {
  const selected = [...matches].sort((left, right) => right.seenAt - left.seenAt)[0]
  if (selected === undefined) throw new Error('Внутренняя ошибка: пустая группа совпадений игрока')
  return selected
}

function candidate(matches: readonly KnownPlayerMatch[]): PlayerStatsLookupCandidate {
  const selected = bestMatch(matches)
  return {
    nick: selected.nick,
    wtUserId: selected.wtUserId,
    sources: [...new Set(matches.map((match) => match.source))].sort(),
  }
}

function aliasesForStableMatch(matches: readonly KnownPlayerMatch[], wtUserId: string) {
  const unique = new Map<string, {
    source: string
    externalId: string | null
    nick: string
    seenAt: number
    matchMethod: 'user_id' | 'exact_nick'
    matchConfidence: 'high' | 'medium'
  }>()
  for (const match of matches) {
    if (match.origin !== 'replay' && match.origin !== 'voice' && match.origin !== 'clan') continue
    const alias = {
      source: match.source,
      externalId: match.origin === 'replay' ? wtUserId : null,
      nick: match.nick,
      seenAt: match.seenAt,
      matchMethod: match.origin === 'replay' ? 'user_id' as const : 'exact_nick' as const,
      matchConfidence: match.origin === 'replay' ? 'high' as const : 'medium' as const,
    }
    unique.set(JSON.stringify([alias.source, alias.externalId, alias.nick]), alias)
  }
  return [...unique.values()]
}

/** Identity без WT user id среди совпадений ника (voice, рейтинг клана, прошлые lookup). */
function nickOnlyIdentities(matches: readonly KnownPlayerMatch[]): PlayerIdentity[] {
  const identityIds = [...new Set(
    matches
      .map((match) => match.identityId)
      .filter((identityId): identityId is number => identityId !== null),
  )]
  return identityIds
    .map((identityId) => getPlayerIdentityById(identityId))
    .filter((identity): identity is PlayerIdentity => identity !== null && identity.wtUserId === null)
}

export function resolveKnownPlayer(player: string): KnownPlayerResolution {
  const query = normalizedLookupText(player)
  const matches = findKnownPlayerMatches(query)
  if (matches.length === 0) return { status: 'not_found' }

  const stableGroups = new Map<string, KnownPlayerMatch[]>()
  for (const match of matches) {
    if (match.wtUserId === null || !/^[1-9]\d*$/.test(match.wtUserId)) continue
    const group = stableGroups.get(match.wtUserId) ?? []
    group.push(match)
    stableGroups.set(match.wtUserId, group)
  }

  if (/^[1-9]\d*$/.test(query) && stableGroups.has(query)) {
    for (const wtUserId of [...stableGroups.keys()]) {
      if (wtUserId !== query) stableGroups.delete(wtUserId)
    }
  }

  if (stableGroups.size > 1) {
    return {
      status: 'ambiguous',
      candidates: [...stableGroups.values()].map(candidate),
    }
  }

  const stable = [...stableGroups.entries()][0]
  if (stable !== undefined) {
    const [wtUserId, stableMatches] = stable
    const selected = bestMatch(stableMatches)
    let existing = getPlayerIdentityByWtUserId(wtUserId)
    if (existing === null) {
      // Ник мог стать identity раньше, чем появился его WT user id (voice,
      // рейтинг клана). Такую nick-only identity усыновляем, а не создаём
      // вторую: иначе её снимки и история навсегда теряли бы связь с игроком.
      const nickOnly = nickOnlyIdentities(matches)
      if (nickOnly.length > 1) {
        return {
          status: 'ambiguous',
          candidates: nickOnly.flatMap((identity) => {
            const identityMatches = matches.filter((match) => match.identityId === identity.id)
            return identityMatches.length === 0 ? [] : [candidate(identityMatches)]
          }),
        }
      }
      existing = nickOnly[0] ?? null
    }
    return {
      status: 'ok',
      identity: savePlayerIdentity({
        ...(existing === null ? {} : { identityId: existing.id }),
        wtUserId,
        canonicalNick: existing?.canonicalNick ?? selected.nick,
        platform: selected.platform ?? existing?.platform ?? platformFromNick(selected.nick),
        aliases: aliasesForStableMatch(stableMatches, wtUserId),
      }),
    }
  }

  const identityIds = [...new Set(
    matches
      .map((match) => match.identityId)
      .filter((identityId): identityId is number => identityId !== null),
  )]
  if (identityIds.length > 1) {
    const candidates = identityIds.flatMap((identityId) => {
      const identityMatches = matches.filter((match) => match.identityId === identityId)
      return identityMatches.length === 0 ? [] : [candidate(identityMatches)]
    })
    return { status: 'ambiguous', candidates }
  }
  const identityId = identityIds[0]
  if (identityId !== undefined) {
    const identity = getPlayerIdentityById(identityId)
    if (identity !== null) return { status: 'ok', identity }
  }

  const selected = bestMatch(matches)
  return {
    status: 'ok',
    identity: savePlayerIdentity({
      wtUserId: null,
      canonicalNick: selected.nick,
      platform: selected.platform ?? platformFromNick(selected.nick),
      aliases: [{
        source: selected.source,
        externalId: null,
        nick: selected.nick,
        seenAt: selected.seenAt,
        matchMethod: 'exact_nick',
        matchConfidence: 'medium',
      }],
    }),
  }
}

function totalView(row: PlayerExternalStats['totals'][number]): NormalizedPlayerExternalTotal {
  return {
    gameType: row.gameType,
    mode: row.mode,
    category: row.category,
    battles: row.battles,
    victories: row.victories,
    defeats: row.defeats,
    deaths: row.deaths,
    timePlayedSec: row.timePlayedSec,
    respawns: row.respawns,
    airKills: row.airKills,
    groundKills: row.groundKills,
    navalKills: row.navalKills,
  }
}

function vehicleView(row: PlayerExternalStats['vehicles'][number]): NormalizedPlayerExternalVehicle {
  return {
    gameType: row.gameType,
    mode: row.mode,
    vehicleId: row.vehicleId,
    flyouts: row.flyouts,
    victories: row.victories,
    defeats: row.defeats,
    deaths: row.deaths,
    airKills: row.airKills,
    groundKills: row.groundKills,
    navalKills: row.navalKills,
    timePlayedSec: row.timePlayedSec,
  }
}

function metricDelta(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous
}

function totalKey(row: Pick<NormalizedPlayerExternalTotal, 'gameType' | 'mode' | 'category'>): string {
  return JSON.stringify([row.gameType, row.mode, row.category])
}

function vehicleKey(row: Pick<NormalizedPlayerExternalVehicle, 'gameType' | 'mode' | 'vehicleId'>): string {
  return JSON.stringify([row.gameType, row.mode, row.vehicleId])
}

function sortedAccountVehicles(stats: PlayerExternalStats): NormalizedPlayerExternalVehicle[] {
  return stats.vehicles
    .map(vehicleView)
    .sort((left, right) =>
      (right.flyouts ?? -1) - (left.flyouts ?? -1)
      || (right.victories ?? -1) - (left.victories ?? -1)
      || left.vehicleId.localeCompare(right.vehicleId),
    )
}

function externalDelta(
  current: PlayerExternalStats | null,
  previous: PlayerExternalStats | null,
): PlayerExternalDelta | null {
  if (current === null || previous === null) return null
  const previousTotals = new Map(previous.totals.map((row) => [totalKey(row), row]))
  const previousVehicles = new Map(previous.vehicles.map((row) => [vehicleKey(row), row]))
  const currentVehicles = sortedAccountVehicles(current).slice(0, MAX_ACCOUNT_VEHICLES)
  return {
    fromCheckedAt: previous.snapshot.lastCheckedAt,
    toCheckedAt: current.snapshot.lastCheckedAt,
    totals: current.totals.slice(0, MAX_ACCOUNT_TOTALS).map((row) => {
      const before = previousTotals.get(totalKey(row))
      return {
        gameType: row.gameType,
        mode: row.mode,
        category: row.category,
        battles: before === undefined ? null : metricDelta(row.battles, before.battles),
        victories: before === undefined ? null : metricDelta(row.victories, before.victories),
        defeats: before === undefined ? null : metricDelta(row.defeats, before.defeats),
        deaths: before === undefined ? null : metricDelta(row.deaths, before.deaths),
        timePlayedSec: before === undefined ? null : metricDelta(row.timePlayedSec, before.timePlayedSec),
        respawns: before === undefined ? null : metricDelta(row.respawns, before.respawns),
        airKills: before === undefined ? null : metricDelta(row.airKills, before.airKills),
        groundKills: before === undefined ? null : metricDelta(row.groundKills, before.groundKills),
        navalKills: before === undefined ? null : metricDelta(row.navalKills, before.navalKills),
      }
    }),
    vehicles: currentVehicles.map((row) => {
      const before = previousVehicles.get(vehicleKey(row))
      return {
        gameType: row.gameType,
        mode: row.mode,
        vehicleId: row.vehicleId,
        flyouts: before === undefined ? null : metricDelta(row.flyouts, before.flyouts),
        victories: before === undefined ? null : metricDelta(row.victories, before.victories),
        defeats: before === undefined ? null : metricDelta(row.defeats, before.defeats),
        deaths: before === undefined ? null : metricDelta(row.deaths, before.deaths),
        airKills: before === undefined ? null : metricDelta(row.airKills, before.airKills),
        groundKills: before === undefined ? null : metricDelta(row.groundKills, before.groundKills),
        navalKills: before === undefined ? null : metricDelta(row.navalKills, before.navalKills),
        timePlayedSec: before === undefined ? null : metricDelta(row.timePlayedSec, before.timePlayedSec),
      }
    }),
  }
}

function accountState(context: ComparisonContext): PlayerAccountState {
  if (!context.externalEnabled) return context.cache.stats === null ? 'disabled' : 'disabled_cached'
  if (context.cache.stats !== null) return context.cache.stale ? 'stale' : 'fresh'
  if (context.cache.refreshQueued) return 'pending'
  const status = context.cache.lastCheck?.status
  return status === undefined || status === 'ok' ? 'empty' : status
}

interface AccountProjection {
  view: PlayerAccountStatsView
  allTotals: NormalizedPlayerExternalTotal[]
  allVehicles: NormalizedPlayerExternalVehicle[]
}

function accountProjection(context: ComparisonContext): AccountProjection {
  const current = context.cache.stats
  const previous = current === null
    ? null
    : context.history.find((stats) => stats.snapshot.id !== current.snapshot.id) ?? null
  const allVehicles = current === null ? [] : sortedAccountVehicles(current)
  const vehicles = allVehicles.slice(0, MAX_ACCOUNT_VEHICLES)
  const allTotals = current?.totals.map(totalView) ?? []
  const totals = allTotals.slice(0, MAX_ACCOUNT_TOTALS)
  return {
    allTotals,
    allVehicles,
    view: {
      source: context.externalSource,
      enabled: context.externalEnabled,
      state: accountState(context),
      stale: context.cache.stale,
      refreshQueued: context.cache.refreshQueued,
      nextRetryAt: context.cache.nextRetryAt,
      lastCheckStatus: context.cache.lastCheck?.status ?? null,
      error: context.cache.lastCheck?.error ?? null,
      fetchedAt: current?.snapshot.fetchedAt ?? null,
      checkedAt: context.cache.lastCheck?.lastCheckedAt ?? current?.snapshot.lastCheckedAt ?? null,
      sourceUpdatedAt: current?.snapshot.sourceUpdatedAt ?? null,
      totals,
      totalCount: allTotals.length,
      totalsTruncated: allTotals.length > totals.length,
      vehicles,
      vehicleCount: allVehicles.length,
      vehiclesTruncated: allVehicles.length > vehicles.length,
      countries: (current?.countries ?? []).map(({ country, vehicles: owned, eliteVehicles, medals }) => ({
        country,
        vehicles: owned,
        eliteVehicles,
        medals,
      })),
      delta: externalDelta(current, previous),
    },
  }
}

function aggregateAccountWinRate(totals: readonly NormalizedPlayerExternalTotal[]): number | null {
  const aggregate = totals.find((row) =>
    row.gameType === null && row.mode === null && row.category === null,
  )
  if (aggregate?.battles === null || aggregate?.battles === undefined || aggregate.battles === 0) return null
  return aggregate.victories === null ? null : aggregate.victories / aggregate.battles
}

export function getPlayerStatsComparison(
  identity: PlayerIdentity,
  period: PlayerReplayStatsPeriod,
  context: ComparisonContext,
  additionalContexts: readonly ComparisonContext[] = [],
): PlayerStatsComparison {
  const primary = accountProjection(context)
  const accountSources = [
    primary.view,
    ...additionalContexts.map((additional) => accountProjection(additional).view),
  ]

  const replayRaw = identity.wtUserId === null
    ? null
    : getPlayerReplayStats({ userId: identity.wtUserId }, period)
  const replayVehicleCount = replayRaw?.vehicles.length ?? 0
  const replayStats = replayRaw === null
    ? null
    : { ...replayRaw, vehicles: replayRaw.vehicles.slice(0, MAX_REPLAY_VEHICLES) }

  const accountWinRate = aggregateAccountWinRate(primary.allTotals)
  const replayWinRate = replayStats?.winRate ?? null
  const accountVehicleIds = new Set(primary.allVehicles.map((vehicle) => vehicle.vehicleId))
  const replayVehicleIds = new Set(replayRaw?.vehicles.map((vehicle) => vehicle.vehicleId) ?? [])
  let vehicleOverlapCount = 0
  for (const vehicleId of accountVehicleIds) {
    if (replayVehicleIds.has(vehicleId)) vehicleOverlapCount += 1
  }

  return {
    player: {
      wtUserId: identity.wtUserId,
      nick: identity.canonicalNick,
      platform: identity.platform,
    },
    period: {
      from: period.from ?? null,
      to: period.to ?? null,
    },
    account: primary.view,
    accountSources,
    replay: {
      source: 'wrpl',
      available: replayStats !== null,
      userId: identity.wtUserId,
      stats: replayStats,
      vehicleCount: replayVehicleCount,
      vehiclesTruncated: replayVehicleCount > MAX_REPLAY_VEHICLES,
    },
    comparison: {
      directlyComparable: false,
      accountWinRate,
      replayWinRate,
      indicativeWinRateDifference: accountWinRate === null || replayWinRate === null
        ? null
        : replayWinRate - accountWinRate,
      vehicleOverlapCount,
      note: 'Account snapshot накопительный, а WRPL показывает только локально собранные реплеи выбранного периода; значения не суммируются и не считаются одной выборкой.',
    },
  }
}

/** Синхронный read-model: внешний HTTP только ставится в lazy-очередь и не блокирует Fastify. */
export class PlayerStatsCoordinator {
  private readonly services = new Map<string, PlayerStatsService>()
  private readonly externalSources: readonly string[]

  constructor(options: PlayerStatsCoordinatorOptions) {
    if (options.externalService !== undefined && options.externalServices !== undefined) {
      throw new Error('Укажите externalService или externalServices, но не оба варианта')
    }
    const configuredServices = options.externalServices === undefined
      ? options.externalService === null || options.externalService === undefined
        ? []
        : [options.externalService]
      : [...options.externalServices]
    for (const service of configuredServices) {
      const source = service.source.trim()
      if (source === '') throw new Error('Источник внешней статистики не может быть пустым')
      if (this.services.has(source)) throw new Error(`Повторный внешний источник ${source}`)
      this.services.set(source, service)
    }

    const primarySource = options.externalSource?.trim()
      || configuredServices[0]?.source
      || OFFICIAL_PROFILE_SOURCE
    if (primarySource === '') throw new Error('Источник внешней статистики не может быть пустым')
    if (
      options.externalServices === undefined
      && configuredServices.length === 1
      && configuredServices[0]!.source !== primarySource
    ) {
      throw new Error('Источник coordinator-а не совпадает с PlayerStatsService')
    }
    this.externalSources = [
      primarySource,
      ...configuredServices
        .map((service) => service.source)
        .filter((source) => source !== primarySource),
    ]
  }

  lookup(input: PlayerStatsLookupInput): PlayerStatsLookupResult {
    const resolution = resolveKnownPlayer(input.player)
    if (resolution.status !== 'ok') return resolution
    const period = normalizedPeriod(input)
    const contexts = this.externalSources.map((source): ComparisonContext => {
      const service = this.services.get(source) ?? null
      const cache = service === null
        ? {
            stats: getLatestPlayerExternalStats(resolution.identity.id, source),
            stale: false,
            refreshQueued: false,
            lastCheck: getLatestPlayerExternalCheck(resolution.identity.id, source),
            nextRetryAt: null,
          }
        : service.request(resolution.identity.id)
      const history = cache.stats === null
        ? []
        : getPlayerExternalStatsHistory(
            resolution.identity.id,
            source,
            1,
            cache.stats.snapshot.id,
          )
      return {
        externalSource: source,
        externalEnabled: service !== null,
        cache,
        history,
      }
    })
    const primary = contexts[0]!
    return {
      status: 'ok',
      stats: getPlayerStatsComparison(resolution.identity, period, primary, contexts.slice(1)),
    }
  }

  /** Дождаться ленивых запросов всех включённых provider-ов. */
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.services.values()].map((service) => service.waitForIdle()))
  }

  /** Запретить новые refresh и закрыть все provider-ы. */
  async stop(): Promise<void> {
    await Promise.all([...this.services.values()].map((service) => service.stop()))
  }
}
