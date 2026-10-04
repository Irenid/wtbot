// Guide texts of one locale. Every locale implements the whole interface, so a
// missing translation is a type error, not a silent fallback to Russian.
// Strings may hold **bold** and [label](/path#section) or [label](https://…)
// links, rendered as React nodes by Rich (pages/guides/parts.tsx), never as
// HTML. Functions take numbers already formatted for the locale; measured
// numbers always come as arguments (pages/guides/measurements.ts), numbers of
// the PSR rule are written out (lib/psr.ts).

export type GuideSlug = 'psr' | 'squadron' | 'updates' | 'battle' | 'stats' | 'method'
export type GuideAudience = 'everyone' | 'commanders' | 'details'
export type QuickId = 'points' | 'grow' | 'ceiling' | 'factors' | 'leave' | 'squadron' | 'delay' | 'battle' | 'favorite' | 'accuracy'
/** Rows of the "what decides the battle" table, sorted by win share on the page. */
export type DecideRow = 'moreKills' | 'firstKill' | 'fewerKills' | 'notLoaded' | 'bot'

/** Formatted numbers a text function receives, by name. */
type Nums<K extends string> = Readonly<Record<K, string>>
type Paragraphs = readonly string[]

export type QuickNums = Nums<'delayMin' | 'delayMax' | 'delayMedian' | 'favoriteWins' | 'favoriteElo' | 'changes' | 'withinOne' | 'battleMedian' | 'wiped'>

