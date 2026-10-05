/**
 * A squadron's own texts (slogan, description, announcement) read for what the leaderboard has no
 * field for: links to its Discord and channels, and join requirements written in prose ("К/Д 0.9+,
 * Бр 10.7+"). The texts are untrusted and free-form, in a dozen languages and scripts. The rules
 * follow the 670 squadrons with text on 2026-10-05 (479 with a link, 212 with a requirement line)
 * and put precision before recall: a figure counts only beside its keyword, and only with a "+",
 * "from", "min" or in a requirements sentence.
 */

export type ClanTextField = 'slogan' | 'description' | 'announcement'

export type ClanLinkKind = 'discord' | 'telegram' | 'youtube' | 'twitch' | 'vk' | 'tiktok' | 'facebook' | 'steam' | 'web'

export interface ClanLink {
  kind: ClanLinkKind
  /** The address as written, https:// added to a bare one. */
  url: string
  /** The address without its scheme and "www.". */
  label: string
}

export type ClanRequirementKind =
  | 'kd' | 'br' | 'rank' | 'topTier' | 'battles' | 'level' | 'psr' | 'activity' | 'age' | 'language' | 'mic' | 'discord'

export interface ClanTextRequirement {
  kind: ClanRequirementKind
  /** The least value: K/D, BR, vehicle rank 1–8, battles, account level, PSR or activity points, age; null for a flag. */
  min: number | null
  /** The branch a K/D, BR or vehicle rank is asked in; null — either, or not said. */
  branch: 'air' | 'ground' | null
  /** ISO 639-1 code of the language asked for. */
  language: string | null
  /** The sentence it was read from, as the squadron wrote it. */
  source: string
}

export interface ClanAbout {
  /** First seen first, one per address; Discord before the rest. */
  links: ClanLink[]
  /** Where each link stands: [field, start, end, index in links], UTF-16 offsets into the field's text. */
  spans: [ClanTextField, number, number, number][]
  requirements: ClanTextRequirement[]
}

const MAX_LINKS = 8
const MAX_REQUIREMENTS = 12
const MAX_SOURCE_LENGTH = 160

/** Fullwidth ASCII ("Ｄｉｓｃｏｒｄ．ｇｇ") and the ideographic space to plain ones: one UTF-16 unit each, so offsets hold. */
function foldWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E\u3000]/g, (char) =>
    char === '\u3000' ? ' ' : String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}

// --- Links ----------------------------------------------------------------------------------------

/**
 * An http(s) address anywhere ("Discord.https://…", the "https;//" typo too), or a bare host not
 * glued to a word or an e-mail; the path is ASCII up to the first space, bracket or non-URL symbol
 * (box-drawing tag decorations end it).
 */
