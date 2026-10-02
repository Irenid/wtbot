import type { ClanSeasonContext, ClanSeasonStage, OfficialClanSeason } from '../api'
import { localeTag, t } from '../i18n'

function dayRange(startsAt: number, endsAt: number): string {
  const format = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleDateString(localeTag(), { dateStyle: 'short', timeZone: 'UTC' })
  return `${format(startsAt)}–${format(endsAt - 1)}`
}

function stageRange(stage: ClanSeasonStage): string {
  return dayRange(stage.startsAt, stage.endsAt)
}

function stageLabel(stage: ClanSeasonStage, seasonEndsAt: number): string {
  const week = stage.endsAt === seasonEndsAt ? t('season.untilEnd') : t('season.week', { n: stage.week })
  return `${week} · ${t('season.maxBr', { br: stage.maxBr.toFixed(1) })}`
}

/**
 * Расписание этапов — с форума, номер сезона — из лидерборда игры. Если даты
 * игры и форума разошлись, этапы могут быть неверны: об этом говорим прямо.
 */
export function SeasonPanel({ context, official = null, compact = false }: {
  context: ClanSeasonContext
  official?: OfficialClanSeason | null
  compact?: boolean
}) {
  const season = context.season
  if (!season) return null
  // Название сезона с форума собирается по-русски, поэтому заголовок строится
  // из дат на языке интерфейса; номер — из игры, если её даты совпадают.
  const sameDates = official !== null && official.startsAt === season.startsAt && official.endsAt === season.endsAt
  const heading = sameDates ? t('season.titleNumbered', { n: official.seasonId }) : t('season.title')
  const range = dayRange(season.startsAt, season.endsAt)
  const mismatch = official !== null && !sameDates
    ? t('season.mismatch', { n: official.seasonId, range: dayRange(official.startsAt, official.endsAt) })
    : null
  const current = context.currentStage
  const currentText = current
    ? `${stageLabel(current, season.endsAt)} · ${stageRange(current)}`
    : season.active
      ? t('season.waiting')
      : t('season.ended')

  if (compact) {
    return (
      <div className="notice" style={{ marginBottom: 16 }}>
        <strong>{heading}</strong>
        <span className="muted" style={{ marginLeft: 8 }}>{range} · {currentText}</span>
        {mismatch && <div className="small" style={{ marginTop: 4 }}>{mismatch}</div>}
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>{heading}</h2>
          <div className="muted small">{range}</div>
        </div>
        <span className="chip accent">{current ? currentText : season.active ? t('season.waiting') : t('season.ended')}</span>
      </div>
      {mismatch && <div className="notice small">{mismatch}</div>}
      {/* Этап и даты — в две строки: в одну они шире колонки и вылезали за плашку. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))', gap: 8, marginTop: 14 }}>
        {context.stages.map((stage) => (
          <div
            key={stage.week}
            className={`chip${current?.week === stage.week ? ' accent' : ''}`}
            style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 10, whiteSpace: 'normal' }}
          >
            <span>{stageLabel(stage, season.endsAt)}</span>
            <span className="muted">{stageRange(stage)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
