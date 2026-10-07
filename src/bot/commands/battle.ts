import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ButtonInteraction,
} from 'discord.js'
import type { Command } from '../types.js'
import { heatmapQualityRow, heatmapScaleForUpload, type HeatmapScale } from '../battle-media-controls.js'
import {
  canAdmitWinnerUpdate,
  shouldQueueWinnerUpdate,
} from '../battle-post-policy.js'
import {
  getBattlePostSummary,
  getClanSeasonContext,
  getItemByExternalId,
  getLatestItems,
  hasBattle,
  hasBattleChat,
  type StoredItem,
} from '../../db/index.js'
import {
  buildBattleHeatmap2x,
  buildBattleMediaKind,
  cachedBattleHeatmap2x,
  cachedBattleMedia,
  cachedBattleMeta,
  type BattleMediaKind,
} from '../../wrpl/battle-media.js'
import { isBattleHeatmapKind } from '../../wrpl/battle-media-kind.js'
import { reconstructBattleSummary } from '../../wrpl/battle-data.js'
import { battlePsr, type BattlePsr } from '../../wrpl/battle-psr.js'
import { fetchRatingsForTags, lookupUnknownClanTags, unknownClanTags } from '../../wrpl/clan-info.js'
import { applyRealNames, fakeNamesFromItem, fetchReplayResults, normalizeSessionId, realNamesFromItem, replayPartUrls, type ReplayResults, type WrplHeader } from '../../wrpl/replay.js'
import { psrLabel, renderBattleImage, stripClanDecorators, summarizeTeams } from '../../wrpl/render-battle.js'
import { ensureVehicleDict } from '../../wrpl/vehicles.js'
import type { WorkerPriority } from '../../workers/pool.js'

/**
 * /battle [id] — картинка с таблицей результатов боя из реплея.
 * Без id берётся последний собранный парсером реплей. Скачивание частей
 * и рендер занимают пару секунд, поэтому сначала deferReply.
 *
 * Под сообщением — кнопки как у Boris Stats: ссылка на реплей, battle log,
 * хитмапы наземки/авиации и чат матча. Материалы собираются из пакетного
 * потока реплея при первом нажатии (все части, ~20 МБ) и кэшируются в
 * data/battles/ — дальше кнопки отвечают мгновенно.
 */

interface ReplayItemData {
  missionName?: string
  gameMode?: string
  gameVersion?: string
  replayParts?: string[] | null
  url?: string
  partsCount?: number
  /** Списки игроков сайта с userId/name/fakeName (см. realNamesFromItem) */
  players?: unknown
}

export const battle: Command = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Результаты боя из реплея War Thunder (картинкой)')
    .addStringOption((o) =>
      o.setName('id').setDescription('sessionId боя из /api/items (по умолчанию — последний бой)'),
    ),
  async execute(interaction) {
    await interaction.deferReply()

    const rawId = interaction.options.getString('id')
    const item = rawId
      ? getItemByExternalId('wt-replays', normalizeSessionId(rawId.trim()))
      : getLatestItems(1, 'wt-replays')[0]
    if (!item) {
      await interaction.editReply(
        rawId ? `Реплей \`${rawId}\` не найден в базе.` : 'В базе пока нет реплеев — парсер ещё не принёс данные.',
      )
      return
    }

    const post = await renderBattlePost(item)
    if (!post) {
      await interaction.editReply('У этой записи нет ссылок на файлы реплея.')
      return
    }
    await interaction.editReply(post.payload)
    queueBattlePostUpdates(post, (p) => interaction.editReply({ ...p, attachments: [] }))
  },
}

export interface BattlePostPayload {
  content: string
  files: AttachmentBuilder[]
  components: ActionRowBuilder<ButtonBuilder>[]
}

export interface BattlePost {
  payload: BattlePostPayload
  sessionIdHex: string
  /** null — durable summary уже доступен; иначе ожидание ingest вернёт обновлённый payload. */
  buildWinnerPayload: (() => Promise<BattlePostPayload | null>) | null
  /** Reads the squadron pages and redraws the PSR column; null — the post has read them already. */
  buildRatingsPayload: (() => Promise<BattlePostPayload | null>) | null
  /**
   * Runs last: looks up squadron tags missing from the clans dictionary (up
   * to a full leaderboard crawl) and redraws the post with their PSR; null —
   * every tag has a name.
   */
  buildLookupPayload: (() => Promise<BattlePostPayload | null>) | null
  /** Консервативная оценка retained state замыканий обновления сообщения. */
  updateBytes: number
}

