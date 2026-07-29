export interface ClanSeasonStage {
  week: number
  startsAt: number
  endsAt: number
  maxBr: number
}

export interface ClanSeasonSchedule {
  id: string
  name: string
  startsAt: number
  endsAt: number
  stages: readonly ClanSeasonStage[]
}

function utcDate(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isSafeInteger(timestamp)) throw new Error(`Некорректная дата сезона: ${value}`)
  return timestamp / 1_000
}

const seasonStages = [
  ['2026-07-01', '2026-07-08', 14.7],
  ['2026-07-08', '2026-07-15', 12.0],
  ['2026-07-15', '2026-07-22', 10.7],
  ['2026-07-22', '2026-07-29', 9.7],
  ['2026-07-29', '2026-08-05', 8.7],
  ['2026-08-05', '2026-08-12', 7.3],
  ['2026-08-12', '2026-08-19', 6.3],
  ['2026-08-19', '2026-08-26', 5.7],
  ['2026-08-26', '2026-09-01', 4.7],
] as const

/** Расписание нужно менять добавлением новой записи, старые сезоны не переписываются. */
export const CLAN_SEASON_SCHEDULES: readonly ClanSeasonSchedule[] = [
  {
    id: '2026-summer',
    name: 'Сезон 2026',
    startsAt: utcDate('2026-07-01'),
    endsAt: utcDate('2026-09-01'),
    stages: seasonStages.map(([starts, ends, maxBr], index) => ({
      week: index + 1,
      startsAt: utcDate(starts),
      endsAt: utcDate(ends),
      maxBr,
    })),
  },
]

export function stageAt(
  season: Pick<ClanSeasonSchedule, 'stages'>,
  atSec: number,
): ClanSeasonStage | null {
  return season.stages.find((stage) => atSec >= stage.startsAt && atSec < stage.endsAt) ?? null
}
