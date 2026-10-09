# Opponent scouting

Whether the bot can name the enemy squadron of a squadron battle at or before
its start, and predict the enemy's players and vehicles (`/scout`, below).
Measured on 2026-10-06 – 2026-10-08: read-only queries on the production database
(21,071 battles since 2026-09-22; predictions evaluated from 2026-09-29, BR
stage 9.0 and the first hours of 8.0), the replay CDN for finished battles,
and the game's own interfaces on the Linux client (Steam) in custom and random
battles — ban-safe methods only (last section).

## What the bot knows and when

- **Only finished battles.** `wt-replays` polls the Replay API every 20 s.
  While the bot runs (delay under 1 h), a battle is listed p10/p50/p90/p99
  5/17/31/2,761 s after its real end (start + `duration_sec`) and parsed
  (`battles.ingested_at`) 12/24/38/1,433 s after it. The other 44.6% since
  2026-09-22 came late with the backfill after the August–September gap.
- **Early listings are no live source:** 1.6% (332 battles since 2026-09-29)
  are listed before the end, at the earliest 151 s after the start, 557 s on
  average.
- **Server replays reach the CDN at the end.** In 12 squadron battles
  (2026-10-07) every part, part 0000 included, has `Last-Modified` within
  −4…+14 s of the real end (p50 +4 s). Parts come in pairs per ~90 s segment:
  14–56 KB, then 0.5–1.5 MB (6 parts for 4 min, 14 for 9.6 min). The CDN
  answers `HEAD` with 404; a one-byte ranged GET (as `replayPartExists`) is
  redirected from `wt-game-replays.warthunder.com` to
  `wt-replays-cdnnow.cdn.gaijin.net` and returns the date and size.
- Battle duration p10/p50/p90 241/333/502 s.
- 94.7% of teams are a single squadron; 99.3% of players belong to their
  team's majority squadron.

## Prediction once the enemy squadron is known

History is limited to the current BR stage (`clan_season_stages`: the cap
drops weekly) and to battles parsed by our start + 30 s.

- **Squadrons requeue at once.** Gap between a squadron's battles
  p10/p50/p90 0/1/10 min; 93.4% within 30 min (one session). The previous
  battle is parsed by the next one's start + 30 s in 92.5%. The enemy's latest
  known battle ended p50 1 min (p90 16 min) before our start; 99.5% have one.
- **Roster:** 95.1% of a squadron's players in a battle played its last known
  battle of the session, 97.0% some battle of the last 3 hours. 5.2% of a
  squadron's battles overlap another battle of the same squadron (two groups
  at once); there its last battle covers only 70.0% of the roster, the last
  battle of the first enemy in the kill feed 92.1% (95.8% overall; that
  player has history in 99.4%).
- **Vehicles** (175,565 player-battles with spawns, 94.8% with same-stage
  history):
  - lineup (`battle_players.vehicles`) p10/p50/p90 1/3/6 vehicles; distinct
    vehicles spawned per battle (`played_vehicles`) p50 1, p90 1;
  - lineup identical to the last battle 90.1%; changed 9.9% (65.6% of the
    changes share no vehicle — a preset swap, 34.4% partial);
  - first spawn in the last lineup 92.2% (every spawned vehicle: 92.2%);
  - first spawn equals the last battle's first spawn 80.3%; the stage's most
    frequent first spawn 66.9%, its top 3 87.1%.
- **New BR stage:** players with same-stage history by hours since the stage
  start — 0–3 h 83.3%, 3–6 h 74.7%, 12–24 h 90.2%, 24–48 h 93.8%, later
  96.3%; with any history 94.6–97.9%.
- **Cost:** the stage history of 8 players is 300 rows, 2.9 ms warm
  (`idx_bp_user_id`, then the `battles` primary key). Readers to reuse:
  `getSiteClanBattleTeams` (a squadron's battles by tag variants),
  `getPlayerReplayInsights` (vehicles, maps, opponents; worker task
  `read-player-insights`).

## The `/scout` model

`/scout squadron [player]` (`src/scout/`) predicts the squadron's next team.
Backtest of 2026-10-08 (`npm run scout:backtest -- <copy.db> --fit`): 99,326
squadron team-battles of 2026-07-15 – 2026-10-08, each predicted as if typed
20 s after its start from what the bot had stored by then (backfilled
battles: stored 40 s after the end); weights fit before 2026-10-01, figures
on 2026-10-01 – 2026-10-08. 16.5 s on 26 threads.

- **One spawn per player:** deaths are 0 or 1 in 99.99% of 795,063 rows,
  one spawned vehicle in 99.99%, so the eight vehicles are the setup.
- **Roster** — logistic regression per regime over the squadron's last two
  weeks (in the last battle, × minutes since it, in the one before, shares
  of the current and previous session and of the week, hours since the
  player's last battle, battles, active days, share of battles within 3 h of
  this time of day). In a session (last battle under 30 min ago, 93% of
  teams): top 8 right 95.8% (17,871 teams); after a break: 45.9% (1,347;
  13% of the players had not played for the squadron in two weeks).
  Calibrated within 1–2 points where 98% of candidates fall (under 10% or
  over 80%); 30–80% happens 5–20 points more often than said.
- **Vehicle** — conditional logit over the player's spawns and lineups at
  the current cap (last spawn, also after a break, the two before, in the last
  lineup, spawn share decayed with a half-life of 8 battles, never spawned)
  and an option "a vehicle not seen at this cap". Top 1 right 79.9%, top 3
  91.8% (147,014 players); in a session 81.2%, after a break 61.1%. Said
  chances match what happened within 2 points in every band. Baselines:
  the last spawn 81.1% in a session but uncalibrated (log loss 0.86 against
  0.69); the period's most frequent spawn 67%.
- **Setup** — exact convolution of the eight likeliest players' class
  chances, then Platt-scaled: independent players overstated "at least one
  aircraft" (said 38%, happened 23%) because teams choose together, so the
  air chance also uses whether the last battle's team spawned air. After
  scaling: within 0.4–3.4 points in the bands holding 84% of teams, 6.8 in
  the 80–90% band (says 86%, happens 93%); the most likely class counts
  within 1–4 points. Expected aircraft off by 0.43 per team, class
  counts by 1.02 players.
- **Hint:** one enemy nick moves the roster from 95.8% to 96.0% overall and
  from 74.2% to 89.7% where another group of the squadron played within 30
  minutes (1,026 teams); the reply lists such a group.
- **Dead ends:** the map changes nothing (aircraft 22–28% of spawns on every
  map with 100+ battles at caps 9.0 and 8.0; per-player entropy drop is
  sampling noise). A player's first battle at a new cap (5% of player-battles)
  has no usable history: half never played for us before, and the others'
  older spawns at or under the cap (datamine BR) give the right vehicle in
  9–15%, so vehicle BR is not used and the reply says "no battles at this BR
  yet".
- **Cap switch:** the cap changes on the stage's first day between 07:00 and
  14:00 UTC, not at the schedule's 00:00: in four stage changes 70–96% of the
  01:00–07:00 UTC spawns are above the new cap, 0% from 14:00 UTC (datamine
  BR: `economicRankTankHistorical` for aircraft in ground battles, else
  `economicRankHistorical`; BR = rank / 3 + 1). The model shifts stages by
  `STAGE_SWITCH_DELAY_SEC` (10 h).
- **Cost:** a squadron's two weeks are ≤ 12,000 rows (the busiest: 4,752 rows
  in 26 ms with the model on a copy), read in worker task
  `read-scout-history`.