/**
 * The battle results message for a stored item: the image, the teams text
 * and the media buttons. Shared by /battle and the announcer. null — the item
 * has no replay part links.
 */
export async function renderBattlePost(
  item: StoredItem,
  priority: WorkerPriority = 'interactive',
): Promise<BattlePost | null> {
  const data = item.data as ReplayItemData
  const sessionId = item.externalId
  const realNames = realNamesFromItem(data)

  // A parsed battle comes from the database without downloading the replay.
  // Otherwise the results-BLK of the last part (parts are needed only here).
  let header: WrplHeader
  let results: ReplayResults
  let parts: string[] = []
  const recon = reconstructBattleSummary(sessionId)
  if (recon) {
    header = recon.header
    results = recon.results // stored nicknames are already the real ones
  } else {
    parts = replayPartUrls(data)
    if (parts.length === 0) return null
    const fetched = await fetchReplayResults(parts, priority)
    header = fetched.header
    results = fetched.results
    // The anonymizer replaces nicknames in the replay: restore the site's ones
    applyRealNames(results, realNames)
  }
  const dict = await ensureVehicleDict(priority)
  let teams = summarizeTeams(results, dict)
  const missionName = data.missionName ?? item.title
  // Unknown until the first build: results-BLK lists the lineups, not the
  // units that actually spawned.
  let hasAir = true

  // Interactive /battle reads the squadron pages first. A background
  // announcement draws dashes until a separate update reads them.
  const clanTags = teams.flatMap((t) => (t.rawTag ? [t.rawTag] : []))
  // A squadron that began playing after the last full leaderboard crawl has
  // no name for its claninfo page yet: the last update looks it up and redraws.
  const unknownTags = unknownClanTags(clanTags)
  let pagesRead = priority !== 'background'
  if (pagesRead) await fetchRatingsForTags(clanTags)
  // The PSR column (battle-psr.ts), recomputed on every draw: the winner, the
  // stored rows and the page readings change between draws.
  let shownPsr = new Map<string, BattlePsr>()
  const readPsr = (winnerTeam: number | null): Map<string, BattlePsr> =>
    pagesRead
      ? battlePsr({ sessionId, startTime: header.startTime, duration: results.timePlayed, players: results.players, winnerTeam })
      : new Map()

  // The text next to the image: Match ID, then each team's clan, composition and players
  const buildContent = (): string => {
    const text =
      `Match ID: \`${header.sessionId}\`${seasonMaxBrSuffix(getClanSeasonContext(header.startTime))}\n` +
      teams
        .map((t, i) => {
          const clan = escapeMarkdown(t.clan ?? `Team ${i + 1}`)
          const players = t.players.map((n) => escapeMarkdown(n)).join(', ')
          return `**${clan}** (${t.composition}): ${players}`
        })
        .join('\n')
    return text.length > 1990 ? text.slice(0, 1990) + '…' : text
  }
  let content = buildContent()

  const buildComponents = (hasChat: boolean): ActionRowBuilder<ButtonBuilder>[] => {
    const overviewButtons = [
      new ButtonBuilder()
        .setLabel('View Replay')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://warthunder.com/en/tournament/replay/${header.sessionId}`),
      ...(hasChat
        ? [new ButtonBuilder().setCustomId(`battle:chat:${header.sessionId}`).setLabel('View Chat').setStyle(ButtonStyle.Secondary)]
        : []),
      new ButtonBuilder().setCustomId(`battle:log:${header.sessionId}`).setLabel('Battle Log').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`battle:heatmap-ground:${header.sessionId}`)
        .setLabel('Heatmap (gnd)')
        .setStyle(ButtonStyle.Secondary),
      ...(hasAir
        ? [
            new ButtonBuilder()
              .setCustomId(`battle:heatmap-air:${header.sessionId}`)
              .setLabel('Heatmap (air)')
              .setStyle(ButtonStyle.Secondary),
          ]
        : []),
    ]
    const clanButtons = teams.slice(0, 2).flatMap((team, teamIndex) => {
      const clan = stripClanDecorators(team.rawTag ?? team.clan ?? `Team ${teamIndex + 1}`)
      return [
        new ButtonBuilder()
          .setCustomId(`battle:heatmap-team-${teamIndex}:${header.sessionId}`)
          .setLabel(`${clan} (gnd)`)
          .setStyle(ButtonStyle.Secondary),
        ...(hasAir
          ? [
              new ButtonBuilder()
                .setCustomId(`battle:heatmap-team-air-${teamIndex}:${header.sessionId}`)
                .setLabel(`${clan} (air)`)
                .setStyle(ButtonStyle.Secondary),
            ]
          : []),
      ]
    })
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(...overviewButtons),
      new ActionRowBuilder<ButtonBuilder>().addComponents(...clanButtons),
    ]
  }

  const makePayload = async (
    winnerTeam: number | null,
    hasChat: boolean,
    psr: Map<string, BattlePsr>,
    renderPriority: WorkerPriority = priority,
  ): Promise<BattlePostPayload> => {
    const png = await renderBattleImage({ missionName, header, results, dict, psr, winnerTeam }, renderPriority)
    shownPsr = psr
    return {
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
      components: buildComponents(hasChat),
    }
  }

  // results-BLK has no winner. The read model also keeps cheap has-air/chat
  // flags and never reads events_blob.
  const dbSummary = getBattlePostSummary(sessionId)
  const mediaMeta = await cachedBattleMeta(header.sessionIdHex)
  hasAir = dbSummary?.airUnitCount !== null && dbSummary?.airUnitCount !== undefined
    ? dbSummary.airUnitCount > 0
    : mediaMeta?.hasAir ?? true
  const hasChat = dbSummary
    ? dbSummary.chatCount === null
      ? hasBattleChat(sessionId)
      : dbSummary.chatCount > 0
    : mediaMeta?.hasChat ?? true
  const winner = dbSummary?.teamWon ?? mediaMeta?.teamWon ?? 0
  const initialHasAir = hasAir
  const initialHasChat = hasChat
  let currentWinnerTeam = winner > 0 ? winner : null
  let currentHasChat = hasChat
  const payload = await makePayload(currentWinnerTeam, currentHasChat, readPsr(currentWinnerTeam))
  // Reads the squadron pages; a redraw only when the column's numbers change.
  const redrawPsr = async (): Promise<BattlePostPayload | null> => {
    await fetchRatingsForTags(clanTags)
    pagesRead = true
    const psr = readPsr(currentWinnerTeam)
    if (samePsr(shownPsr, psr)) return null
    return makePayload(currentWinnerTeam, currentHasChat, psr, 'background')
  }
  const buildRatingsPayload = priority === 'background' && clanTags.length > 0 ? redrawPsr : null
  const buildLookupPayload = unknownTags.length > 0
    ? async (): Promise<BattlePostPayload | null> => {
        await lookupUnknownClanTags(unknownTags)
        if (unknownClanTags(unknownTags).length === unknownTags.length) return null
        return redrawPsr()
      }
    : null
  const buildWinnerPayload = shouldQueueWinnerUpdate(dbSummary !== null, mediaMeta !== null)
    ? async (): Promise<BattlePostPayload | null> => {
        const fresh = await waitForBattlePostSummary(sessionId)
        if (!fresh) return null
        // A post drawn from results-BLK alone: the stored rows add driven
        // vehicles, bot-played slots and resolved teams (player-events.ts).
        const stored = recon ? null : reconstructBattleSummary(sessionId)
        if (stored) {
          results = stored.results
          teams = summarizeTeams(results, dict)
          content = buildContent()
        }
        const freshHasAir = fresh.airUnitCount === null ? initialHasAir : fresh.airUnitCount > 0
        const freshHasChat = fresh.chatCount === null ? hasBattleChat(sessionId) : fresh.chatCount > 0
        if (!stored && fresh.teamWon <= 0 && freshHasAir === initialHasAir && freshHasChat === initialHasChat) {
          return null
        }
        hasAir = freshHasAir
        currentWinnerTeam = fresh.teamWon > 0 ? fresh.teamWon : null
        currentHasChat = freshHasChat
        return makePayload(currentWinnerTeam, currentHasChat, readPsr(currentWinnerTeam), 'background')
      }
    : null
  return {
    payload,
    sessionIdHex: header.sessionIdHex,
    buildWinnerPayload,
    buildRatingsPayload,
    buildLookupPayload,
    updateBytes: buildWinnerPayload || buildRatingsPayload || buildLookupPayload
      ? estimatePostUpdateBytes(results, content)
      : 0,
  }
}

