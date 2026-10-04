import { load, type CheerioAPI } from 'cheerio'
import { config } from '../../config.js'
import type { ParsedItem } from '../../db/index.js'
import { readResponseJson, readResponseText } from '../../http-response.js'
import type { ParserSource } from '../types.js'
import { fetchWtResponse, WtRequestError, WT_USER_AGENT } from './wt-request.js'

const PROFILE_URL = 'https://warthunder.com/en/community/userinfo/'
const REPLAY_URL = 'https://warthunder.com/en/api/replay'
const MAX_PROFILE_BYTES = 2 * 1024 * 1024
const MAX_REPLAY_BYTES = 4 * 1024 * 1024
const MAX_REPLAY_ITEMS = 100
const MAX_PLAYERS_PER_REPLAY = 512

export type PlayerMode = 'arcade' | 'realistic' | 'simulation'

export interface PlayerProfile {
  nickname: string
  clan: string | null
  level: number | null
  registrationDate: string | null
  avatar: string | null
}

export interface ParsedProfilePage {
  profile: PlayerProfile
  statistics: Record<PlayerMode, Record<string, string | null>>
}

export interface PlayerReplayIdentity {
  userId: string
  name: string
  fakeName: string
}

export interface PlayerReplay {
  replayId: string
  userId: string
  name: string
  fakeName: string
  team: string
  mission: string
  mode: string
  startTime: number
}

export interface PlayerData extends Record<string, unknown> {
  profile: PlayerProfile
  statistics: Record<PlayerMode, Record<string, string | null>>
  replayIdentity: PlayerReplayIdentity | null
  /** Общее число реплеев в ответе API; `replays` содержит первую страницу совпадений. */
  replayCount: number
  replays: PlayerReplay[]
}

export interface ReplayPage {
  totalCount: number
  replays: ReplayRecord[]
}

interface ReplayPlayer {
  userId: string
  name: string
  fakeName: string
  team: string
}

interface ReplayRecord {
  replayId: string
  mission: string
  mode: string
  startTime: number
  players: ReplayPlayer[]
}

export class PlayerNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayerNotFoundError'
  }
}

export class PlayerSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayerSessionError'
  }
}

export class PlayerSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayerSchemaError'
  }
}

class PlayerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PlayerHttpError'
  }
}

function throwPlayerRequestError(error: unknown, nickname: string): never {
  if (!(error instanceof WtRequestError)) throw error
  if (error.status === 404) {
    throw new PlayerNotFoundError(`профиль ${nickname}: игрок не найден`)
  }
  if (error.status === 401 || error.status === 403) {
    throw new PlayerSessionError(`${nickname}: ${error.message}`)
  }
  throw new PlayerHttpError(error.status, error.message)
}

/** Сравнение ников без учёта регистра и с канонизацией Unicode. */
export function normalizeNickname(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function cleanText(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '' || /^(?:n\/a|not available|не указано|—|-)$/i.test(text)) return null
  return text
}

function firstText($: CheerioAPI, selectors: string): string | null {
  const value = cleanText($(selectors).first().text())
  return value
}

function firstAttribute($: CheerioAPI, selectors: string, attribute: string): string | null {
  const value = $(selectors).first().attr(attribute)
  return typeof value === 'string' ? cleanText(value) : null
}

function looksLikeSessionPage($: CheerioAPI, html: string): boolean {
  const body = $('body').text().replace(/\s+/g, ' ').trim().toLowerCase()
  return (
    $('input[type="password"], form[action*="login" i]').length > 0 ||
    /cloudflare|access denied|forbidden|sign in|log in|войти/.test(body) ||
    /cloudflare|access denied|forbidden/i.test(html.slice(0, 16_384))
  )
}

