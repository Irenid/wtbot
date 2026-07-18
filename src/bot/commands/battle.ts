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
import { getBattleWinner, getItemByExternalId, getLatestItems, hasBattle, type StoredItem } from '../../db/index.js'
import { buildBattleMedia, cachedBattleMedia, cachedBattleMeta, type BattleMediaKind } from '../../wrpl/battle-media.js'
import { reconstructBattle } from '../../wrpl/battle-data.js'
import { fetchRatingsForTags } from '../../wrpl/clan-info.js'
import { applyRealNames, fetchReplayResults, normalizeSessionId, realNamesFromItem, replayPartUrls, type ReplayResults, type WrplHeader } from '../../wrpl/replay.js'
import { renderBattleImage, summarizeTeams } from '../../wrpl/render-battle.js'
import { ensureVehicleDict } from '../../wrpl/vehicles.js'

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
export async function renderBattlePost(item: StoredItem): Promise<BattlePost | null> {
  const data = item.data as ReplayItemData
  const sessionId = item.externalId
  const realNames = realNamesFromItem(data)

  // Бой уже разобран — берём результаты из БД, реплей не качаем. Иначе
  // скачиваем results-BLK из последней части (parts нужны только тут).
  let header: WrplHeader
  let results: ReplayResults
  let parts: string[] = []
  const recon = reconstructBattle(sessionId)
  if (recon) {
    header = recon.header
    results = recon.results // ники в БД уже настоящие
  } else {
    parts = replayPartUrls(data)
    if (parts.length === 0) return null
    const fetched = await fetchReplayResults(parts)
    header = fetched.header
    results = fetched.results
    // Анонимайзер подменяет ники в реплее — возвращаем настоящие с сайта
    applyRealNames(results, realNames)
  }
  const dict = await ensureVehicleDict()
  const teams = summarizeTeams(results, dict)
  const missionName = data.missionName ?? item.title

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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('View Replay')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://warthunder.com/en/tournament/replay/${header.sessionId}`),
    new ButtonBuilder().setCustomId(`battle:chat:${header.sessionId}`).setLabel('View Chat').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`battle:log:${header.sessionId}`).setLabel('Battle Log').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`battle:heatmap-ground:${header.sessionId}`)
      .setLabel('Heatmap (Ground)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`battle:heatmap-air:${header.sessionId}`)
      .setLabel('Heatmap (Air)')
      .setStyle(ButtonStyle.Secondary),
  )

  const makePayload = async (winnerTeam: number | null): Promise<BattlePostPayload> => {
    const png = await renderBattleImage({ missionName, header, results, dict, ratings, winnerTeam })
    return {
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
      components: [row],
    }
  }

  // Победителя в results-BLK нет. Берём его из БД (воркер ingest уже мог
  // разобрать бой) или из кэша меты. Если ни там, ни там — собираем материалы
  // в фоне: это и даст победителя, и подготовит кнопки к мгновенному ответу.
  const dbWinner = getBattleWinner(sessionId) // null — бой ещё не разобран
  const metaWinner = cachedBattleMeta(header.sessionIdHex)?.teamWon ?? null
  const known = dbWinner !== null || metaWinner !== null
  const winner = dbWinner ?? metaWinner ?? 0
  const payload = await makePayload(winner > 0 ? winner : null)
  const buildWinnerPayload = known
    ? null
    : async (): Promise<BattlePostPayload | null> => {
        await buildBattleMedia(sessionId, parts, { missionName, gameMode: data.gameMode, gameVersion: data.gameVersion }, realNames)
        const fresh = getBattleWinner(sessionId) ?? cachedBattleMeta(header.sessionIdHex)?.teamWon ?? 0
        if (fresh <= 0) return null
        return makePayload(fresh)
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
  if (!build || buildingMeta.has(post.sessionIdHex)) return
  buildingMeta.add(post.sessionIdHex)
  void (async () => {
    try {
      const payload = await build()
      if (payload) await apply(payload)
    } catch (err) {
      console.warn(`[bot] фоновая сборка меты ${post.sessionIdHex}: ${(err as Error).message}`)
    } finally {
      buildingMeta.delete(post.sessionIdHex)
    }
  })()
}

/** Сессии, для которых уже идёт фоновая сборка материалов */
const buildingMeta = new Set<string>()

const KIND_NAMES: Record<BattleMediaKind, string> = {
  log: 'battle log',
  'heatmap-ground': 'хитмапу (наземка)',
  'heatmap-air': 'хитмапу (авиация)',
  chat: 'чат',
}

/** Нажатия кнопок battle:<kind>:<sessionId> (роутер — в bot/index.ts) */
export async function handleBattleButton(interaction: ButtonInteraction): Promise<void> {
  const [, kind, sessionId] = interaction.customId.split(':') as [string, BattleMediaKind, string]
  if (!KIND_NAMES[kind] || !sessionId) return

  // Ответы видны только нажавшему — иначе кнопки быстро замусорят канал.
  // Подтвердить нажатие нужно за 3 с; если бот в этот момент был занят
  // синхронным разбором и токен протух (10062), это ловит роутер кнопок
  // (bot/index.ts) — нажатие просто повторяют.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const sessionIdHex = BigInt(sessionId).toString(16).padStart(16, '0')
  let media = cachedBattleMedia(sessionIdHex, kind)

  if (!media) {
    const item = getItemByExternalId('wt-replays', sessionId)
    const data = item?.data as ReplayItemData | undefined
    const parts = data ? replayPartUrls(data) : []
    // Бой в БД собирается из неё (реплей не нужен); иначе нужны части реплея
    if (!hasBattle(sessionId) && (!item || parts.length === 0)) {
      await interaction.editReply('Реплей этого боя не найден в базе — собрать материалы не из чего.')
      return
    }
    try {
      const built = await buildBattleMedia(
        sessionId,
        parts,
        { missionName: data?.missionName ?? item?.title ?? '', gameMode: data?.gameMode, gameVersion: data?.gameVersion },
        realNamesFromItem(data ?? {}),
      )
      media =
        kind === 'log' ? built.log
        : kind === 'heatmap-ground' ? built.heatmapGround
        : kind === 'heatmap-air' ? built.heatmapAir
        : Buffer.from(built.chat)
    } catch (err) {
      console.error(`[bot] сборка ${kind} для ${sessionId}:`, err)
      await interaction.editReply(
        `Не получилось собрать ${KIND_NAMES[kind]}: ${(err as Error).message}\n` +
          'Части реплея могли уже протухнуть на CDN (живут около двух недель).',
      )
      return
    }
  }

  if (kind === 'chat') {
    let text = media.toString('utf8')
    if (text.length > 1900) text = text.slice(0, 1900) + '\n…'
    await interaction.editReply({ content: `**Match Chat**\n\`\`\`\n${text}\n\`\`\`\nMatch ID: \`${sessionId}\`` })
    return
  }

  await interaction.editReply({
    files: [new AttachmentBuilder(media, { name: `battle-${sessionIdHex}-${kind}.png` })],
  })
}