### By picture

A Tab screenshot posted in `WT_SCOUT_CHANNEL` names the enemy players, so only
their vehicles are predicted (`predictKnownTeam`: each player's own battles at
the cap, any squadron; unread rows count with the class shares). The test set
is `data/scout-images/` with `truth.json` (`npm run scout:images` scores it):
the three screenshots sent to the bot on 2026-10-08 (crops 649×265, 1623×623,
2158×701) and five pasted that day (two full screens and three crops, kept
downscaled to 2000 px), 51 enemies the bot has battles of. Reading, rewritten
2026-10-08 after the first screenshots in the channel came back short (3 of 4,
7 of 8, 6 of 8 enemies):

- **Rows:** per pixel row, the pixels whose colour differs from their
  right-hand neighbour (horizontal edges, any hue); rows are the longest
  evenly spaced run of text bands (±15% pitch, two missing rows filled in, end
  rows more than 10% off the median pitch trimmed), the highest threshold
  that keeps the run. The previous mask (colour distance from a local mean)
  haloed dense red Chinese nicks and took in the own row's frame line, so
  three rows merged into one band (5 of 8 rows); a short last row fell apart
  into slivers (7 of 8). Now 8 of 8 on all eight images, 2–6 ms.
- **OCR:** the rows stacked and scaled to 42 px text (30 px found 49 of 51
  enemies and 46 of 47 allies, 36 px 50 and 46, 48 px the same as 42), each
  pixel's distance from its row's median colour; one Tesseract call
  (`--psm 6`, TSV) per model in parallel: eng, rus, chi_sim, HanS (script)
  and jpn. A mixed eng+rus+chi_sim model chooses one per word:
  it read Latin nicks in Cyrillic ("Azadx5x" → "Агадх5х"), Chinese ones as
  Latin noise. 0.5–1.2 s an image (OCR 0.4–0.9 s, matching 0.1–0.2 s against
  19,466 players). The best models (`tessdata_best`) found 47; the Latin and
  Cyrillic script models no more than eng and rus, at 7–20 times the size.
- **Matching:** nicks of players seen in 120 days, letters and digits only,
  accents dropped (no pass reads "Loupák" with its á), look-alikes folded
  (Cyrillic, `0`/`o`, `1`/`l`/`i`), approximate substring search in every
  pass's reading; allowed edits by weight (a CJK character counts 2): 0 up to
  6, 1 up to 10, 2 up to 15, then 3. A find counts when its stored tag stands
  right before it (anywhere in a window, the plane icon read "ANA" before
  "SIZGOY" made "nasi" one edit from NASHI), or it is exact and weighs 8+, or
  it stands under its side's squadron and in its column (own nicks end at one
  x, enemy nicks start at one: a Discord voice overlay over the table names
  squadron mates). The squadron is the tag read before the nick when it is
  one read before another nick (dennis7781 played for CH68 in his last stored
  battle, the screenshot shows =FTNDS=), else the stored one. Among finds over
  the same text the one explaining most text wins (weight minus twice the
  edits; "ace" of "メAce" took the place of "ЯсельныйГенералヅ"), then the
  spelling with case and underscores ("__MAVERiCK__" against
  "__Maverick____"). A nick decorated with kana or CJK ("GRIMッ") also matches
  by its letters when they outnumber the decoration 1.5 to 1. Score columns
  are skipped: digit-only words and words of `о`/`o`/`i` alone (the Cyrillic
  pass reads zeros as "о"), and nicks of under 3 distinct characters
  ("ooooooox").
- **Result:** 50 of 51 enemies, 47 of 47 allies, no false find; the one-team
  crop answers "only one team". Before: 34 of 51 and 38 of 47 allies with one
  false (the overlay). The three channel screenshots: 20 of 20 known enemies
  (16 before); their other 4 (kexik1234, ley2211327 and two Chinese nicks)
  have no stored battles and are listed as not recognised. The miss: one character
  (點/点) of a 10 px Chinese nick on a downscaled crop. 48 kana-decorated
  nicks drawn on synthetic tables (their squadrons mixed, so only tag-confirmed
  finds count): 19 without the jpn pass, 35 with it and the letters rule.

### Flags above the table

The game builds the line in `getCountriesByTeam` (`gui.vromfs.bin`
`scripts/statistics/mpstatistics.nut`, datamine of 2026-10-08): the team's
players in its player list's order, skipping those `isDead` (not spawned yet
or destroyed) and those without a unit, each one's flag appended once. So the
line holds the countries of the players in a vehicle now: none before the
first spawn (a loading screen, the first ~30 s), fewer as players are
destroyed. The list's order is the user ids compared as text, which the rows
follow while scores tie: it held for all six lines whose battles are stored
(BLOB1 and WLILY on 2026-10-07, CH68 and WLILY on 2026-09-26 from two viewers)
and for the rows of six teams with equal scores. Which flag a vehicle gets is
the viewer's game setting (the Spearhead update's operator flags): its
operator's (`unit.getOperatorCountry()`: Norway for the Swedish tree's K9
Vidar, Germany's modern flag for the Leopard 2K) with it on, else its nation's
through the viewer's override (`getCountryOverride`: Russia for the USSR).
Four of the six lines had operator flags on; the CH68 battle shows each way.
`data/wt-vehicles.json` keeps `operator` (unittags `operatorCountry`, 942 of
3,416 vehicles differ from their nation).