function toAbsoluteHttpUrl(value: string | null, baseUrl: string): string | null {
  if (value === null) return null
  const cssUrl = value.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1] ?? value
  try {
    const url = new URL(cssUrl, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function parseLevel(value: string | null): number | null {
  if (value === null) return null
  const match = value.match(/(?:level|уровень)?\s*[:#-]?\s*(\d{1,4})\b/i)
  if (match === null) return null
  const level = Number(match[1])
  return Number.isSafeInteger(level) && level >= 0 && level <= 10_000 ? level : null
}

function parseRegistrationDate(value: string | null): string | null {
  if (value === null) return null
  const match = value.match(/\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/)
  return match?.[0] ?? value
}

function parseAvatar($: CheerioAPI, profileUrl: string): string | null {
  const imageSelectors = '.user-profile__avatar img, .user-profile__ava-img, .user-profile img[src*="avatars.warthunder.com"], .user-profile img'
  const image = firstAttribute($, imageSelectors, 'src')
    ?? firstAttribute($, imageSelectors, 'data-src')
  if (image !== null) return toAbsoluteHttpUrl(image, profileUrl)
  const dataImage = firstAttribute($, '.user-profile__avatar, .user-profile [style*="background-image"]', 'style')
  return toAbsoluteHttpUrl(dataImage, profileUrl)
}

function parseModeStatistics(
  $: CheerioAPI,
  selectors: string,
): Record<string, string | null> {
  const values = $(`.user-profile__stat.user-stat ${selectors}`).first()
  if (values.length === 0) return {}

  const titles: Array<string | null> = []
  $('.user-profile__stat.user-stat ul.user-stat__list--titles').first()
    .children('li')
    .each((_, element) => {
      titles.push(cleanText($(element).text()))
    })
  const result: Record<string, string | null> = {}
  const valueItems = values.children('li')
  const titleOffset = titles.length > 0 && titles.length === valueItems.length - 1 ? 1 : 0
  valueItems.each((index, element) => {
    const titleIndex = index - titleOffset
    if (titleIndex < 0) return
    const key = titles[titleIndex] ?? `value${index + 1 - titleOffset}`
    if (key === null || key.trim() === '') return
    result[key] = cleanText($(element).text())
  })
  return result
}

function parseStatistics($: CheerioAPI): Record<PlayerMode, Record<string, string | null>> {
  return {
    arcade: parseModeStatistics($, 'ul.user-stat__list.arcadeFightTab'),
    realistic: parseModeStatistics($, 'ul.user-stat__list.historyFightTab, ul.user-stat__list.realisticFightTab'),
    simulation: parseModeStatistics($, 'ul.user-stat__list.simulationFightTab'),
  }
}

const PROFILE_NOT_FOUND = /player\s+not\s+found|user\s+not\s+found|игрок не найден/i

/**
 * Parses a profile page into the profile and its statistics. "Not found"
 * needs the site to say so: unknown markup is a schema error, retried soon,
 * not a not_found snapshot kept for the whole TTL.
 */
export function parsePlayerProfilePageHtml(
  html: string,
  requestedNickname: string,
  profileUrl = PROFILE_URL,
): ParsedProfilePage {
  if (Buffer.byteLength(html, 'utf8') > MAX_PROFILE_BYTES) {
    throw new PlayerSchemaError(`profile ${requestedNickname}: response exceeds ${MAX_PROFILE_BYTES} bytes`)
  }
  const $ = load(html)
  const profile = $('.user-profile').first()
  if (profile.length === 0) {
    if (looksLikeSessionPage($, html)) {
      throw new PlayerSessionError(`profile ${requestedNickname}: the WT session expired or the site returned a protection page`)
    }
    if (PROFILE_NOT_FOUND.test($('body').text())) {
      throw new PlayerNotFoundError(`profile ${requestedNickname}: player not found`)
    }
    throw new PlayerSchemaError(`profile ${requestedNickname}: no user-profile block`)
  }

  const nickname = firstText($, '.user-profile__data-nick a, .user-profile__data-nick')
    ?? firstText($, '.user-profile h1, h1')
  if (PROFILE_NOT_FOUND.test(nickname ?? $('body').text())) {
    throw new PlayerNotFoundError(`profile ${requestedNickname}: player not found`)
  }
  if (nickname === null) {
    throw new PlayerSchemaError(`profile ${requestedNickname}: no nickname in the user-profile block`)
  }
  if (/sign\s+in|log\s+in|войти/i.test(nickname)) {
    throw new PlayerSessionError(`profile ${requestedNickname}: the site returned the sign-in page, update WT_COOKIE`)
  }

  const clanValue = firstText($, '.user-profile__data-clan a, .user-profile__data-clan')
  const clan = clanValue !== null && !/^(?:not in a clan|no clan|нет клана)$/i.test(clanValue)
    ? clanValue
    : null
  const dataRows = profile.children('ul').first().children('li')
  const levelRow = dataRows.filter((_, element) =>
    /^(?:level|уровень)\b/i.test($(element).text().trim()),
  ).first()
  const registrationRow = dataRows.filter((_, element) =>
    /^(?:registration(?: date)?|registered|дата регистрации)\b/i.test($(element).text().trim()),
  ).first()
  const levelValue = firstText($, '.user-profile__data-level, .user-profile [class*="level"]')
    ?? cleanText(levelRow.text())
  const registrationValue = firstText($, '.user-profile__data-regdate')
    ?? cleanText(registrationRow.text())
  return {
    profile: {
      nickname,
      clan,
      level: parseLevel(levelValue),
      registrationDate: parseRegistrationDate(registrationValue),
      avatar: parseAvatar($, profileUrl),
    },
    statistics: parseStatistics($),
  }
}

/** Разбирает HTML профиля; не выполняет никаких сетевых запросов. */
export function parsePlayerProfileHtml(
  html: string,
  requestedNickname: string,
  profileUrl = PROFILE_URL,
): PlayerProfile {
  return parsePlayerProfilePageHtml(html, requestedNickname, profileUrl).profile
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function numberField(record: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = record[name]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function requiredStringField(
  record: Record<string, unknown>,
  label: string,
  ...names: string[]
): string {
  const value = stringField(record, ...names)
  if (value === null) throw new PlayerSchemaError(`${label}: отсутствует поле ${names.join('/')}`)
  return value
}

function requiredTimestamp(record: Record<string, unknown>, label: string): number {
  const value = numberField(record, 'startTime', 'start_time', 'timestamp')
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new PlayerSchemaError(`${label}: неверный startTime`)
  }
  return value
}

function parseReplayPlayer(value: unknown, team: string, label: string): ReplayPlayer {
  if (!isRecord(value)) throw new PlayerSchemaError(`${label}: участник не является объектом`)
  return {
    userId: requiredStringField(value, label, 'userId', 'user_id', 'userid'),
    name: stringField(value, 'name') ?? '',
    fakeName: stringField(value, 'fakeName', 'fake_name') ?? '',
    team: stringField(value, 'team', 'teamId') ?? team,
  }
}

function parseReplayPlayers(value: unknown, label: string): ReplayPlayer[] {
  if (!isRecord(value)) throw new PlayerSchemaError(`${label}: players не является объектом`)
  const players: ReplayPlayer[] = []
  for (const [team, rawPlayers] of Object.entries(value)) {
    if (!Array.isArray(rawPlayers)) throw new PlayerSchemaError(`${label}: команда ${team} не является массивом`)
    if (rawPlayers.length > MAX_PLAYERS_PER_REPLAY) {
      throw new PlayerSchemaError(`${label}: слишком много участников в команде ${team}`)
    }
    rawPlayers.forEach((player, index) => {
      players.push(parseReplayPlayer(player, team, `${label}, команда ${team}, участник ${index + 1}`))
    })
  }
  return players
}

/** Проверяет и нормализует ответ POST /en/api/replay. */
export function parseReplayPage(value: unknown): ReplayPage {
  if (!isRecord(value)) throw new PlayerSchemaError('replay API: ответ не является JSON-объектом')
  const statusCode = numberField(value, 'statusCode', 'status_code', 'code')
  const statusText = [
    stringField(value, 'status', 'result'),
    stringField(value, 'message', 'error', 'errorMessage'),
  ].filter((part): part is string => part !== null).join(' ')
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /authentication|authorization|forbidden|login|session|unauthori[sz]ed|истекла|сесс/i.test(statusText)
  ) {
    throw new PlayerSessionError('replay API: сервер сообщил об истёкшей или недействительной сессии WT')
  }
  const rawItems = value['items'] ?? value['replays']
  if (!Array.isArray(rawItems)) throw new PlayerSchemaError('replay API: отсутствует массив items')
  if (rawItems.length > MAX_REPLAY_ITEMS) throw new PlayerSchemaError('replay API: слишком много реплеев в ответе')

  const replays = rawItems.map((rawReplay, index) => {
    const label = `replay API, реплей ${index + 1}`
    if (!isRecord(rawReplay)) throw new PlayerSchemaError(`${label}: запись не является объектом`)
    return {
      replayId: requiredStringField(rawReplay, label, 'sessionId', 'session_id', 'replayId', 'id'),
      mission: requiredStringField(rawReplay, label, 'missionName', 'mission', 'title'),
      mode: requiredStringField(rawReplay, label, 'gameMode', 'mode', 'game_mode'),
      startTime: requiredTimestamp(rawReplay, label),
      players: parseReplayPlayers(rawReplay['players'], label),
    }
  })
  const total = numberField(value, 'total_count', 'totalCount', 'count')
  const totalCount = total !== null && Number.isSafeInteger(total) && total >= 0 ? total : replays.length
  return { totalCount, replays }
}

function matchingPlayer(player: ReplayPlayer, normalizedNickname: string): boolean {
  return [player.name, player.fakeName].some(
    (name) => name !== '' && normalizeNickname(name) === normalizedNickname,
  )
}

export function replayDataForPlayer(page: ReplayPage, nickname: string): {
  identity: PlayerReplayIdentity | null
  replays: PlayerReplay[]
} {
  const replays: PlayerReplay[] = []
  let identity: PlayerReplayIdentity | null = null
  const normalizedNickname = normalizeNickname(nickname)
  for (const replay of page.replays) {
    const player = replay.players.find((candidate) => matchingPlayer(candidate, normalizedNickname))
    if (player === undefined) continue
    identity ??= {
      userId: player.userId,
      name: player.name,
      fakeName: player.fakeName,
    }
    replays.push({
      replayId: replay.replayId,
      userId: player.userId,
      name: player.name,
      fakeName: player.fakeName,
      team: player.team,
      mission: replay.mission,
      mode: replay.mode,
      startTime: replay.startTime,
    })
  }
  return { identity, replays }
}

/**
 * Загружает HTML профиля тем же транспортом, cookie jar и rate-limit, что и
 * плановый источник wt-players. Отдельно от разбора — страница нужна и
 * player-stats провайдеру, который читает с неё все блоки статистики.
 */
export async function fetchPlayerProfileHtml(
  nickname: string,
): Promise<{ html: string; url: string }> {
  const url = new URL(PROFILE_URL)
  url.searchParams.set('nick', nickname)
  let response: Response
  try {
    response = await fetchWtResponse(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en,en-US;q=0.9,en-GB;q=0.8,ru;q=0.7',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        priority: 'u=0, i',
        'sec-ch-ua': '\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Microsoft Edge\";v=\"150\"',
        'sec-ch-ua-arch': '\"x86\"',
        'sec-ch-ua-bitness': '\"64\"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-model': '\"\"',
        'sec-ch-ua-platform': '\"Windows\"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'sec-gpc': '1',
        'upgrade-insecure-requests': '1',
        'user-agent': WT_USER_AGENT,
        referer: `https://warthunder.com/en/community/searchplayers?name=${encodeURIComponent(nickname.toLowerCase())}`,
      },
    }, `профиль ${nickname}`)
  } catch (error) {
    throwPlayerRequestError(error, nickname)
  }
  if (/login\.gaijin\.net|\/login(?:[/?]|$)/i.test(response.url)) {
    await response.body?.cancel().catch(() => undefined)
    throw new PlayerSessionError(`профиль ${nickname}: перенаправление на страницу входа — обнови WT_COOKIE`)
  }
  const profileContentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const contentType = profileContentType
  if (!contentType.includes('html')) {
    await response.body?.cancel().catch(() => undefined)
    throw new PlayerSchemaError(`профиль ${nickname}: сервер вернул не HTML (Content-Type: ${contentType || 'отсутствует'})`)
  }
  const html = await readResponseText(response, MAX_PROFILE_BYTES, `профиль ${nickname}`)
  return { html, url: response.url || url.toString() }
}

async function fetchProfile(nickname: string): Promise<ParsedProfilePage> {
  const page = await fetchPlayerProfileHtml(nickname)
  return parsePlayerProfilePageHtml(page.html, nickname, page.url)
}

async function fetchReplayPage(nickname: string): Promise<ReplayPage> {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': WT_USER_AGENT,
    referer: 'https://warthunder.com/en/tournament/replay/',
  }
  let response: Response
  try {
    response = await fetchWtResponse(REPLAY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        gameMode: ['arcade', 'realistic', 'simulation'],
        gameType: 'randomBattle',
        techType: 'all',
        findMissionValue: '',
        findUserValue: nickname,
        findUserType: 'USERNAME',
        isUserOwnReplays: false,
        rankRange: '',
        timeRangeFrom: '',
        timeRangeTo: '',
        timeRangeFromDay: 1,
        timeRangeFromMonth: 0,
        timeRangeFromTime: '00:00',
        timeRangeToDay: 31,
        timeRangeToMonth: 11,
        timeRangeToTime: '23:59',
        limit: 50,
        page: 1,
      }),
    }, `replay for ${nickname}`)
  } catch (error) {
    throwPlayerRequestError(error, nickname)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('json')) {
    await response.body?.cancel().catch(() => undefined)
    throw new PlayerSessionError(`replay for ${nickname}: the server returned non-JSON, the session may have expired`)
  }
  // An empty list alone is no expired session: the player may have no public
  // random-battle replays; explicit 401/403/redirect/error became PlayerSessionError above.
  return parseReplayPage(await readResponseJson<unknown>(response, MAX_REPLAY_BYTES, `replay for ${nickname}`))
}

