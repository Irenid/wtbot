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
import { getItemByExternalId, getLatestItems } from '../../db/index.js'
import { buildBattleMedia, cachedBattleMedia, type BattleMediaKind } from '../../wrpl/battle-media.js'
import { fetchRatingsForTags } from '../../wrpl/clan-info.js'
import { fetchReplayResults, normalizeSessionId, replayPartUrls } from '../../wrpl/replay.js'
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
  replayParts?: string[] | null
  url?: string
  partsCount?: number
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

    const data = item.data as ReplayItemData
    const parts = replayPartUrls(data)
    if (parts.length === 0) {
      await interaction.editReply('У этой записи нет ссылок на файлы реплея.')
      return
    }

    const { header, results } = await fetchReplayResults(parts)
    const dict = await ensureVehicleDict()
    const teams = summarizeTeams(results, dict)

    // Личный клановый рейтинг обеих команд — с сайта; сбой сети не должен
    // ломать команду, тогда картинка выходит без колонки ПКР
    const ratings = await fetchRatingsForTags(teams.flatMap((t) => (t.rawTag ? [t.rawTag] : [])))

    const png = await renderBattleImage({
      missionName: data.missionName ?? item.title,
      header,
      results,
      dict,
      ratings,
    })

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

    await interaction.editReply({
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
      components: [row],
    })
  },
}

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

  // Ответы видны только нажавшему — иначе кнопки быстро замусорят канал
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const sessionIdHex = BigInt(sessionId).toString(16).padStart(16, '0')
  let media = cachedBattleMedia(sessionIdHex, kind)

  if (!media) {
    const item = getItemByExternalId('wt-replays', sessionId)
    const data = item?.data as ReplayItemData | undefined
    const parts = data ? replayPartUrls(data) : []
    if (!item || parts.length === 0) {
      await interaction.editReply('Реплей этого боя не найден в базе — собрать материалы не из чего.')
      return
    }
    try {
      const built = await buildBattleMedia(parts, data?.missionName ?? item.title)
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
