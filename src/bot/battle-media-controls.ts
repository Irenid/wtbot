import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { BattleHeatmapKind } from '../wrpl/battle-media-kind.js'

export type HeatmapScale = 1 | 2

export function heatmapQualityRow(
  kind: BattleHeatmapKind,
  sessionId: string,
  currentScale: HeatmapScale,
): ActionRowBuilder<ButtonBuilder> {
  const nextScale: HeatmapScale = currentScale === 1 ? 2 : 1
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`battle:${kind}:${sessionId}:${nextScale}`)
      .setLabel(currentScale === 1 ? 'Открыть в 2×' : 'Вернуть 1×')
      .setStyle(ButtonStyle.Secondary),
  )
}
