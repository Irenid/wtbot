import { useEffect, useState, type ReactNode } from 'react'
import { fetchClans, type ClanListEntry, type ClanSeasonContext, type OfficialClanSeason } from '../../api'
import { SeasonPanel } from '../../components/SeasonPanel'
import { Loading } from '../../components/ui'
import type { DecideRow, GuideAudience, GuideSlug, GuideText, QuickId, QuickNums } from '../../i18n/guide'
import { fmtDateTime } from '../../lib/format'
import {
  PSR_K,
  PSR_MIN_LOSS,
  PSR_REFERENCE,
  PSR_SCALE,
  SQUADRON_REST_SHARE,
  SQUADRON_TOP,
  battlesToReach,
  breakEvenWinRate,
  expectedChange,
  fullWinBelow,
  lossPoints,
  psrCeiling,
  winPoints,
  winsInARow,
} from '../../lib/psr'
import { Calculator } from './Calculator'
import {
  ACTIVITY,
  BATTLES,
  BATTLE_FLOW,
  BATTLE_WINDOWS,
  DATA_PERIODS,
  FIT,
  MAP_SIDES,
  MATCHMAKING,
  MEASURED_AT,
  NOT_LOADED,
  PACE,
  PEAK_HOURS,
  PSR_DISTRIBUTION,
  SQUADRON_GAP,
  TEAM_PSR_GAP,
  TIMING,
  type GapRow,
} from './measurements'
import { Change, FormulaBlock, GuideTable, Paras, Rich, dayMonth, localHour, longDate, num, pct, psrText, utcTime } from './parts'

export interface GuideSection {
  /** Anchor: /guides/<slug>#<id>; guide texts link to these. */
  id: string
  title: string
  body: ReactNode
}

export interface GuideArticle {
  lead: string
  sections: readonly GuideSection[]
}

/** The rule behind every computed table, in the public repository (AGPL source link, App.tsx SOURCE_URL). */
const PSR_SOURCE_URL = 'https://github.com/Irenid/wtbot/blob/master/frontend/src/lib/psr.ts'

/** A level counts as reached within this many points (the "battles from zero" column). */
const NEAR = 50

const round10 = (value: number) => Math.round(value / 10) * 10

function gapLabel(g: GuideText, row: GapRow): string {
  return row.to === null ? g.ui.over(num(row.from)) : `${num(row.from)}–${num(row.to)}`
}

function battleCount(rows: readonly GapRow[]): number {
  return rows.reduce((total, row) => total + row.battles, 0)
}

/** Seconds as the locale's "5 мин 37 с". */
function minSec(g: GuideText, seconds: number): string {
  const whole = Math.round(seconds)
  return g.ui.minSec({ min: num(Math.floor(whole / 60)), sec: num(whole % 60) })
}

/** Battle end → new PSR on warthunder.com, in whole minutes for prose (at least 1). */
function delayNums(): { min: string; max: string; median: string } {
  return {
    min: num(Math.max(1, Math.round(TIMING.delay.min))),
    max: num(Math.round(TIMING.delay.max)),
    median: num(Math.round(TIMING.delay.median)),
  }
}

