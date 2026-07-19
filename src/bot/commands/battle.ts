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
import { heatmapQualityRow, type HeatmapScale } from '../battle-media-controls.js'
import { getBattleWinner, getItemByExternalId, getLatestItems, hasBattle, hasBattleChat, type StoredItem } from '../../db/index.js'
import {
  buildBattleHeatmap2x,
  buildBattleMedia,
  cachedBattleHeatmap2x,
  cachedBattleMedia,
  cachedBattleMeta,
  type BattleMediaKind,
} from '../../wrpl/battle-media.js'
import { isBattleHeatmapKind } from '../../wrpl/battle-media-kind.js'
import { reconstructBattleSummary } from '../../wrpl/battle-data.js'
import { fetchRatingsForTags } from '../../wrpl/clan-info.js'
import { applyRealNames, fetchReplayResults, normalizeSessionId, realNamesFromItem, replayPartUrls, type ReplayResults, type WrplHeader } from '../../wrpl/replay.js'
import { renderBattleImage, stripClanDecorators, summarizeTeams } from '../../wrpl/render-battle.js'
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
    queueWinnerUpdate(post, (p) => interaction.editReply(p))
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
  /** null — победитель уже на картинке; иначе сборка материалов вернёт payload с отметкой (или null) */
  buildWinnerPayload: (() => Promise<BattlePostPayload | null>) | null
}

/**
 * Сообщение с результатами боя по записи БД: картинка, текст с составами
 * и кнопки материалов. Общий код /battle и автоанонса. null — у записи
 * нет ссылок на файлы реплея.
 */
export async function renderBattlePost(
  item: StoredItem,
  priority: WorkerPriority = 'interactive',
): Promise<BattlePost | null> {
  const data = item.data as ReplayItemData
  const sessionId = item.externalId
  const realNames = realNamesFromItem(data)

  // Бой уже разобран — берём результаты из БД, реплей не качаем. Иначе
  // скачиваем results-BLK из последней части (parts нужны только тут).
  let header: WrplHeader
  let results: ReplayResults
  let parts: string[] = []
  const recon = reconstructBattleSummary(sessionId)
  if (recon) {
    header = recon.header
    results = recon.results // ники в БД уже настоящие
  } else {
    parts = replayPartUrls(data)
    if (parts.length === 0) return null
    const fetched = await fetchReplayResults(parts, priority)
    header = fetched.header
    results = fetched.results
    // Анонимайзер подменяет ники в реплее — возвращаем настоящие с сайта
    applyRealNames(results, realNames)
  }
  const dict = await ensureVehicleDict(priority)
  const teams = summarizeTeams(results, dict)
  const missionName = data.missionName ?? item.title
  // До первой сборки точный признак неизвестен: results-BLK перечисляет
  // доступную технику, а не только реально появившиеся в бою юниты.
  let hasAir = true

  // Личный клановый рейтинг обеих команд — с сайта; сбой сети не должен
  // ломать команду, тогда картинка выходит без колонки ПКР
  const ratings = await fetchRatingsForTags(teams.flatMap((t) => (t.rawTag ? [t.rawTag] : [])))

  // Текст рядом с картинкой: Match ID, затем кланы, состав и игроки команд
  let content =
    `Match ID: \`${header.sessionId}\`\n` +
    teams
      .map((t, i) => {
        const clan = escapeMarkdown(t.clan ?? `Команда ${i + 1}`)
        const players = t.players.map((n) => escapeMarkdown(n)).join(', ')
        return `**${clan}** (${t.composition}): ${players}`
      })
      .join('\n')
  if (content.length > 1990) content = content.slice(0, 1990) + '…'

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
      const clan = stripClanDecorators(team.rawTag ?? team.clan ?? `Команда ${teamIndex + 1}`)
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
    renderPriority: WorkerPriority = priority,
  ): Promise<BattlePostPayload> => {
    const png = await renderBattleImage({ missionName, header, results, dict, ratings, winnerTeam }, renderPriority)
    return {
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
      components: buildComponents(hasChat),
    }
  }

  // Победителя в results-BLK нет. Берём его из БД (воркер ingest уже мог
  // разобрать бой) или из кэша меты. Если ни там, ни там — собираем материалы
  // в фоне: это и даст победителя, и подготовит кнопки к мгновенному ответу.
  const dbWinner = getBattleWinner(sessionId) // null — бой ещё не разобран
  const mediaMeta = await cachedBattleMeta(header.sessionIdHex)
  const metaWinner = mediaMeta?.teamWon ?? null
  hasAir = mediaMeta?.hasAir ?? true
  const known = dbWinner !== null || metaWinner !== null
  const winner = dbWinner ?? metaWinner ?? 0
  const payload = await makePayload(
    winner > 0 ? winner : null,
    hasBattle(sessionId) ? hasBattleChat(sessionId) : mediaMeta?.hasChat ?? true,
  )
  const buildWinnerPayload = known && mediaMeta
    ? null
    : async (): Promise<BattlePostPayload | null> => {
        const built = await buildBattleMedia(
          sessionId,
          parts,
          { missionName, gameMode: data.gameMode, gameVersion: data.gameVersion },
          realNames,
          'background',
        )
        const fresh = getBattleWinner(sessionId) ?? (await cachedBattleMeta(header.sessionIdHex))?.teamWon ?? 0
        hasAir = built.summary.airUnits > 0
        return makePayload(fresh > 0 ? fresh : null, built.summary.chat > 0, 'background')
      }
  return { payload, sessionIdHex: header.sessionIdHex, buildWinnerPayload }
}