- **Reading** (`src/scout/flags.ts`): the line's middle stood 2.33–2.49 row
  pitches above the first row's, 0.6–0.7 pitch tall, on four screenshots
  1,919–2,158 px wide; it is the band of solid runs 0.5–2.6 pitches wide (text
  strokes are shorter, separators longer), each flag 100:66. Templates are the
  game's own 86 flags (`ui/atlases.vromfs.bin`, `country_*.svg` and
  `flag_republic_china.svg`) drawn 60×40 by Resvg (14 ms without system fonts;
  6 s with them), restricted to the dictionary's nations and operators; a
  10×6 colour grid shortlists six, a per-pixel comparison with half-pixel
  shifts ranks them (the grid alone took Israel for Argentina on a 17 px
  flag). Teams part at the widest gap within a flag width of the table's
  middle, which is 1.40–1.53 pitches right of the own nicks' right edge
  (halfway to the enemy nicks was 30–60 px off: tags differ in length). On
  the four screenshots 40 of 42 flags right, 3–57 ms; the two misses are
  Israel read as Argentina on a 12 px high downscaled crop, kept as a
  candidate at likelihood 0.12–0.15. Only `italy`/`italy_modern` draw alike.
- **Row icons** (`src/scout/row-icons.ts`): the same script's `unitIcon`
  draws `dead.svg`, a blue (#3f84c5) parachute, for a player `isDead`, a white
  camera (`player_spectator.svg`) for a spectator, and a white
  figure (grey nick) for one not in the battle: still loading or left (the
  channel's screenshot from before the first spawn has both). Realistic
  battles hide the enemy's vehicles, so an enemy in a vehicle has an empty
  cell: the rows with an icon are exactly the players without a flag. The
  column's centre stood 14.2–15.1 pitches right of the table middle on five
  screenshots; a row has an icon when parachute-blue or white pixels cover
  0.08 pitch² of the 12.5–17 pitch window (a parachute covers 0.27–0.33); a
  picture cut before 15.8 pitches has no column, and nothing is known. 49 of
  49 enemy rows right on the test set (one crop without the column).
- **Who is in a vehicle when** (events of the 23,588 stored squadron battles,
  2026-09-24 – 2026-10-08): the first spawn comes 29.5 s after the replay
  starts (p5 28.4 s, p95 30.8 s); 0.2% of players never spawn, 1.3% spawn
  more than once. Seconds after the battle's first spawn, the share not spawned yet:

  | | 10 s | 30 s | 60 s | 2 min |
  |---|---|---|---|---|
  | aircraft | 8.3% | 1.9% | 0.6% | 0.2% |
  | light tanks | 14.0% | 5.5% | 2.4% | 0.8% |
  | tanks | 15.5% | 6.3% | 3.1% | 0.9% |
  | anti-aircraft | 21.8% | 9.4% | 5.0% | 1.7% |

  A team of 8 is all in at 10 s in 37.5% of battles, at 30 s in 69%, at 60 s
  in 84%, at 3 min in 97%. Losses take over from 90 s: destroyed 17% at
  2 min, 41% at 3 min, 62% at 5 min, alike across classes (helicopters
  more). In a vehicle overall: 84% at 10 s, 92–93% at 30–60 s, 81% at 2 min,
  58% at 3 min, 36% at 5 min, when 26% of teams show no flag at all. The
  three late spawners of the BLOB1 battle (88–93 s) and the two of IZGOY's (97
  and 244 s) were all ground vehicles.
- **Using them** (`src/scout/flag-evidence.ts`): a chain over the enemy rows
  in the game's order, its state how many of the line's flags have appeared:
  a player in a vehicle repeats a flag already in or brings the next one, a
  player out of one brings none. An icon puts a row in a vehicle at 0.02, no
  icon at 0.98 (`IN_VEHICLE_WITH_ICON`, `_WITHOUT_ICON`); a flag the line
  lacks (missed) and one out of turn (a place or the order misread) each
  0.02. Rows nobody was recognised in keep their screen place while the
  recognised rows stand in id order (scores tie), else they may stand
  anywhere (the chain interleaves them). The line's readings (each flag's
  candidates by likelihood, each flag once), the two settings and, with no
  icon column, the share of players in a vehicle (0.97, 0.8, 0.55, 0.3 at
  prior 0.55, 0.25, 0.12, 0.08) are mixed by how well each explains the line.
  A vehicle not seen from a player leans to their own vehicles' flags; an
  unread row shows any flag. 0.1 ms per team (p99 0.4).
