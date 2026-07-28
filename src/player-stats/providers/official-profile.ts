import {
  fetchPlayerProfileHtml,
  parsePlayerProfilePageHtml,
  PlayerNotFoundError,
  PlayerSchemaError,
  PlayerSessionError,
} from '../../parsers/sources/wt-player.js'
import { WtRequestError } from '../../parsers/sources/wt-request.js'
import {
  parseProfileStatSections,
  ProfileStatsLayoutError,
  type ProfileStatSection,
} from '../../parsers/sources/wt-profile-stats.js'
import {
  normalizeOfficialProfile,
  OFFICIAL_PROFILE_SOURCE,
  PlayerStatsSchemaError,
} from '../normalizer.js'
import {
  type PlayerReference,
  type PlayerStatsFailureStatus,
  type PlayerStatsProvider,
  type RawPlayerStats,
} from '../types.js'

/**
 * Account-статистика с публичной страницы профиля warthunder.com.
 *
 * Профиль ключуется ником: числового user id на странице нет (он приходит
 * только из реплеев), поэтому resolvePlayer возвращает ссылку по нику, а
 * wtUserId остаётся тем, что уже известно identity из локальных боёв.
 *
 * В raw snapshot кладётся не HTML страницы, а извлечённые строки: HTML меняется
 * при каждой загрузке (токены, реклама), и дедупликация по content_hash тогда
 * никогда бы не срабатывала, а база росла бы на 120 КБ за проверку.
 */

export interface OfficialProfileProviderOptions {
  /** Возвращает Unix-время в секундах. */
  now?: () => number
  /** Загрузка страницы; подменяется в тестах. */
  fetchProfile?: (nickname: string) => Promise<{ html: string; url: string }>
}

interface ProfileDocument {
  nick: string
  clan: string | null
  level: number | null
  registrationDate: string | null
  sections: ProfileStatSection[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function platformFromNick(nick: string): string | null {
  return nick.match(/@(psn|live|epic)$/i)?.[1]?.toLowerCase() ?? null
}

/** Раскладывает ошибки транспорта и разбора по статусам snapshot. */
function failureStatus(error: unknown): PlayerStatsFailureStatus {
  if (error instanceof PlayerNotFoundError) return 'not_found'
  if (error instanceof PlayerSessionError) return 'private'
  if (error instanceof PlayerSchemaError) return 'schema_error'
  if (error instanceof ProfileStatsLayoutError) return 'schema_error'
  if (error instanceof PlayerStatsSchemaError) return 'schema_error'
  if (error instanceof WtRequestError) {
    if (error.status === 404) return 'not_found'
    if (error.status === 401 || error.status === 403) return 'private'
    if (error.status === 429) return 'rate_limited'
    return 'error'
  }
  return 'error'
}

export class OfficialProfileProvider implements PlayerStatsProvider {
  readonly source = OFFICIAL_PROFILE_SOURCE

  private readonly now: () => number
  private readonly loadProfile: (nickname: string) => Promise<{ html: string; url: string }>

  constructor(options: OfficialProfileProviderOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.loadProfile = options.fetchProfile ?? fetchPlayerProfileHtml
  }

  /**
   * Профиль адресуется ником, поэтому поиска как такового нет: возвращается
   * ровно одна ссылка, а фактический ник берётся уже со страницы.
   */
  resolvePlayer(nick: string): Promise<PlayerReference[]> {
    const normalized = nick.trim()
    if (normalized === '') {
      return Promise.reject(new Error('Ник для профиля warthunder.com не может быть пустым'))
    }
    return Promise.resolve([{
      source: this.source,
      sourcePlayerId: normalized,
      wtUserId: null,
      nick: normalized,
      platform: platformFromNick(normalized),
    }])
  }

  async fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats> {
    if (player.source !== this.source) {
      throw new Error(`PlayerReference источника ${player.source} нельзя передать в ${this.source}`)
    }
    const nickname = player.nick.trim()
    if (nickname === '') throw new Error('Профиль warthunder.com требует непустой ник')
    const fetchedAt = this.now()

    let document: ProfileDocument
    try {
      document = await this.readProfile(nickname)
    } catch (error) {
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status: failureStatus(error),
        rawJson: null,
        error: errorMessage(error),
        normalized: null,
      }
    }

    const rawJson = JSON.stringify(document)
    try {
      const normalized = normalizeOfficialProfile(document)
      return {
        player: {
          source: this.source,
          sourcePlayerId: document.nick,
          // Страница профиля не публикует числовой id: он остаётся тем, что
          // identity уже знает из локальных реплеев.
          wtUserId: player.wtUserId,
          nick: document.nick,
          platform: platformFromNick(document.nick) ?? player.platform,
        },
        fetchedAt,
        // Профиль не сообщает время своего обновления.
        sourceUpdatedAt: null,
        status: 'ok',
        rawJson,
        error: null,
        normalized,
      }
    } catch (error) {
      return {
        player,
        fetchedAt,
        sourceUpdatedAt: null,
        status: failureStatus(error),
        rawJson,
        error: errorMessage(error),
        normalized: null,
      }
    }
  }

  private async readProfile(nickname: string): Promise<ProfileDocument> {
    const page = await this.loadProfile(nickname)
    // Разбор шапки заодно отличает «игрок не найден» и страницу входа от
    // настоящей смены вёрстки.
    const parsed = parsePlayerProfilePageHtml(page.html, nickname, page.url)
    return {
      nick: parsed.profile.nickname,
      clan: parsed.profile.clan,
      level: parsed.profile.level,
      registrationDate: parsed.profile.registrationDate,
      sections: parseProfileStatSections(page.html),
    }
  }
}