/**
 * Меты ещё нет — собирает материалы в фоне (даёт победителя и мгновенные
 * кнопки) и передаёт apply обновлённое сообщение с отметкой «Победа».
 * Защищено от параллельных сборок одной сессии.
 */
export function queueWinnerUpdate(post: BattlePost, apply: (p: BattlePostPayload) => Promise<unknown>): void {
  const build = post.buildWinnerPayload
  if (!build || winnerUpdatesStopping || winnerUpdates.has(post.sessionIdHex)) return
  const task = (async () => {
    try {
      const payload = await build()
      if (payload && !winnerUpdatesStopping) await apply(payload)
    } catch (err) {
      if (!winnerUpdatesStopping) {
        console.warn(`[bot] фоновая сборка меты ${post.sessionIdHex}: ${(err as Error).message}`)
      }
    }
  })().finally(() => winnerUpdates.delete(post.sessionIdHex))
  winnerUpdates.set(post.sessionIdHex, task)
  void task
}

/** Сессии, для которых уже идёт фоновая сборка материалов. */
const winnerUpdates = new Map<string, Promise<void>>()
let winnerUpdatesStopping = false

export async function stopWinnerUpdates(): Promise<void> {
  winnerUpdatesStopping = true
  await Promise.allSettled([...winnerUpdates.values()])
}

const KIND_NAMES: Record<BattleMediaKind, string> = {
  log: 'battle log',
  'heatmap-ground': 'карту наземной техники',
  'heatmap-air': 'карту авиации',
  'heatmap-team-0': 'карту первого клана',
  'heatmap-team-1': 'карту второго клана',
  'heatmap-team-air-0': 'воздушную карту первого клана',
  'heatmap-team-air-1': 'воздушную карту второго клана',
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
          await buildBattleMedia(sessionId, parts, meta, realNamesFromItem(data ?? {}), 'interactive')
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
        const built = await buildBattleMedia(
          sessionId,
          parts,
          meta,
          realNamesFromItem(data ?? {}),
          'interactive',
        )
        media =
          kind === 'log' ? built.log
          : kind === 'heatmap-ground' ? built.heatmapGround
          : kind === 'heatmap-air' ? built.heatmapAir
          : kind === 'heatmap-team-0' ? built.heatmapTeamGround[0]
          : kind === 'heatmap-team-1' ? built.heatmapTeamGround[1]
          : kind === 'heatmap-team-air-0' ? built.heatmapTeamAir[0]
          : kind === 'heatmap-team-air-1' ? built.heatmapTeamAir[1]
          : Buffer.from(built.chat)
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

  await interaction.editReply({
    ...(isQualityToggle ? { attachments: [] } : {}),
    files: [new AttachmentBuilder(media, { name: `battle-${sessionIdHex}-${kind}${scale === 2 ? '@2x' : ''}.png` })],
    components: isBattleHeatmapKind(kind) ? [heatmapQualityRow(kind, sessionId, scale)] : [],
  })
}
