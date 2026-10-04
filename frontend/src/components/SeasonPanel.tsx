import type { CSSProperties } from 'react'
import type { ClanSeasonContext, ClanSeasonStage, OfficialClanSeason } from '../api'
import { localeTag, t, tp } from '../i18n'

const DAY_SEC = 86_400

/** UTC days of a [startsAt, endsAt) range: "Sep 1 – Oct 31, 2026", the year only where asked. */
function dayRange(startsAt: number, endsAt: number, withYear = true): string {
  const options: Intl.DateTimeFormatOptions = withYear
    ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' }
  return new Intl.DateTimeFormat(localeTag(), options).formatRange(new Date(startsAt * 1000), new Date((endsAt - 1) * 1000))
}

/** Without the year: the season range next to it carries it. */
function stageRange(stage: ClanSeasonStage): string {
  return dayRange(stage.startsAt, stage.endsAt, false)
}

function stageLabel(stage: ClanSeasonStage, seasonEndsAt: number): string {
  const week = stage.endsAt === seasonEndsAt ? t('season.untilEnd') : t('season.week', { n: stage.week })
  return `${week} · ${t('season.maxBr', { br: stage.maxBr.toFixed(1) })}`
}

/** "Oct 6" in UTC. */
function shortDay(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** Numeric day and month without zero padding ("9/29", "29.9"): fits a chart column on a phone. */
function numericDay(timestamp: number): string {
  return new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'numeric', timeZone: 'UTC' })
    .formatToParts(new Date(timestamp * 1000))
    .map((part) => (part.type === 'day' || part.type === 'month' ? String(Number(part.value)) : part.value))
    .join('')
}

/** Axis label under a narrow chart: the day, with the month where it changes ("9/29", "10/6", "13"). */
function axisDay(stage: ClanSeasonStage, previous: ClanSeasonStage | undefined): string {
  const start = new Date(stage.startsAt * 1000)
  return previous !== undefined && new Date(previous.startsAt * 1000).getUTCMonth() === start.getUTCMonth()
    ? String(start.getUTCDate())
    : numericDay(stage.startsAt)
}

/**
 * Stage schedule from the forum, season number from the game's leaderboard. If
 * the game's and the forum's dates disagree, the stages may be wrong: say so.
 */
