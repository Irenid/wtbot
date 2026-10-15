import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { BotText } from '../i18n/index.js'
import type { BattleHeatmapKind } from '../wrpl/battle-media-kind.js'

export type HeatmapScale = 1 | 2

/** The scale whose file fits the attachment limit of the current Discord interaction. */
export function heatmapScaleForUpload(
  requestedScale: HeatmapScale,
  byteLength: number,
  attachmentSizeLimit: number,
): HeatmapScale {
  return requestedScale === 2 && byteLength > attachmentSizeLimit ? 1 : requestedScale
}

export function heatmapQualityRow(
  kind: BattleHeatmapKind,
  sessionId: string,
  currentScale: HeatmapScale,
  t: BotText,
): ActionRowBuilder<ButtonBuilder> {
  const nextScale: HeatmapScale = currentScale === 1 ? 2 : 1
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`battle:${kind}:${sessionId}:${nextScale}`)
      .setLabel(currentScale === 1 ? t.battle.buttons.scaleUp : t.battle.buttons.scaleDown)
      .setStyle(ButtonStyle.Secondary),
  )
}