function psrArticle(g: GuideText): GuideArticle {
  const p = g.psr
  const fullWin = fullWinBelow()
  const pointsAt = (value: number, label: string): ReactNode[] => [
    label,
    <Change value={winPoints(value)} />,
    <Change value={-lossPoints(value)} />,
    pct(breakEvenWinRate(value)),
  ]
  const pointRows = [pointsAt(fullWin, g.ui.upTo(psrText(fullWin)))]
  let evenRow = 0
  for (let value = 900; value <= 2100; value += 100) {
    if (value === PSR_REFERENCE) evenRow = pointRows.length
    pointRows.push(pointsAt(value, psrText(value)))
  }

  const ceilingRates = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]
  const ceilingRows = ceilingRates.map((rate) => {
    const level = psrCeiling(rate)
    const battles = battlesToReach(0, level - NEAR, rate)
    return [pct(rate, 0), psrText(round10(level)), battles === null ? '—' : num(battles)]
  })
  const streaks: readonly (readonly [number, number])[] = [
    [0, 1000], [0, 1500], [1500, 1800], [1800, 2000], [2000, 2100], [2100, 2200], [2200, 2300],
  ]
  const streakRows = streaks.map(([from, to]) => {
    const wins = winsInARow(from, to)
    return [psrText(from), psrText(to), wins === null ? '—' : num(wins)]
  })

  const f = p.formula
  const width = Math.max(f.win.length, f.loss.length) + 2
  const label = (text: string) => `${text}:`.padEnd(width)
  const formulaLines = [
    `x = (${PSR_REFERENCE} − ${g.term}) / ${PSR_SCALE}`,
    'E = 1 / (1 + 10^x)',
    `${label(f.win)}+ ${PSR_K} × (1 − E)`,
    `${label(f.loss)}− ${PSR_K} × E, ${f.atLeast(String(PSR_MIN_LOSS))}`,
    f.floor,
  ]

  return {
    lead: p.lead,
    sections: [
      {
        id: 'points',
        title: p.points.title,
        body: <><GuideTable head={p.points.head} rows={pointRows} mark={evenRow} /><Paras items={p.points.notes} /></>,
      },
      {
        id: 'calculator',
        title: p.calc.title,
        body: <><p className="guide-p">{p.calc.intro}</p><Calculator g={g} /></>,
      },
      {
        id: 'factors',
        title: p.factors.title,
        body: <ul className="guide-list">{p.factors.items.map((item, index) => <li key={index}><Rich text={item} /></li>)}</ul>,
      },
      {
        id: 'ceiling',
        title: p.ceiling.title,
        body: (
          <>
            <p className="guide-p">{p.ceiling.intro}</p>
            <GuideTable head={p.ceiling.head} rows={ceilingRows} mark={ceilingRates.indexOf(0.5)} />
            <Paras items={p.ceiling.notes} />
            <p className="guide-p">{p.ceiling.streaks}</p>
            <GuideTable head={p.ceiling.streakHead} rows={streakRows} />
          </>
        ),
      },
      { id: 'season', title: p.season.title, body: <Paras items={p.season.body} /> },
      {
        id: 'formula',
        title: f.title,
        body: <><FormulaBlock lines={formulaLines} /><Paras items={f.body} /></>,
      },
    ],
  }
}

function squadronArticle(g: GuideText): GuideArticle {
  const s = g.squadron
  const players: readonly (readonly [number, number])[] = [[1300, 0.6], [1500, 0.6], [1600, 0.6], [1800, 0.7]]
  const whoRows = players.map(([value, rate]) => [
    psrText(value),
    pct(rate, 0),
    <Change value={10 * expectedChange(value, rate)} />,
  ])
  const ceilingRates = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9]
  const ceilingRows = ceilingRates.map((rate) => {
    const level = psrCeiling(rate)
    return [pct(rate, 0), psrText(round10(level)), num(Math.round((SQUADRON_TOP * level) / 100) * 100)]
  })
  // Battles from zero to within NEAR of each level, as the "battles from zero" column of the PSR guide.
  const toLevel = ceilingRates.flatMap((rate) => battlesToReach(0, psrCeiling(rate) - NEAR, rate) ?? [])
  const fewest = Math.min(...toLevel)
  const most = Math.max(...toLevel)
  const line = s.formula.line({ top: String(SQUADRON_TOP), share: pct(SQUADRON_REST_SHARE, 0) })

  return {
    lead: s.lead,
    sections: [
      {
        id: 'formula',
        title: s.formula.title,
        body: <><FormulaBlock lines={[line]} /><Paras items={s.formula.body} /></>,
      },
      { id: 'top20', title: s.top20.title, body: <Paras items={s.top20.body} /> },
      {
        id: 'who',
        title: s.who.title,
        body: (
          <>
            <p className="guide-p"><Rich text={s.who.intro} /></p>
            <GuideTable head={s.who.head} rows={whoRows} />
            <Paras items={s.who.notes} />
          </>
        ),
      },
      { id: 'roster', title: s.roster.title, body: <Paras items={s.roster.body} /> },
      {
        id: 'ceiling',
        title: s.ceiling.title,
        body: (
          <>
            <p className="guide-p">{s.ceiling.intro}</p>
            <GuideTable head={s.ceiling.head} rows={ceilingRows} />
            <Paras
              items={s.ceiling.notes({
                battlesLow: num(round10(fewest)),
                battlesHigh: num(round10(most)),
                hoursLow: num(Math.round(fewest / PACE.perHour)),
                hoursHigh: num(Math.round(most / PACE.perHour)),
              })}
            />
          </>
        ),
      },
      { id: 'live', title: s.live.title, body: <LiveLeaderboard g={g} /> },
    ],
  }
}

