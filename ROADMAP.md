# wtbot open tasks

A living list: a closed item is deleted, a new one is added here. Checked
against the code and the production run on 2026-10-02. Earlier plans and
audits (`AUDIT.md`, `IMPROVEMENT_PLAN.md`, `MASTER_PLAN.md`, `WEBSITE_PLAN.md`,
`PLAYER_STATS_PLAN.md`) are done or obsolete; their open items are below, the
full texts are in Git (commit `46b6950` and earlier).

## Operations

1. **Database copies on another disk.** Since 2026-09-29 the bot runs in
   Docker on a home Linux server, and `./backups` is on the same disk as the
   database. After the events blobs moved to the columnar format (2026-10-02)
   the database is ~1.3 GiB and grows by ~1,800 battles and ~57 MiB a day
   (~20 GiB a year). The three copies are ~18 GB now (taken before the
   conversion) and ~4 GB after rotation by 2026-10-05 (`docs/database.md`).
2. **`data/data/`** (~480 MB, came from Windows) — an old copy of the data
   directory with the previous `wt-cookies.json`. Its `replays/` holds parts
   of 28 battles: 9 are already in the database, 19 are not (14 `expired`,
   5 `error`; the CDN no longer has them). Decide whether to parse them by
   hand, then delete the directory.
3. **Forum season.** If the post format changes, `wt-clan-season` fails with a
   parse error (visible on the dashboard) — fix `src/clan-season-forum.ts`;
   the schedule already in the database stays.
4. **Public site.** The tunnel to the external reverse proxy is up and
   `WEB_TRUST_PROXY` is set; the proxy still needs the site and TLS (do not
   commit addresses: the repository is public). Recovery after a server reboot
   or an IP change is untested. `POST /api/player-stats` (the refresh button
   on the player page, the dashboard form) queues a request to the
   warthunder.com profile through the browser (and to StatShark if enabled) —
   for anonymous visitors turn it off (`WT_PLAYER_STATS_ENABLED=false`) or
   keep the site behind the token. Discord OAuth is a separate decision.
5. **Image freshness.** Chromium and Debian packages update only with a
   rebuild without cache (README, "Production in Docker"): decide whether it is
   manual or a systemd timer, and when (a restart briefly pauses
   announcements).

## Code

- **English everywhere** (AGENTS.md, section 9). Docs are English; comments
  and strings in `src/`, `frontend/` and configs are still Russian: ~5,500
  lines (comments ~3,300, strings ~2,050: logs, Discord, site, images, tests).
  Cheap plan instead of a whole-repo sweep: a script extracts only the
  Cyrillic spans, a model translates small batches in fresh contexts, the
  script puts them back with checks (span unchanged, quotes, `${}` and `{n}`
  placeholders), then `npm run verify` and `npm run build:web`. Terms follow
  `frontend/src/i18n/en.ts` (squadron, PSR, AB/RB/SB); `en.ts` becomes the
  canonical UI dictionary (today `ru.ts` is, and `en.ts` lacks 4 keys).
  Server-side `ru`/`ru-RU` formatting → `en-GB`, `pluralRu` → English plurals.
  Logs quoted in docs (`[ingest] бой …`, `API вернул пустой список`, the verify
  skill) change together with the code. Slash-command descriptions reach
  Discord only after `npm run deploy:commands`. Also remove `.cbmignore`
  (codebase-memory-mcp is not configured) and move
  `Редизайн игрового портала/` to `frontend/design/portal-redesign/`.
- **Dead code and hotspots without reading everything:**
  `tsc --noUnusedLocals --noUnusedParameters`, exports without callers, files
  without importers, the longest functions — review only what they flag; the
  rest is reviewed when it is changed.
- `buildClanSnapshot` runs synchronously on the main thread: 89–103 ms per
  rebuild once a minute while the site is open (latest PSR snapshots 29 ms,
  roster 24 ms, the rest is JS). In a worker the main thread would keep ~13 ms
  of receiving the snapshot (3 MiB) — do it before the site goes public; needs
  `database` parameters on four read functions and a fallback path for
  `:memory:` tests.
