# wtbot open tasks

A living list: a closed item is deleted, a new one is added here. Checked
against the code and the production run on 2026-10-02. Earlier plans and
audits (`AUDIT.md`, `IMPROVEMENT_PLAN.md`, `MASTER_PLAN.md`, `WEBSITE_PLAN.md`,
`PLAYER_STATS_PLAN.md`) are done or obsolete; their open items are below, the
full texts are in Git (commit `46b6950` and earlier).

## Operations

1. **Public site.** The tunnel to the external reverse proxy is up and
   `WEB_TRUST_PROXY` is set; the proxy still needs the site and TLS (do not
   commit addresses: the repository is public). Recovery after a server reboot
   or an IP change is untested. `POST /api/player-stats` (the refresh button
   on the player page, the dashboard form) queues a request to the
   warthunder.com profile through the browser (and to StatShark if enabled) —
   for anonymous visitors turn it off (`WT_PLAYER_STATS_ENABLED=false`) or
   keep the site behind the token. Discord OAuth is a separate decision.
2. **Image freshness.** Chromium and Debian packages update only with a
   rebuild without cache (README, "Production in Docker"): decide whether it is
   manual or a systemd timer, and when (a restart briefly pauses
   announcements).
3. **Cap at a season boundary.** `stageAt` treats a season's first day like
   a week's: its 01:00–07:00 UTC window keeps the previous cap (battle posts
   and maps take the old season's last stage; the site and `/stats` count
   down to 14:00 UTC). Only weekly switches are measured
   (`docs/opponent-scouting.md`, "Cap switch"): the database has no battles
   from 2026-08-03 to 09-22 (the bot was off). After 2026-11-01 count that
   window's spawns above the old cap (5.0) the same way: many — the new
   season plays from 00:00 UTC and `stageAt` needs a season-start case;
   none — the assumption holds; no battles — a break between seasons,
   nothing to change.

## Code

