import { EmbedBuilder, SlashCommandBuilder, type AutocompleteInteraction } from 'discord.js'
import type { Command } from '../types.js'
import { formatScoutReport, squadronLabel } from '../../scout/format.js'
import { buildScoutReport, findSquadrons, loadScoutHistory, nickKey, recentNicks, type ScoutSquadron } from '../../scout/report.js'

const MAX_CHOICE = 100

function squadronChoice(squadron: ScoutSquadron): { name: string; value: string } {
  const place = squadron.position !== null ? ` · place ${squadron.position}` : ''
  const label = `${squadronLabel(squadron.displayTag, squadron.name)}${place}${squadron.inReplays ? '' : ' · no battles stored'}`
  return { name: label.slice(0, MAX_CHOICE), value: squadron.core.slice(0, MAX_CHOICE) }
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true)
  if (focused.name === 'squadron') {
    await interaction.respond(findSquadrons(focused.value).map(squadronChoice))
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
  const key = nickKey(focused.value)
  const nicks = recentNicks(history.battles).filter((nick) => key === '' || nickKey(nick).includes(key))
  await interaction.respond(nicks.slice(0, 25).map((nick) => ({ name: nick.slice(0, MAX_CHOICE), value: nick.slice(0, MAX_CHOICE) })))
}

export const scout: Command = {
  data: new SlashCommandBuilder()
    .setName('scout')
    .setDescription("Predict an enemy squadron's players and vehicles from its recent battles")
    .addStringOption((option) => option
      .setName('squadron')
      .setDescription('Squadron tag or name, as the game shows it')
      .setRequired(true)
      .setMaxLength(64)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('player')
      .setDescription('A nick you see on the enemy team: picks the right group when two play at once')
      .setMaxLength(64)
      .setAutocomplete(true)),
  async execute(interaction) {
    await interaction.deferReply()
    const query = interaction.options.getString('squadron', true)
    const squadron = findSquadrons(query, 1)[0]
    if (!squadron) {
      await interaction.editReply(`No squadron matches "${query.slice(0, 64)}". Type the tag as the game shows it, for example WLILY.`)
      return
    }
    const report = await buildScoutReport(squadron, interaction.options.getString('player'))
    const text = formatScoutReport(report)
    const embed = new EmbedBuilder().setTitle(text.title).setDescription(text.description).setColor(text.color)
    if (text.fields.length > 0) embed.addFields(text.fields)
    await interaction.editReply({ embeds: [embed] })
  },
  autocomplete,
}
