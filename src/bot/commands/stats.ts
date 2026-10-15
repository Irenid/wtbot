import { EmbedBuilder, SlashCommandBuilder } from 'discord.js'
import type { Command } from '../types.js'
import { getClanSeasonContext, getCommandStats, getItemStats, getLatestParsePerSource, type ClanSeasonContext } from '../../db/index.js'

function formatUptime(totalSec: number): string {
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

/** The cap that plays now and the next change, as the site's season panel counts them (Discord shows <t:…:R> on the reader's clock). */
export function seasonText({ season, stages, currentStage, stageSwitchDelaySec }: ClanSeasonContext, nowSec: number): string {
  if (!season) return 'no schedule'
  if (!season.active) return `season ended <t:${season.endsAt}:R>`
  const last = currentStage !== null && currentStage.endsAt === season.endsAt
  const current = currentStage === null
    ? 'between stages'
    : `${last ? 'until the end of the season' : `week ${currentStage.week}`} · max BR ${currentStage.maxBr.toFixed(1)}`
  const next = last ? undefined : stages.find((stage) => stage.startsAt + stageSwitchDelaySec > nowSec)
  return next
    ? `${current} · max BR ${next.maxBr.toFixed(1)} <t:${next.startsAt + stageSwitchDelaySec}:R>`
    : `${current} · season ends <t:${season.endsAt}:R>`
}

export const stats: Command = {
  data: new SlashCommandBuilder().setName('stats').setDescription('Статистика бота и парсеров'),
  async execute(interaction) {
    const cmdStats = getCommandStats()
    const parses = getLatestParsePerSource()
    const itemStats = getItemStats()
    const nowSec = Math.floor(Date.now() / 1_000)

    const topCommands =
      cmdStats.byCommand
        .slice(0, 5)
        .map((c) => `\`/${c.command}\` — ${c.count}`)
        .join('\n') || 'none yet'

    const parsers =
      parses
        .map(
          (p) =>
            `${p.ok ? '🟢' : '🔴'} \`${p.source}\` — ${p.summary ?? p.error ?? '?'} · <t:${p.parsedAt}:R>`,
        )
        .join('\n') || 'not run yet'

    const embed = new EmbedBuilder()
      .setTitle('📊 Statistics')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
        { name: 'Servers', value: String(interaction.client.guilds.cache.size), inline: true },
        { name: 'Commands run', value: String(cmdStats.total), inline: true },
        { name: 'Items collected', value: String(itemStats.total), inline: true },
        { name: 'Squadron battles season', value: seasonText(getClanSeasonContext(nowSec), nowSec), inline: false },
        { name: 'Top commands', value: topCommands },
        { name: 'Parsers', value: parsers },
      )
      .setTimestamp()

    await interaction.reply({ embeds: [embed] })
  },
}