- **Backtest** (`npm run scout:backtest -- <copy.db> --known-team`, 20,121
  teams of 8 of 2026-10-01 – 2026-10-08, players known, their battles of 9
  days stored by 20 s after the start; the line and icons as the game shows
  them at moments of that battle, from its events, read without error): the
  right vehicle first / log loss under operator flags; no flags 76.2% / 0.659.
  The previous model (the flags as a set, each player shown at 0.9) was
  scored on the same teams before it was replaced.

  | Screenshot | In a vehicle | Previous model | Icons read | No icon column |
  |---|---|---|---|---|
  | everyone in a vehicle | 100% | 79.2% / 0.491 | 80.3% / 0.425 | 80.1% / 0.433 |
  | 10 s after the first spawn | 84% | 78.3% / 0.539 | 79.5% / 0.465 | |
  | 30 s | 93% | 78.8% / 0.513 | 80.0% / 0.442 | 79.7% / 0.460 |
  | 1 min | 93% | 78.9% / 0.509 | 80.1% / 0.438 | |
  | 2 min | 81% | 78.4% / 0.539 | 79.6% / 0.461 | |
  | 3 min | 58% | 77.5% / 0.587 | 78.8% / 0.512 | 78.1% / 0.551 |
  | 5 min | 36% | 76.8% / 0.625 | 77.8% / 0.573 | |

  Nation flags with icons read: 77.3% / 0.555 with everyone in a vehicle
  (previously 76.7%), 77.2% at 30 s. The previous model lowered the players
  without a flag below no flags at all (63.2% to 61.6% at 10 s): the set
  pulled them into its countries; now they keep their own chances. The
  operator setting got 98.0% under operator flags (90% at 3 min, 68% at 5 min,
  as flags thin out), 16.6% under nation flags. Each player's own flag known
  would give 81.3%. The stated chance of the first vehicle matches what
  happened within 0.1–1.4 points in every band from 10% (everyone in a
  vehicle). 1.2 ms a team with flags (p99 1.7), the conditioning 0.1 ms. Tuned
  on the same backtest: a missed flag and one out of turn at 0.005 instead of
  0.02 gain 0.06 points on readings without error (kept for misreads); the
  in-vehicle mix against one share of 0.95 holds 0.3 points at 3 min;
  operator prior 0.6 instead of 0.75 gains 0.08 under nation flags and loses
  0.02 under operator flags. Knowing the viewer's setting (the own team's
  vehicles are named on screen) would add 0.14 points under nation flags,
  0.03 under operator flags.
- **On the screenshots**: the stored battles' events put each of the six
  lines' flags on the players in a vehicle, in id order; the reader got 40 of
  42 flags and 49 of 49 icons, and the duplicate Argentina of the crop
  resolves to Israel (each flag once). Their history is too short to score
  the chances (CH68's battle of 2026-09-26 is before 9 stored days; BLOB1's
  was its first at a new cap). With BLOB1's flags on its next battle (18:44,
  the same seven flags) the previous model moved the vehicle each player took
  from 78–87% to 84–93% for seven of eight; the eighth switched within the
  USSR (T-54 to Object 906).
- **Dead ends** (same backtest, fitted before 2026-10-01): for a known team,
  the vehicle the player took last time with four of these teammates, its
  share with them, whether the last battle was lost, scored low or had no
  kill, and minutes since it moved the first vehicle from 79.93% to 80.01%;
  reweighting the team's class counts (players choose together) from 76.29%
  to 76.35%; weighting a row with an icon by how often each class is out of a
  vehicle at that moment (anti-aircraft 2.6 times aircraft at 10 s), even with
  the moment known, by under 0.05. Squadron teams spawned 0/1/2/3/4 aircraft
  or helicopters in 24.8/10.3/12.1/17.6/35.2% of 26,541 teams of September, 5
  or more in 5. The player search (`src/nick-search.ts`) named none of the six
  unread enemy rows of the test set: five have no stored battle, one Chinese
  nick is misread in 4 of 10 characters; its look-alike table now folds the
  matcher's Greek and stroked letters (32 of 19,659 nicks, `MΛRS` to `mars`).

### New vehicles, the opponent's air and StatShark

Measured 2026-10-09 on the known-team backtest (20,338 teams of 8 of
2026-10-01 – 10-08, operator flags, everyone in a vehicle, the model of
1f8ae62) unless said otherwise.

- **The misses** (19.7% of players): a class switch within one nation 5.2%
  (56% of them tank ↔ SPAA), no battle at the cap yet 4.6% (a quarter on the
  cap's first day), a vehicle never seen from them at the cap 4.1%, one of an
  earlier lineup never spawned 3.4%, another vehicle of the same nation and
  class 1.5%, another nation 0.8% (4.9% without flags). Repeating the last
  vehicle (76% of players) is named 98.9%, a switch (19.4%) 26% (6% without
  flags). Each player's own flag known would give 81.2%, flag and class 88.2%.
  Asking 90–300 s after the start instead of 20 s: 80.4–80.5%.
- **What squadrons take** (first spawns of the 50,312 stored battles at six
  caps; BR from the datamine `wpcost.blkx`, the BR of then only for the current
  season): 10–14 vehicles make half the spawns at every cap, 39–50 make 80%;
  at 9.0 and 8.0 58–70% are at the cap and 22% 0.3 under, at 10.0 37/35/22% at
  the cap, 0.3 and 0.7 under. One vehicle often holds its class: the WZ305 62%
  of 8.0's SPAA spawns, the Vautour IIN(C) 47% of its aircraft, the Leopard 2K
  35% of 10.0's tanks, the M247 42% of its SPAA. Premium, gift and squadron
  vehicles are 24–40% of spawns. Of the players seen with a vehicle before a
  stage, 92% took the Vautour IIN(C) at 8.0, 70% the WZ305, 37% the Leopard I,
  24% the ZSU-23-4V.
- **Stock vehicles** (the owner's hypothesis: a vehicle without its
  modifications stays out of squadron battles, and they take dozens of
  battles): modifications cost 77–112k RP for 8.0's popular vehicles (datamine
  `reqExp`, most ~98k; the Vautour IIN(C) 140k), 133–182k at 9.0, 290–297k for a
  top-tier tank; forum reports put a top-tier realistic ground battle at 2–10k
  RP, so 10–70 battles at 8.0 (more: lower tiers earn less) and 30–145 at the
  top. The 19 players with an official profile have 4,246 of 15,710 vehicles
  fully upgraded (27%). Squadron battles show no stock dip: the first battle in
  a vehicle (20,171 by active players since 2026-09-22) scores 92–98% of the
  player's usual kills for the class, and in the 4,693 vehicles kept for 11+
  battles the first one scores 109–114% of the vehicle's mean, survival and
  wins flat. StatShark's per-vehicle battles leave squadron battles out (a
  Leopard 2K: 3 realistic battles there, 19 stored squadron battles); of the 9
  players with them and squadron battles this season, the vehicles spawned had
  a median of 116 battles elsewhere, and of their vehicles within 1.0 BR under
  the cap 0% with 1–4 battles were taken, ~2% with 10–49, ~5% with 50–199, 11%
  with 200+ — but 32% of their spawns came in vehicles with under 20 (the
  Vautour IIN(C) with none: upgraded in squadron battles or with Golden
  Eagles).