/**
 * Accounts whose real name (never the anonymous fakeName) is `nickname` in the
 * first Replay API page (50 random battles); bot slots (id ≤ 0) are skipped.
 * Needs WT_COOKIE; an empty list does not prove there is no such account.
 */
export async function findReplayAccounts(nickname: string): Promise<Array<{ userId: string; name: string }>> {
  if (config.wtCookie.trim() === '') throw new PlayerSessionError(`${nickname}: WT_COOKIE is not set`)
  const page = await fetchReplayPage(nickname)
  const wanted = normalizeNickname(nickname)
  const accounts = new Map<string, string>()
  for (const replay of page.replays) {
    for (const player of replay.players) {
      if (!/^[1-9]\d*$/.test(player.userId) || player.name === '') continue
      if (normalizeNickname(player.name) === wanted) accounts.set(player.userId, player.name)
    }
  }
  return [...accounts].map(([userId, name]) => ({ userId, name }))
}

async function collectPlayer(nickname: string): Promise<PlayerData> {
  const profilePage = await fetchProfile(nickname)
  const replayPage = await fetchReplayPage(profilePage.profile.nickname)
  const replayData = replayDataForPlayer(replayPage, profilePage.profile.nickname)
  return {
    profile: profilePage.profile,
    statistics: profilePage.statistics,
    replayIdentity: replayData.identity,
    replayCount: replayPage.totalCount,
    replays: replayData.replays,
  }
}