export interface GuideText {
  /** The locale's official abbreviation of the personal squadron rating. */
  term: string
  ui: {
    title: string
    lead: (n: Nums<'battles'>) => string
    quickTitle: string
    articlesTitle: string
    audience: Record<GuideAudience, string>
    prev: string
    next: string
    notFound: string
    /** Table labels: "up to 780", "over 400", "1000 and more". */
    upTo: (n: string) => string
    over: (n: string) => string
    andMore: (n: string) => string
    /** A duration: "5 мин 37 с", "5 min 37 s". */
    minSec: (n: Nums<'min' | 'sec'>) => string
  }
  quick: Record<QuickId, { q: string; a: (n: QuickNums) => string }>
  articles: Record<GuideSlug, { title: string; summary: string }>
  psr: {
    lead: string
    points: { title: string; head: readonly [string, string, string, string]; notes: Paragraphs }
    calc: {
      title: string
      intro: string
      psr: string
      winRate: string
      win: string
      loss: string
      hold: string
      per10: string
      ceiling: string
      battles: string
      fromNow: string
      reached: string
      above: string
      endless: string
      stuck: string
      note: string
    }
    factors: { title: string; items: Paragraphs }
    ceiling: {
      title: string
      intro: string
      head: readonly [string, string, string]
      notes: Paragraphs
      streaks: string
      streakHead: readonly [string, string, string]
    }
    season: { title: string; body: Paragraphs }
    formula: { title: string; win: string; loss: string; atLeast: (n: string) => string; floor: string; body: Paragraphs }
  }
  squadron: {
    lead: string
    formula: { title: string; line: (n: Nums<'top' | 'share'>) => string; body: Paragraphs }
    top20: { title: string; body: Paragraphs }
    who: { title: string; intro: string; head: readonly [string, string, string]; notes: Paragraphs }
    roster: { title: string; body: Paragraphs }
    ceiling: {
      title: string
      intro: string
      head: readonly [string, string, string]
      /** Battles each of the 20 best needs to reach their level, and the hours of play that takes at PACE. */
      notes: (n: Nums<'battlesLow' | 'battlesHigh' | 'hoursLow' | 'hoursHigh'>) => Paragraphs
    }
    live: {
      title: string
      updated: (when: string) => string
      places: string
      placesHead: readonly [string, string]
      groups: string
      groupsHead: readonly [string, string, string, string]
      /** How many times more battles the top 10 played than places 51–100. */
      conclusion: (n: Nums<'times'>) => string
      note: string
      empty: string
    }
  }
  updates: {
    lead: string
    delay: { title: string; body: (n: Nums<'min' | 'max' | 'median'>) => Paragraphs }
    site: { title: string; body: Paragraphs }
    season: { title: string; body: Paragraphs }
    hours: {
      title: string
      body: (n: Nums<'first' | 'second' | 'peak' | 'firstShare' | 'firstPsr' | 'secondPsr'>) => Paragraphs
    }
  }
  battle: {
    lead: (n: Nums<'battles'>) => string
    vehicles: { title: string; body: (n: Nums<'aircraft' | 'none' | 'four'>) => Paragraphs }
    length: { title: string; body: (n: Nums<'median' | 'p90' | 'over10' | 'firstKill' | 'gap' | 'series' | 'perHour'>) => Paragraphs }
    ending: { title: string; body: (n: Nums<'wiped' | 'captured' | 'onlyAircraft' | 'survivors'>) => Paragraphs }
    decides: {
      title: string
      intro: string
      head: readonly [string, string]
      rows: Readonly<Record<DecideRow, string>> & {
        /** The widest gap rows of the stats tables: "average PSR higher by 400 or more". */
        psr: (n: Nums<'gap'>) => string
        squadron: (n: Nums<'gap'>) => string
      }
      notes: (n: Nums<'withFirst' | 'withoutFirst' | 'notLoadedBattles' | 'botWins' | 'botBattles' | 'aircraft' | 'aircraftKills' | 'spread'>) => Paragraphs
    }
    sides: { title: string; body: (n: Nums<'team1' | 'team2' | 'maps' | 'minBattles' | 'low' | 'high'>) => Paragraphs }
  }
  stats: {
    lead: (n: Nums<'battles' | 'date'>) => string
    psr: { title: string; intro: string; head: readonly [string, string, string, string]; notes: Paragraphs }
    squadron: {
      title: string
      head: readonly [string, string, string]
      notes: (n: Nums<'even' | 'strong' | 'strongWins'>) => Paragraphs
    }
    matchmaking: {
      title: string
      body: (n: Nums<'psrReal' | 'psrRandom' | 'squadronReal' | 'squadronRandom' | 'repeat' | 'opponents'>) => Paragraphs
    }
    distribution: {
      title: string
      intro: (n: Nums<'players' | 'zero'>) => string
      head: readonly [string, string]
      notes: (n: Nums<'median' | 'top10' | 'top1' | 'max'>) => Paragraphs
    }
    activity: {
      title: string
      intro: (n: Nums<'from' | 'to'>) => string
      head: readonly [string, string]
      rows: Readonly<Record<'battles' | 'squadrons' | 'players' | 'squadronDay' | 'playerDay', string>>
      notes: (n: Nums<'low' | 'high' | 'topLow' | 'topHigh' | 'from' | 'to' | 'playersLow' | 'playersHigh'>) => Paragraphs
    }
  }
  method: {
    lead: string
    data: {
      title: string
      body: (n: Nums<'date' | 'battles' | 'changes' | 'psrBattles' | 'squadronBattles' | 'from1' | 'to1' | 'from2' | 'to2'>) => Paragraphs
    }
    formula: {
      title: string
      body: (n: Nums<'single' | 'k' | 'reference' | 'scale' | 'withinOne' | 'chainLow' | 'chainHigh' | 'liveMatched' | 'liveTotal' | 'max'>) => Paragraphs
    }
    squadron: { title: string; body: (n: Nums<'states' | 'errorLow' | 'errorHigh'>) => Paragraphs }
    timing: {
      title: string
      body: (n: Nums<'date' | 'from' | 'to' | 'poll' | 'squadrons' | 'battles' | 'min' | 'max' | 'median' | 'fresh' | 'timer'>) => Paragraphs
    }
    code: { title: string; body: (n: Nums<'url'>) => Paragraphs }
  }
}
