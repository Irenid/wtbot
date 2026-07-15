import { AttachmentBuilder, SlashCommandBuilder, escapeMarkdown } from 'discord.js'
import type { Command } from '../types.js'
import { getItemByExternalId, getLatestItems } from '../../db/index.js'
import { fetchReplayResults, normalizeSessionId, replayPartUrls } from '../../wrpl/replay.js'
import { renderBattleImage, summarizeTeams } from '../../wrpl/render-battle.js'
import { ensureVehicleDict } from '../../wrpl/vehicles.js'

/**
 * /battle [id] — картинка с таблицей результатов боя из реплея.
 * Без id берётся последний собранный парсером реплей. Скачивание частей
 * и рендер занимают пару секунд, поэтому сначала deferReply.
 */
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

    const data = item.data as { missionName?: string; replayParts?: string[] | null; url?: string; partsCount?: number }
    const parts = replayPartUrls(data)
    if (parts.length === 0) {
      await interaction.editReply('У этой записи нет ссылок на файлы реплея.')
      return
    }

    const { header, results } = await fetchReplayResults(parts)
    const dict = await ensureVehicleDict()
    const png = await renderBattleImage({
      missionName: data.missionName ?? item.title,
      header,
      results,
      dict,
    })

    // Текст рядом с картинкой: кланы, состав и игроки обеих команд
    const teams = summarizeTeams(results, dict)
    let content = teams
      .map((t, i) => {
        const clan = escapeMarkdown(t.clan ?? `Команда ${i + 1}`)
        const players = t.players.map((n) => escapeMarkdown(n)).join(', ')
        return `**${clan}** (${t.composition}): ${players}`
      })
      .join('\n')
    if (content.length > 1990) content = content.slice(0, 1990) + '…'

    await interaction.editReply({
      content,
      files: [new AttachmentBuilder(png, { name: `battle-${header.sessionIdHex}.png` })],
    })
  },
}