export function seasonMaxBrSuffix(context: ReturnType<typeof getClanSeasonContext>): string {
  if (!context.season?.active) return ''
  const stage = context.currentStage
  return stage ? ` · Макс. БР ${stage.maxBr.toFixed(1)}` : ''
}

/** Последовательно применяет быстрый ПКР и затем при необходимости durable summary. */
export function queueBattlePostUpdates(post: BattlePost, apply: (p: BattlePostPayload) => Promise<unknown>): void {
  const builders = [post.buildRatingsPayload, post.buildWinnerPayload, post.buildLookupPayload].filter(
    (build): build is () => Promise<BattlePostPayload | null> => build !== null,
  )
  const sessionIdHex = post.sessionIdHex
  const estimatedBytes = Math.max(0, Math.floor(post.updateBytes))
  if (builders.length === 0 || postUpdatesStopping || postUpdates.has(sessionIdHex)) return
  if (!canAdmitWinnerUpdate(postUpdates.size, postUpdatesBytes, estimatedBytes)) {
    console.warn(
      `[bot] обновление анонса ${sessionIdHex} отложено: ` +
        `очередь ${postUpdates.size}, ${(postUpdatesBytes / 1024 / 1024).toFixed(1)} МиБ`,
    )
    return
  }
  postUpdatesBytes += estimatedBytes
  const task = (async () => {
    try {
      // Рендеры применяются по порядку: поздний payload обязан включать
      // уже обновлённые ПКР, winner/chat flags и не откатывать сообщение.
      for (const build of builders) {
        const payload = await build()
        if (payload && !postUpdatesStopping) await apply(payload)
      }
    } catch (err) {
      if (!postUpdatesStopping) {
        console.warn(`[bot] обновление анонса ${sessionIdHex}: ${(err as Error).message}`)
      }
    }
  })().finally(() => {
    const current = postUpdates.get(sessionIdHex)
    if (current?.task !== task) return
    postUpdates.delete(sessionIdHex)
    postUpdatesBytes = Math.max(0, postUpdatesBytes - current.estimatedBytes)
  })
  postUpdates.set(sessionIdHex, { task, estimatedBytes })
  void task
}