- **The new-vehicle guess** (`newVehicleChances`): a player's "not seen at
  this cap" share is spread over the cap's 150 most spawned vehicles so far,
  every squadron's (`getScoutCapSpawns`, ~0.1 s for a stage), by a conditional
  logit (`NEW_VEHICLE_FEATURES`): the log of the vehicle's share of the cap's
  spawns, the player's share of spawns in its nation and its class at any cap
  in 120 days, whether they were seen with it (any lineup or spawn), StatShark's
  battles in it and whether StatShark has none; "other" takes the rest. The
  guesses are options of the flag chain with their own flags. Fitted before
  2026-10-01 on 72,153 such events: seen with it 2.31, nation 1.17, class
  0.86, log share 0.85; on the 13,891 events from the split it names the
  vehicle first 12.2%, among three 23.3%, 11% outside the 150. Alone, the cap's
  most spawned vehicle named 5% of players without battles at the cap, their
  usual nation's 11%, the most spawned they were seen with 13%; their flag
  known exactly would name 37% (flag and class 57%).
- **The opponent's air** (`OPPONENT_AIR_WEIGHTS`): a player who took SPAA last
  time keeps it 62% against squadrons spawning under 0.5 aircraft or
  helicopters a battle, 88% against 3 or more. The screenshot's own squadron's
  mean over its latest 20 teams (`allyAir`) scales each class by
  exp(weight × the excess over 2): fitted AA 0.33, T −0.08, the others within
  ±0.05.
- **The picture path's setup calibration** (`KNOWN_TEAM_SETUP_CALIBRATION`,
  without flags and with them, fitted on screenshots 10–120 s after the first
  spawn): /scout squadron's calibration said 45.9% for the most likely setup
  that happened 42.1% (flags) and missed the air chance by 24–28 points in 4%
  of teams. On held-out teams the air calibration over logit and the last
  battle's air has the best log loss (0.2137 without flags, 0.1530 with; the
  logit alone 0.2216 and 0.1538, with an interaction 0.2139 and 0.1533).
- **Backtest** (`npm run scout:backtest -- <copy.db> --known-team --fit`:
  fitted before 2026-10-01, scored after; first vehicle right / log loss with
  every vehicle not seen at the cap as one outcome):

  | Screenshot | 1f8ae62 | + new-vehicle guess | + opponent, setup |
  |---|---|---|---|
  | no flags | 76.2% / 0.658 | 77.0% / 0.658 | 77.2% / 0.650 |
  | everyone in a vehicle | 80.3% / 0.425 | 82.2% / 0.417 | 82.5% / 0.409 |
  | 30 s after the first spawn | 79.9% / 0.443 | 81.8% / 0.435 | 82.1% / 0.427 |
  | 3 min | 78.7% / 0.512 | 80.3% / 0.507 | 80.6% / 0.499 |

  Players without battles at the cap (4.6%): 0% → 15% without flags, 30% with
  everyone in a vehicle. Everyone in a vehicle: among three 89.6% → 93.1%, the
  class 84.7% → 87.6%, the most likely setup 42.1% → 45.0% (said 46.4%), the
  first vehicle's stated chance within 1.5 points in every band; nation flags
  78.9%, the icon column cut off 82.3%. ~3 ms a team.
- **StatShark for screenshots**: with `STATSHARK_PLAYER_STATS_ENABLED` the reply
  queues a StatShark refresh for each recognised enemy (those without battles
  at the cap first; the lazy service: 24 h TTL, one at a time, ~5 s each) and
  is edited when they end or after `STATSHARK_WAIT_MS` (3 min). In the guess
  log(1 + battles) weighs 0.30 and a vehicle never played outside squadron
  battles −3.82, fitted on the 84 players with a snapshot read up to 3 days
  after the battle (64 refreshed for this on 2026-10-09: cold or new at 8.0 on
  10-07/08; the counts may include a day or two of later games). Fitted on one
  half of the players and scored on the other (`SCOUT_SHARK_FOLD=0|1`), their
  first vehicle with everyone in a vehicle went 75.4% → 77.4% and 84.5% →
  85.8% (483 and 387 player-teams), without flags 71.4% → 72.0% and 80.9% →
  81.9%. These gains came from snapshots read after the battle (see
  "StatShark without the leak" below). StatShark answered 429 after ~60
  profiles in a row and still did 15 minutes later: a 429 now pauses the
  whole source (`PlayerStatsService`),
  doubling from 5 minutes to 6 hours, and a screenshot's update then comes
  without it. Live, the first reply and every reply during such a pause read
  each enemy's latest snapshot however old (19 of the 84 were over 2 days old
  on 2026-10-09, the oldest 10 days), so since 2026-10-09 a snapshot older
  than `STATSHARK_FRESH_SEC` (2 days) gives battle counts only: a vehicle
  bought or played since would otherwise count as never played (×0.02).
- **Constants**: refitted 2026-10-09 with the kill columns and the air knots
  (next section): `npm run scout:backtest -- <copy.db> --known-team --fit-all
  --statshark` on the backup of 2026-10-09 10:05 UTC (99,865 teams, 72,485
  new-vehicle events); the tables are `--fit` (before 2026-10-01).

### Kill columns, StatShark without the leak, the outcome check

Measured 2026-10-09 on the backup of 10:05 UTC (`--known-team --fit
--statshark`: 20,808 teams of 8 scored from 2026-10-01, fitted before)
unless said otherwise.

- **History is at its ceiling.** An offline replica of the per-player model
  (Python: `vehicleChoiceFeatures`' features on the backtest's teams, 76.3%
  without flags as the backtest) found nothing for the first vehicle in the
  lineup's slot order (a switch inside an unchanged lineup takes the earliest
  other slot 42.1% against 29.8% by chance, yet 76.28% → 76.25%, and
  81.50% → 81.24% with each player's flag known), class-specific repeat rates
  (in a session aircraft 86.1%, tanks 83.6%, light tanks 80.0%, SPAA 75.7%:
  76.27%), the player's switch rate (76.24%), or `VEHICLE_WEIGHTS` refitted on
  this path's players (the same weights). The opponent's context adds ~0.1:
  28.1% of teams met the same squadron in the previous 3 h; the previous
  battle's opponent air and rematch × that meeting's air raise SPAA picks'
  log-likelihood by 372 and 124 on 144k player-battles, the first vehicle
  76.59% → 76.71% (ROADMAP).