const LINK = /(?:(https?)[:;]\/\/|(?<![\p{L}\p{N}@._/\\-]))((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])(\/[\w\-.~%!$&*+,;=:@/?#]*)?/giu

/** A bare host needs "www." or a path, and one of these zones: "cz.sk" or "Clan.Auto" is not a link. */
const BARE_ZONES = new Set([
  'com', 'net', 'org', 'gg', 'me', 'io', 'tv', 'ru', 'su', 'ua', 'by', 'kz', 'eu', 'de', 'at', 'ch', 'pl',
  'cz', 'sk', 'fr', 'es', 'pt', 'br', 'it', 'nl', 'be', 'se', 'no', 'fi', 'dk', 'uk', 'us', 'ca', 'au', 'jp',
  'cn', 'kr', 'tw', 'hk', 'info', 'xyz', 'app', 'link', 'site', 'online', 'top', 'club', 'gl', 'ly', 'co',
  'cc', 'to', 'fm', 'live', 'gs',
])

const LINK_KINDS: [ClanLinkKind, RegExp][] = [
  ['discord', /^(?:discord\.(?:gg|com|me)|discordapp\.com|dsc\.gg)$/],
  ['telegram', /^(?:t|telegram)\.me$/],
  ['youtube', /^(?:(?:m\.)?youtube\.com|youtu\.be)$/],
  ['twitch', /^(?:m\.)?twitch\.tv$/],
  ['vk', /^(?:m\.)?vk\.(?:com|ru)$/],
  ['tiktok', /^(?:vm\.)?tiktok\.com$/],
  ['facebook', /^(?:(?:m\.)?facebook\.com|fb\.(?:com|me))$/],
  ['steam', /^(?:steamcommunity\.com|store\.steampowered\.com|s\.team)$/],
]

function linkKind(host: string): ClanLinkKind {
  return LINK_KINDS.find(([, pattern]) => pattern.test(host))?.[0] ?? 'web'
}

interface FoundLink {
  link: ClanLink
  key: string
  start: number
  end: number
}

function findLinks(folded: string): FoundLink[] {
  const found: FoundLink[] = []
  const pattern = new RegExp(LINK.source, LINK.flags)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(folded)) !== null) {
    const scheme = match[1]?.toLowerCase()
    const hostText = match[2]!
    const host = hostText.toLowerCase()
    // Trailing punctuation belongs to the sentence: "vk.com/name.", "twitch.tv/name!"
    const path = (match[3] ?? '').replace(/[.,;:!?*'-]+$/, '')
    const zone = host.slice(host.lastIndexOf('.') + 1)
    const bareOk = host.startsWith('www.') || (path.length > 1 && BARE_ZONES.has(zone))
    if (scheme === undefined && !bareOk) {
      // "Discord.https://…": a rejected bare host must not swallow the address behind it.
      pattern.lastIndex = match.index + 1
      continue
    }
    const start = match.index
    const end = match.index + match[0].length - ((match[3] ?? '').length - path.length)
    const plainHost = host.replace(/^www\./, '')
    const trimmedPath = path.replace(/\/+$/, '')
    found.push({
      link: {
        kind: linkKind(plainHost),
        url: `${scheme ?? 'https'}://${host}${path}`,
        label: `${plainHost}${trimmedPath}`,
      },
      // Vanity invites ignore case: "discord.gg/Team" and "discord.gg/team" are one door.
      key: `${plainHost}${trimmedPath}`.toLowerCase(),
      start,
      end,
    })
  }
  return found
}

// --- Requirements: words ---------------------------------------------------------------------------

// JS \b knows only ASCII: these mark word edges in any script.
const W0 = '(?<![\\p{L}\\p{N}])'
const W1 = '(?![\\p{L}])'

function anyOf(source: string): RegExp {
  return new RegExp(source, 'giu')
}

type AnchorKind = 'kd' | 'br' | 'rank' | 'battles' | 'level' | 'psr' | 'points' | 'activity' | 'age'

/**
 * Keywords a figure stands beside, by kind. K/D comes as K/D, K/S, KPS, KD, К/Д, КД, К/В (kills per
 * sortie), К/Б, KR or KB (Chinese, before a comparison); ages, battles and points also as the unit
 * after the figure ("16 лет", "500 боёв", "750 очков").
 */
const ANCHORS: [AnchorKind, RegExp][] = [
  ['kd', anyOf(`${W0}(?:k\\s?[/\\\\|.]\\s?[ds]|kdr?|k\\.d\\.?|kps|к\\s?[/\\\\.]\\s?[дбвс]|кд|кдр|киллы?\\s?/\\s?(?:выезд|смерт)\\S*|kills?\\s?/\\s?(?:deaths?|spawns?))${W1}|(?:kr|kb|kd)(?=\\s?(?:>|≥|大于|高于))`)],
  ['br', anyOf(`${W0}(?:br|бр|battle\\s?rating|боев\\S*\\s+рейтинг\\S*)${W1}`)],
  ['rank', anyOf(`${W0}(?:ранг\\S*|rank|rango|tier|era|erę|erze|razin\\S*|úrovn\\S*|ступен\\S*)${W1}|[级級](?:及以上)?(?:的)?(?:陆战|空战|陆|空)?载具`)],
  ['battles', anyOf(`${W0}(?:бо[её]в|battles?|bitew|bitw|schlachten|gefechte|csat\\S*|batallas|batalhas|partidas)${W1}|局`)],
  ['level', anyOf(`${W0}(?:lvl|level|уровень|уровня|ур\\.|lv|stufe|spielerstufe|niveau|nivel|poziom\\S*)(?=[\\s.:]|\\d|$)|等[级級]|[级級](?!(?:及以上)?(?:的)?(?:陆战|空战|陆|空)?载具)`)],
  ['psr', anyOf(`${W0}(?:лпр|пкр|psr|личн\\S*\\s+полков\\S*\\s+рейтинг\\S*|полков\\S*\\s+(?:рейтинг|очк)\\S*|очк\\S*\\s+рейтинг\\S*|очок\\s+рейтинг\\S*|personal\\s+squadron\\s+rating|squadron\\s+(?:rating|points?)|sqb\\s+points?|clasificaci\\S+\\s+personal)${W1}|[赛賽]季分[数數]`)],
  ['points', anyOf(`${W0}(?:очк\\S*|очок|points?|pts|pkt|punkte?|puntos|ptos|pontos|pontuação)${W1}|(?<=\\d\\s?)[分点點]`)],
  ['activity', anyOf(`${W0}(?:активн\\S*|актив\\S*|activity|activit\\S*|aktywn\\S*|aktywno\\S*|aktivit\\S*|actividad|atividade)${W1}|[活][跃躍]度?|月?[贡貢][献獻]`)],
  ['age', anyOf(`${W0}(?:возраст\\S*|вік|wiek|alter|mindestalter|âge|age|ages|edad|idade|vek|ηλικία|mayores\\s+de|старше|older|über|ü)${W1}`)],
]

/** A unit right after an age: "16 лет", "16y", "18ans", "15 anos"; not "год" (Ukrainian hours: "через 24 год"). */
const AGE_UNIT = /^\s?(?:y|yo|yrs?|years?|лет|jahre?n?|ans|lat|años|anos|anni|godin\S*|let|岁|歲)(?![\p{L}])/iu

/** Air and ground words: game modes (АРБ, GRB, ПРБ), branches, vehicles, in the languages seen. */
const AIR = anyOf(`${W0}(?:авиа\\S*|лётк\\S*|летк\\S*|лётчик\\S*|летчик\\S*|самол\\S*|арб|прб|повітр\\S*|авіац\\S*|arb|air|luft\\S*|lotnict\\S*|samolot\\S*|avion\\S*|aviones|aviação|aviacao|aéreo|aereo|aire|pilots?|planes?|jets?)${W1}|空战?|战斗机|空历`)
const GROUND = anyOf(`${W0}(?:танк\\S*|наземк\\S*|наземн\\S*|техник\\S*(?=\\s+и\\s+авиац)|трб|grb|ground\\S*|tanks?|panzer\\S*|boden|czołg\\S*|tanques?|chars|tierra|terrestre)${W1}|陆战?|坦克|陆历`)

/** "or" between alternatives: "K/D 1.5+ in GRB or 1.2+ in ARB", "кд ТРБ 1.0 или АРБ 0.8". */
const ALTERNATIVE = /^(?:[\s+]|в|in|на|na|en|em|im|at|or|или|або|lub|oder|ou|o|ή|и|and|&|\/|y|e|от|from|≥|>=|>|~|-|—|–)*$/iu

/** Words that make a figure a threshold wherever it stands in its clause. */
const MARKER = anyOf(`[+≥>~]|${W0}(?:от|from|min|min\\.|minimum|минимум|минимальн\\S*|мінімум|мінімальн\\S*|не\\s+ниже|не\\s+менее|не\\s+меньше|at\\s?least|more\\s+than|or\\s+(?:higher|more|above)|above|mindestens|mind\\.|ab|über|mínim\\S*|minim\\S*|conajmniej|co\\s+najmniej|najmniej|od|lub\\s+wyższ\\S*|i\\s+wyżej)${W1}|大于|高于|以上|达到|達到?|不低于|至少|最低|超过|须`)

/** A sentence about joining: its figures count without a "+" or "min". */
const CONTEXT = anyOf(`(?:требовани|требуется|требуем|услови[ея]|необходим|обязател|минимальн|минимум|нужно|нужен|нужна|принимаем|при[её]м|вступлени|для\\s+вступ|рассматрива|набира|набор|вимог|умов[иа]|необхідн|обов|мінімальн|мінімум|приймаємо|прийом|вступ|requirement|requir|${W0}req${W1}|must|minimum|${W0}min${W1}|at\\s?least|accept|apply|recruit|looking\\s+for|seeking|anforderung|voraussetzung|aufnahmebeding|mindest|pflicht|benötig|erforderlich|bewerb|wymaga|minimaln|conajmniej|co\\s+najmniej|rekrut|szukamy|prérequis|condition|requis|exig|obligatoire|recrut|requisit|mínim|obligatori|obrigat|necesari|reclut|προαπαιτ|要求|最低|至少|需要|必须|入队|požadav|minimáln|uvjet|követelmény)`)

/** Prizes and perks: "+1520 puntos … + 1000 de actividad" there is what members win, not what they need. */
const PRIZES = anyOf(`(?:premio|prize|reward|награ|приз|nagrod|belohn|récompense|recompensa|福利|奖|抽)`)

/** Discord words, and the words that make it a condition rather than a contact. */
const DISCORD = anyOf(`(?:discord|дискорд\\S*|діскорд\\S*|${W0}(?:дс|ds|dc)${W1})`)
const DISCORD_DUTY = anyOf(`(?:обязат|обязан|только|строго|через|после|собеседов|заявк|при[её]м|приним|примут|вступ|без\\s+дискорд|виключно|обов['’ʼ]?язк|прийом|вимог|required|requirement|${W0}req${W1}|must|mandatory|apply|applying|application|accepted|acceptance|(?:recruit|rekrut|recrut|reclut)\\S*\\s+(?:via|through|przez|par|por|on|in)${W1}|wymag|obowiąz|aplikac|przez|pflicht|bewerb|obligat|obrigat|requis|requisit|présence|presenti|δεκτ|αιτήσ|审核|必须)`)
const NEGATION = anyOf(`(?:не\\s+обязат|необязат|не\\s+нужен|не\\s+требуется|not\\s+required|no\\s+need|optional|nicht\\s+pflicht|nie\\s+wymag|no\\s+obligatori|pas\\s+obligatoire|без\\s+микрофона)`)

const MIC = anyOf(`${W0}(?:микрофон\\S*|mics?|microphone|mikrofon\\S*|micrófono|microfono|microfone|micro|voip)${W1}|麦克风|开麦`)
const TOP_TIER = anyOf(`${W0}(?:top[\\s-]?tier|топ[\\s-]?техник\\S*|топов\\S*\\s+техник\\S*)${W1}|顶级`)

/** Languages asked for, when a speaking word, "only" or "language" stands beside them. */
const LANGUAGES: [string, RegExp][] = [
  ['en', anyOf(`${W0}(?:english|англ\\S*|inglés|ingles|anglais|englisch|angielsk\\S*|inglês)${W1}`)],
  ['ru', anyOf(`${W0}(?:russian|russhian|русск\\S*|русскоговорящ\\S*|rosyjsk\\S*)${W1}`)],
  ['uk', anyOf(`${W0}(?:ukrainian|українськ\\S*|україномовн\\S*)${W1}`)],
  ['de', anyOf(`${W0}(?:deutsch\\S*|german|немецк\\S*)${W1}`)],
  ['fr', anyOf(`${W0}(?:francophone|français|francais|french|французск\\S*)${W1}`)],
  ['pt', anyOf(`${W0}(?:português|portugues|portuguese)${W1}`)],
  ['es', anyOf(`${W0}(?:español|espanol|spanish|castellano)${W1}`)],
  ['it', anyOf(`${W0}(?:italiano|italian)${W1}`)],
  ['pl', anyOf(`${W0}(?:polsk\\S*|polish)${W1}`)],
  ['hr', anyOf(`${W0}(?:croatian|hrvatsk\\S*)${W1}`)],
  ['fi', anyOf(`${W0}(?:finnish|suomi|suomen)${W1}`)],
]
const SPEAKING = anyOf(`(?:speak|spoken|know|fluent|basic|decent|understandable|говорящ|говорить|знание|язык|language|langue|idioma|língua|sprache|sprechen|mówi|falar|hablar|parler|francophone|русскоговорящ|україномовн)`)

// --- Requirements: figures -------------------------------------------------------------------------

interface Figure {
  value: number
  start: number
  end: number
  /** A "+" right after it ("0.9+", "16 +") or before it ("+18"). */
  plus: boolean
  integer: boolean
}

/**
 * A figure not glued to a Latin, Cyrillic or Greek word ("x100x", "Т-34", "топ-1"), a tag, a time
 * ("17:00") or a date ("28.09.2026"), nor a list number ("2.等级"); Chinese text runs straight into
 * figures ("KR大于1.1"). "1,000" and "1 000" are thousands, "0,8" a decimal.
 */
const FIGURE = /(?<![\p{sc=Latin}\p{sc=Cyrillic}\p{sc=Greek}\p{N}#№]|\d[.,:]|[\p{sc=Latin}\p{sc=Cyrillic}]-)(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d+(?:[.,]\d{1,2})?)(?!\d|[.,:]\d|\s?%|[.)]\p{sc=Han})/gu
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 }
const ROMAN_FIGURE = /(?<![\p{L}\p{N}])(VIII|VII|VI|IV|V|III|II|I)(?![\p{L}\p{N}])/gu
/** "1. K/D ~1.0", "> 1.2. Минимальное…", "2) …": list numbers at a line's start. */
const LIST_NUMBER = /^[\s>*•·-]*\d+(?:\.\d+)?[.)]\s/u

function readFigures(sentence: string, lineStart: boolean): Figure[] {
  const figures: Figure[] = []
  const list = lineStart ? LIST_NUMBER.exec(sentence) : null
  for (const match of sentence.matchAll(FIGURE)) {
    const start = match.index
    if (list !== null && start < list[0].length) continue
    const text = match[1]!
    const thousands = /^\d{1,3}(?:[ \u00a0.,]\d{3})+$/.test(text)
    const value = thousands ? Number(text.replace(/[ \u00a0.,]/g, '')) : Number(text.replace(',', '.'))
    const end = start + text.length
    const plus = /^\s?\+/.test(sentence.slice(end, end + 2)) || sentence[start - 1] === '+'
    figures.push({ value, start, end, plus, integer: !/[.,]/.test(text) || thousands })
  }
  return figures
}

/** Romans count only as vehicle ranks: "Rank VII", "VII ранг". */
function readRomans(sentence: string): Figure[] {
  return [...sentence.matchAll(ROMAN_FIGURE)].map((match) => {
    const end = match.index + match[0].length
    return { value: ROMAN[match[1]!]!, start: match.index, end, plus: sentence[end] === '+', integer: true }
  })
}

function fits(kind: AnchorKind, figure: Figure, roman: boolean): boolean {
  const value = figure.value
  if (roman) return kind === 'rank'
  switch (kind) {
    case 'kd': return value >= 0.2 && value <= 5
    case 'br': return value >= 1 && value <= 14.7
    case 'rank': return figure.integer && value >= 1 && value <= 8
    case 'battles': return figure.integer && value >= 10 && value <= 100_000
    case 'level': return figure.integer && value >= 1 && value <= 150
    case 'psr': return figure.integer && value >= 20 && value <= 5_000
    case 'points': return figure.integer && value >= 20 && value <= 100_000
    case 'activity': return figure.integer && value >= 20 && value <= 100_000
    case 'age': return figure.integer && value >= 13 && value <= 25
  }
}

// --- Requirements: sentences -----------------------------------------------------------------------

/** Chinese units that follow their figure: level "级", battles "局", points "分", vehicle rank "级…载具". */
const SUFFIX_UNIT = /^(?:[级級局分点點]|[级級].*载具)$/u

/** Clause breaks: a comma not inside a figure, ";", bars, bullets, box-drawing decorations. */
const CLAUSE_BREAK = /,(?!\d)|(?<!\d),|[;|•◊▪●■►▶☛☞✦★☆✪♦→⇒、]|[\u2500-\u259F]/gu

interface Anchor {
  kind: AnchorKind
  start: number
  end: number
}

function findAnchors(sentence: string): Anchor[] {
  const anchors: Anchor[] = []
  for (const [kind, pattern] of ANCHORS) {
    for (const match of sentence.matchAll(pattern)) {
      if (match[0].length === 0) continue
      anchors.push({ kind, start: match.index, end: match.index + match[0].length })
    }
  }
  anchors.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))
  // Overlaps: the longer keyword wins ("полковых очков" over "очков").
  const kept: Anchor[] = []
  for (const anchor of anchors) {
    if (kept.some((other) => anchor.start < other.end && other.start < anchor.end)) continue
    kept.push(anchor)
  }
  return kept.sort((left, right) => left.start - right.start)
}

