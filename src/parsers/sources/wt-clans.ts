import {
  getBotState,
  getClanRosterRefreshedAt,
  getClanSeasonContext,
  saveClanLeaderboard,
  saveOfficialClanSeason,
  setBotState,
  type ClanLeaderboardEntry,
  type ClanRequirements,
  type ClanSeasonRewards,
  type OfficialClanSeason,
} from '../../db/index.js'
import { decodeHtmlEntities } from '../../html-text.js'
import { readResponseText } from '../../http-response.js'
import { fetchRatingsForTags } from '../../wrpl/clan-info.js'
import { fetchWtResponse } from './wt-request.js'
import type { ParserSource } from '../types.js'

/**
 * Официальный лидерборд полков warthunder.com: полный тег с украшениями
 * («╁0NYX╂») → имя клана («0NYX») для страницы claninfo и статистика клана —
 * рейтинг полковых боёв текущего сезона (dr_era5_hist), место, состав, бои,
 * победы.
 *
 * Зачем: в реплее лежит только тег, а личный клановый рейтинг (ПКР)
 * участников виден на странице клана, которая открывается по имени. Рейтинг
 * же самого клана — только здесь: снимки ПКР есть лишь у кланов, чьи бои бот
 * рисовал, и сумма по ним теряла лидеров сезона.
 *
 * Каждый запуск читает первые TOP_PAGES страниц (20 кланов на каждой) — сотню
 * лидеров, которую показывает сайт. Раз в 12 часов обход идёт дальше, пока у
 * кланов ненулевой рейтинг сезона: активные кланы, чьи бои и попадают в
 * реплеи, все в этой части списка. Пишем не в items, а в clans и
 * clan_rating_history (см. db/index.ts).
 */

const LB_URL = 'https://warthunder.com/en/community/getclansleaderboard/dif/_hist/page'
const PAGE_SIZE = 20
const TOP_PAGES = 5
const MAX_PAGES = 40
const INTERVAL_MS = 20 * 60_000
const FULL_CRAWL_INTERVAL_SEC = 12 * 60 * 60
const FULL_CRAWL_STATE_KEY = 'wt-clans:full-crawl-at'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 2_048
const MAX_REWARDS = 100
const MAX_REQUIREMENTS = 8
const GAME_MARKUP = /<\/?(?:color|b|i|u|size)(?:=[^<>]*)?>/gi
/**
 * Ростер и ПКР участников со страницы claninfo раньше читались только для
 * кланов из нарисованных боёв: у лидера, не игравшего при боте, страница
 * клана была пустой. Каждый запуск обновляет ростер нескольких лидеров, чей
 * ростер старше суток: 5 за 20 минут — вся сотня примерно за 7 часов.
 */
const ROSTERS_PER_RUN = 5
const ROSTER_MAX_AGE_SEC = 24 * 60 * 60

/** Лидеры, чей ростер claninfo пора обновить: по месту в лидерборде, не больше limit. */
export function pickRostersToRefresh(
  clans: readonly ClanLeaderboardEntry[],
  refreshedAt: ReadonlyMap<string, number>,
  nowSec: number,
  limit = ROSTERS_PER_RUN,
): string[] {
  return [...clans]
    .filter((clan) => clan.rating !== null && clan.rating > 0)
    .filter((clan) => nowSec - (refreshedAt.get(clan.tag) ?? 0) >= ROSTER_MAX_AGE_SEC)
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit)
    .map((clan) => clan.tag)
}

