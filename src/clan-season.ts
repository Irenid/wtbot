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

/**
 * Проверяет расписание: этапы идут подряд без дыр и перекрытий, первый
 * начинается вместе с сезоном, последний заканчивается вместе с ним, недели
 * нумеруются с 1, сезоны не пересекаются. Ошибка в расписании — ошибка
 * старта, а не тихо неверные рейтинговые границы.
 */
export function validateClanSeasonSchedules(schedules: readonly ClanSeasonSchedule[]): void {
  const ids = new Set<string>()
  const sorted = [...schedules].sort((left, right) => left.startsAt - right.startsAt)
  sorted.forEach((season, index) => {
    const label = `сезон ${season.id}`
    if (ids.has(season.id)) throw new Error(`${label}: повторяющийся id`)
    ids.add(season.id)
    if (!(season.endsAt > season.startsAt)) throw new Error(`${label}: конец не позже начала`)
    const previous = sorted[index - 1]
    if (previous !== undefined && season.startsAt < previous.endsAt) {
      throw new Error(`${label}: пересекается с сезоном ${previous.id}`)
    }
    if (season.stages.length === 0) throw new Error(`${label}: нет этапов`)
    let expectedStart = season.startsAt
    season.stages.forEach((stage, stageIndex) => {
      if (stage.week !== stageIndex + 1) throw new Error(`${label}: этапы должны нумероваться 1, 2, 3…`)
      if (stage.startsAt !== expectedStart) throw new Error(`${label}: дыра или перекрытие перед этапом ${stage.week}`)
      if (!(stage.endsAt > stage.startsAt)) throw new Error(`${label}: этап ${stage.week} пустой`)
      if (!(stage.maxBr > 0)) throw new Error(`${label}: этап ${stage.week} без максимального БР`)
      expectedStart = stage.endsAt
    })
    if (expectedStart !== season.endsAt) throw new Error(`${label}: последний этап не совпадает с концом сезона`)
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

export function stageAt(
  season: Pick<ClanSeasonSchedule, 'stages'>,
  atSec: number,
): ClanSeasonStage | null {
  return season.stages.find((stage) => atSec >= stage.startsAt && atSec < stage.endsAt) ?? null
}

validateClanSeasonSchedules(CLAN_SEASON_SCHEDULES)
