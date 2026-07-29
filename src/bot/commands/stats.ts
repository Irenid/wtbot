import { EmbedBuilder, SlashCommandBuilder } from 'discord.js'
import type { Command } from '../types.js'
import { getClanSeasonContext, getCommandStats, getItemStats, getLatestParsePerSource } from '../../db/index.js'

function formatUptime(totalSec: number): string {
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}д`)
  if (h > 0) parts.push(`${h}ч`)
  if (m > 0) parts.push(`${m}м`)
  parts.push(`${s}с`)
  return parts.join(' ')
}

export const stats: Command = {
  data: new SlashCommandBuilder().setName('stats').setDescription('Статистика бота и парсеров'),
  async execute(interaction) {
    const cmdStats = getCommandStats()
    const parses = getLatestParsePerSource()
    const itemStats = getItemStats()
    const season = getClanSeasonContext()

    const topCommands =
      cmdStats.byCommand
        .slice(0, 5)
        .map((c) => `\`/${c.command}\` — ${c.count}`)
        .join('\n') || 'пока пусто'

    const parsers =
      parses
        .map(
          (p) =>
            `${p.ok ? '🟢' : '🔴'} \`${p.source}\` — ${p.summary ?? p.error ?? '?'} · <t:${p.parsedAt}:R>`,
        )
        .join('\n') || 'ещё не запускались'

    const embed = new EmbedBuilder()
      .setTitle('📊 Статистика')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Аптайм', value: formatUptime(process.uptime()), inline: true },
        { name: 'Серверов', value: String(interaction.client.guilds.cache.size), inline: true },
        { name: 'Команд выполнено', value: String(cmdStats.total), inline: true },
        { name: 'Собрано записей', value: String(itemStats.total), inline: true },
        {
          name: 'Клановый сезон',
          value: season.currentStage && season.season
            ? `${season.currentStage.endsAt === season.season.endsAt ? 'до конца сезона' : `${season.currentStage.week} неделя`} · макс. БР ${season.currentStage.maxBr.toFixed(1)} · <t:${season.currentStage.endsAt - 1}:d>`
            : season.season
              ? `${season.season.name} · завершён`
              : 'расписание не задано',
          inline: false,
        },
        { name: 'Топ команд', value: topCommands },
        { name: 'Парсеры', value: parsers },
      )
      .setTimestamp()

    await interaction.reply({ embeds: [embed] })
  },
}