- **StatShark without the leak.** `--statshark` counted a snapshot read up to
  3 days after the battle, so the games played since leaked into "never
  played" and set `notPlayed` to −3.82 (−7.03 fitted before the split).
  Counted as the reply reads it (the latest snapshot by its update; fresh
  within `STATSHARK_FRESH_SEC`), 11 of the 72,485 new-vehicle events have one
  (6 fresh), and the two weights fall to their prior (`SHARK_L2`): 0.077 and
  −0.369. The first vehicle is unchanged (77.2% without flags, 82.5% with
  everyone in a vehicle); the earlier "+1–2 points with StatShark" was the
  leak. Live, a snapshot older than 2 days gives counts only.
- **Kill columns.** Each enemy row shows its score, air and ground targets
  destroyed, assists, zones captured and deaths. By the time since the first
  spawn (the events' kill feed, team kills left out), the share of players
  showing no kill / air kills only / ground kills only / both
  (`KILL_LIKELIHOODS`):

  | At 120 s | none | air | ground | both |
  |---|---|---|---|---|
  | SPAA | 66.7% | 31.4% | 1.5% | 0.5% |
  | tanks | 82.7% | 0.8% | 16.3% | 0.2% |
  | light tanks | 84.7% | 5.4% | 9.5% | 0.4% |
  | aircraft | 87.2% | 5.3% | 7.2% | 0.2% |

  At 180 s SPAA show air kills 44.7%, tanks 1.2%. The board counts a scout
  drone as an air kill (the two M247 of `e-ch68-full` shot theirs 57 and 61 s
  into the replay), which is how an SPAA shows itself first. A capture needs a ground
  vehicle (aircraft ×0.01, helicopters ×0.1). Each recognised enemy's options
  are weighed by their class's chance of the row's pattern; without the
  moment (the timer is not read) a kill shown uses the 180 s row and no kill
  says nothing — knowing the moment moved the results below by under 0.1
  point.

  First vehicle right / class right with the columns, out of sample
  (operator flags and row icons as the game shows them, columns read
  without error):

  | Screenshot | Without columns | With columns |
  |---|---|---|
  | 60 s after the first spawn | 82.1% / 87.4% | 82.3% / 87.6% |
  | 120 s | 81.6% / 87.0% | 82.1% / 87.6% |
  | 180 s | 80.5% / 86.3% | 81.4% / 87.4% |
  | 300 s | 79.2% / 85.4% | 80.3% / 86.8% |

  Log loss falls at every moment (180 s: 0.665 → 0.641). Players without
  battles at the cap gain the most (180 s: 25.6% → 27.3%). The offline replica
  without flags gave +0.15 / +0.51 / +0.89 / +1.08 points at the same moments.

- **Reading the columns** (`scoreboard-columns.ts`). The six header icons
  stand 0.8–1.75 row pitches above the first row; plane → skull are evenly
  spaced and ★ → plane is 1.76 spacings, while their offsets in pitches vary
  with the screen width and UI scale (★ 17.4–22.2 pitches right of the
  middle), so the columns are found from the icons. Each cell's ink is its
  brightness over the cell's own background (a colour mask lost thin strokes
  of the lighter row stripes to JPEG's half-resolution colour), the cells are
  cropped and set three text heights apart in one line per row, and one
  Tesseract call with a digit whitelist reads them; the picture's own zero
  (the glyph most cells share, a ring Tesseract mostly reads as 0) overrules a
  number read off a zero (correlation ≥ 0.3: zeros 0.34–1.00, ones and fives
  −0.18–0.19), so doubt falls to "no kill". The bot image's Tesseract 5.3.0
  read lone zeros away with one cell per line, ran neighbours into one number
  closer than three text heights, and read zeros of the lighter stripes as 1,
  4 or 9. On the four test screenshots with the columns: 192 of 192 cells,
  ~0.4–0.5 s an image.
- **"At least one aircraft"** was 7–16 points low between 50% and 90% (with
  flags said 65.2%, happened 81.6%). After the logistic calibration it now
  goes through isotonic knots per case (`KNOWN_TEAM_AIR_KNOTS`: no flags,
  flags with every enemy row in a vehicle, other flags), fitted at every
  screenshot moment with the kill columns; with flags and everyone in a vehicle the middle bands
  now say 54.9 / 65.1 / 75.8 / 85.6% where 62.9 / 73.2 / 83.0 / 91.7% happen
  (before: 64.7 / 81.6 / 83.6 / 93.2%), without flags 55.7 / 65.4 / 75.2 /
  85.9% where 54.9 / 70.4 / 79.4 / 90.5% happen (before: 55.3 / 72.8 / 82.1 /
  93.1%). The rest is the test period's air (October's 8.0 and 9.0 caps) above
  the fitting period's: the cap's air share as a calibration feature is the
  next step (ROADMAP).
- **Last played together** is the latest battle at least four of them played
  (`GROUP_MIN_SHARED`), else the one with the most of them: the most-players
  rule alone picked a battle 69 h old (median) in 2.9% of teams where a
  group's was 22 h old.
- **Unread rows.** 1.52% of October's player-battles had no earlier stored
  battle (6% none at the cap); a screenshot cannot name them, while the
  backtest scored them as known. `--unread-live` makes them unread rows:
  the recognised enemies' first vehicle is right 78.1% without
  flags, 83.2% with everyone in a vehicle and 82.2% at 180 s with the kill
  columns — 0.7–0.9 points above the all-known figures, the unread being the
  hardest — while 1.2% of the enemies get classes only. (The live matcher
  knows the last 120 days, the backtest any stored battle: 86 days so far.)
- **Outcome check.** Each record keeps its reply's prediction (and the update
  after StatShark); `npm run scout:outcomes -- <copy.db>` finds each record's
  battle (most recognised enemies on one team, started within 45 min before
  the post) and scores reading, first vehicle, stated chance and setup by the
  moment. The four channel records of 2026-10-08 were test posts of battles
  18.5 h older, so none counts yet.
