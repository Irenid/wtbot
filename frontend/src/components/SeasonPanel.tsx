import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { ClanSeasonContext, ClanSeasonStage, OfficialClanSeason } from '../api'
import { localeTag, t, tp } from '../i18n'
import type { MessageKey } from '../i18n/ru'
import { fmtInt } from '../lib/format'
import { BATTLE_WINDOWS } from '../pages/guides/measurements'

const MINUTE_SEC = 60
const HOUR_SEC = 3_600
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

/** A narrow column's date: the day, with the month at the first stage and where it changes ("Sep 1", "8", "Oct 6"). */
function axisDay(stage: ClanSeasonStage, previous: ClanSeasonStage | undefined): string {
  const start = new Date(stage.startsAt * 1000)
  return previous !== undefined && new Date(previous.startsAt * 1000).getUTCMonth() === start.getUTCMonth()
    ? String(start.getUTCDate())
    : shortDay(stage.startsAt)
}

/**
 * "2 days 10 hours", "5 hours", "40 minutes": whole units, minutes only in the last hour.
 * Counted from whole minutes rounded up, so never "0 minutes" or "60 minutes".
 */
function duration(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds / MINUTE_SEC)) * MINUTE_SEC
  if (total >= DAY_SEC) {
    const days = tp('season.days', Math.floor(total / DAY_SEC))
    const hours = Math.floor((total % DAY_SEC) / HOUR_SEC)
    return hours === 0 ? days : `${days} ${tp('season.hours', hours)}`
  }
  if (total >= HOUR_SEC) return tp('season.hours', Math.floor(total / HOUR_SEC))
  return tp('season.minutes', total / MINUTE_SEC)
}

/** The hour format of the viewer's clock: "17:00" and "01:00", or "5:00 PM" where the locale counts 12 hours. */
function hourOption(): 'numeric' | '2-digit' {
  return new Intl.DateTimeFormat(localeTag(), { hour: 'numeric' }).resolvedOptions().hour12 === true ? 'numeric' : '2-digit'
}

/** Local time of day, never split across lines: "01:00", "1:00 AM". */
function clock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString(localeTag(), { hour: hourOption(), minute: '2-digit' }).replace(/\s/g, '\u00a0')
}

/** Local weekday, date and time: "Tue, Oct 6, 3:00 AM" (stage dates are UTC days, this is the moment). */
function moment(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(localeTag(), {
    weekday: 'short', day: 'numeric', month: 'short', hour: hourOption(), minute: '2-digit',
  })
}

/** Unix seconds, refreshed every 30 s: the countdown, the current stage and the battle status follow the clock on an open page. */
function useNowSec(): number {
  const [now, setNow] = useState(() => Date.now() / 1_000)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1_000), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** Whether a battle window is open now, and when it closes or the next one opens. */
function battleState(now: number): { open: boolean; at: number } {
  const today = Math.floor(now / DAY_SEC) * DAY_SEC
  let opensAt = Number.POSITIVE_INFINITY
  for (const day of [today - DAY_SEC, today, today + DAY_SEC]) {
    for (const window of BATTLE_WINDOWS) {
      const start = day + window.start * HOUR_SEC
      const end = day + window.end * HOUR_SEC
      if (now >= start && now < end) return { open: true, at: end }
      if (start > now) opensAt = Math.min(opensAt, start)
    }
  }
  return { open: false, at: opensAt }
}

/** The daily battle windows on the viewer's clock, the earliest first: "04:00–10:00 and 17:00–01:00". */
function windowTimes(now: number): string {
  const today = Math.floor(now / DAY_SEC) * DAY_SEC
  const localHour = (timestamp: number): number => {
    const date = new Date(timestamp * 1000)
    return date.getHours() + date.getMinutes() / 60
  }
  const windows = BATTLE_WINDOWS
    .map((window) => ({ start: today + window.start * HOUR_SEC, end: today + window.end * HOUR_SEC }))
    .sort((a, b) => localHour(a.start) - localHour(b.start))
    .map((window) => `${clock(window.start)}–${clock(window.end)}`)
  return new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(windows)
}