export interface LeaderboardPage {
  status: string
  /** Элементов на странице; пустая страница — конец лидерборда. */
  size: number
  /** Кланы с тегом и именем; элементы без них пропускаются. */
  clans: ClanLeaderboardEntry[]
  /** Хотя бы у одного клана ненулевой рейтинг сезона. */
  hasActive: boolean
  /** Официальный сезон (clanSeasonRatingRewards первого клана с ним). */
  season: OfficialClanSeason | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Неотрицательное целое поле лидерборда; отсутствие — null, иной тип — ошибка схемы. */
function optionalCount(value: unknown, field: string, page: number, index: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверное поле ${field}`)
  }
  return value
}

/**
 * Строка украшения (регион, тип, слоган, награда): чистый текст, ограниченный
 * по длине, пустой — null. Лидерборд отдаёт её экранированной для HTML
 * (&lt;, &amp;, &#039;) и с разметкой игры (<color=#…>, <b>, <br>); снимаются
 * только известные теги игры, текст в угловых скобках остаётся.
 */
export function leaderboardText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(GAME_MARKUP, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? null : text.slice(0, MAX_TEXT_LENGTH)
}

/**
 * Многострочный текст лидерборда (описание, объявление): как leaderboardText,
 * но переносы строк остаются, пустые строки подряд схлопываются в одну.
 */
export function leaderboardMultilineText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(GAME_MARKUP, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text === '' ? null : text.slice(0, MAX_DESCRIPTION_LENGTH)
}

function boundedCount(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
}

/**
 * Условия вступления (membership_req). Пустой массив — условий нет.
 * Украшение, а не схема: незнакомые ключи и элементы пропускаются.
 */
export function parseClanRequirements(value: unknown): ClanRequirements | null {
  if (!isRecord(value)) return null
  let ranks: ClanRequirements['ranks'] = null
  const rawRanks = value['ranks']
  if (isRecord(rawRanks)) {
    const items: { unitType: string; rank: number; count: number }[] = []
    for (const item of Object.values(rawRanks)) {
      if (!isRecord(item) || item['type'] !== 'rank') continue
      const unitType = item['unitType']
      const rank = boundedCount(item['rank'], 100)
      const count = boundedCount(item['count'], 1_000)
      if (typeof unitType !== 'string' || !/^[A-Za-z_]{1,32}$/.test(unitType) || rank === null || count === null) continue
      if (items.length < MAX_REQUIREMENTS) items.push({ unitType, rank, count })
    }
    if (items.length > 0) ranks = { mode: rawRanks['type'] === 'or' ? 'or' : 'and', items }
  }
  const battles: ClanRequirements['battles'] = []
  for (const [key, item] of Object.entries(value)) {
    if (!key.startsWith('battles_') || !isRecord(item) || item['type'] !== 'battles') continue
    const difficulty = item['difficulty']
    const count = boundedCount(item['count'], 10_000_000)
    if (typeof difficulty !== 'string' || !/^[a-z_]{1,32}$/.test(difficulty) || count === null) continue
    if (battles.length < MAX_REQUIREMENTS) battles.push({ difficulty, count })
  }
  return ranks === null && battles.length === 0 ? null : { ranks, battles }
}

/** Дата лидерборда вида {"$date": мс} → Unix-секунды; иное — null. */
function mongoDateSec(value: unknown): number | null {
  const ms = isRecord(value) ? value['$date'] : undefined
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : null
}

function seasonNumber(value: unknown): number | null {
  const match = typeof value === 'string' ? /^seasonId(\d{1,4})_/.exec(value) : null
  return match ? Number(match[1]) : null
}

/**
 * Награды прошлых сезонов: лучшие (clanBestRewards) и все (clanRewardLog).
 * Украшение, а не схема: незнакомый формат элемента пропускается.
 */
function parseRewards(best: unknown, log: unknown): ClanSeasonRewards | null {
  const rewards: ClanSeasonRewards = { best: [], log: [] }
  if (Array.isArray(best)) {
    for (const item of best.slice(0, MAX_REWARDS)) {
      if (!isRecord(item)) continue
      const season = seasonNumber(item['seasonName'])
      const title = leaderboardText(item['title'])
      if (season !== null && title !== null) rewards.best.push([season, title])
    }
  }
  if (isRecord(log)) {
    for (const [key, item] of Object.entries(log).slice(0, MAX_REWARDS)) {
      if (!isRecord(item)) continue
      const season = seasonNumber(key)
      const titles = Array.isArray(item['titles'])
        ? item['titles'].map(leaderboardText).filter((title): title is string => title !== null)
        : []
      if (season !== null && titles.length > 0) rewards.log.push([season, titles])
    }
    rewards.log.sort((left, right) => right[0] - left[0])
  }
  return rewards.best.length > 0 || rewards.log.length > 0 ? rewards : null
}

/** Официальные границы сезона: конец в лидерборде включающий (23:59:59). */
function parseSeason(value: unknown): OfficialClanSeason | null {
  if (!isRecord(value)) return null
  const seasonId = value['seasonId']
  const startsAt = mongoDateSec(value['seasonStartTimestamp'])
  const lastSecond = mongoDateSec(value['seasonEndTimestamp'])
  if (typeof seasonId !== 'number' || !Number.isSafeInteger(seasonId) || startsAt === null || lastSecond === null) {
    return null
  }
  return lastSecond >= startsAt ? { seasonId, startsAt, endsAt: lastSecond + 1 } : null
}

export function parseLeaderboardPage(raw: string, page: number): LeaderboardPage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`лидерборд, страница ${page}: некорректный JSON`)
  }
  if (!isRecord(value) || typeof value['status'] !== 'string' || !Array.isArray(value['data'])) {
    throw new Error(`лидерборд, страница ${page}: неожиданная схема ответа`)
  }

  const clans: ClanLeaderboardEntry[] = []
  let hasActive = false
  let season: OfficialClanSeason | null = null
  for (const [index, rawClan] of value['data'].entries()) {
    if (!isRecord(rawClan)) {
      throw new Error(`лидерборд, страница ${page}: элемент ${index} не является объектом`)
    }
    const tag = rawClan['tag']
    const name = rawClan['name']
    const astat = rawClan['astat']
    if (tag !== undefined && typeof tag !== 'string') {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный tag`)
    }
    if (name !== undefined && typeof name !== 'string') {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный name`)
    }
    if (astat !== undefined && !isRecord(astat)) {
      throw new Error(`лидерборд, страница ${page}: у элемента ${index} неверный astat`)
    }
    const rating = optionalCount(astat?.['dr_era5_hist'], 'dr_era5_hist', page, index)
    if (rating !== null && rating > 0) hasActive = true
    season ??= parseSeason(rawClan['clanSeasonRatingRewards'])
    if (!tag || !name) continue
    // pos считается с нуля; без него место восстанавливается по странице.
    const pos = optionalCount(rawClan['pos'], 'pos', page, index)
    clans.push({
      tag,
      name,
      rating,
      position: pos === null ? (page - 1) * PAGE_SIZE + index + 1 : pos + 1,
      members: optionalCount(rawClan['members_cnt'], 'members_cnt', page, index),
      battles: optionalCount(astat?.['battles_hist'], 'battles_hist', page, index),
      wins: optionalCount(astat?.['wins_hist'], 'wins_hist', page, index),
      airKills: optionalCount(astat?.['akills_hist'], 'akills_hist', page, index),
      groundKills: optionalCount(astat?.['gkills_hist'], 'gkills_hist', page, index),
      deaths: optionalCount(astat?.['deaths_hist'], 'deaths_hist', page, index),
      flightTime: optionalCount(astat?.['ftime_hist'], 'ftime_hist', page, index),
      activity: optionalCount(astat?.['activity'], 'activity', page, index),
      region: leaderboardText(rawClan['region']),
      clanType: leaderboardText(rawClan['type']),
      foundedAt: mongoDateSec(rawClan['cdate']),
      slogan: leaderboardText(rawClan['slogan']),
      rewards: parseRewards(rawClan['clanBestRewards'], rawClan['clanRewardLog']),
      clanId: boundedCount(rawClan['_id'], Number.MAX_SAFE_INTEGER),
      description: leaderboardMultilineText(rawClan['desc']),
      announcement: leaderboardMultilineText(rawClan['announcement']),
      requirements: parseClanRequirements(rawClan['membership_req']),
      status: leaderboardText(rawClan['status']),
      autoAccept: typeof rawClan['autoaccept'] === 'boolean' ? rawClan['autoaccept'] : null,
      plainTag: leaderboardText(rawClan['lastPaidTag']),
      regalia: leaderboardText(rawClan['currentTagRegalia']),
    })
  }
  return { status: value['status'], size: value['data'].length, clans, hasActive, season }
}

export const wtClans: ParserSource = {
  name: 'wt-clans',
  intervalMs: INTERVAL_MS,
  async run(signal) {
    // Один момент на весь обход: по общему rating_at сайт отличает кланы
    // свежего обхода от оставшихся с прежних.
    const capturedAt = Math.floor(Date.now() / 1_000)
    const lastFullCrawl = Number(getBotState(FULL_CRAWL_STATE_KEY) ?? 0)
    const full = !Number.isFinite(lastFullCrawl) || capturedAt - lastFullCrawl >= FULL_CRAWL_INTERVAL_SEC * 0.9
    const maxPages = full ? MAX_PAGES : TOP_PAGES

    const entries: ClanLeaderboardEntry[] = []
    const seenTags = new Set<string>()
    let season: OfficialClanSeason | null = null
    let pages = 0
    // Страницы зависимы: конец списка и нулевой рейтинг останавливают обход,
    // а общая очередь warthunder.com всё равно выполняет запросы по одному.
    for (let page = 1; page <= maxPages; page++) {
      signal.throwIfAborted()
      const res = await fetchWtResponse(
        `${LB_URL}/${page}/sort/dr_era5`,
        { headers: { accept: 'application/json' } },
        `лидерборд, страница ${page}`,
        MAX_RESPONSE_BYTES,
      )
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`HTTP ${res.status} на странице ${page} лидерборда`)
      }
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType !== '' && !contentType.includes('json')) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`лидерборд, страница ${page}: сервер вернул не JSON`)
      }
      const parsed = parseLeaderboardPage(
        await readResponseText(res, MAX_RESPONSE_BYTES, `лидерборд, страница ${page}`),
        page,
      )
      if (parsed.status !== 'ok' || parsed.size === 0) break
      pages = page
      season ??= parsed.season
      // Пока идёт обход, клан может сдвинуться на соседнюю страницу — дубль
      // с более низким местом отбрасываем.
      for (const clan of parsed.clans) {
        if (seenTags.has(clan.tag)) continue
        seenTags.add(clan.tag)
        entries.push(clan)
      }
      // страница целиком из кланов с нулевым рейтингом — дальше только неактивные
      if (!parsed.hasActive) break
    }
    if (entries.length === 0) {
      throw new Error('лидерборд не вернул ни одного клана — изменился ответ сайта или доступ')
    }

    saveClanLeaderboard(entries, capturedAt)
    if (full) setBotState(FULL_CRAWL_STATE_KEY, String(capturedAt))
    if (season) saveOfficialClanSeason(season)

    // Ростеры лидеров: сбой claninfo пишется в лог и не роняет обход лидерборда.
    signal.throwIfAborted()
    const leaders = entries.slice(0, TOP_PAGES * PAGE_SIZE)
    const rosterTags = pickRostersToRefresh(leaders, getClanRosterRefreshedAt(leaders.map((clan) => clan.tag)), capturedAt)
    if (rosterTags.length > 0) await fetchRatingsForTags(rosterTags)
    const rosterText = rosterTags.length > 0 ? ` · ростеры claninfo: ${rosterTags.length}` : ''

    const leader = entries[0]!
    const leaderText = leader.rating === null ? '' : ` · лидер ${leader.tag} — ${leader.rating}`
    const seasonText = season ? ` · сезон ${season.seasonId}${seasonMismatch(season)}` : ''
    return {
      summary: full
        ? `Кланов в лидерборде: ${entries.length} (страниц: ${pages}, полный обход)${leaderText}${seasonText}${rosterText}`
        : `Лидеры обновлены: ${entries.length} кланов (страниц: ${pages})${leaderText}${seasonText}${rosterText}`,
    }
  },
}

/**
 * Сверка сезона с форумом (источник wt-clan-season): расхождение видно в
 * статусе источника на дашборде, расписание при этом не меняется.
 */
function seasonMismatch(official: OfficialClanSeason): string {
  const forum = getClanSeasonContext(official.startsAt).season
  if (forum === null) return ' (на форуме сезона нет)'
  return forum.startsAt === official.startsAt && forum.endsAt === official.endsAt
    ? ''
    : ' (даты с форумом расходятся)'
}