/** Points with no kind of their own: activity when the sentence speaks of activity, PSR when of the season. */
function pointsKind(sentence: string): 'activity' | 'psr' | null {
  if (/(?:актив|activ|aktyw|aktiv|活[跃躍]|[贡貢][献獻])/iu.test(sentence)) return 'activity'
  if (/(?:сезон|season|(?<![\p{L}])eos(?![\p{L}])|sqb|полков|squadron|psr|лпр|рейтинг|rating|personal|[赛賽]季)/iu.test(sentence)) return 'psr'
  return null
}

function branchOf(text: string): 'air' | 'ground' | null | undefined {
  const air = new RegExp(AIR.source, AIR.flags).test(text)
  const ground = new RegExp(GROUND.source, GROUND.flags).test(text)
  if (air && ground) return null
  if (air) return 'air'
  if (ground) return 'ground'
  return undefined
}

interface Claim {
  kind: Exclude<AnchorKind, 'points'>
  figure: Figure
}

/**
 * Figures of one sentence to their keywords: each keyword takes the closest free figure in its
 * clause with no other figure or keyword between (after it within 32 characters, before it within
 * 12; a tie goes after: "rank 7" over the "3" of "3 rank 7"), then alternatives chained by "or"
 * ("K/D 1.5+ in GRB or 1.2+ in ARB").
 */
