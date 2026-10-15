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
  if (!Number.isSafeInteger(timestamp)) throw new Error(`invalid season date: ${value}`)
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

/**
 * Checks a schedule: stages follow each other without gaps or overlaps, the
 * first starts with the season and the last ends with it, weeks count from 1,
 * seasons do not overlap. A schedule error fails startup instead of quietly
 * giving wrong rating bounds.
 */
export function validateClanSeasonSchedules(schedules: readonly ClanSeasonSchedule[]): void {
  const ids = new Set<string>()
  const sorted = [...schedules].sort((left, right) => left.startsAt - right.startsAt)
  sorted.forEach((season, index) => {
    const label = `season ${season.id}`
    if (ids.has(season.id)) throw new Error(`${label}: duplicate id`)
    ids.add(season.id)
    if (!(season.endsAt > season.startsAt)) throw new Error(`${label}: the end is not after the start`)
    const previous = sorted[index - 1]
    if (previous !== undefined && season.startsAt < previous.endsAt) {
      throw new Error(`${label}: overlaps season ${previous.id}`)
    }
    if (season.stages.length === 0) throw new Error(`${label}: no stages`)
    let expectedStart = season.startsAt
    season.stages.forEach((stage, stageIndex) => {
      if (stage.week !== stageIndex + 1) throw new Error(`${label}: stages must be numbered 1, 2, 3…`)
      if (stage.startsAt !== expectedStart) throw new Error(`${label}: a gap or overlap before stage ${stage.week}`)
      if (!(stage.endsAt > stage.startsAt)) throw new Error(`${label}: stage ${stage.week} is empty`)
      if (!(stage.maxBr > 0)) throw new Error(`${label}: stage ${stage.week} has no max BR`)
      expectedStart = stage.endsAt
    })
    if (expectedStart !== season.endsAt) throw new Error(`${label}: the last stage does not end with the season`)
  })
}

/**
 * Встроенные сезоны. Новые сезоны бот берёт сам с форума
 * (clan-season-forum.ts, источник wt-clan-season) с id `forum-ГГГГ-ММ-ДД`;
 * сюда их добавлять не нужно. Старые записи не переписываются,
 * seedClanSeasons() синхронизирует SQLite с этим списком.
 */
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

/**
 * A stage's max BR plays from 14:00 UTC of its first day, not the schedule's 00:00: that day's
 * 01:00–07:00 UTC window still plays the previous cap, the 14:00 window the new one (5 of 5
 * switches, 2026-07-22…10-13). No battle starts 07:00–14:00 UTC (57,682 battles to 2026-10-15),
 * so any delay in that gap sorts battles alike; 14 h is when the new cap becomes playable. The
 * rating season (leaderboard, PSR) keeps the UTC days: season 62 is [09-01, 11-01) 00:00 UTC.
 */
export const STAGE_SWITCH_DELAY_SEC = 14 * 3600

/** The stage whose max BR plays at atSec: stages shifted by STAGE_SWITCH_DELAY_SEC. */
export function stageAt<T extends Pick<ClanSeasonStage, 'startsAt' | 'endsAt'>>(stages: readonly T[], atSec: number): T | null {
  const scheduleTime = atSec - STAGE_SWITCH_DELAY_SEC
  return stages.find((stage) => scheduleTime >= stage.startsAt && scheduleTime < stage.endsAt) ?? null
}

validateClanSeasonSchedules(CLAN_SEASON_SCHEDULES)