/**
 * Собирает один профиль тем же transport/cookie jar/rate-limit, что и
 * плановый источник wt-players. Вызов экспортирован для voice-табло: игрок,
 * впервые появившийся в голосовом канале, не обязан заранее находиться в
 * WT_PLAYER_NAMES.
 *
 * Все сборы игроков проходят через одну очередь. Это не даёт планировщику и
 * табло одновременно запрашивать один и тот же профиль и сохраняет общий
 * порядок HTTP-запросов (между самими запросами интервал держит
 * fetchWtResponse).
 */
const playerCollectionTail: { current: Promise<void> } = { current: Promise.resolve() }
const playerCollections = new Map<string, Promise<ParsedItem>>()

async function collectPlayerItemUnsafe(nickname: string): Promise<ParsedItem> {
  const requested = nickname.trim()
  if (requested === '') throw new Error('Ник игрока не может быть пустым')
  if (config.wtCookie.trim() === '') {
    throw new PlayerSessionError(`${requested}: WT_COOKIE не задан в .env — запрос профиля пропущен`)
  }
  const player = await collectPlayer(requested)
  return {
    externalId: player.replayIdentity?.userId ?? player.profile.nickname,
    title: player.profile.nickname,
    data: player,
  }
}

export function collectPlayerItem(nickname: string): Promise<ParsedItem> {
  const key = normalizeNickname(nickname)
  if (key === '') return Promise.reject(new Error('Ник игрока не может быть пустым'))
  const existing = playerCollections.get(key)
  if (existing !== undefined) return existing

  const run = playerCollectionTail.current.then(
    () => collectPlayerItemUnsafe(nickname),
    () => collectPlayerItemUnsafe(nickname),
  )
  const result = run.then(
    (item) => {
      playerCollections.delete(key)
      return item
    },
    (error: unknown) => {
      playerCollections.delete(key)
      throw error
    },
  )
  playerCollections.set(key, result)
  playerCollectionTail.current = result.then(() => undefined, () => undefined)
  return result
}

