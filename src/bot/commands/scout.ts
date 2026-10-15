import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction } from 'discord.js'
import { botText, type BotText } from '../../i18n/index.js'
import { channelLocale, userLocale } from '../locale.js'
import type { Command } from '../types.js'
import { formatScoutReport, squadronLabel } from '../../scout/format.js'
import { buildScoutReport, findSquadrons, loadScoutHistory, recentNicks, type ScoutSquadron } from '../../scout/report.js'
import { rankNicks } from '../../nick-search.js'

const MAX_CHOICE = 100

function squadronChoice(squadron: ScoutSquadron, t: BotText['scout']): { name: string; value: string } {
  const place = squadron.position !== null ? ` · ${t.choicePlace(squadron.position)}` : ''
  const label = `${squadronLabel(squadron.displayTag, squadron.name)}${place}${squadron.inReplays ? '' : ` · ${t.choiceNoBattles}`}`
  return { name: label.slice(0, MAX_CHOICE), value: squadron.core.slice(0, MAX_CHOICE) }
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true)
  if (focused.name === 'squadron') {
    // Suggestions only the typist sees.
    const t = botText(userLocale(interaction)).scout
    await interaction.respond(findSquadrons(focused.value).map((squadron) => squadronChoice(squadron, t)))
    return
  }
  if (focused.name !== 'player') {
    await interaction.respond([])
    return
  }
  const squadron = findSquadrons(interaction.options.getString('squadron') ?? '', 1)[0]
  if (!squadron?.inReplays) {
    await interaction.respond([])
    return
  }
  const history = await loadScoutHistory(squadron, Math.floor(Date.now() / 1000))
  // Typos and the other keyboard layout forgiven; equal matches stay most recent first.
  const nicks = rankNicks(focused.value, recentNicks(history.battles))
  await interaction.respond(nicks.slice(0, 25).map((nick) => ({ name: nick.slice(0, MAX_CHOICE), value: nick.slice(0, MAX_CHOICE) })))
}

export const scout: Command = {
  definition: (t) => new SlashCommandBuilder()
    .setName('scout')
    .setDescription(t.commands.scout.description)
    .addStringOption((option) => option
      .setName('squadron')
      .setDescription(t.commands.scout.squadron)
      .setRequired(true)
      .setMaxLength(64)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('player')
      .setDescription(t.commands.scout.player)
      .setMaxLength(64)
      .setAutocomplete(true)),
  async execute(interaction) {
    await interaction.deferReply()
    const t = botText(channelLocale(interaction))
    const query = interaction.options.getString('squadron', true)
    const squadron = findSquadrons(query, 1)[0]
    if (!squadron) {
      await interaction.editReply(t.scout.squadronNotFound(query.slice(0, 64)))
      return
    }
    const report = await buildScoutReport(squadron, interaction.options.getString('player'))
    const text = formatScoutReport(report, t)
    const embed = new EmbedBuilder().setTitle(text.title).setDescription(text.description).setColor(text.color)
    if (text.fields.length > 0) embed.addFields(text.fields)
    await interaction.editReply({ embeds: [embed] })
  },
  autocomplete,
}
