import type { ClanSeasonContext, ClanSeasonStage } from '../api'
import { localeTag, t } from '../i18n'

function stageRange(stage: ClanSeasonStage): string {
  const format = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleDateString(localeTag(), { dateStyle: 'short', timeZone: 'UTC' })
  return `${format(stage.startsAt)}–${format(stage.endsAt - 1)}`
}

function stageLabel(stage: ClanSeasonStage, seasonEndsAt: number): string {
  const week = stage.endsAt === seasonEndsAt ? t('season.untilEnd') : t('season.week', { n: stage.week })
  return `${week} · ${t('season.maxBr', { br: stage.maxBr.toFixed(1) })}`
}

export function SeasonPanel({ context, compact = false }: { context: ClanSeasonContext; compact?: boolean }) {
  const season = context.season
  if (!season) return null
  const current = context.currentStage
  const currentText = current
    ? `${stageLabel(current, season.endsAt)} · ${stageRange(current)}`
    : season.active
      ? t('season.waiting')
      : t('season.ended')

  if (compact) {
    return (
      <div className="notice" style={{ marginBottom: 16 }}>
        <strong>{t('season.title')}: {season.name}</strong>
        <span className="muted" style={{ marginLeft: 8 }}>{currentText}</span>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>{t('season.title')}: {season.name}</h2>
          <div className="muted small">
            {new Date(season.startsAt * 1000).toLocaleDateString(localeTag(), { dateStyle: 'short', timeZone: 'UTC' })}
            {' – '}
            {new Date((season.endsAt - 1) * 1000).toLocaleDateString(localeTag(), { dateStyle: 'short', timeZone: 'UTC' })}
          </div>
        </div>
        <span className="chip accent">{current ? currentText : season.active ? t('season.waiting') : t('season.ended')}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 14 }}>
        {context.stages.map((stage) => (
          <div
            key={stage.week}
            className={`chip${current?.week === stage.week ? ' accent' : ''}`}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 10px' }}
          >
            <span>{stageLabel(stage, season.endsAt)}</span>
            <span className="muted">{stageRange(stage)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
