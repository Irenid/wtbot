export const BATTLE_HEATMAP_KINDS = [
  'heatmap-ground',
  'heatmap-air',
  'heatmap-team-0',
  'heatmap-team-1',
  'heatmap-team-air-0',
  'heatmap-team-air-1',
] as const

export type BattleHeatmapKind = (typeof BATTLE_HEATMAP_KINDS)[number]
export type BattleMediaKind = 'log' | BattleHeatmapKind | 'chat'

const heatmapKinds = new Set<string>(BATTLE_HEATMAP_KINDS)

export function isBattleHeatmapKind(kind: string): kind is BattleHeatmapKind {
  return heatmapKinds.has(kind)
}

export function heatmapSelection(kind: BattleHeatmapKind): { mode: 'ground' | 'air'; teamIndex?: number } {
  if (kind === 'heatmap-ground') return { mode: 'ground' }
  if (kind === 'heatmap-air') return { mode: 'air' }
  if (kind === 'heatmap-team-0') return { mode: 'ground', teamIndex: 0 }
  if (kind === 'heatmap-team-1') return { mode: 'ground', teamIndex: 1 }
  if (kind === 'heatmap-team-air-0') return { mode: 'air', teamIndex: 0 }
  return { mode: 'air', teamIndex: 1 }
}