- **The backtest on 26 threads.** Workers stream the rows with shared strings
  and lineups and rebuild a team's inputs for each pass (keeping them took
  15 GB at 12 threads): 7 GiB on 26 threads, a full `--fit` run 333 s instead
  of 474 s with identical results; `--variants REGEX` scores a subset.

## Guessing the enemy from server data

- **Candidates** — squadrons whose battle ended at most 20 min before our
  start: p10/p50/p90 16/53/73; the enemy is among them in 90.5%. Ended at most
  2 min before: p50 9, p90 17.
- The enemy was met earlier the same day in 26.9%.
- **Rankings** (19,745 team-battles with the enemy among the candidates),
  top 1/3/5:
  - most recent finish 13.0/33.0/46.5%;
  - finish time closest to ours 12.5/22.7/30.9%;
  - closest official rating (`clan_rating_history`) 5.5/15.0/22.4%: the gap
    to the real enemy is p50 7,138, to other candidates 10,670;
  - met today first, then most recent: top 5 31.5% of all 21,982.
- **Session IDs are sequential across the whole game:** ~2.9 a second (three
  consecutive squadron battles 285–430 s apart differ by 821–1,231). Finding
  running squadron battles by ID would mean scanning the CDN, which holds
  nothing before the end anyway.

## Game client

### Local API (`127.0.0.1:8111`)

The game's built-in browser map; it listens on `0.0.0.0:8111`. The map page
`/` reads `map_info.json`, `map_obj.json`, `map.img`, `mission.json`,
`hudmsg?lastEvt=&lastDmg=`, `gamechat?lastId=`, `indicators`, `state` and
`loc/map/*_objectives?fmt=js`; `/info` is 404. No player list, no session ID.

| State | `map_info.valid` | `mission.status` | `indicators` |
|---|---|---|---|
| In battle | true | `running` | `army` (`tank`/`air`), `type` (`tankModels/sw_itpsv_90`, `su_33`) |
| Respawn screen | false | `running` | `type` follows the vehicle being picked (3 in 8 s) |
| Battle over | true, then false | `fail`/`success`, kept in the hangar | the hangar vehicle |
| Loading | requests time out | — | `dummy_plane` until the spawn |

- `/state` is `{"valid": false}` in a tank (aircraft data only).
- **`/hudmsg`:** `{events, damage[]}`, a damage item `{id, msg, sender,
  enemy, mode, time}` (`time` in mission seconds). `msg` is
  `[<decorated tag>] <nick> (<vehicle>) <verb> [[<decorated tag>] <nick>
  (<vehicle>)]`, verbs `destroyed`, `shot down`, `set afire`, `severely
  damaged`, `critically damaged`, `has crashed.`, `has been wrecked`; all 39
  lines of a random battle split on them. `enemy` was always false and
  `sender`/`mode` empty (61 lines): the side is not marked, so in a squadron
  battle the enemy is the other tag. Vehicle names are display names with game
  glyphs and Cyrillic look-alikes (`◍Т-80U-Е1`, `␗T-26`); after removing the
  glyphs and mapping the look-alikes, 74 of 77 matched `data/wt-vehicles.json`
  (English names only), 5 of them ambiguous. `events` stayed empty.
- **First line naming both sides** (1,500 squadron battles since 2026-09-29,
  from stored events): a cross-team kill or critical/severe damage
  p10/p50/p90 61/103/156 s after the replay start. Damage lines rarely come
  first (they lead the first kill by p50 0 s, p90 7 s); a kill of a non-player
  unit can name one side earlier (the first kill of any kind p50 93 s).
- **`/map_obj.json`:** 214 objects in a ground battle — tank, fighter and UCAV
  respawn bases and airfields per team colour (`#174DFF`, `#fa0C00`), capture
  zones, the player; no names.
- **`/gamechat`:** a list, empty in the observed battles. In squadron battles
  since 2026-09-29, 26.1% of 10,991 have an all-chat message, and the first one
  comes within 30/60/90 s in 4.3/9.7/11.9% (either team).

### Replays

- **Saved:** `Replays/#YYYY.MM.DD HH.MM.SS.wrpl` and `replays.wdb` in the game
  folder, written in one go when the battle ends (creation and modification
  time within 1 ms).