export function SeasonPanel({ context, official = null, compact = false }: {
  context: ClanSeasonContext
  official?: OfficialClanSeason | null
  compact?: boolean
}) {
  const season = context.season
  if (!season) return null
  // The forum's season name is Russian, so the heading is built from dates in
  // the UI language; the number comes from the game when its dates match.
  const sameDates = official !== null && official.startsAt === season.startsAt && official.endsAt === season.endsAt
  const heading = sameDates ? t('season.titleNumbered', { n: official.seasonId }) : t('season.title')
  const range = dayRange(season.startsAt, season.endsAt)
  const mismatch = official !== null && !sameDates
    ? t('season.mismatch', { n: official.seasonId, range: dayRange(official.startsAt, official.endsAt) })
    : null
  const current = context.currentStage

  if (compact) {
    const currentText = current
      ? `${stageLabel(current, season.endsAt)} · ${stageRange(current)}`
      : season.active ? t('season.waiting') : t('season.ended')
    return (
      <div className="notice" style={{ marginBottom: 16 }}>
        <strong>{heading}</strong>
        <span className="muted" style={{ marginLeft: 8 }}>{range} · {currentText}</span>
        {mismatch && <div className="small" style={{ marginTop: 4 }}>{mismatch}</div>}
      </div>
    )
  }

  const now = Date.now() / 1_000
  const stages = context.stages
  // Between stages the summary shows the next one to start.
  const focus = current ?? stages.find((stage) => stage.startsAt > now) ?? null
  const following = current === null ? null : stages.find((stage) => stage.startsAt >= current.endsAt) ?? null
  const currentIndex = current === null ? -1 : stages.findIndex((stage) => stage.week === current.week)
  const progress = current === null ? 0 : Math.min(1, Math.max(0, (now - current.startsAt) / (current.endsAt - current.startsAt)))
  // The line under the bars: stages behind plus the elapsed part of the current one.
  const doneStages = currentIndex >= 0 ? currentIndex : stages.filter((stage) => stage.endsAt <= now).length
  const topBr = Math.max(1, ...stages.map((stage) => stage.maxBr))
  const totalDays = Math.round((season.endsAt - season.startsAt) / DAY_SEC)
  const day = Math.min(totalDays, Math.max(1, Math.floor((now - season.startsAt) / DAY_SEC) + 1))
  const focusLabel = current === null
    ? season.active ? t('season.waiting') : t('season.ended')
    : current.endsAt === season.endsAt
      ? `${t('season.week', { n: current.week })} · ${t('season.untilEnd')}`
      : t('season.week', { n: current.week })
  // Without a stage to show, the summary card carries the season range itself.
  const meta = [focus === null ? null : range, season.active ? t('season.day', { n: day, total: totalDays }) : null]
    .filter((part) => part !== null)
    .join(' · ')

  return (
    <section className="card season-panel" aria-label={heading}>
      <div className="season-panel__head">
        <div className="sec-head"><h2>{heading}</h2></div>
        {meta !== '' && <span className="season-panel__meta">{meta}</span>}
      </div>
      <div className="season-panel__body">
        <div className="season-focus">
          {focus !== null && (
            <div className="season-focus__br">
              <b>{focus.maxBr.toFixed(1)}</b>
              <small>{t('season.maxBrCaption')}</small>
            </div>
          )}
          <div className="season-focus__info">
            <span className="season-focus__label">
              {current !== null && <span className="season-focus__live" aria-hidden="true" />}
              {focusLabel}
            </span>
            <span className="season-focus__dates">
              {focus === null ? range : stageRange(focus)}
              {current !== null && (
                <span className="chip accent">{tp('season.daysLeft', Math.max(1, Math.ceil((current.endsAt - now) / DAY_SEC)))}</span>
              )}
            </span>
            {following !== null && (
              <span className="season-focus__next">
                {t('season.next', { br: following.maxBr.toFixed(1), date: shortDay(following.startsAt) })}
              </span>
            )}
          </div>
        </div>
        {stages.length > 0 && (
          <div className="season-chart-box">
            <ol
              className="season-chart"
              aria-label={t('a11y.seasonStages')}
              style={{ '--n': stages.length, '--i': doneStages, '--p': progress.toFixed(3) } as CSSProperties}
            >
              {stages.map((stage, index) => {
                const state = index === currentIndex ? 'current' : stage.endsAt <= now ? 'past' : 'next'
                return (
                  <li
                    key={stage.week}
                    className={`season-chart__stage is-${state}`}
                    aria-current={state === 'current' ? 'step' : undefined}
                    title={`${stageLabel(stage, season.endsAt)} · ${stageRange(stage)}`}
                    style={{ '--h': (stage.maxBr / topBr).toFixed(3), '--delay': `${index * 45}ms` } as CSSProperties}
                  >
                    <span className="season-chart__slot">
                      <span className="season-chart__value">{stage.maxBr.toFixed(1)}</span>
                      <span className="season-chart__bar" />
                      {state === 'current' && <span className="season-chart__now" aria-hidden="true" />}
                    </span>
                    <span className="season-chart__week">{t('season.week', { n: stage.week })}</span>
                    <span className="season-chart__dates">{numericDay(stage.startsAt)}–{numericDay(stage.endsAt - 1)}</span>
                    <span className="season-chart__axis">{axisDay(stage, stages[index - 1])}</span>
                  </li>
                )
              })}
            </ol>
          </div>
        )}
      </div>
      {mismatch && <div className="notice small">{mismatch}</div>}
    </section>
  )
}