- WAL checkpoint on the main thread: the main connection has the default
  `wal_autocheckpoint`, so a commit that crosses 1,000 frames synchronously
  moves the whole WAL (3,000 frames — 23 ms). While ingest checkpoints by
  itself the pauses are rare, ~10 ms; if writes grow —
  `wal_autocheckpoint = 0` on main and a periodic checkpoint in a worker.
- ECS 2.59: no serializer for the new type `0xcfad499d` (hanging ordnance
  `rocket`/`payload`), part of `ri_gpu_object` does not parse. Kills and
  trajectories are unaffected (entities are isolated), but these entities are
  lost.
- Migrations: the season tables and some indexes are created by bootstrap DDL
  outside the `PRAGMA user_version` registry.
  The same migration can drop the seven indexes no query uses (list in
  `docs/database.md`, "Page usage").
- Retention of `clan_rating_snapshots`, `clan_rating_history`,
  `player_external_snapshots`: decide how long to keep them.
- Foreign keys (`ON DELETE CASCADE` on player and season-stage tables) are
  declared but `PRAGMA foreign_keys` is off — cascades do nothing; the code
  deletes child rows itself, there are no violations (`foreign_key_check`
  2026-10-02). Enable after an integrity check or drop the declarations.
  `INSERT OR REPLACE` exists only on `battle_events`, which has no foreign
  keys — replacing never cascades.
- Player queries on a cold cache take ~120 ms (random reads of
  `battle_players`; warm — 1–5 ms, and since the blob conversion the whole
  database fits in the OS cache). If it becomes noticeable — a covering index
  `battle_players (user_id, session_id, …)`, ~+35 MiB.
- Web: `@fastify/compress` for large JSON (`/api/vehicles` — 226 KB, 43 KB
  gzipped), ETag for immutable responses.
- Dashboard `/`: ~1,000 lines of untyped inline script in
  `src/web/routes/pages.ts` — move it to a `.ts` built by `tsc`.
- SPA accessibility: timeline markers and event-feed rows in `ScenePlayer.tsx`
  are `<span>`/`<div>` with `onClick` and no keyboard support; replace them
  with `<button type="button">`. Arrow keys in `SegControl`.
- Large functions: `buildHeatmapSvg` (~710 lines), `extractReplayEventsProfiled`
  (~240), `src/db/index.ts` (~6,700 lines) — split once things settle.

## Tests

- `announce_state`: exactly-once and baseline monotonicity (the attempt limit
  and skipping stale battles are already in `src/db/announce.test.ts`).
- Migrations v1–v5 and v10 have no tests of their own (the other versions and
  the runner are in `src/db/migrations.test.ts`).
- Worker pool scheduler with a fake worker factory and fake clocks.
- WRPL/ECS/GMSync fuzzing and decompression edge cases.
- Render fixtures with many players: non-zero values, sorting, 32 players.
- `src/player-stats/service.ts` — smoke scripts only.
- Frontend: no tests and no test setup (error states, resetting
  `vehicleDictPromise` after a failure, battle pagination).

## Performance

Measurements, gates and rollback — [docs/performance.md](docs/performance.md).
Open: prove or disprove the RSS plateau for
`WT_REPLAY_EXACT_RESERVATION_ENABLED`, measure announcement latency
(discovery → preliminary → final edit), profile under Docker/Linux.

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
  `wt-vehicles.json` is built once and kept forever — it needs a format version
  and an expiry: BR changes with patches, so update it automatically after a
  game patch (or from the BR-change articles). Then show BR on the site and
  check the season stages' weekly limits against the vehicles in battles (in
  the summary worker).
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
- **Battle branch** (`air`/`ground`/`mixed`) from `battle_players.vehicles`
  and the vehicle dictionary: a `battles.branch` field and a server-side
  filter. As of 2026-09-28 every battle is ground with aircraft: low value
  until other modes appear.
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