- **In progress:** `/tmp/wt_replay_XXXXXX` (Steam's container shares the
  host's `/tmp`), held open by the game. Created with 0 bytes as loading ends
  (2026-10-07: 1.1 s after the local API stopped answering, 0.06 s before
  `map_info.valid`); the **first write (128 KiB) came 82.1 s after that, 36.5 s
  after the spawn**; then 128 KiB (once 132 KiB) every 4–50 s, median 22 s.
  The writes lag the stream by ~20 s: the header `startTime` was 3 s before
  the file appeared, and the first and second writes (85 and 113 s after it)
  held the stream up to 64.7 and 98.7 s (the saved copy of the same battle).
  Deleted 7–12 s after the mission status turns `fail`/`success`; the saved
  file follows ~4 s later. The last size before deletion (4,210,688) trailed
  the saved stream's end (4,273,477) by under 64 KiB: the same stream.
- **Format:** the saved file is a WRPL with `isServer` false (byte 742 is not
  `0x5a`), so `extractReplayEvents` skips it. Header `e5ac0010`, version
  101404, the session ID at offset 732 (e.g. `127b004900818a7a`), a 1,157-byte
  settings BLK, then one zstd stream in 24–32 blocks of ~50–75 KB and the
  results BLK at `resultsBlkOffset`.
- **Player slots** (`02 58 2d f0` packets, `SlotParser` in
  `src/wrpl/replay-events.ts`): user ID (signed), nickname, squadron tag,
  title, team, real nickname; a table of 64 slots. In a 32-vs-32 battle with
  bots all 64 slots (1 player, 63 bots with negative IDs) came named, 32 per
  team, in one batch at 4.5 s of stream time, complete at file byte 53,350;
  in three custom battles at 7.0–8.3 s, by byte 51,572–54,530. Always inside
  the first compressed block, so the roster reaches the disk with the first
  128 KiB write. In 4 saved replays the first 128 KiB holds the stream up to
  55–59 s of stream time, the first 256 KiB up to 82–102 s.
- **Not measured:** the first write in a squadron battle (one bot battle so
  far); human slots of both teams (the bot battle shows the table complete);
  whether the in-progress header already holds the session ID; the path on
  Windows.
- **Limit:** the same stream records the movement of every unit the client
  receives. Reading it during a battle beyond the slots is a radar cheat. How
  Gaijin treats a tool that reads only the slots (what Tab shows) is unknown.

### Not examined or ruled out

- `.clog` logs (`~/.config/WarThunder/.game_logs/`): obfuscated, not examined.
- **Discord:** the bot has only the `Guilds` and `GuildVoiceStates` intents
  (`src/bot/index.ts`); presence needs a privileged intent, and the game is
  not known to publish battle details there.
- **Ruled out:**
  - reading game memory or traffic — anti-cheat territory (the client ships
    BattlEye);
  - guessing running sessions on the CDN — a scan, and parts appear only at
    the end;
  - automatic OCR of the scoreboard — needs someone to press Tab (a person
    posting the screenshot is `/scout` by picture, above);
  - voice transcription — privacy.

## Comparison

| Source | Enemy known | Result | Caveat |
|---|---|---|---|
| In-progress replay, slots only | first 128 KiB write: 82 s after the start (one battle) | exact roster | game rules unclear; ~20 s ahead of the kill feed |
| Server replay on the CDN | at the end (+4 s) | exact roster and lineups | too late for the battle |
| Screenshot of the Tab scoreboard + OCR (StatShark's way) | when the player opens Tab | names of both teams → squadron and group through the database | no process access, only what Tab shows; no official ruling |
| `8111` kill feed | first line naming both sides p50 103 s (p10 61, p90 156) | exact tag; a nickname gives squadron and group through the database | the game's own read-only API |
| `8111` all-chat | within 60 s in 9.7% (either team) | bonus | — |
| Server data only | before the battle | top 1 13.0%, top 5 46.5% when visible (90.5%) | — |
| A person after Tab (`/scout`) | ~10–20 s (estimate) | exact tag | needs a person |

No fully automatic source names the enemy at the start. The in-progress replay
gets the roster to disk with its first 128 KiB write, 82 s in — about as late
as the kill feed (p50 103 s), so it does not justify the rules risk. The
automatic, ban-safe source is the kill feed on `8111` (~1.5–2 min); the start
needs Tab: a person typing the tag (`/scout`) or, as StatShark does, a
screenshot of the scoreboard read by OCR; server data alone gives a 13%
(top 1) / 46.5% (top 5) shortlist. Once the squadron is known, its last battle
(or the last battle of the first enemy seen) predicts players and vehicles
well.

## Ban-safe measurement

What the measurements touched, from no risk to the rules' grey zone:

- **The local API on `8111`** — the game's own browser map, read-only GETs at
  ~1 Hz, as its page polls; no access to the game process.
- **File metadata** of `/tmp/wt_replay_*` and `Replays/` (name, size, times),
  polled every 0.5–1 s.
- **Saved replays after the battle**, offline — the same data the game's replay
  viewer shows.
- **The replay CDN for finished battles** — one-byte ranged GETs at 1/s, the
  requests the bot's ingest makes anyway.
- Once, on 2026-10-06, the list of the game's open files in `/proc/<pid>/fd`
  (metadata, no memory); not repeated: anything that inspects the game process
  is avoided.

Never done: reading the in-progress replay during a battle, reading game memory
or traffic, injecting code, automating input, editing game files, decoding the
obfuscated logs.

## Third-party tools and the rules

Checked on 2026-10-07 on the War Thunder forum. statshark.net itself was not
read: its `robots.txt` disallows AI agents (`Disallow: /`) and `/api/` for
every client — the API the bot's optional StatShark provider
(`STATSHARK_PLAYER_STATS_ENABLED=false`) calls.

- **StatShark "Shark Client"** — a Windows app for Patreon supporters (from
  $6.50 a month; 139 patrons on 2026-01-30) since 2026-01-02: Live Game
  Viewer, Session Viewer, Streamer Overlay. It replaced a live viewer on the
  website (seen from 2025-09) that was "permanently" gone on October 8. Its
  announcement: "We use OCR (Optical Character Recognition) alongside available
  localhost endpoints to find the player names and map them to each given
  team", "which is why it needs to run locally". Its developer, paraphrased: the
  app screenshots the display while the scoreboard (Tab) is open and sends it to
  StatShark's servers for AI OCR, with "no interaction with in-game processes".
  Stats come from scraped service records, not replays; users who use the
  viewer and leave battles early are blocked. No Gaijin statement on it.
  Threads: [298328](https://forum.warthunder.com/t/statsharks-live-game-viewer-is-really-bad-for-the-games-health/298328),
  [256939](https://forum.warthunder.com/t/statshark-in-game-overlay/256939).
- **Tools on `8111`** show no enemy roster (the API has none): WT-Plotter
  (saved replays, live positions from `8111`, Windows/Linux), LockOn (Android,
  own results over the LAN), WTRTI, WtHud2, Thunder Viewer (own telemetry),
  Gaijin's WT Assistant (tactical map). No open-source roster OCR was found.
- **Official answers** (forum, community manager Stona_WT and GM Schindibee):
  "Generally speaking, using localhost data to display overlays is considered
  fine and not a bannable offense"; enemy markers where the mode has none "can
  be considered an ESP overlay"; "we won't permanently suspend any account
  without a preceding temporary ban or a warning" (2024-05-13,
  [106664/16](https://forum.warthunder.com/t/tools-using-data-provided-on-port-8111/106664/16));
  "We do not provide such "seal of approval" for 3rd party apps" (2026-01-27,
  [303251](https://forum.warthunder.com/t/any-contact-for-decision-is-my-in-development-overlay-app-ok/303251));
  "WHAT you get is important here, not HOW you get it"; an app showing
  distances to spotted enemies "had to remove that functionality" (2026-09-07,
  [351718](https://forum.warthunder.com/t/question-ground-battle-map-tool-using-the-official-8111-localhost-api-within-the-rules/351718)).
  Rules 6.1.3–6.1.4 (automation, third-party software):
  legal.gaijin.net/en/gamerules-wt. Nothing official on OCR, replays or memory.