export const wtPlayers: ParserSource = {
  name: 'wt-players',
  intervalMs: 30 * 60_000,
  async run(signal) {
    const nicknames = config.playerNames
    if (nicknames.length === 0) return { summary: 'Список WT-игроков пуст — сбор пропущен', items: [] }
    if (config.wtCookie.trim() === '') {
      throw new Error('WT_COOKIE не задан в .env — источник wt-players требует залогиненную сессию WT')
    }

    const items: ParsedItem[] = []
    const errors: string[] = []
    // Игроки намеренно идут последовательно через общую очередь: 429 или
    // потеря сессии должны остановить batch без лишних запросов.
    for (const nickname of nicknames) {
      signal.throwIfAborted()
      try {
        items.push(await collectPlayerItem(nickname))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof PlayerSessionError || (error instanceof PlayerHttpError && error.status === 429)) {
          throw new Error(message)
        }
        errors.push(`${nickname}: ${message}`)
        console.error(`[parser:wt-players] ${nickname}: ${message}`)
      }
    }

    if (items.length === 0 && errors.length > 0) {
      throw new Error(`Не удалось собрать ни одного игрока: ${errors.join(' | ')}`)
    }
    let summary = `Игроков собрано: ${items.length}/${nicknames.length}`
    if (errors.length > 0) summary += `; ошибки: ${errors.join(' | ')}`
    return { summary, items }
  },
}