interface BattlePostUpdateEntry {
  task: Promise<void>
  estimatedBytes: number
}

const WINNER_UPDATE_WAIT_MS = 14 * 60_000
const WINNER_UPDATE_POLL_MS = 1_000
/** Сессии, ожидающие обновление ПКР или durable summary; full media здесь не строится. */
const postUpdates = new Map<string, BattlePostUpdateEntry>()
let postUpdatesBytes = 0
let postUpdatesStopping = false

export async function stopBattlePostUpdates(): Promise<void> {
  postUpdatesStopping = true
  await Promise.allSettled([...postUpdates.values()].map((entry) => entry.task))
}

async function waitForBattlePostSummary(sessionId: string) {
  const deadline = Date.now() + WINNER_UPDATE_WAIT_MS
  while (!postUpdatesStopping) {
    const summary = getBattlePostSummary(sessionId)
    if (summary) return summary
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return null
    await sleepWinnerUpdate(Math.min(WINNER_UPDATE_POLL_MS, remainingMs))
  }
  return null
}

function sleepWinnerUpdate(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function estimatePostUpdateBytes(results: ReplayResults, content: string): number {
  return 64 * 1024
    + Buffer.byteLength(content, 'utf8')
    + Buffer.byteLength(JSON.stringify(results), 'utf8')
}

/** Whether two PSR columns draw the same numbers. */
function samePsr(left: ReadonlyMap<string, BattlePsr>, right: ReadonlyMap<string, BattlePsr>): boolean {
  if (left.size !== right.size) return false
  for (const [userId, entry] of left) {
    const other = right.get(userId)
    if (!other) return false
    const shown = psrLabel(entry)
    const fresh = psrLabel(other)
    if (shown.psr !== fresh.psr || shown.change !== fresh.change) return false
  }
  return true
}

const KIND_NAMES: Record<BattleMediaKind, string> = {
  log: 'battle log',
  'heatmap-ground': 'карту наземной техники',
  'heatmap-air': 'карту авиации',
  'heatmap-team-0': 'карту первого полка',
  'heatmap-team-1': 'карту второго полка',
  'heatmap-team-air-0': 'воздушную карту первого полка',
  'heatmap-team-air-1': 'воздушную карту второго полка',
  chat: 'чат',
}

/** Нажатия battle:<kind>:<sessionId>[:<scale>]; scale есть только у ephemeral-переключателя heatmap. */
export async function handleBattleButton(interaction: ButtonInteraction): Promise<void> {
  const [, rawKind, sessionId, rawScale] = interaction.customId.split(':')
  const kind = rawKind as BattleMediaKind
  if (!KIND_NAMES[kind] || !sessionId) return
  if (rawScale !== undefined && rawScale !== '1' && rawScale !== '2') return
  if (rawScale !== undefined && !isBattleHeatmapKind(kind)) return
  const scale: HeatmapScale = rawScale === '2' ? 2 : 1
  const isQualityToggle = rawScale !== undefined

  // Ответы видны только нажавшему — иначе кнопки быстро замусорят канал.
  // Подтверждаем до любых cache/worker/network операций: Discord даёт 3 с.
  // Протухший токен 10062 централизованно обрабатывает bot/index.ts.
  if (isQualityToggle) await interaction.deferUpdate()
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const sessionIdHex = BigInt(sessionId).toString(16).padStart(16, '0')
  const item = getItemByExternalId('wt-replays', sessionId)
  const data = item?.data as ReplayItemData | undefined
  const parts = data ? replayPartUrls(data) : []
  const meta = {
    missionName: data?.missionName ?? item?.title ?? '',
    gameMode: data?.gameMode,
    gameVersion: data?.gameVersion,
    fakeNames: fakeNamesFromItem(data ?? {}),
  }
  let media: Buffer | null = null

  try {
    if (scale === 2 && isBattleHeatmapKind(kind)) {
      media = await cachedBattleHeatmap2x(sessionIdHex, kind)
      if (!media) {
        // Первый обычный рендер сохраняет нормализованный бой в БД. HD-задача
        // затем получает из неё blob и строит только одну выбранную карту.
        if (!hasBattle(sessionId)) {
          if (!item || parts.length === 0) {
            await interaction.editReply('Реплей этого боя не найден в базе — собрать HD-карту не из чего.')
            return
          }
          await buildBattleMediaKind(
            sessionId,
            parts,
            meta,
            kind,
            realNamesFromItem(data ?? {}),
            'interactive',
          )
        }
        media = await buildBattleHeatmap2x(sessionId, kind, meta, 'interactive')
      }
    } else {
      media = await cachedBattleMedia(sessionIdHex, kind)
      if (!media) {
        // Бой в БД собирается из неё (реплей не нужен); иначе нужны части реплея.
        if (!hasBattle(sessionId) && (!item || parts.length === 0)) {
          await interaction.editReply('Реплей этого боя не найден в базе — собрать материалы не из чего.')
          return
        }
        media = await buildBattleMediaKind(
          sessionId,
          parts,
          meta,
          kind,
          realNamesFromItem(data ?? {}),
          'interactive',
        )
      }
    }
  } catch (err) {
    console.error(`[bot] сборка ${kind} ${scale}× для ${sessionId}:`, err)
    await interaction.editReply(
      `Не получилось собрать ${KIND_NAMES[kind]} в ${scale}×: ${(err as Error).message}\n` +
        'Части реплея могли уже протухнуть на CDN (живут около двух недель).',
    )
    return
  }

  if (!media) return

  if (kind === 'chat') {
    let text = media.toString('utf8')
    if (text.length > 1900) text = text.slice(0, 1900) + '\n…'
    await interaction.editReply({ content: `**Match Chat**\n\`\`\`\n${text}\n\`\`\`\nMatch ID: \`${sessionId}\`` })
    return
  }

  let responseScale = scale
  let qualityNotice: string | undefined
  if (
    isBattleHeatmapKind(kind) &&
    heatmapScaleForUpload(scale, media.byteLength, interaction.attachmentSizeLimit) === 1 &&
    scale === 2
  ) {
    const hdByteLength = media.byteLength
    const standard = await cachedBattleMedia(sessionIdHex, kind)
    if (!standard) {
      await interaction.editReply(
        'Версия 2× превышает лимит вложения Discord, а версия 1× отсутствует в кэше. Откройте карту заново.',
      )
      return
    }
    media = standard
    responseScale = 1
    qualityNotice =
      `Версия 2× весит ${(hdByteLength / 1024 / 1024).toFixed(1)} МиБ и превышает лимит Discord; показана версия 1×.`
  }

  await interaction.editReply({
    ...(qualityNotice ? { content: qualityNotice } : {}),
    ...(isQualityToggle ? { attachments: [] } : {}),
    files: [new AttachmentBuilder(media, { name: `battle-${sessionIdHex}-${kind}${responseScale === 2 ? '@2x' : ''}.png` })],
    components:
      isBattleHeatmapKind(kind) && !qualityNotice
        ? [heatmapQualityRow(kind, sessionId, responseScale)]
        : [],
  })
}