- **Bot-played player slots (a8fdc87, DB v22): leftovers.** The independent
  review of a8fdc87 was stopped on 2026-10-12 before it reported (it had read
  every reader and run the tests; no findings). Open: whether the game counts
  a battle the AI played for a player in that player's PSR
  (`getPlayerBattleResults` includes it; the image's PSR column shows a dash).
  The 30 posts of 2026-10-12 sent before the deploy miss 62 players; the bot
  keeps no message ids since 2026-08-01, so fixing them means finding them in
  the channel history and editing Discord: the owner's decision. Battle
  499981394946553783 (July) keeps 7 rows: the v9 phantom-bot rule dropped
  its second bot.

- **English everywhere** (AGENTS.md, section 9). Docs and the bot's Discord
  and image text (`src/i18n`) are English; comments and strings elsewhere in
  `src/`, `frontend/` and configs are still Russian: ~4,050 lines on
  2026-10-15 (`src/` ~3,180 in code and ~710 in tests, `frontend/src` ~170:
  comments, logs, CLIs, the `/statistics` dashboard, site API errors).
  Cheap plan instead of a whole-repo sweep: a script extracts only the
  Cyrillic spans, a model translates small batches in fresh contexts, the
  script puts them back with checks (span unchanged, quotes, `${}` and `{n}`
  placeholders), then `npm run verify` and `npm run build:web`. Terms follow
  `frontend/src/i18n/en.ts` (squadron, PSR, AB/RB/SB); `en.ts` becomes the
  canonical UI dictionary (today `ru.ts` is, and `en.ts` lacks 4 keys).
  The remaining server-side `ru-RU` formatting (the dashboard in
  `src/web/routes/pages.ts`, `player-stats-live-smoke.ts`) → `en-GB`. Logs
  quoted in docs (`[ingest] бой …`, the verify skill) change together with
  the code. Also remove `.cbmignore` (codebase-memory-mcp is not
  configured).
- **Tactical map: arrows to bases outside the view.** The game draws
  `arrow_mark.svg` (hud.blk `outOfMapArrow`, 15×18 UI px) at the frame's edge
  for every base outside it; `src/tactical-map/render.ts` draws none yet. The
  snapshots show two arrows per team where the tank bases give one: the rest
  are helicopter, UCAV and airfield spawns (air_spawn_template's categories
  `heli_spawn_logic`, `ucav_spawn_logic`, `enable_airfields_part`), which the
  model now has (helipads and airfields on `units.objectGroups`, UCAVs from
  rank 26; the air map draws them). Which of them get an arrow is unknown.
  Placement measured so far: the base's position clamped 7.3 UI px inside the
  frame, pointing away from the view centre (corner arrows diagonal); the
  ardennes and sun_city snapshots also have one on an edge (x 256 and 508 of
  1153) that this does not explain (`docs/tactical-maps.md`).
- WAL checkpoint on the main thread: the main connection has the default
  `wal_autocheckpoint`, so a commit that crosses 1,000 frames synchronously
  moves the whole WAL (3,000 frames — 23 ms). While ingest checkpoints by
  itself the pauses are rare, ~10 ms; if writes grow —
  `wal_autocheckpoint = 0` on main and a periodic checkpoint in a worker.
- ECS 2.59: no serializer for the new type `0xcfad499d` (hanging ordnance
  `rocket`/`payload`), part of `ri_gpu_object` does not parse. Kills and
  trajectories are unaffected (entities are isolated), but these entities are
  lost.
- Retention of `clan_rating_snapshots`, `clan_rating_history`,
  `player_external_snapshots`: decide how long to keep them.
- Player queries on a cold cache take ~120 ms (random reads of
  `battle_players`; warm — 1–5 ms, and since the blob conversion the whole
  database fits in the OS cache). If it becomes noticeable — a covering index
  `battle_players (user_id, session_id, …)`, ~+35 MiB.
- Dashboard `/`: ~1,000 lines of untyped inline script in
  `src/web/routes/pages.ts` — move it to a `.ts` built by `tsc`.
- Large functions: `buildHeatmapSvg` (~710 lines), `extractReplayEventsProfiled`
  (~240), `src/db/index.ts` (~6,700 lines) — split once things settle.

## Tests

- WRPL/ECS/GMSync fuzzing and decompression edge cases.
- Render fixtures with many players: non-zero values, sorting, 32 players.
- `src/player-stats/service.ts` — smoke scripts only.

## Performance

Measurements, gates and rollback — [docs/performance.md](docs/performance.md).
Open: prove or disprove the RSS plateau for
`WT_REPLAY_EXACT_RESERVATION_ENABLED`, measure announcement latency
(discovery → commit → post), profile under Docker/Linux.

## Collecting and showing statistics (started 2026-09-29)

- **Source reconciliation.** Compare the data of all parsers (replays, site
  profile, companion, StatShark, leaderboards), find and explain mismatches.
  Merge them into one set of statistics, and where that is impossible or
  inconvenient for users, show them separately; cross-check matching metrics
  between sources to catch errors. Known so far: StatShark stores the mode as
  `simulator`, the rest of the code as `simulation`; the site profile and
  StatShark count kills differently (up to 12×), only battles, wins and losses
  are comparable.
- **Vehicle BR from the datamine.** `economicRankArcade/Historical/Simulation`
  from `wpcost.blkx` → `VehicleInfo.br` (BR = rank / 3 + 1).
  `wt-vehicles.json` is rebuilt in the background once it is 7 days old
  (`src/wrpl/vehicles.ts`); a new field also needs a format version so an old
  cache without it is rebuilt at once, and BR changes with patches, so rebuild
  right after a game patch too. Aircraft in ground battles use
  `economicRankTankHistorical` (matches every spawn under the caps after the
  switch, 2026-10-08). Then show BR on the site and in `/scout`, and
  check the season stages' weekly limits against the vehicles in battles (in
  the summary worker). `/scout` predictions do not need it: older spawns
  under a new cap give a player's first battle at it in 9–15%
  (`docs/opponent-scouting.md`).
- **`/scout` pictures.** Screenshots pile up in `data/scout-images/` (kept
  for now): decide retention. Improve the reading on them with
  `npm run scout:images` (two of eight Chinese nicks unread on 2026-10-08:
  try `chi_tra`, per-row OCR or a higher scale for CJK rows). Add each new
  channel screenshot's flags, enemy row icons and enemy columns to
  `truth.json`, and score the replies with `npm run scout:outcomes --
  <copy.db>` once their battles are stored (the four channel records of
  2026-10-08 were test posts of battles 18 h older).