const LIVE_PLACES = [1, 5, 10, 20, 50, 100]
const LIVE_GROUPS: readonly (readonly [number, number])[] = [[1, 10], [11, 50], [51, 100]]

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
}

/** What a place takes right now and how the leaders differ: /api/clans, the top 100 by place. */
function LiveLeaderboard({ g }: { g: GuideText }) {
  const l = g.squadron.live
  const [clans, setClans] = useState<ClanListEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetchClans()
      .then((data) => { if (!cancelled) setClans(data.clans) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])
  if (failed) return <div className="notice">{l.empty}</div>
  if (clans === null) return <Loading />

  // Only leaderboard clans: a clan outside it ranks by its members' PSR sum and has no season record.
  const official = clans.filter((clan) => clan.seasonBattles !== null)
  if (official.length === 0) return <div className="notice">{l.empty}</div>
  const updatedAt = Math.max(...official.map((clan) => clan.lastSeenAt))
  const placeRows = LIVE_PLACES.flatMap((place) => {
    const clan = official.find((entry) => entry.rank === place)
    return clan ? [[num(place), num(Math.round(clan.totalRating))]] : []
  })
  const groups = LIVE_GROUPS.flatMap(([from, to]) => {
    const inGroup = official.filter((clan) => clan.rank >= from && clan.rank <= to)
    const battles = mean(inGroup.map((clan) => clan.seasonBattles ?? 0))
    if (battles === null) return []
    const winRate = mean(inGroup.flatMap((clan) =>
      clan.seasonBattles && clan.seasonWins !== null ? [clan.seasonWins / clan.seasonBattles] : []))
    return [{ from, label: `${num(from)}–${num(to)}`, battles, winRate, players: mean(inGroup.map((clan) => clan.members)) ?? 0 }]
  })
  const leaders = groups.find((group) => group.from === 1)
  const tail = groups.find((group) => group.from === 51)
  const times = leaders && tail && tail.battles > 0 ? leaders.battles / tail.battles : null

  return (
    <>
      <p className="guide-note">{l.updated(fmtDateTime(updatedAt))}</p>
      <p className="guide-p">{l.places}</p>
      <GuideTable head={l.placesHead} rows={placeRows} />
      <p className="guide-p">{l.groups}</p>
      <GuideTable
        head={l.groupsHead}
        rows={groups.map((group) => [
          group.label,
          group.winRate === null ? '—' : pct(group.winRate),
          num(Math.round(group.battles)),
          num(Math.round(group.players)),
        ])}
      />
      {times !== null && times >= 1.5 && <p className="guide-p"><b>{l.conclusion({ times: num(times, 1) })}</b></p>}
      <p className="guide-note">{l.note}</p>
    </>
  )
}