function claimFigures(sentence: string, anchors: Anchor[], figures: Figure[], romans: Figure[]): Claim[] {
  const breaks = [...sentence.matchAll(CLAUSE_BREAK)].map((match) => match.index)
  const sameClause = (from: number, to: number): boolean => !breaks.some((at) => at >= from && at < to)
  const claimed = new Set<Figure>()
  const claims: Claim[] = []
  const all = [...figures, ...romans].sort((left, right) => left.start - right.start)
  const between = (from: number, to: number): boolean =>
    all.some((figure) => figure.start >= from && figure.end <= to) || anchors.some((anchor) => anchor.start >= from && anchor.end <= to)

  // Specific keywords first: "2000 activity point or 200 squadron rating" leaves "point" nothing.
  const order = [...anchors].sort((left, right) => Number(left.kind === 'points') - Number(right.kind === 'points') || left.start - right.start)
  for (const anchor of order) {
    const resolved = anchor.kind === 'points' ? pointsKind(sentence) : anchor.kind
    if (resolved === null) continue
    const usable = (figure: Figure): boolean =>
      !claimed.has(figure) && fits(anchor.kind, figure, romans.includes(figure)) && (anchor.kind !== 'points' || fits(resolved, figure, false))
    const after = all.find((figure) => figure.start >= anchor.end && usable(figure))
    const before = [...all].reverse().find((figure) => figure.end <= anchor.start && usable(figure))
    // A unit after its figure ("45级", "750局") takes no figure behind it.
    const unit = SUFFIX_UNIT.test(sentence.slice(anchor.start, anchor.end))
    const afterGap = !unit && after && after.start - anchor.end <= 32 && sameClause(anchor.end, after.start) && !between(anchor.end, after.start)
      ? after.start - anchor.end : null
    const beforeGap = before && anchor.start - before.end <= 12 && sameClause(before.end, anchor.start) && !between(before.end, anchor.start)
      ? anchor.start - before.end : null
    let figure: Figure | null = null
    if (afterGap !== null && (beforeGap === null || afterGap <= beforeGap)) figure = after!
    else if (beforeGap !== null) figure = before!
    if (figure === null) continue
    claimed.add(figure)
    claims.push({ kind: resolved, figure })
    if (resolved !== 'kd' && resolved !== 'br' && resolved !== 'rank') continue
    // Alternatives on either side, joined only by "or", branch words and markers.
    const joined = (from: Figure, to: Figure): boolean => ALTERNATIVE.test(stripBranches(sentence.slice(from.end, to.start)))
    const index = all.indexOf(figure)
    for (const step of [1, -1]) {
      let last = figure
      for (let at = index + step; at >= 0 && at < all.length; at += step) {
        const next = all[at]!
        if (claimed.has(next) || !fits(anchor.kind, next, romans.includes(next))) break
        if (!(step === 1 ? joined(last, next) : joined(next, last))) break
        claimed.add(next)
        claims.push({ kind: resolved, figure: next })
        last = next
      }
    }
  }
  return claims.sort((left, right) => left.figure.start - right.figure.start)
}