- **`/scout` StatShark weights.** Counted as live reads them (the snapshot
  the reply's update has, fresh within 2 days), only 11 new-vehicle events of
  2026-07-15 – 10-09 had one, so the two StatShark weights sit near their
  prior (`SHARK_L2`): refit with `--known-team --fit-all --statshark` once
  screenshots have refreshed a few hundred enemies before their battles
  (`scout:outcomes` counts them), and check the two-fold split
  (`SCOUT_SHARK_FOLD`).
- **`/scout` air chance.** After `KNOWN_TEAM_AIR_KNOTS`, "at least one
  aircraft" with flags and everyone in a vehicle still says 55–86% where
  63–92% happen out of sample (2026-10-09; 8–16 points before): the October
  caps fly more than the fitting period's. Try the cap's air share (from
  `capSpawns`) as a calibration feature, refit, and check the bands per
  moment.
- **`/scout` opponent context.** The previous battle's opponent air and a
  rematch × that meeting's air (28% of teams met the same squadron in the
  previous 3 h) add ~0.1 point to the first vehicle in an offline replica of
  the model (2026-10-09): worth it only with a cheap query for the opposing
  team of each enemy's last battle (`read-scout-players`).
- **StatShark: what is not shown.** The player page shows level, rank, dates,
  clan and nickname history and WT leaderboard places (`account_json`), but
  not `ratingsNeo` (StatShark's own scale, meaning undocumented) and
  `vehicleHistory` (fields are numeric codes). Go through all StatShark pages
  and the purpose of every field, from saved HTML if needed.
- **Clan `_id` as the key.** The leaderboard number does not change with the
  tag: use it, instead of `clan_core`, to link clans that changed their tag
  core (roster, rating history, battles under the old tag). Collected since
  2026-10-01; 2026-10-02 brought the first case: a clan changed its tag
  including the core, the number stayed. Open question — show the clan's
  current tag in old battles or the one it had at the time.
- **Guide calculator: the enemy team.** Since 2026-10-07 the PSR rule scores
  a battle against the enemy team's average PSR, at least 1500; the
  calculator and the tables assume a team at or below 1500. A field for the
  enemy team's average would show what strong opponents give (`lib/psr.ts`
  takes it; `psrCeiling` and the other average-path helpers need it too).
- **Guide measurements by script.** `frontend/src/pages/guides/measurements.ts`
  (data up to 2026-10-03, `OPPONENT` up to 2026-10-07) came from one-off
  read-only queries; a script over a database copy would refresh it each
  season and print what changed. `TIMING` comes from a live poll of
  warthunder.com and cannot be recomputed offline: repeat the poll when the
  site changes its caching.
- **Not collected yet** (decide whether needed): player search
  `searchplayers` (up to 100 nicknames by prefix, nickname only; needs the
  browser) — nickname hints for `/api/player-stats`; the player leaderboard
  `community/leaderboard` (top 2,020 per mode and sorting, numbers rounded to
  "105.0K"); WTCS `text/wtcsleaderboard` (esports);
  `clan_activity_by_periods` (meaning unclear).

## Product

The data for everything below is already collected; compute aggregates during
ingest or in the background, not per HTTP request.

- **Vehicle metastatistics**: win rate and K/D per vehicle, a "who kills whom"
  matrix (`battle_kills.killer_model × victim_model`), weapon efficiency
  (`weapon`), vehicles per map; classes from `data/wt-vehicles.json`.
- **Battle branch** (`air`/`ground`/`mixed`) from
  `battle_players.played_vehicles` (the lineup when NULL) and the vehicle
  dictionary: a `battles.branch` field and a server-side filter. As of
  2026-09-28 every battle is ground with aircraft: low value until other
  modes appear.
- **Clan vs clan**: meeting history, streaks, average score per opponent
  (`battle_players.clan_tag`, `team`, `battles.team_won`).
- **Maps**: a `levels/*.bin` dictionary → human-readable names, then win rate
  per side, duration and death locations (`battle_kills.victim_x/y/z`).
- **External player statistics**: develop or freeze (snapshots exist for 6
  identities; no dashboards until there is real data).
- **Not possible**: squad analytics — `battle_players.squad_id` is really a
  team marker (4096/4097). Postgres, Rust and GPU are not goals in themselves.

Notes on replay data quality —
[docs/replay-data-quality.md](docs/replay-data-quality.md).
