import { EmbedBuilder, SlashCommandBuilder } from 'discord.js'
import { botText, type BotText } from '../../i18n/index.js'
import { isBotOwner } from '../access.js'
import { channelLocale } from '../locale.js'
import type { Command } from '../types.js'
import { getClanSeasonContext, getCommandStats, getItemStats, getLatestParsePerSource, type ClanSeasonContext } from '../../db/index.js'

function formatUptime(totalSec: number, t: BotText): string {
  return t.stats.uptime(
    Math.floor(totalSec / 86400),
    Math.floor((totalSec % 86400) / 3600),
    Math.floor((totalSec % 3600) / 60),
    Math.floor(totalSec % 60),
  )
}

/** The cap that plays now and the next change, as the site's season panel counts them (Discord shows <t:…:R> on the reader's clock). */
export function seasonText(
  { season, stages, currentStage, stageSwitchDelaySec }: ClanSeasonContext,
  nowSec: number,
  t: BotText,
): string {
  const text = t.stats.season
  if (!season) return text.noSchedule
  if (!season.active) return text.ended(`<t:${season.endsAt}:R>`)
  const last = currentStage !== null && currentStage.endsAt === season.endsAt
  const current = currentStage === null
    ? text.betweenStages
    : `${last ? text.untilEnd : text.week(currentStage.week)} · ${text.maxBr(currentStage.maxBr.toFixed(1))}`
  const next = last ? undefined : stages.find((stage) => stage.startsAt + stageSwitchDelaySec > nowSec)
  return next
    ? `${current} · ${text.nextMaxBr(next.maxBr.toFixed(1), `<t:${next.startsAt + stageSwitchDelaySec}:R>`)}`
    : `${current} · ${text.ends(`<t:${season.endsAt}:R>`)}`
}

/**
 * /stats — the bot's uptime, reach and the squadron battles season for
 * everyone; the parsers' state (English operator text, errors included) only
 * for the application's owner, who runs the bot (access.ts).
 */
export const stats: Command = {
  definition: (t) => new SlashCommandBuilder().setName('stats').setDescription(t.commands.stats.description),
  async execute(interaction) {
    const t = botText(channelLocale(interaction))
    const cmdStats = getCommandStats()
    const owner = isBotOwner(interaction.client.application.owner, interaction.user.id)
    const parses = owner ? getLatestParsePerSource() : []
    const itemStats = getItemStats()
    const nowSec = Math.floor(Date.now() / 1_000)

    const topCommands =
      cmdStats.byCommand
        .slice(0, 5)
        .map((c) => `\`/${c.command}\` — ${c.count}`)
        .join('\n') || t.stats.noCommands

    const parsers =
      parses
        .map(
          (p) =>
            `${p.ok ? '🟢' : '🔴'} \`${p.source}\` — ${p.summary ?? p.error ?? '?'} · <t:${p.parsedAt}:R>`,
        )
        .join('\n') || t.stats.noParsers

    const embed = new EmbedBuilder()
      .setTitle(t.stats.title)
      .setColor(0x5865f2)
      .addFields(
        { name: t.stats.fields.uptime, value: formatUptime(process.uptime(), t), inline: true },
        { name: t.stats.fields.servers, value: t.number(interaction.client.guilds.cache.size), inline: true },
        { name: t.stats.fields.commandsRun, value: t.number(cmdStats.total), inline: true },
        { name: t.stats.fields.itemsCollected, value: t.number(itemStats.total), inline: true },
        { name: t.stats.fields.season, value: seasonText(getClanSeasonContext(nowSec), nowSec, t), inline: false },
        { name: t.stats.fields.topCommands, value: topCommands },
        ...(owner ? [{ name: t.stats.fields.parsers, value: parsers.slice(0, 1024) }] : []),
      )
      .setTimestamp()

    await interaction.reply({ embeds: [embed] })
  },
}