/** Current season stages from /api/clans; nothing on failure — the text above still explains the season. */
function SeasonLive() {
  const [data, setData] = useState<{ season: ClanSeasonContext; official: OfficialClanSeason | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchClans()
      .then((response) => { if (!cancelled) setData({ season: response.season, official: response.officialSeason }) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  if (data === null) return null
  return <div className="guide-embed"><SeasonPanel context={data.season} official={data.official} /></div>
}

function updatesArticle(g: GuideText): GuideArticle {
  const u = g.updates
  const [first, second] = BATTLE_WINDOWS
  const hours = (start: number, end: number) => `${localHour(start)}–${localHour(end)}`
  return {
    lead: u.lead,
    sections: [
      { id: 'delay', title: u.delay.title, body: <Paras items={u.delay.body(delayNums())} /> },
      { id: 'site', title: u.site.title, body: <Paras items={u.site.body} /> },
      { id: 'season', title: u.season.title, body: <><Paras items={u.season.body} /><SeasonLive /></> },
      {
        id: 'hours',
        title: u.hours.title,
        body: (
          <Paras
            items={u.hours.body({
              first: hours(first.start, first.end),
              second: hours(second.start, second.end),
              peak: hours(PEAK_HOURS.start, PEAK_HOURS.end),
              firstShare: pct(first.share, 0),
              firstPsr: psrText(first.medianTeamPsr),
              secondPsr: psrText(second.medianTeamPsr),
            })}
          />
        ),
      },
    ],
  }
}

function battleArticle(g: GuideText): GuideArticle {
  const b = g.battle
  const f = BATTLE_FLOW
  const d = b.decides
  const widestPsr = TEAM_PSR_GAP.at(-1)
  const widestSquadron = SQUADRON_GAP.at(-1)
  const shares: readonly (readonly [DecideRow, number])[] = [
    ['moreKills', f.moreKillsWins],
    ['firstKill', f.firstKillWins],
    ['fewerKills', f.fewerKillsWins],
    ['notLoaded', NOT_LOADED.oneMore.wins],
    ['bot', NOT_LOADED.bot.wins / NOT_LOADED.bot.battles],
  ]
  const decideRows = [
    ...shares.map(([row, share]) => [d.rows[row], share] as const),
    ...(widestPsr ? [[d.rows.psr({ gap: num(widestPsr.from) }), widestPsr.higherWins] as const] : []),
    ...(widestSquadron ? [[d.rows.squadron({ gap: num(widestSquadron.from) }), widestSquadron.higherWins] as const] : []),
  ]
    .sort((left, right) => right[1] - left[1])
    .map(([label, share]) => [label, pct(share)])
  return {
    lead: b.lead({ battles: num(BATTLES.total) }),
    sections: [
      {
        id: 'vehicles',
        title: b.vehicles.title,
        body: <Paras items={b.vehicles.body({ aircraft: pct(f.aircraftShare), none: pct(f.teamsNoAircraft), four: pct(f.teamsFourAircraft) })} />,
      },
      {
        id: 'length',
        title: b.length.title,
        body: (
          <Paras
            items={b.length.body({
              median: minSec(g, f.duration),
              p90: minSec(g, f.durationP90),
              over10: pct(f.over10Minutes),
              firstKill: minSec(g, f.firstKill),
              gap: minSec(g, PACE.gap),
              series: num(PACE.series),
              perHour: num(PACE.perHour, 1),
            })}
          />
        ),
      },
      {
        id: 'ending',
        title: b.ending.title,
        body: (
          <Paras
            items={b.ending.body({
              wiped: pct(f.wiped),
              captured: pct(f.winnersCapturedMore),
              onlyAircraft: pct(f.onlyAircraftLeft),
              survivors: num(f.winnerSurvivors),
            })}
          />
        ),
      },
      {
        id: 'decides',
        title: d.title,
        body: (
          <>
            <p className="guide-p">{d.intro}</p>
            <GuideTable head={d.head} rows={decideRows} />
            <Paras
              items={d.notes({
                // A squadron that wins half its battles, with and without the first kill.
                withFirst: pct(0.5 + f.firstKillLift, 0),
                withoutFirst: pct(0.5 - f.firstKillLift, 0),
                notLoadedBattles: num(NOT_LOADED.oneMore.battles),
                botWins: num(NOT_LOADED.bot.wins),
                botBattles: num(NOT_LOADED.bot.battles),
                aircraft: pct(f.aircraftShare),
                aircraftKills: pct(f.aircraftKills),
                spread: pct(f.aircraftWinSpread, 0),
              })}
            />
          </>
        ),
      },
      {
        id: 'sides',
        title: b.sides.title,
        body: (
          <Paras
            items={b.sides.body({
              team1: pct(BATTLES.team1Won / BATTLES.total),
              team2: pct(BATTLES.team2Won / BATTLES.total),
              maps: num(MAP_SIDES.maps),
              minBattles: num(MAP_SIDES.minBattles),
              low: pct(MAP_SIDES.low),
              high: pct(MAP_SIDES.high),
            })}
          />
        ),
      },
    ],
  }
}

function statsArticle(g: GuideText): GuideArticle {
  const s = g.stats
  const psrRows = TEAM_PSR_GAP.map((row) => [gapLabel(g, row), pct(row.higherWins), pct(row.elo), num(row.battles)])
  const squadronRows = SQUADRON_GAP.map((row) => [gapLabel(g, row), pct(row.higherWins), num(row.battles)])
  const even = SQUADRON_GAP.at(0)
  const strong = SQUADRON_GAP.at(-1)
  const distributionRows = PSR_DISTRIBUTION.atLeast.map((row) => [g.ui.andMore(psrText(row.psr)), pct(row.share)])
  return {
    lead: s.lead({ battles: num(BATTLES.total), date: longDate(MEASURED_AT) }),
    sections: [
      {
        id: 'psr',
        title: s.psr.title,
        body: <><p className="guide-p">{s.psr.intro}</p><GuideTable head={s.psr.head} rows={psrRows} /><Paras items={s.psr.notes} /></>,
      },
      {
        id: 'squadron',
        title: s.squadron.title,
        body: (
          <>
            <GuideTable head={s.squadron.head} rows={squadronRows} />
            <Paras
              items={s.squadron.notes({
                even: num(even?.to ?? 0),
                strong: num(strong?.from ?? 0),
                strongWins: pct(strong?.higherWins ?? 0),
              })}
            />
          </>
        ),
      },
      {
        id: 'matchmaking',
        title: s.matchmaking.title,
        body: (
          <Paras
            items={s.matchmaking.body({
              psrReal: psrText(MATCHMAKING.psr.real),
              psrRandom: psrText(MATCHMAKING.psr.random),
              squadronReal: num(MATCHMAKING.squadron.real),
              squadronRandom: num(MATCHMAKING.squadron.random),
              repeat: pct(ACTIVITY.repeatOpponent),
              opponents: num(ACTIVITY.opponentsPer10, 1),
            })}
          />
        ),
      },
      {
        id: 'activity',
        title: s.activity.title,
        body: (
          <>
            <p className="guide-p">{s.activity.intro({ from: dayMonth(ACTIVITY.from), to: dayMonth(ACTIVITY.to) })}</p>
            <GuideTable
              head={s.activity.head}
              rows={[
                [s.activity.rows.battles, num(ACTIVITY.battles.median)],
                [s.activity.rows.squadrons, num(ACTIVITY.squadrons)],
                [s.activity.rows.players, num(ACTIVITY.players)],
                [s.activity.rows.squadronDay, num(ACTIVITY.squadronDay)],
                [s.activity.rows.playerDay, num(ACTIVITY.playerDay)],
              ]}
            />
            <Paras
              items={s.activity.notes({
                low: num(ACTIVITY.battles.low),
                high: num(ACTIVITY.battles.high),
                topLow: num(ACTIVITY.topPerDay.low),
                topHigh: num(ACTIVITY.topPerDay.high),
                from: dayMonth(ACTIVITY.seasonFrom),
                to: dayMonth(MEASURED_AT),
                playersLow: num(ACTIVITY.topPlayers.low),
                playersHigh: num(ACTIVITY.topPlayers.high),
              })}
            />
          </>
        ),
      },
      {
        id: 'distribution',
        title: s.distribution.title,
        body: (
          <>
            <p className="guide-p">{s.distribution.intro({ players: num(PSR_DISTRIBUTION.players), zero: pct(PSR_DISTRIBUTION.zeroShare) })}</p>
            <GuideTable head={s.distribution.head} rows={distributionRows} />
            <Paras
              items={s.distribution.notes({
                median: psrText(PSR_DISTRIBUTION.median),
                top10: psrText(PSR_DISTRIBUTION.top10),
                top1: psrText(PSR_DISTRIBUTION.top1),
                max: psrText(PSR_DISTRIBUTION.max),
              })}
            />
          </>
        ),
      },
    ],
  }
}

function methodArticle(g: GuideText): GuideArticle {
  const m = g.method
  return {
    lead: m.lead,
    sections: [
      {
        id: 'data',
        title: m.data.title,
        body: (
          <Paras
            items={m.data.body({
              date: longDate(MEASURED_AT),
              battles: num(BATTLES.total),
              changes: num(FIT.changes),
              psrBattles: num(battleCount(TEAM_PSR_GAP)),
              squadronBattles: num(battleCount(SQUADRON_GAP)),
              from1: dayMonth(DATA_PERIODS[0].from),
              to1: dayMonth(DATA_PERIODS[0].to),
              from2: dayMonth(DATA_PERIODS[1].from),
              to2: longDate(DATA_PERIODS[1].to),
            })}
          />
        ),
      },
      {
        id: 'formula',
        title: m.formula.title,
        body: (
          <Paras
            items={m.formula.body({
              single: num(FIT.singleBattles),
              k: num(FIT.k, 1),
              reference: `${psrText(FIT.reference.low)}–${psrText(FIT.reference.high)}`,
              scale: `${psrText(FIT.scale.low)}–${psrText(FIT.scale.high)}`,
              withinOne: pct(FIT.withinOnePoint),
              chainLow: pct(FIT.chain.low, 0),
              chainHigh: pct(FIT.chain.high, 0),
              liveMatched: num(FIT.live.matched),
              liveTotal: num(FIT.live.total),
              max: psrText(PSR_DISTRIBUTION.max),
            })}
          />
        ),
      },
      {
        id: 'squadron',
        title: m.squadron.title,
        body: (
          <Paras
            items={m.squadron.body({
              states: num(FIT.squadron.states),
              errorLow: num(FIT.squadron.errorLow, 1),
              errorHigh: num(FIT.squadron.errorHigh, 1),
            })}
          />
        ),
      },
      {
        id: 'timing',
        title: m.timing.title,
        body: (
          <Paras
            items={m.timing.body({
              date: longDate(TIMING.pollFrom),
              from: utcTime(TIMING.pollFrom),
              to: utcTime(TIMING.pollTo),
              poll: num(TIMING.pollSeconds),
              squadrons: num(TIMING.squadrons),
              battles: num(TIMING.battles),
              min: num(TIMING.delay.min, 1),
              max: num(TIMING.delay.max, 1),
              median: num(TIMING.delay.median, 1),
              fresh: pct(TIMING.freshFirst, 0),
              timer: pct(TIMING.freshTimer, 0),
            })}
          />
        ),
      },
      { id: 'code', title: m.code.title, body: <Paras items={m.code.body({ url: PSR_SOURCE_URL })} /> },
    ],
  }
}

/** Reading order: the widest audience and the most actionable first. */
export const GUIDES: readonly { slug: GuideSlug; audience: GuideAudience; build: (g: GuideText) => GuideArticle }[] = [
  { slug: 'psr', audience: 'everyone', build: psrArticle },
  { slug: 'squadron', audience: 'commanders', build: squadronArticle },
  { slug: 'updates', audience: 'everyone', build: updatesArticle },
  { slug: 'battle', audience: 'everyone', build: battleArticle },
  { slug: 'stats', audience: 'details', build: statsArticle },
  { slug: 'method', audience: 'details', build: methodArticle },
]

/** Quick answers in the order players ask them, each linked to the section with the details. */
export const QUICK: readonly { id: QuickId; to: string }[] = [
  { id: 'points', to: '/guides/psr#points' },
  { id: 'grow', to: '/guides/psr#points' },
  { id: 'ceiling', to: '/guides/psr#ceiling' },
  { id: 'factors', to: '/guides/psr#factors' },
  { id: 'leave', to: '/guides/psr#factors' },
  { id: 'squadron', to: '/guides/squadron#who' },
  { id: 'delay', to: '/guides/updates#delay' },
  { id: 'battle', to: '/guides/battle#length' },
  { id: 'favorite', to: '/guides/stats#psr' },
  { id: 'accuracy', to: '/guides/method#formula' },
]

export function quickNums(g: GuideText): QuickNums {
  const delay = delayNums()
  const widestGap = TEAM_PSR_GAP.at(-1)
  return {
    delayMin: delay.min,
    delayMax: delay.max,
    delayMedian: delay.median,
    favoriteWins: pct(widestGap?.higherWins ?? 0),
    favoriteElo: pct(widestGap?.elo ?? 0),
    changes: num(Math.round(FIT.changes / 1000) * 1000),
    withinOne: pct(FIT.withinOnePoint),
    battleMedian: minSec(g, BATTLE_FLOW.duration),
    wiped: pct(BATTLE_FLOW.wiped),
  }
}