/** Text between two alternatives without branch words, mode names and decorations ("▮1.1 GRB ή ▭0.9"). */
function stripBranches(text: string): string {
  return text.replace(new RegExp(AIR.source, AIR.flags), ' ').replace(new RegExp(GROUND.source, GROUND.flags), ' ')
    .replace(/(?:рб|rb)(?![\p{L}])/giu, ' ')
    .replace(/\p{So}/gu, ' ')
}

/**
 * The branch of each figure: when its clause names a branch before the first figure ("ТРБ — КД
 * 1.3+ ПРБ — КД 1.1+", "кд в танках от 0.9"), the words before each figure; otherwise the words
 * after it ("1.5+ K/S in GRB", "1,1 K/S AIR"), never past a clause break. Both branches, or none —
 * either.
 */
function branches(sentence: string, figures: Figure[]): Map<Figure, 'air' | 'ground' | null> {
  const sorted = [...figures].sort((left, right) => left.start - right.start)
  const result = new Map<Figure, 'air' | 'ground' | null>()
  if (sorted.length === 0) return result
  const breaks = [...sentence.matchAll(CLAUSE_BREAK)].map((match) => match.index)
  const clauseStart = (at: number): number => Math.max(0, ...breaks.filter((point) => point < at).map((point) => point + 1))
  const clauseEnd = (at: number): number => Math.min(sentence.length, ...breaks.filter((point) => point >= at))
  const leading = branchOf(sentence.slice(clauseStart(sorted[0]!.start), sorted[0]!.start)) !== undefined
  sorted.forEach((figure, index) => {
    const segment = leading
      ? sentence.slice(Math.max(clauseStart(figure.start), index === 0 ? 0 : sorted[index - 1]!.end), figure.start)
      : sentence.slice(figure.end, Math.min(clauseEnd(figure.end), index + 1 < sorted.length ? sorted[index + 1]!.start : sentence.length))
    result.set(figure, branchOf(segment) ?? null)
  })
  return result
}