/** A message with nodes in its {placeholders}: t() fills them with markers, which are then split out. */
function richT(key: MessageKey, nodes: Record<string, ReactNode>): ReactNode[] {
  const names = Object.keys(nodes)
  const marked = t(key, Object.fromEntries(names.map((name, index) => [name, `\u0000${index}\u0000`])))
  return marked.split('\u0000').map((part, index) => {
    const name = index % 2 === 1 ? names[Number(part)] : undefined
    return name === undefined ? part : <Fragment key={index}>{nodes[name]}</Fragment>
  })
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8l2.25 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.25 6.75h11.5M5.5 1.75v3M10.5 1.75v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** A ring filled to the share of the season gone, from the top clockwise. */
function ProgressIcon({ share }: { share: number }) {
  return (
    <svg className="season-panel__ring" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.75" opacity="0.3" />
      <circle
        cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round"
        pathLength="100" strokeDasharray={`${(share * 100).toFixed(1)} 100`} transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/** The next max BR and when it starts (br null — the season's end, from its last stage), over the stage at index. */
interface StageChange { index: number; at: number; br: number | null }

/** Counted from the current stage, between stages from the next one; null — nothing ahead. */
function nextChange(stages: readonly ClanSeasonStage[], seasonEndsAt: number, now: number): StageChange | null {
  const currentIndex = stages.findIndex((stage) => now >= stage.startsAt && now < stage.endsAt)
  const current = stages[currentIndex]
  if (current !== undefined && current.endsAt >= seasonEndsAt) return { index: currentIndex, at: current.endsAt, br: null }
  const nextIndex = stages.findIndex((stage) => stage.startsAt > now)
  const next = stages[nextIndex]
  return next === undefined ? null : { index: current !== undefined ? currentIndex : nextIndex, at: next.startsAt, br: next.maxBr }
}

/**
 * The countdown in a gold bubble over its stage's max BR, centred on the stage's column (--x of the
 * track's width). Hover: the exact moment in the viewer's time zone (stage dates are UTC days).
 */
function SeasonCountdown({ change, stageCount, now }: { change: StageChange; stageCount: number; now: number }) {
  const time = <b>{duration(change.at - now)}</b>
  return (
    <div className="season-countdown" style={{ '--x': ((change.index + 0.5) / stageCount).toFixed(4) } as CSSProperties}>
      <span className="season-countdown__bubble" title={moment(change.at)}>
        <ClockIcon />
        <span>
          {change.br === null
            ? richT('season.endsIn', { time })
            : richT('season.nextBr', { br: <b className="season-countdown__br">{change.br.toFixed(1)}</b>, time })}
        </span>
      </span>
    </div>
  )
}

/** Squadron battles: open now (a gold pulse) and until when, or when the next window opens; the hover names the daily windows. */
function BattleStatus({ now }: { now: number }) {
  const { open, at } = battleState(now)
  return (
    <span className={`season-battles${open ? ' is-open' : ''}`} title={t('season.windowsTitle', { windows: windowTimes(now) })}>
      <span className="season-battles__dot" aria-hidden="true" />
      <span>{richT(open ? 'season.battlesUntil' : 'season.battlesFrom', { time: <b>{clock(at)}</b> })}</span>
    </span>
  )
}

/** "day 35 of 61", the day in bold, by a ring of the share gone: the current UTC day of the season, counting from 1. */
function SeasonDay({ startsAt, endsAt, now }: { startsAt: number; endsAt: number; now: number }) {
  if (now < startsAt || now >= endsAt) return null
  return (
    <span className="season-panel__part">
      <ProgressIcon share={(now - startsAt) / (endsAt - startsAt)} />
      <span>
        {richT('season.day', {
          n: <b>{fmtInt(Math.floor((now - startsAt) / DAY_SEC) + 1)}</b>,
          total: fmtInt(Math.round((endsAt - startsAt) / DAY_SEC)),
        })}
      </span>
    </span>
  )
}

/** Every stage's max BR on one rail, its start date under it; the current stage is gold. */
function SeasonTrack({ stages, seasonEndsAt, now }: { stages: ClanSeasonStage[]; seasonEndsAt: number; now: number }) {
  const currentIndex = stages.findIndex((stage) => now >= stage.startsAt && now < stage.endsAt)
  const current = currentIndex >= 0 ? stages[currentIndex] : undefined
  // The gold part of the rail ends at the current stage, or at the last one begun.
  const reached = currentIndex >= 0 ? currentIndex : Math.max(0, stages.filter((stage) => stage.startsAt <= now).length - 1)
  // A node is its stage's start, so the gold runs on to this moment: the elapsed share of
  // the way to the next node (the last stage has none).
  const elapsed = current !== undefined && currentIndex < stages.length - 1
    ? (now - current.startsAt) / (current.endsAt - current.startsAt)
    : 0
  const style = { '--n': stages.length, '--i': (reached + elapsed).toFixed(4) } as CSSProperties

  return (
    <ol className="season-track" style={style} aria-label={t('a11y.seasonStages')}>
      {stages.map((stage, index) => {
        const state = index === currentIndex ? 'current' : stage.endsAt <= now ? 'past' : 'next'
        return (
          <li
            key={stage.week}
            className={`season-track__stage is-${state}`}
            style={{ '--s': index } as CSSProperties}
            aria-current={state === 'current' ? 'step' : undefined}
            title={`${stageLabel(stage, seasonEndsAt)} · ${stageRange(stage)}`}
          >
            <span className="season-track__br">{stage.maxBr.toFixed(1)}</span>
            <span className="season-track__node" aria-hidden="true" />
            {/* One of the two is displayed, by the column's width. */}
            <span className="season-track__date">{shortDay(stage.startsAt)}</span>
            <span className="season-track__axis">{axisDay(stage, stages[index - 1])}</span>
          </li>
        )
      })}
    </ol>
  )
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
  const now = useNowSec()
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

  if (compact) {
    const current = context.currentStage
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

  // The client's clock, not the API's answer: an open page follows the season's end.
  const live = season.active && now < season.endsAt
  const change = live ? nextChange(context.stages, season.endsAt, now) : null

  return (
    <section className="card season-panel" aria-label={heading}>
      <div className="season-panel__head">
        <div className="season-panel__title">
          <div className="sec-head">
            <h2>
              {sameDates
                ? richT('season.titleNumbered', { n: <span className="season-panel__no">{official.seasonId}</span> })
                : heading}
            </h2>
          </div>
          {/* Each part wraps whole: "Tag 35 von 61" never splits in a guide column. */}
          <div className="season-panel__meta">
            <span className="season-panel__part"><CalendarIcon /><span>{range}</span></span>
            {live
              ? <SeasonDay startsAt={season.startsAt} endsAt={season.endsAt} now={now} />
              : <span className="season-panel__part">{t('season.ended')}</span>}
          </div>
        </div>
        {live && <BattleStatus now={now} />}
      </div>
      {change !== null && <SeasonCountdown change={change} stageCount={context.stages.length} now={now} />}
      {context.stages.length > 0 && <SeasonTrack stages={context.stages} seasonEndsAt={season.endsAt} now={now} />}
      {mismatch && <div className="notice small">{mismatch}</div>}
    </section>
  )
}
