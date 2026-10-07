import type { GuideText } from './types'

// English guide text: War Thunder terms of i18n/en.ts (PSR, squadron).
export const en: GuideText = {
  term: 'PSR',
  ui: {
    title: 'Guides',
    lead: ({ battles }) =>
      `How squadron battles and their ratings work: how much PSR a battle gives, how high it can grow, how the squadron rating is counted, when points update and what decides a battle. The rules were reconstructed from public warthunder.com data; the statistics cover every squadron battle in the bot's database (${battles}).`,
    quickTitle: 'Quick answers',
    articlesTitle: 'All guides',
    audience: { everyone: 'All players', commanders: 'Squadron commanders', details: 'In depth' },
    prev: 'Previous',
    next: 'Next',
    notFound: 'No such guide',
    upTo: (n) => `up to ${n}`,
    over: (n) => `over ${n}`,
    andMore: (n) => `${n} and more`,
    minSec: ({ min, sec }) => `${min} min ${sec} s`,
  },
  quick: {
    points: {
      q: 'How much PSR does a battle give?',
      a: () => 'Your PSR decides, and the enemy team too when its average PSR is above 1500. Against a team averaging 1500 or less: up to 780 a win gives +32 and a loss −1, at 1500 +16 and −16, at 2000 +2 and −30.',
    },
    grow: {
      q: 'How often do I need to win for PSR to grow?',
      a: () => 'More than 24 battles in 100 at PSR 1300, more than half at 1500 and more than 85 in 100 at 1800, against teams averaging 1500 or less. Against stronger teams fewer wins are enough.',
    },
    ceiling: {
      q: 'How high will my PSR get?',
      a: () => 'Your win rate decides: at 50% PSR stops around 1500, at 70% around 1650, at 90% around 1880. Regular battles against teams averaging above 1500 raise that level.',
    },
    factors: {
      q: 'Do the opponent and my play in battle matter?',
      a: () => 'Your play does not: score, kills, deaths and battle length do not count. The opponent counts only when the enemy team averages above 1500 PSR: then a win gives more and a loss takes less.',
    },
    leave: {
      q: 'Can I leave a lost battle without losing PSR?',
      a: () => 'No. Leaving a battle costs the same PSR as an ordinary loss.',
    },
    squadron: {
      q: 'Whose battles raise the squadron rating?',
      a: () => 'Battles of the squadron\'s 20 best players, while their PSR is below the level where it stops. A point of anyone else is worth 20 times less to the squadron.',
    },
    delay: {
      q: 'When does PSR update after a battle?',
      a: ({ delayMin, delayMax, delayMedian }) =>
        `In ${delayMin}–${delayMax} minutes, ${delayMedian} on average: warthunder.com pages refresh at most once every 15 minutes.`,
    },
    battle: {
      q: 'How long does a squadron battle last?',
      a: ({ battleMedian, wiped }) =>
        `Half of the battles end in less than ${battleMedian}. Every player has one vehicle, and in ${wiped} of battles the losing team is destroyed to the last vehicle.`,
    },
    favorite: {
      q: 'Does the team with higher PSR win?',
      a: ({ favoriteWins, favoriteElo }) =>
        `More often, but not by much: with a lead of over 400 it wins ${favoriteWins} of battles, while the formula promises ${favoriteElo}.`,
    },
    accuracy: {
      q: 'Where do these rules come from and how accurate are they?',
      a: ({ changes, withinOne }) =>
        `Gaijin does not publish the formula. It was reconstructed by matching about ${changes} PSR changes with battle results: for a single battle it matches the game's site within 1 point in ${withinOne} of cases.`,
    },
  },
  articles: {
    psr: {
      title: 'How PSR works',
      summary: 'Points for a win and a loss, a calculator, how high PSR can grow and the formula.',
    },
    squadron: {
      title: 'Squadron rating',
      summary: 'How it adds up from players\' PSR, whose battles raise it, what removing a member costs and what the top 10 takes.',
    },
    updates: {
      title: 'Updates and the season',
      summary: 'When points appear after a battle, how often this site updates, the season dates and squadron battle hours.',
    },
    battle: {
      title: 'How a squadron battle goes',
      summary: 'One vehicle per player, how long a battle lasts, how it ends and what decides it.',
    },
    stats: {
      title: 'Squadron battle statistics',
      summary: 'How well ratings predict the winner, how opponents are matched, how much squadrons play and how many players reach high PSR.',
    },
    method: {
      title: 'How this was measured',
      summary: 'Where the data comes from, how the formula was fitted and how accurate it is.',
    },
  },
  psr: {
    lead: 'PSR is the personal squadron rating. After every squadron battle it grows for a win and drops for a loss. By how much depends on your PSR — the higher it is, the less a win gives and the more a loss takes — and on the enemy team if its average PSR is above 1500.',
    points: {
      title: 'Points per battle',
      head: ['PSR', 'Win', 'Loss', 'Win %'],
      notes: [
        'The table is for an enemy team averaging 1500 PSR or less. A stronger team counts with its average instead of 1500: a win gives more and a loss takes less. At PSR 1800 against a team averaging 1800 a win gives +16 instead of +5, and a loss −16 instead of −27.',
        '**Win %** — how many battles out of 100 you need to win for PSR to grow. Win less often and PSR drops.',
        'Above 903 a win and a loss together are always worth 32 points: the less a win gives, the more a loss takes.',
        'Above 1500 a loss costs more than a win gives: at 1800 one loss wipes out 5–6 wins, at 2000 about 18. So the same record — 5 wins and 5 losses — gives +155 at PSR 0, 0 at 1500 and −143 at 2000.',
        'PSR never goes below 0. The game keeps the fractional part of PSR and shows a whole number, so the same win can look like +16 or +17.',
      ],
    },
    calc: {
      title: 'Calculator',
      intro: 'Enter your PSR and win rate: the calculator applies the formula for an enemy team averaging 1500 or less to show what you get and how high you will climb.',
      psr: 'Your PSR',
      winRate: 'Win rate',
      win: 'For a win',
      loss: 'For a loss',
      hold: 'PSR grows if you win more than',
      per10: 'Per 10 battles on average',
      ceiling: 'PSR stops around',
      battles: 'Battles to that level',
      fromNow: 'from your PSR, on average',
      reached: 'you are already there',
      above: 'you are above it: PSR will drift down on average',
      endless: 'without losses PSR grows without limit, ever slower',
      stuck: 'at this win rate PSR does not grow',
      note: 'These are averages: real streaks of wins and losses scatter around them.',
    },
    factors: {
      title: 'What affects PSR',
      items: [
        '**Opponent strength — only above 1500.** The formula compares you with the enemy team\'s average PSR, but never with less than 1500. A win over any team averaging 1500 or less is worth the same; against a stronger team a win gives more and a loss takes less.',
        '**Play in battle — no effect.** Score, kills, deaths and battle length do not count. PSR changes for the whole team: the best player, those who disconnected and those who failed to load.',
        '**Leaving does not help.** If you leave a lost battle, you lose the same PSR as for an ordinary loss.',
        '**Squadron role — no effect.** The commander, an officer and a private get the same.',
        '**Your own PSR matters most.** For a win over a team averaging 1500 or less a player at PSR 0 gets +32 and a player at 1800 gets +5.',
      ],
    },
    ceiling: {
      title: 'How high PSR can grow',
      intro: 'The higher PSR is, the less a win gives, so PSR stops at a level set by your win rate. At 50% wins PSR reaches 1500 and then hovers around it. More battles do not raise that level — they only get you there sooner. The table is for enemy teams averaging 1500 or less; stronger opponents raise the level: at 50% wins it is their average PSR.',
      head: ['Win rate', 'PSR stops around', 'Battles from zero'],
      notes: [
        '**Battles from zero** — how many battles from the season start it takes to get within 50 points of that level. A lucky streak can lift you higher, but PSR then comes back.',
        'That is why PSR shows the number of battles more than skill: 100 battles at 40% wins give about 1170, while 20 battles at 80% give about 510.',
      ],
      streaks: 'Even without losses growth slows down:',
      streakHead: ['From PSR', 'To PSR', 'Wins in a row'],
    },
    season: {
      title: 'Season start and breaks',
      body: [
        'At the start of a season everyone has PSR 0. Below 903 a loss costs just 1 point while a win gives 31–32, so at first PSR grows almost only with the number of wins. Reaching 903 takes about 42 battles at 70% wins, 59 at 50% and 103 at 30%. So **early in the season playing more matters more** than winning often.',
        'Without battles PSR does not change and stays until the season ends. If a lucky streak lifted you above your level, every further battle takes points on average, and a break does not.',
      ],
    },
    formula: {
      title: 'Formula',
      win: 'Win',
      loss: 'Loss',
      atLeast: (n) => `at least ${n}`,
      floor: 'PSR never goes below 0',
      opponent: (n) => ["enemy team's average PSR,", `at least ${n}`],
      body: [
        '**E** is the win share at which PSR stays put: the “Win %” column of the [table](/guides/psr#points), which uses R = 1500. Below 903 the formula would charge less than 1 point for a loss, so there it is always −1 and 3% wins are enough to grow.',
        'Example for PSR 1300 against a team averaging 1500 or less: x = (1500 − 1300) / 400 = 0.5; 10^0.5 ≈ 3.16; E = 1 / 4.16 ≈ 0.24. Win: 32 × 0.76 ≈ +24. Loss: 32 × 0.24 ≈ −8.',
        'Above 903 the average result of one battle is simpler: 32 × (win share − E). At PSR 1300 and 60% wins that is 32 × (0.60 − 0.24) ≈ +11.5 per battle.',
        'This is the Elo system, as in chess, with the enemy team\'s average PSR as the opponent. A weaker team counts as 1500, so a win over it gives as much as over a team averaging 1500.',
      ],
    },
  },
  squadron: {
    lead: 'The squadron rating adds up its players\' PSR, but not equally: the 20 best count in full, the rest at 5%. This explains whose battles help the squadron and why a place in the table depends on the number of battles. On this site squadron ratings are in [Squadrons](/clans).',
    formula: {
      title: 'How it is counted',
      line: ({ top, share }) => `Squadron rating = PSR of the ${top} best + ${share} of the others' PSR`,
      body: ['A squadron has up to 128 players. The current roster counts: inactive members stay in the rating, and the PSR of those who leave goes with them.'],
    },
    top20: {
      title: 'The 20 best decide',
      body: [
        'A point of a top-20 player is worth 20 times more to the squadron. A win by a top-20 player at PSR 1500 gives the squadron +16; the same player outside the top 20 gives +0.8.',
        'A squad of 8 top-20 players at about 1500 brings the squadron +128 for a win and −128 for a loss.',
        'When a player overtakes the 20th, they start counting in full, and the one pushed out counts at 5%. From then on every point of the new player goes to the squadron in full.',
      ],
    },
    who: {
      title: 'Whose battles earn points',
      intro: 'While a player\'s PSR is below the level where it stops at their win rate (the “[How high PSR can grow](/guides/psr#ceiling)” table), their battles add points to the squadron on average. Above it they take points away, even if the player plays well:',
      head: ['Player PSR', 'Win rate', 'Average per 10 battles'],
      notes: [
        'Players at 1300 and 1600 win equally often, but the first earns points for the squadron and the second loses them: at 60% wins PSR stops at 1570. If two players are equally strong, the squadron gains more by fielding the one with lower PSR — as long as the swap does not lower the squad\'s chance to win.',
        'PSR does not drop without battles, so a player above their level keeps the squadron\'s points while not playing.',
      ],
    },
    roster: {
      title: 'Other members and roster cleanup',
      body: [
        'Members outside the 20 best also add points, 5% of their PSR each: 100 players at PSR 1000 add 5,000 — about as much as three top-20 players.',
        'So removing a member costs points. A member outside the top 20 at PSR 1000 takes 50 with them. A top-20 member takes their PSR, but the 21st takes their place and starts counting in full: the squadron loses the leaver\'s PSR minus 95% of the 21st\'s PSR. For example, a player at 1800 leaves and the 21st has 1500 — the squadron loses 1800 − 1425 = 375.',
      ],
    },
    ceiling: {
      title: 'Squadron ceiling',
      intro: 'Once the 20 best reach their levels, the squadron rating no longer grows with the number of battles, only with the win rate:',
      head: ['Wins of the 20 best', 'PSR of each', 'Sum of the 20 best'],
      notes: ({ battlesLow, battlesHigh, hoursLow, hoursHigh }) => [
        `Plus 5% of the others' PSR. Each of the 20 best needs ${battlesLow}–${battlesHigh} battles to reach their level: at the usual [pace](/guides/battle#length) that is ${hoursLow}–${hoursHigh} hours of squadron battles. Until then the squadron rating also grows with the number of battles.`,
        'Lucky streaks and high-PSR players who stopped playing can hold a squadron above this level: PSR does not drop without battles.',
      ],
    },
    live: {
      title: 'The table right now',
      updated: (when) => `as of ${when}`,
      places: 'What a place in the rating table takes:',
      placesHead: ['Place', 'Squadron rating'],
      groups: 'Averages over the squadrons in these places:',
      groupsHead: ['Places', 'Wins', 'Season battles', 'Players'],
      conclusion: ({ times }) => `Squadrons in places 1–10 have played ${times} times as many battles as those in places 51–100.`,
      note: 'Data from the official warthunder.com rating table.',
      empty: 'The rating table is unavailable right now.',
    },
  },
  updates: {
    lead: 'PSR changes right after a battle, but warthunder.com pages show it up to 15 minutes later. Here: where the delay comes from, how often this site updates, the season dates and squadron battle hours.',
    delay: {
      title: 'When points appear',
      body: ({ min, max, median }) => [
        'The game records a battle\'s result about 30 seconds after it ends. But the squadron pages and the rating table on warthunder.com do not show it at once: the game\'s site keeps a copy of them for 15 minutes and builds a new one on the first request after that.',
        `So the new PSR appears ${min}–${max} minutes after the battle, ${median} on average. Reloading more often does not help: while the copy is under 15 minutes old, the game's site shows it. If more than 15 minutes have passed since the battle ended, reload the squadron page: it will show the result.`,
        'Battles played within those 15 minutes appear together. They are applied one by one in the order they ended, each from the PSR after the previous one.',
        'The rating table works the same way, but each of its pages (20 squadrons) refreshes on its own, separately from the squadron pages. So for a while the table and a squadron page can show different ratings.',
      ],
    },
    site: {
      title: 'How this site updates',
      body: [
        'This site takes squadron ratings and places from the warthunder.com rating table: the top 100 squadrons every 20 minutes, the rest every 12 hours. Together with the 15-minute copy on warthunder.com, the leaders\' ratings here usually lag the game by no more than 35 minutes.',
        'Player PSR comes from squadron pages: the bot reads a squadron\'s page when it posts a battle with that squadron, and goes through the rosters of the top 100 squadrons once a day. So a player\'s PSR here can lag the game.',
      ],
    },
    season: {
      title: 'Season',
      body: ['At the start of a season the PSR of every player and the rating of every squadron reset to zero. The season is split into stages, each with its own maximum battle rating of vehicles:'],
    },
    hours: {
      title: 'Squadron battle hours',
      body: ({ first, second, peak, firstShare, firstPsr, secondPsr }) => [
        `Squadron battles run every day in two windows (in your local time): ${first} and ${second}. The first window has ${firstShare} of all battles, and the busiest hours are ${peak}.`,
        `Opponents are slightly stronger in the second window: a team's average PSR there is typically ${secondPsr}, against ${firstPsr} in the first.`,
      ],
    },
  },
  battle: {
    lead: ({ battles }) =>
      `Every squadron battle is 8 vs 8, Realistic, Domination. Here: how they go and what decides them, across every squadron battle in the bot's database (${battles}).`,
    vehicles: {
      title: 'One vehicle per battle',
      body: ({ aircraft, none, four }) => [
        'In a squadron battle every player has one vehicle. Once it is destroyed, the player is out until the battle ends, and the team plays on without them.',
        `${aircraft} of the vehicles in battles are planes and helicopters, the rest are ground vehicles. Most often a team takes either no aircraft (${none} of teams) or four (${four}). More than four almost never happens.`,
      ],
    },
    length: {
      title: 'How long a battle lasts',
      body: ({ median, p90, over10, firstKill, gap, series, perHour }) => [
        `Half of the battles end in less than ${median}, nine in ten in less than ${p90}. Only ${over10} of battles last longer than 10 minutes. The first vehicle is usually destroyed ${firstKill} after the start.`,
        `The next battle usually starts ${gap} after the previous one ends. A typical series is ${series} battles in a row, and an hour of play gives a squad ${perHour} battles on average, pauses included.`,
      ],
    },
    ending: {
      title: 'How a battle ends',
      body: ({ wiped, captured, onlyAircraft, survivors }) => [
        `In ${wiped} of battles the losing team is destroyed to the last vehicle.`,
        `In the rest the losers still had vehicles left but lost on capture zones: in ${captured} of these battles the winners captured more zones. Most often the losers had only aircraft left (${onlyAircraft} of these battles), and aircraft cannot capture zones.`,
        `Winning is costly too: usually ${survivors} of the winners' 8 players are still alive at the end.`,
      ],
    },
    decides: {
      title: 'What decides a battle',
      intro: 'How often a team wins when it has:',
      head: ['The team has', 'Wins'],
      rows: {
        moreKills: 'More kills than the opponent',
        firstKill: 'The first kill of the battle',
        fewerKills: 'Fewer kills than the opponent',
        notLoaded: 'One more player who failed to load',
        bot: 'A bot instead of a player who failed to load',
        psr: ({ gap }) => `Average PSR higher by ${gap} or more`,
        squadron: ({ gap }) => `Squadron rating higher by ${gap} or more`,
      },
      notes: ({ withFirst, withoutFirst, notLoadedBattles, botWins, botBattles, aircraft, aircraftKills, spread }) => [
        `**The first kill** matters not only because stronger teams usually get it. Even a squadron that wins half of its battles wins ${withFirst} of its battles with the first kill and ${withoutFirst} without it.`,
        '**With fewer kills** a team almost always loses, and its rare wins usually come from capture zones.',
        `**A player who failed to load** almost means a loss (${notLoadedBattles} such battles in the data). Usually a bot takes the empty slot, but even then the team wins only ${botWins} battles of ${botBattles}.`,
        `**Aircraft.** Planes and helicopters are ${aircraft} of the vehicles but make ${aircraftKills} of the kills. Even so, the number of aircraft hardly affects the result: a squadron's win rate with any number of aircraft, from 0 to 4, differs from its usual one by no more than ${spread}.`,
        'More on how ratings predict the winner — in the [statistics](/guides/stats#psr).',
      ],
    },
    sides: {
      title: 'Map sides',
      body: ({ team1, team2, maps, minBattles, low, high }) => [
        `The map side gives no advantage: teams 1 and 2 won almost equally (${team1} and ${team2}). On every map with over ${minBattles} battles (${maps} maps) the first side wins ${low} to ${high} of battles, within chance.`,
      ],
    },
  },
  stats: {
    lead: ({ battles, date }) =>
      `Squadron battles in the bot's database as of ${date}: ${battles}. All of them are 8 vs 8, Realistic, Domination.`,
    psr: {
      title: 'How well PSR predicts the winner',
      intro: 'The team with the higher average PSR wins more often, but far less often than the formula promises:',
      head: ['Gap in team average PSR', 'Higher-PSR team wins', 'By the PSR formula', 'Battles'],
      notes: [
        '**By the PSR formula** — how often the team would win if PSR measured strength exactly. The real edge is smaller: PSR grows with the number of battles, not only with skill ([why](/guides/psr#ceiling)). A player\'s win rate tells more about their strength.',
      ],
    },
    squadron: {
      title: 'How well the squadron rating predicts the winner',
      head: ['Gap in squadron rating', 'Higher-rated squadron wins', 'Battles'],
      notes: ({ even, strong, strongWins }) => [
        `With a gap of up to ${even}, squadrons beat each other about equally often. Only with a gap of over ${strong} does the higher-rated squadron win ${strongWins} of battles: the rating grows with the number of battles, and only 8 players fight in a battle, not necessarily the strongest.`,
      ],
    },
    matchmaking: {
      title: 'Opponent matching',
      body: ({ psrReal, psrRandom, squadronReal, squadronRandom, repeat, opponents }) => [
        `Matchmaking weighs ratings only weakly. The teams' average PSR in a battle typically differs by ${psrReal}, while two random teams that played within the same 2 hours differ by ${psrRandom}. For squadron ratings it is ${squadronReal} against ${squadronRandom}. An opponent 200 PSR stronger or weaker is normal.`,
        `Opponents often repeat: within one [squadron battle window](/guides/updates#hours), ${repeat} of a squadron's battles are against a squadron it has already played in that window. In 10 battles in a row it meets ${opponents} different opponents on average.`,
      ],
    },
    distribution: {
      title: 'How many players reach high PSR',
      intro: ({ players, zero }) =>
        `Squadron players whose PSR the bot saw this season: ${players}. ${zero} of them have PSR 0: they have not won yet this season. Among the rest:`,
      head: ['PSR', 'Share of players'],
      notes: ({ median, top10, top1, max }) => [
        `Half of them are below ${median}. The top 10% start at ${top10}, the top 1% at ${top1}. The highest PSR the bot has seen is ${max}.`,
      ],
    },
    activity: {
      title: 'How much squadrons play',
      intro: ({ from, to }) => `A typical day of this season — averages over the full days from ${from} to ${to}:`,
      head: ['Per day', 'Average'],
      rows: {
        battles: 'Squadron battles',
        squadrons: 'Squadrons in battles',
        players: 'Players in battles',
        squadronDay: 'Battles of one squadron',
        playerDay: 'Battles of one player',
      },
      notes: ({ low, high, topLow, topHigh, from, to, playersLow, playersHigh }) => [
        `Battles per day range from ${low} to ${high}. A squadron or a player counts only on the days they played.`,
        `The 10 most active squadrons play ${topLow} to ${topHigh} battles a day, and from ${from} to ${to} each fielded ${playersLow} to ${playersHigh} different players. Only the 20 best of them count in full in the squadron rating ([why](/guides/squadron#top20)).`,
      ],
    },
  },
  method: {
    lead: 'Gaijin does not publish the PSR formula. The rules in these guides were reconstructed from public warthunder.com data and checked on live battles. This is not official data: Gaijin can change the rules at any time, and then the numbers here will be out of date.',
    data: {
      title: 'Data',
      body: ({ date, battles, changes, psrBattles, squadronBattles, from1, to1, from2, to2 }) => [
        `The bot collects squadron members' PSR and the squadron rating table from warthunder.com pages, and from battle replays who played, in which vehicle, who destroyed whom, who captured zones and who won. As of ${date} the database holds ${battles} squadron battles and ${changes} PSR changes. The battles run from ${from1} to ${to1} and from ${from2} to ${to2}: on other days the bot did not collect them.`,
        `Team PSR comparisons use battles where the PSR of at least 6 of 8 players on each team is known (${psrBattles}); squadron comparisons use battles where both squadrons' ratings are known (${squadronBattles}).`,
      ],
    },
    formula: {
      title: 'PSR formula',
      body: ({ single, k, reference, scale, withinOne, chainLow, chainHigh, liveMatched, liveTotal, max, strong, fixed, enemy, weaker }) => [
        `The formula was fitted on cases where exactly one battle separated two readings of a player's PSR (${single}). The Elo system fit best. The fitted numbers (${k}; ${reference}; ${scale}) are 32, 1500 and 400.`,
        `For a single battle the formula matches the game's site within 1 point in ${withinOne} of cases. It explains ${chainLow}–${chainHigh} of changes spanning several battles, depending on PSR. In a live check ${liveMatched} of ${liveTotal} changes matched.`,
        `A larger check in October 2026 showed that a strong opponent counts. In ${strong} single-battle changes against an enemy team averaging above 1500, a fixed opponent of 1500 matched the game's site within 1 point in only ${fixed}, the enemy team's average PSR in ${enemy}. Against weaker teams both give ${weaker}: the opponent never counts as weaker than 1500.`,
        `Checked on PSR from 0 to ${max}, the highest PSR in the data; above it there is nothing to check the formula on.`,
      ],
    },
    squadron: {
      title: 'Squadron rating',
      body: ({ states, errorLow, errorHigh }) => [
        `The squadron rating formula was checked on ${states} states of squadron pages: the difference was ${errorLow} to ${errorHigh} points, the fractional parts of PSR that the game's site does not show.`,
      ],
    },
    timing: {
      title: 'Update timing',
      body: ({ date, from, to, poll, squadrons, battles, min, max, median, fresh, timer }) => [
        `On ${date} from ${from} to ${to} UTC the bot read the pages of ${squadrons} squadrons every ${poll} seconds during their battles. Across ${battles} battles the result appeared ${min}–${max} minutes after the battle ended, ${median} on average.`,
        `Page updates came exactly 15 minutes apart, and the first request after a pause got fresh data in ${fresh} of cases; a page refreshed on a timer would give about ${timer}. So the page is rebuilt on request once its copy is older than 15 minutes.`,
      ],
    },
    code: {
      title: 'Code',
      body: ({ url }) => [`The formula and every table of these guides are computed in the site's open source code: [lib/psr.ts](${url}).`],
    },
  },
}