interface Sentence {
  text: string
  /** Inside a "Requirements:" block or a sentence about joining. */
  context: boolean
  /** Its first character opens a line: list numbers count there. */
  lineStart: boolean
}

/**
 * A heading line ("Requirements to join:", "⚔ Требования:", "WYMAGANIA DYWIZJONU"): no figures, a
 * requirements word, a colon at the end or the word first. The lines below it are requirements.
 */
function isHeading(line: string): boolean {
  const words = line.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || test(FIGURE, line) || !test(CONTEXT, line)) return false
  if (/:[^\p{L}\p{N}]*$/u.test(line)) return words.length <= 8
  return words.length <= 6 && test(CONTEXT, words[0]!)
}

function sentences(folded: string): Sentence[] {
  const result: Sentence[] = []
  // The leaderboard keeps some line breaks as a literal "\n".
  const lines = folded.split(/\r?\n|\\n/)
  let block = 0
  for (const line of lines) {
    if (line.trim() === '') {
      block = 0
      continue
    }
    const heading = isHeading(line)
    const lineContext = test(CONTEXT, line)
    // Sentence ends: "!", "?", Chinese stops, "." after a word and before a word (not "0.9", "К.Д", "min. 0,5").
    const parts = line.split(/(?<=[!?。！？])|(?<=[^\d\s.]{2}\.)\s+(?=[^\d\s])/u)
    parts.forEach((part, index) => {
      if (part.trim() === '') return
      result.push({ text: part, context: block > 0 || lineContext, lineStart: index === 0 })
    })
    block = heading ? 8 : Math.max(0, block - 1)
  }
  return result
}

function trimSource(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SOURCE_LENGTH ? `${flat.slice(0, MAX_SOURCE_LENGTH - 1)}…` : flat
}

function test(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags).test(text)
}

function readRequirements(sentence: Sentence): ClanTextRequirement[] {
  const { text, context } = sentence
  const found: ClanTextRequirement[] = []
  const source = trimSource(text)
  const anchors = findAnchors(text)
  const figures = readFigures(text, sentence.lineStart)
  const romans = anchors.some((anchor) => anchor.kind === 'rank') ? readRomans(text) : []
  const claims = claimFigures(text, anchors, figures, romans)
  const claimedFigures = new Set(claims.map((claim) => claim.figure))
  const sides = branches(text, claims.filter((claim) => claim.kind === 'kd' || claim.kind === 'br' || claim.kind === 'rank').map((claim) => claim.figure))
  const breaks = [...text.matchAll(CLAUSE_BREAK)].map((match) => match.index)
  const clauseOf = (figure: Figure): string => {
    const from = Math.max(0, ...breaks.filter((at) => at < figure.start).map((at) => at + 1))
    const to = Math.min(text.length, ...breaks.filter((at) => at >= figure.end))
    return text.slice(from, to)
  }
  const prizes = test(PRIZES, text)
  for (const claim of claims) {
    if (prizes) break
    const marked = claim.figure.plus || test(MARKER, clauseOf(claim.figure))
    if (!marked && !context) continue
    const branch = claim.kind === 'kd' || claim.kind === 'br' || claim.kind === 'rank' ? sides.get(claim.figure) ?? null : null
    found.push({ kind: claim.kind, min: claim.figure.value, branch, language: null, source })
  }
  // A bare "16+" or "+18": an age, unless a keyword took it or it ranks a place ("top 10+").
  for (const figure of figures) {
    if (claimedFigures.has(figure) || !figure.plus || !fits('age', figure, false)) continue
    if (/(?:top|топ|#)\s?$/iu.test(text.slice(Math.max(0, figure.start - 5), figure.start))) continue
    found.push({ kind: 'age', min: figure.value, branch: null, language: null, source })
  }
  // "16 лет", "16y": the unit after an unclaimed figure.
  for (const figure of figures) {
    if (claimedFigures.has(figure) || !fits('age', figure, false) || !AGE_UNIT.test(text.slice(figure.end))) continue
    if (found.some((item) => item.kind === 'age')) continue
    if (!context && !test(MARKER, clauseOf(figure)) && !/(?:возраст|age|alter|wiek|edad|idade|old|older|старше|mayores)/iu.test(text)) continue
    found.push({ kind: 'age', min: figure.value, branch: null, language: null, source })
  }
  const negated = test(NEGATION, text)
  if (!negated && test(DISCORD, text) && (test(DISCORD_DUTY, text) || context)) {
    // In a requirements block a bare "• Discord" counts; elsewhere it must be a condition.
    if (test(DISCORD_DUTY, text) || isListItem(text)) found.push(flag('discord', source))
  }
  if (!negated && test(MIC, text) && (context || /(?:need|required|must|working|have|has|with|there\s+is|наличи|обязат|нужен|есть|funcional|fonctionnel|wymag|benötig|pflicht|mit|con|com|avec)/iu.test(text))) {
    found.push(flag('mic', source))
  }
  if (test(TOP_TIER, text) && context) found.push(flag('topTier', source))
  for (const [code, pattern] of LANGUAGES) {
    if (!test(pattern, text) || !test(SPEAKING, text)) continue
    found.push({ kind: 'language', min: null, branch: null, language: code, source })
  }
  return found
}

/** "• Discord", "Req: Discord, mic": a short item of a requirements list. */
function isListItem(text: string): boolean {
  return text.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).length <= 6
}

function flag(kind: 'discord' | 'mic' | 'topTier', source: string): ClanTextRequirement {
  return { kind, min: null, branch: null, language: null, source }
}

const REQUIREMENT_ORDER: ClanRequirementKind[] = [
  'kd', 'br', 'rank', 'topTier', 'battles', 'level', 'psr', 'activity', 'age', 'language', 'mic', 'discord',
]

/** Links and join requirements from a squadron's texts; null — nothing found. */
export function readClanAbout(texts: Partial<Record<ClanTextField, string | null>>): ClanAbout | null {
  const found: FoundLink[] = []
  const spans: [ClanTextField, FoundLink][] = []
  const requirements: ClanTextRequirement[] = []
  for (const field of ['slogan', 'description', 'announcement'] as const) {
    const text = texts[field]
    if (!text) continue
    const folded = foldWidth(text)
    for (const link of findLinks(folded)) {
      spans.push([field, link])
      if (!found.some((other) => other.key === link.key)) found.push(link)
    }
    for (const sentence of sentences(folded)) requirements.push(...readRequirements(sentence))
  }
  // Discord first: the squadron's main door; then in the order written.
  const ordered = [...found.filter((item) => item.link.kind === 'discord'), ...found.filter((item) => item.link.kind !== 'discord')]
    .slice(0, MAX_LINKS)
  const links = ordered.map((item) => item.link)
  const linkSpans: ClanAbout['spans'] = []
  for (const [field, item] of spans) {
    const index = ordered.findIndex((other) => other.key === item.key)
    if (index !== -1) linkSpans.push([field, item.start, item.end, index])
  }
  // One per kind and branch (and language), the first written; a K/D "for either" stays beside per-branch ones.
  const unique: ClanTextRequirement[] = []
  for (const item of requirements) {
    if (unique.some((other) => other.kind === item.kind && other.branch === item.branch && other.language === item.language)) continue
    unique.push(item)
  }
  unique.sort((left, right) => REQUIREMENT_ORDER.indexOf(left.kind) - REQUIREMENT_ORDER.indexOf(right.kind))
  const kept = unique.slice(0, MAX_REQUIREMENTS)
  return links.length === 0 && kept.length === 0 ? null : { links, spans: linkSpans, requirements: kept }
}
