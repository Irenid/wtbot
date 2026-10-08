# AGENTS.md

`wtbot` contracts for agents and developers — what the code does not show at
a glance. Behavior: the code and the SQLite schema; commands and env:
`package.json`, `src/config.ts`, `src/runtime-options.ts`, `.env.example`.

## 1. Working rules

- Use every available resource and all of the machine's capacity, search
  everywhere — do not hold back. Model tokens are the exception: estimate a
  large job first and give the model only what needs it (scripts extract the
  text, small batches, a fresh session).
- Search with targeted tools (`rg`, `git grep`) instead of reading the whole
  repository; no MCP server or shell wrapper is required.
- Before an edit, find the affected functions and their callers; after it,
  check the impact on neighbouring subsystems. No unrelated refactoring.
- Other people's changes and untracked files are the owner's work: do not
  revert, reformat, delete or include them in your commit.
- Documents: `README.md` — running; this file — contracts; `ROADMAP.md` — the
  only list of open tasks (closed items are deleted); `docs/` — measurements
  and notes (`performance.md`, `database.md`, `replay-data-quality.md`,
  `opponent-scouting.md`); `LICENSES/` — licenses of ported code; skills —
  `.claude/skills/verify/` (checks, live bot), `.agents/skills/monorepo-debug/`
  (diagnostics). Do not add new plans or audits to the repository root.
- Do not read or print `.env` values without a direct need; for diagnostics
  print the key name and `set/empty`.

Never without the owner's explicit permission:

- publish tokens, cookies, API keys, Discord IDs, battle chat, DB dumps;
- delete, recreate or publish `data/wtbot.db` (Discord IDs, voice presence,
  players, chat) or `data/wt-cookies.json` (live cookies);
- clean `data/replays`, `data/battles`, maps or assets — before deleting name
  the path, size and reason;
- run commands with external effects (section 10), deploy or restart the bot.

## 2. Architecture

Modular TypeScript monolith. One Node.js process: Discord, Fastify, the parser
scheduler, ingest coordination. A bounded `worker_threads` pool: WRPL parsing,
zlib/zstd/gzip, Resvg, part of the geometry, provably blocking SQLite writes.
Entry point — `src/index.ts`; storage — synchronous `node:sqlite`, all SQL in
`src/db/index.ts`, no ORM. Modules call this API directly: moving to async
storage would touch every caller, not only `src/db/`.

```text
warthunder.com / CDN -> parser sources -> items -> staged WRPL ingest
  -> battles / players / kills / chat -> Discord + web API + media
```

`src/`: `index.ts` (startup, shutdown), `config.ts` and `runtime-options.ts`
(env, resource plan), `db/` (bootstrap, migrations, SQL, maintenance), `bot/`
(commands, announcer, voice tracker, player board), `web/` (API, dashboard
`/statistics`, SPA `/`), `parsers/` (scheduler, sources, cookies, browser, backfill),
`wrpl/` (replays, ingest, assets, media), `workers/` (pool, protocol),
`player-stats/` (external providers), `analysis/` (manual CLIs, smoke checks,
paid AI analysis). `frontend/` — React/Vite SPA; `data/` — database, cookies,
caches, assets.

Startup: Discord token check → process lock → signal and fatal-error handlers
→ SQLite (no page warmup) → player stats → Discord → player board → voice
tracker → Fastify → SQLite warmup in a worker → WT cookie refresh (browser on
demand) → parsers → ingest → database maintenance. Shutdown: refuse new work,
up to 10 s to drain producers, then the browser, Discord, the CPU pool and
SQLite last. Do not close the pool before worker-task producers have stopped.

### Concurrency

- Independent I/O runs in parallel: `Promise.all` when the input is bounded by
  configuration or a small constant; otherwise a worker loop with an explicit
  concurrency cap, byte budget, timeout and cancellation.
- A sequential `await` in a loop only for dependent results, required order,
  rate limits, locks, retry/backoff, short-circuit search or a shared budget;
  write the reason next to the loop.
- CPU work only through the pool: `Promise.all` does not make it parallel.
- Fan-out is bounded by `WT_WORKER_THREADS`, `WT_INGEST_CONCURRENCY`, the
  browser pool, Discord and API rate limits, SQLite write pressure and the
  replay budget.
- Deliberately serialized: SQLite transactions and the write queue, the shared
  warthunder.com queue, paginated fetches with stop conditions, retries,
  commit-marker publication, ordered Discord flows.
- A new parallel path comes with a test: simultaneous start, concurrency cap,
  partial failure and fallback.

## 3. Environment and operations

- Node.js ≥ 22.15.0 (`zstdDecompressSync`); npm, install with `npm ci`;
  `package-lock.json` changes only together with dependencies.
- `.env` is local and outside Git; the full catalogue with defaults is
  `.env.example`. A new variable goes at once into `src/config.ts` or
  `src/runtime-options.ts`, `.env.example` and, if it is a contract, here. No
  real values in tracked files.

| Variable | Contract |
|---|---|
| `TOKEN` | required by the bot process and CLIs importing `src/config.ts` (`battle`, `analyze`, `backfill`, `deploy:commands`); standalone CLIs (`db:backup`) do not need it |
| `CLIENT_ID`, `GUILD_ID` | slash-command registration |
| `DB_PATH`, `WTBOT_ALLOW_NEW_DB=false` | a new database only when explicitly allowed |
| `PORT`, `WEB_HOST=127.0.0.1`, `WEB_TOKEN` | loopback accepts only a loopback `Host` (DNS rebinding); non-loopback (always `0.0.0.0` in Docker) only with `WEB_TOKEN`: Bearer or HTTP Basic password |
| `WEB_TRUST_PROXY` | `false`/`true`/IP-CIDR list for `X-Forwarded-For`; Fastify 5.12 has no hop count |
| `WTBOT_API_URL`, `WTBOT_API_TOKEN` | Vite dev proxy only (`frontend/vite.config.ts`): `/api` to the production server with Bearer; the bot does not read them, the token never reaches the bundle |
| `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL`, `WT_CLAN_TAG` | empty voice list — all channels; a battles channel without a clan tag announces every clan (~1,800 battles a day); the tag filters publishing, not collection |
| `WT_SCOUT_CHANNEL` | channels where a scoreboard screenshot is read and answered (`src/bot/scout-images.ts`); adds the `GuildMessages` intent, and `MessageContent` only when the application has it (asking without it fails the login, 4014) |
| `WT_ANNOUNCE_MAX_AGE_HOURS=2` | older battles are marked done instead of posted: downtime does not flood the channel with history |
| `WT_COOKIE` | warthunder.com session for `wt-replays` and `wt-players` |
| `WT_COMPANION_COOKIE` | separate `companion-app.warthunder.com` session; never mix with `WT_COOKIE` |
| `WT_BROWSER_*` (`ENABLED=true`) | Edge (Windows) or Edge/Chrome/Chromium (Linux) for addresses behind Cloudflare; `NO_SANDBOX=true` only in Docker |
| `WT_VNC_PASSWORD` | VNC to the browser's Xvfb display in Docker: manual login and Cloudflare checks |
| `WT_REPLAY_HOSTS` | allowlist of CDN hosts for replay parts (`src/wrpl/replay-url-policy.ts`); structural SSRF protection applies without it |
| `WT_PLAYER_NAMES` | nicknames for `wt-players`: Replay API and HTML profile |
| `WT_PLAYER_STATS_ENABLED=true`, `WT_COMPANION_PROFILE_ENABLED=true`, `STATSHARK_PLAYER_STATS_ENABLED=false` | lazy account snapshots: companion (primary; runs only with `WT_COMPANION_COOKIE`), site profile, StatShark (fallback, only with a known numeric WT user id) |
| `WT_PLAYER_ID_LOOKUP_ENABLED=true` | with `WT_PLAYER_STATS_ENABLED`: a profile without an id looks its WT user id up (`POST /api/player-id`, section 8); the Replay API step only with `WT_COOKIE` |
| `WT_WORKER_THREADS=auto` | from CPU, RAM and reserves; cap 8, estimate 320 MiB per worker |
| `WT_WORKER_BACKGROUND_RESERVE`, `WT_WORKER_MAX_OLD_SPACE_MB` | slots reserved for interactive work; old space of one worker |
| `WT_INGEST_CONCURRENCY` | cap 32; above the pool size it overlaps CDN I/O at the cost of RAM held by replays |
| `WT_INGEST_ADAPTIVE_ENABLED=true` | AIMD lowers concurrency on 429/retry/5xx and on replay-budget or SQLite-queue pressure |
| `WT_INGEST_PIPELINE_ENABLED=true` | staged pipeline; `false` — the previous runner (rollback) |
| `WT_REPLAY_PROCESS_BUDGET_MB` | shared limit for replay buffers, 128–8192 MiB; auto reserves it before sizing the pool |
| `WT_REPLAY_EXACT_RESERVATION_ENABLED=false` | reserve by cached size or 1× `Content-Length` instead of the 96 MiB worst case; off until an RSS plateau is proven (`docs/performance.md`) |
| `WT_BATTLE_CACHE_MB`, `WT_BATTLE_CACHE_ENABLED`, `WT_GAME_DIR`, `WT_HEATMAP_AIR_*` | media cache, game files, air heatmap parameters |
| `WTBOT_BACKUP_TIME`, `WTBOT_BACKUP_DIR`, `WTBOT_BACKUP_KEEP`, `TZ` | daily `db-backup-schedule` (`backup` service) |
| `ANTHROPIC_API_KEY` | manual `npm run analyze` only |

- Production runs in Docker on Linux (`Dockerfile`, `docker-compose.yml`,
  `docker/entrypoint.sh`): Chromium under Xvfb, `node` user, `./data` volume,
  `restart: unless-stopped`. Development and tests — Linux or Windows (CI runs
  both). `data/*` paths are relative to the working directory: `WORKDIR /app`
  in Docker, the repository root locally. If your checkout is the production
  compose directory, its `data/` is the running bot's data: `npm run dev`,
  `battle` and backfill write to the same database, and a second bot would use
  the same Discord token.
- Deploy only with permission. Before `docker compose build`, tag the running
  image (`docker tag wtbot:latest wtbot:pre-<what>`): an untagged image is gone
  once the container is recreated. Back up the database as a separate step and
  check the file before `up -d`: without it a schema-changing migration cannot
  be undone. Rollback — `docs/database.md`.
- Lock files (process lock, cookie jar, backup) survive a container restart:
  the new process usually gets the crashed one's PID, so a lock with our PID
  and a foreign `ownerToken` is left over from the previous run.

## 4. SQLite

`node:sqlite` is synchronous: a query on the main thread stalls the Discord
heartbeat, the voice tracker and Fastify. Queries are short, indexed and
parameterized. Measurements, decisions and migration rollback —
`docs/database.md`.

- SQL lives only in typed functions of `src/db/index.ts`; batch writes run in
  a transaction.
- Check a new or changed heavy SELECT with `EXPLAIN QUERY PLAN`, also on a
  copy of the production database: since v17 the planner has statistics
  (`ANALYZE`, then `PRAGMA optimize`), and the `:memory:` plan may differ.
- The events blob lives in `battle_events` and is read only by one battle's
  key (`SCAN battle_events` is forbidden); `battles` is compact,
  `WITHOUT ROWID` by `session_id`. A large value (blob, JSON > ~1 KiB) in a hot
  row takes its own page, and the columns after it are read through an
  overflow chain.
- Each `battle_players` index costs ~16 entries (the battle's players) per
  battle: add one only for a query whose plan uses it.
- `WHERE session_id = ? OR session_hex = ?` uses a multi-index OR with
  `idx_battles_session_hex`, not a full scan.
- `getIngestStats().pending` and `getPendingBattleItems()` share one
  retryable predicate; the pending aggregate does not read `events_blob`.
- `initDb()` is the idempotent bootstrap of a clean database,
  `runDbMigrations()` versions via `PRAGMA user_version`. A change to a table,
  index or constraint is a new migration version plus the matching bootstrap
  change; never hide migration errors behind a broad `catch`. The code refuses
  a database with `user_version > DB_SCHEMA_VERSION`, so after a migration the
  previous image needs a backup.
- Connection: WAL, `synchronous = NORMAL` (commits skip fsync; a power loss
  rolls back the last transactions but does not corrupt the file), mmap 1 GiB,
  `journal_size_limit`, `temp_store = MEMORY` after VACUUM. A new database gets
  `auto_vacuum = INCREMENTAL`; startup VACUUM runs only for a database without
  it (once, minutes per gigabytes, bot offline) when free space exceeds 20% and
  256 MiB.
- Maintenance (`db/maintenance.ts`) runs in worker tasks `db-maintenance` and
  `repair-battle-events`, never on the main thread: each repair batch returns
  freed pages at once; every few hours `PRAGMA optimize(0x10002)` (without flag
  0x10000 a fresh connection sees no tables) and `incremental_vacuum` in
  `VACUUM_STEP_PAGES` (256 pages) steps with a pause; it stops before the CPU
  pool.
- A background write transaction (worker, maintenance, a one-off script next
  to the bot) takes tens of milliseconds at most: a main-thread write waits for
  the foreign lock synchronously and the event loop stalls. One 8,192-page
  `incremental_vacuum` portion held the lock for 1.3 s (watchdog, 2026-10-02).
- Stored battles are fixed by the `repair-battle-events` pass: the rules in
  `events-repair.ts` and `player-events.ts` are the ingest rules; columnar
  format, empty `slot`, `title`, `air_unit_count`, `chat_count` and the player
  facts (section 7, "Ingest") come from the events. The blob with the kill and
  chat rows, and the player facts, are replaced only if the blob did not
  change since it was read. A new rule is the next `REPAIR_VERSION`, never a
  manual edit of the database; what SQL or a fresh CDN parse can fix is a
  migration (example: v18).
- A final failure to re-parse a stored battle (`expired`, `no_parts`) keeps
  status `ok` with the reason in `error`: the previous parse's rows are the
  battle's data.
- Frequent writes to the database file (ingest, parser history, player board
  publication) run as worker tasks `persist-ingested-battle`,
  `record-parse-result`, `update-player-stat-board-publication`; `:memory:`
  tests use a sync fallback.
- A worker write changes `PRAGMA data_version`: main-thread read caches are
  invalidated through it, never on the assumption that only main writes.
- `primeKnownItemExternalIds('wt-replays')` loads known IDs from a covering
  unique index before the parsers start: a hit skips SQLite, a miss queries
  (keeps parallel backfill correct).
- Player search uses the indexed `canonical_nick_search`, `nick_search`,
  `battle_players.nick_search`: JS `NFKC` + locale-neutral lowercase
  (`normalizePlayerSearchKey`), never `COLLATE NOCASE`; typo-tolerant matches
  scan these keys in a worker (section 8, "Player search").
- `items`: transactional writes, `UNIQUE(source, external_id)`, changes
  detected by `content_hash` of title + JSON; new sources and backfill keep it.
- `db:backup`: `VACUUM INTO`, lock, free-space check, rotation, read-only
  `quick_check`. Restore only with the service stopped: check the backup, save
  the current database as `.pre-restore`, check a temporary copy, then replace
  `DB_PATH`.

## 5. Workers

- Only structured-clone values and exact transferable `ArrayBuffer`s go to a
  worker; Discord, Fastify and SQLite handles never do.
- Not on the main thread: synchronous WRPL/BLK/VROMFS/ECS parsing, large JSON
  transforms, compression, base64 images, Resvg (`@resvg/resvg-js` is created
  only in workers), provably long SQLite writes.
- Pool: limits on task count and transferable bytes, priorities, reserved
  interactive slots, queue and execution timeouts, hung-worker replacement.
- An interactive request raises the priority of the shared background task
  instead of starting a duplicate.
- `EXEC_TIMEOUT`, queue timeout, startup or scheduling failure and queue
  overflow spend no ingest or announcement attempts — except 3 timeouts in a
  row (`ExecTimeoutBudget`), otherwise a deterministically slow task would
  repeat forever. A failure of a parse that already ran is a normal attempt.
- Discord handlers still `deferReply`/`deferUpdate` right away.

## 6. Parsers and warthunder.com access

Sources (constants live in their files under `src/parsers/sources/`):

- `wt-replays` — every 20 s, up to 50 pages (`PLANNED_REPLAYS_MAX_PAGES`),
  `stopAtKnown`, no `fetchDetails`; stops at a known page, the last incomplete
  page, a date cutoff or the cap.
- `wt-players` — every 30 min, `WT_PLAYER_NAMES` one by one, only the first
  Replay API page.
- `wt-clans` — every 20 min the first 5 pages of the squadron leaderboard (top
  100), every 12 h further while the season rating (`dr_era5_hist`) is above
  zero, up to 100 pages (hitting the cap shows in the source status). A tag
  missing from the dictionary (a squadron that began playing after the last
  full crawl: 1.9% of teams on 2026-10-03) has no claninfo name, so no PSR:
  the battle post's last update asks for the full crawl at once
  (`lookupUnknownClanTags` → `runParserNow`; one lookup at a time; a tag not
  found is retried after 15 min, doubling up to 12 h), then fetches claninfo
  and redraws the post. A crawl writes `clans` with one shared `rating_at`,
  change points of rating, battles,
  wins, kills and deaths to `clan_rating_history`, the core tags it read in
  place order and whether it was full to `clan_crawls` (kept
  `CLAN_CRAWL_KEEP_SEC`, 3 days: change points cannot tell an unchanged
  squadron from one the crawl missed), the leaderboard season to
  `bot_state` `wt-clans:season` (a mismatch with the forum shows in the
  status). Region, type, slogan and rewards arrive HTML-escaped with game
  markup (`<color=#…>`, `<b>`) — plain text is stored; tag and name stay as
  they are (keys of battles and claninfo). Profile: `_id` (survives tag
  changes), description and announcement (line breaks kept, ≤ 2048 chars),
  `membership_req` `{ranks, battles}`, auto-accept, undecorated tag
  `lastPaidTag`, last season's decoration. Then the claninfo roster of 5
  leaders whose roster is older than a day (otherwise only clans from drawn
  battles would have rosters and PSR): role (the deputy's cell reads the
  untranslated key `clan/deputy`), join date, activity; an unknown cell value
  becomes `NULL`. Founding date — the leaderboard's `cdate`:
  claninfo shows "01.01.1970".
- `wt-clan-season` — every 6 h the first post of
  `forum.warthunder.ru/raw/2509/1` (not warthunder.com: no Cloudflare, a plain
  bounded fetch) → seasons `forum-YYYY-MM-DD` in `clan_seasons`.

The scheduler starts sources at once, never overlaps runs of one source, keeps
results per source and backs off exponentially up to 30 min; a worker task
writes parse history for a file database. A new source is a `ParserSource`
with a unique `name`, `intervalMs` and `run(): Promise<{ summary, items? }>`,
registered in `src/parsers/sources/index.ts`; rerunning unchanged items yields
`unchanged`.

Access:

- `wt-replays` and `wt-players` need an authorized session; HTTP 200 with an
  empty list does not prove it works (source status
  `API вернул пустой список` — "API returned an empty list": `WT_COOKIE`
  expired, log in by hand).
- Every warthunder.com request goes through `fetchWtResponse()` or
  `waitForRequestSlot()`: one queue per process, 1,500 ms spacing,
  `Retry-After`. A direct `fetch()` to the site's HTML or API is forbidden.
- Cloudflare checks individual addresses: in October 2026 only the player
  profile and player search got 403 `cf-mitigated: challenge`, while the
  Replay API, leaderboards, claninfo and WTCS answered directly. So the
  transport is chosen per route (first three path segments): a direct request
  first, the browser after a Cloudflare check, the direct path re-probed every
  6 h; modes are in `/api/stats` → `wtTransport.routes`. A network failure of
  a direct request is retried once through the browser without changing the
  route's mode.
- Jar `data/wt-cookies.json`: live cookies in plain text, atomic writes, an
  inter-process lock; it also keeps the User-Agent of the browser that issued
  the session (direct requests present themselves as that browser).
- The jar owns the WT session (`identity_*`); only the Replay API needs it. A
  public direct request goes without cookies and leaves the jar alone; direct
  requests never send Cloudflare cookies. The browser gets the jar session
  only while the Replay API goes through it, and writes it back then;
  otherwise it browses anonymously: the server rotates `identity_sid`, and two
  live copies of one session would diverge. The browser's own session (a VNC
  login) is adopted into the jar when the Replay API returns an empty list;
  without one the Replay API moves to the browser for 6 h. A host-only cookie
  copy next to the domain cookie was a past bug: the server read a stale
  `identity_sid`, redirected to login, and the Replay API returned an empty
  list.
- claninfo (`src/wrpl/clan-info.ts`) uses its own direct `fetch` without
  cookies, but after `waitForRequestSlot()`; a 429 delays the whole queue. If
  it starts answering 403 `cf-mitigated: challenge`, switch it to
  `fetchWtResponse()`.
- The browser is a normal process driven over CDP: a persistent Playwright
  context and true headless mode fail Cloudflare; hidden mode is an
  off-screen window; CAPTCHAs are never solved automatically. Platform code
  (paths, Docker flags, `/proc`, SingletonLock) lives in
  `wt-browser-platform.ts`; on Linux without `DISPLAY` the browser does not
  start. Clearance probes: pause 0.5→4 s, at most
  `MAX_FAILED_CLEARANCE_PROBES` failures per attempt.
- `.wrpl` parts come from the CDN through a plain bounded `fetch`: the browser
  transport decodes bodies as text.
- Every external fetch has a timeout, a response byte limit and a schema or
  format check before anything is cached permanently.
- `npm run backfill -- <days>` closes a gap (3 days by default, parsing left to
  ingest) while the parts are still on the CDN (~2 weeks).

## 7. Ingest, WRPL and media

### Ingest

- A tick takes up to `2 × concurrency` pending items: newest first, every 8th
  sweep oldest first. Producers (every 500 ms) download a replay into a
  bounded ready queue (by count and bytes) → up to 4 consumers → worker
  `parse-battle` → serialized `persist-ingested-battle` on its own connection:
  one transaction updates `battles`, `battle_events`, `battle_players`,
  `battle_kills`, `battle_chat`, `battle_ingest`. Passive WAL checkpoint every
  32 commits or 60 s, and a separate worker task on shutdown.
- AIMD and the process byte budget keep the load on the CDN, the pool, SQLite
  and RAM in check; a budget timeout defers the item without an attempt.
- After the commit the session's cached parts and its old artifacts in
  `data/battles/` are deleted: the battle can be rebuilt from its rows and
  events blob.
- The events blob (`battle_events`, `events-codec.ts`) is columnar:
  trajectories (99% of events) as delta arrays, zstd-19, ~20 KiB per battle.
  A write verifies a byte-exact round trip, otherwise it stores zstd-JSON;
  readers also accept zstd-JSON and gzip. Read through
  `decodeEventsPayload`/`decodeEventsBlob`; `inflateEventsBlob` (JSON text) is
  only for hashes and format conversion. An image without the columnar format
  cannot read these blobs (rollback — `docs/database.md`).
- The Replay API lists ~2% of battles before they end: their `partsCount` and
  `endTime` are early, and the bot reads an item only once. So before
  downloading, ingest probes for parts after the known ones
  (`withUnlistedReplayParts`: a one-byte GET until the first 404; a 429 is
  retried, any other error fails the attempt instead of ending the list,
  otherwise an old battle with an incomplete list would become `expired`). A
  404/410 for a battle younger than an hour (from `endTime`) means "not
  uploaded yet". Intermediate results (part 0001, ~95 s, no status) are not
  stored; the final results of a battle that ran out of time (also without a
  status) are told apart by a duration at least the listed one
  (`hasFinalReplayResults`). Such a battle waits in memory
  (`ReplayPartWaitList`, 1→3 min) without an attempt; `expired` only after
  that window. A truncated battle in the data: `status` NULL, `team_won = 0`,
  ~95 s (v11–v14 requeued such battles).
- results-BLK lists each player's lineup (`vehicles`, matchingInfo
  `crafts_info`), not what was driven; credits a bot slot's kills and score to
  the player who did not load in (the bot keeps its deaths); has
  `teamKills` ≈ 0; may give team 0 to a player who never loaded in while
  `squad_id` keeps the marker. `player-events.ts` (ingest and repair v2)
  derives from the events: `played_vehicles` in spawn order (`vehicle` is its
  first; NULL — no tracks, readers use the lineup), `bot_user_id` (only the
  team's single slotless player and single negative-id slot pair up),
  `team_kills` from the kill feed, the team from the squad marker. Readers
  hide a paired bot row, credit its tracks, kills and damage to the player
  (`creditBotSlots`, scene `botSlots`) and draw no card for team ≤ 0. Audit —
  `docs/replay-data-quality.md`.
- The game sometimes records no squadron tag for a player, in results-BLK and
  the ECS slot alike, for a whole login session (0.8% of rows, 2026-10-08).
  `fillSquadronTags` (`squadron-tags.ts`) gives such a player the team's tag
  when every real player of the team carries its squadron-battle marker
  (`squad_id` 4096/4097; never a random battle's platoons) and the team's tags
  share one core: ingest after the event facts, the results-only render of
  an unstored battle, migration v21 for stored rows. The chat text takes the
  results tags over the slots'; the events blob keeps the slots as recorded.

### Untrusted binary input

`.wrpl`, BLK, VROMFS and ECS packets are untrusted data without a schema. In
`bit-reader.ts`, `packet-stream.ts`, `lz4.ts`, `ecs.ts`, `gm-sync.ts`,
`replay-events.ts` and new decoders:

- check lengths, counts, offsets and ranges before arithmetic and allocation;
  never remove bounds checks of varints, LZ4, ECS, FAT BLK, VROMFS, XOR/RLE or
  packet fields; a TypeScript non-null assertion is not a runtime guard;
- zlib/zstd/gzip get output limits, workers an execution timeout;
- after a parser change run the corpus (`npm run verify:benchmark-corpus`:
  hash, outcome, data contract).

Format: the packet stream starts after `1234 + settingsBlkSize`, parts are
concatenated logically. Compression is detected by magic
(`packetStreamCodec`): zlib before 2.59, zstd since 2.59 (header `101404`),
when the ECS construct message also gained a format byte before the component
count (`ECS_CONSTRUCT_PREFIX_VERSION`). A slot userId is a signed int64
(`BigInt.asIntN`; negative for bots, as in results-BLK). Chat strings have a
varint length (`readVarLenStr`: a one-byte length truncated messages longer
than 127 bytes). The chat is signed with the anonymous `fakeName`s of the
Replay API item — ingest replaces them with real names (`fakeNamesFromItem`)
before storing. ECS links an entity UID to a model and a player; aircraft
tracks come from flight-model packets, ground tracks from GMSync
(delta/XOR/RLE).

A game patch breaks parsing silently — results-BLK (players, scores) still
reads, the events do not:

- a part no codec can decompress is a parse error, not an empty battle;
- one failing ECS entity does not abort the packet (the block boundary is
  known): the others, player vehicles included, still parse, and the error
  goes to `events.errors`;
- the symptom in the data: `kill_count = 0` and empty trajectories while
  `battle_players` has kills; compare by `game_version`;
- add a replay of each new game version to `benchmarks/replay-corpus.json`;
- re-parse stored bad battles with a migration that clears their
  `battle_ingest` status (example: v6/v7) while the parts are on the CDN
  (~2 weeks).

`prepareBattleData()` downloads and reserves parts, `parsePreparedBattleData()`
hands them to a worker; the previous `loadBattleData()` stays for rollback and
interactive paths. `reconstructBattleSummary()` does not read `events_blob`;
media hands the compressed blob to a worker.

### Media and cache

- Media is built from SQLite, from the CDN only when needed; parallel builds of
  one session are merged, and an interactive request raises the priority.
- `buildBattleMediaKind()` + `render-media-kind` build only the requested log,
  chat or heatmap; `buildBattleMedia()` + `render-media` build the full set for
  warmup and CLI; the 2× heatmap is separate. Ground/air/team heatmaps reuse
  `PreparedHeatmapScene`; SVG builders are pure functions.
- The site's scene background matches the ground heatmap: a snapshot of the
  mission mode's tactical map (wt-tools, exactly battleArea; downloaded while
  building the scene, only when battleArea is known), otherwise the local
  level map; never substitute another mode's map. `/api/battles/:key/map.png`
  reads maps only from disk.
- The winner comes from events and the database, never from results-BLK;
  anonymized names are restored by `userId`, not only by nickname.
- Resvg font order (`src/workers/render-fonts.ts`) is the fallback order: a UI
  font without box-drawing glyphs (Linux — Noto Sans from `fonts-noto-core`,
  Windows — Segoe UI), the game font, scripts, symbols. DejaVu with
  box-drawing draws frames instead of the game's glyphs in clan tags;
  `map-icons.ttf` is not in the Resvg base set: it replaces digits and letters
  with icons.

Data:

- `data/wtbot.db` — the source of truth and the dataset;
- `data/replays/<sid>/` — TTL cache of replay parts;
- `data/battles/` — LRU of rendered artifacts up to `WT_BATTLE_CACHE_MB`:
  `*-meta.json` is published last as the commit marker, eviction removes the
  whole session set; `WT_BATTLE_CACHE_ENABLED=false` disables reuse, not
  saving;
- `benchmarks/fixtures/replays/` — the only permanent WRPL corpus;
- `data/scout-images/` — screenshots sent to `/scout` and their readings;
- `data/missions/`, `maps/`, `unit-icons/`, `fonts/`, `weapons.json`,
  `ecshashes.json`, `wt-vehicles.json` — assets and rebuildable indexes;
- `data/wt-game/ui/` — copies of the game's `fonts.vromfs.bin` and
  `atlases.vromfs.bin` for Docker (`WT_GAME_DIR`): nation flags are read from
  the atlas at every start; on failure the built-in flags remain and the image
  still renders.

## 8. Discord, site and player statistics

- Slash command: a file in `src/bot/commands/`, registration in
  `src/bot/commands/index.ts`, then `npm run deploy:commands` — only with
  permission.
- `/battle` and the announcer share `renderBattlePost()`; `battle:*` buttons
  are routed in `src/bot/index.ts`; chat, log and heatmaps are ephemeral.
- `/scout squadron [player]` (`src/scout/`): the enemy squadron's likely
  players, each one's vehicle chances and the team's class counts, from its
  stored battles (worker task `read-scout-history`, 30 s cache; squadron
  and player autocomplete through `Command.autocomplete`). One spawn per
  player in a squadron battle, so the eight vehicles are the setup.
  `model.ts` holds logistic weights and calibrations that
  `npm run scout:backtest -- <copy.db> --fit-all` fits (`--fit`: train
  before `--split`, test after); refit after a rules or format change and
  update the accuracy in `docs/opponent-scouting.md`. The BR cap switches
  `STAGE_SWITCH_DELAY_SEC` after the schedule's 00:00 UTC.
- `/scout` by picture: a Tab screenshot in `WT_SCOUT_CHANNEL` → worker task
  `read-scoreboard-image` (`src/scout/scoreboard-read.ts`): rows by
  horizontal colour edges and even spacing (team colours are never assumed),
  one Tesseract child process per model of `OCR_PASSES` (the image installs
  them), nicks of the last 120 days matched approximately in every reading;
  the right-hand nick of a row is the enemy. Then `read-scout-players` and
  `predictKnownTeam` (roster known, vehicles from each player's own battles at
  the cap). Every image and its reading stay in `data/scout-images/<day>/`;
  with `truth.json` there they are the test set (`npm run scout:images`
  scores them; Discord IDs inside, never publish).
- The image's PSR column (`src/wrpl/battle-psr.ts`): the battle's points by
  the guides' formula above, PSR after the battle below (before it while the
  winner is unknown). The formula's opponent is the enemy team's average PSR,
  at least 1500: the drawn battle's from its players' estimates, an earlier
  one's from their readings before its start (`getBattleTeamPsr`, cached). A
  claninfo read at the announcement lags up to 15 min, so the PSR before the
  battle is the last readings (snapshot changes, the last roster read) carried
  over the player's stored battles; which battles a reading counts is a
  Viterbi path over read times and values. `PSR_RECHECK_AFTER_SEC` (16 min)
  after the battle the post rereads the pages (`freshAfter`), and
  `PSR_RECHECK_STORE_WAIT_SEC` (3 min) later redraws when a number changes: a
  reading that counts exactly the battle gives the page's own PSR. The wait
  lets the battles the read counts be stored: a player's next battle often
  ends before the recheck (median 7 min apart), and a read counting a battle
  the path lacks is pinned on this one. The page shows the PSR after a battle
  only if it refreshed before the next one ended (about half of players); the
  others keep the formula's. The page's change replaces the formula's only
  past the rounding, within 4 points and with the result's sign; otherwise it
  holds another battle. The recheck queue is in memory: a restart drops the
  waiting ones.
  Rechecked players whose battle two readings isolate feed
  `psrFormulaCheck()` (`/api/stats` → `psrFormula`, a warning under 90%): a
  drop means Gaijin changed the rule. Accuracy in the module header.
- Announcer: attempts and message state in `announce_state`, the baseline in
  `bot_state`; the first start does not publish history; battles older than
  `WT_ANNOUNCE_MAX_AGE_HOURS` are skipped by one `skipStaleAnnounce()`. A
  battle is posted once, after its commit; preliminary messages are no longer
  sent (since 2026-08-01), and the legacy ones behind the baseline
  (`getUnfinishedAnnounceMessages()`, loaded at announcer start, kept until
  resolved) are edited into the post or the error, or marked done if Discord
  deleted them.
- `/playerboard setup` stores the channel and one editable message in SQLite;
  the board shows the current voice snapshot and writes its publication state
  through a worker task only when the hash changes. The WT nickname is the
  display name up to the first `(`.
- `POST /api/voice/refresh` — at most once per 5 s (`Retry-After`),
  single-flight `refreshVoice()`.
- Squadrons on the site: rating, place, the list's 24 h change, the clan
  page's "30 days" delta and chart are official, from the leaderboard (PSR
  snapshots exist only for clans from drawn battles, and their sum missed the
  leaders). Ranking tiers (`RANK_TIER_*` in `src/web/routes/site.ts`): the
  latest crawl, earlier crawls of the season, clans with a rating above zero
  missed by the last full crawl (`wt-clans:full-crawl-at`; disbanded or fallen
  to zero: a stale rating would outrank clans in the table), then clans
  without official data, rated by the PSR sum from snapshots (a zero sum —
  seen only in an earlier season — is left out of the list and the home
  count; its page still opens). A zero rating
  below the crawled part is confirmed by the full crawl, not dropped. A
  renamed squadron (one leaderboard `_id`, else one founding time) is one row
  under its newest core tag (`renamedClanCores`; its old core used to keep its
  last row among the dropped: 4 squadrons on 2026-10-05); old links,
  favourites and search resolve to it, its history and crawl reads stay under
  the old core.
  The 24 h change and the day's battles and wins end at the clan's own
  confirmation time (top 100 every 20 min, the rest at full crawls) and start
  at the `clan_crawls` read nearest a day before it, at most
  `DAY_BASE_MAX_SHIFT_SEC` (6 h) off and no further than the log's start;
  otherwise at the last history point before that mark (alone it gave the
  rest 32–36 h, 2026-10-05). `/api/clans` returns the window
  (`delta24hFrom`, `delta24hTo`; null after that fallback: history cannot
  tell when the base was read). A squadron's page (`/api/clans/:coreTag`)
  carries its row's day figures, places moved and live mark from the same
  snapshot, and `ranking`: the table's size, leader, tier cut-offs, records
  and the neighbours one place up and down (null unless both are `current`:
  a dropped or estimated rating is no score to pass). `clan_roster` is the last
  non-empty roster; the roster, members' PSR and their deltas are filtered by
  it. A member links to an identity by alias, else to the single WT user id
  of the exact nick in replays (a reused nick: none), else to
  `/players/nick/:nick` — the matching of `resolveKnownPlayer` without its
  writes: a GET creates no identity; that page then looks the id up
  (`POST /api/player-id`).
- `/api/clans` views (`src/web/clan-ranking.ts`): `sort`
  (place/change/battles/winRate/kd/members), `dir`, `live`, `tags` (≤ 50 core
  tags: the SPA's favourites, kept only in the browser's localStorage); search
  → filters → sort → page. A win rate or K/D from fewer than
  `MIN_RATE_BATTLES` (50) season battles sorts after the rest and holds no
  record. Places moved compare with the table a day before the latest crawl,
  rebuilt from `clan_crawls` (`clanPlacesAt`: squadrons dropped since keep
  their place; none until the log holds a full crawl before that moment).
  "Playing now" (`recentBattles`): squadron battles from replays that ended
  within `LIVE_WINDOW_SEC` (45 min), for every squadron; a team counts when its
  tagged players share one core tag; no marks while `wt-replays` has had no
  successful run for `LIVE_MAX_REPLAY_AGE_SEC` (10 min). The leaderboard's
  battle counts lagged a crawl or two and marked top-100 entrants for old
  battles.
- `clan.about` of `/api/clans/:coreTag` (`readClanAbout`,
  `src/web/clan-about.ts`): links and join requirements read on request
  from the squadron's untrusted slogan, description and announcement. The
  parser builds every address itself (http/https only; a bare host needs
  "www." or a path in a known zone) and returns `spans` (UTF-16 offsets per
  text) for the SPA's clickable text; links open with
  `rel="noopener noreferrer nofollow ugc"`. Requirements put precision
  first: a figure counts beside its keyword and with a "+", "from", "min" or
  in a requirements sentence; Discord counts only as a condition. A new
  wording goes into `clan-about.test.ts` as written.
- `CLAN_SEASON_SCHEDULES` — UTC `[startsAt, endsAt)`; changing a built-in
  schedule takes reconciliation or a data migration, never a manual database
  edit. New seasons come from `wt-clan-season` (`src/clan-season-forum.ts`),
  not code. The forum post is untrusted: any oddity fails the whole parse; a
  forum season with a shifted start replaces the old one, overlapping a
  built-in one is an error.
- Dashboard `/statistics` (`DASHBOARD_PATH`) — HTML in
  `src/web/routes/pages.ts`: user data goes through `textContent`, never
  `innerHTML`. SPA at the root — only when `frontend/dist` exists: named routes
  (`/api/*`, `/health`, the dashboard) win over its static wildcard, other GET
  paths get `index.html` except `/assets/*` (a missing hashed asset stays a
  404). `/app/*`, the SPA's address until 2026-10-04, redirects 301 to the
  same path at the root (`legacySpaTarget` collapses leading slashes: no open
  redirect).
- A new route goes to `src/web/routes/`, dependencies through an explicit
  `WebDeps`, no hidden singletons; APIs have a schema, bounded limits and a
  rate limit.
- Web listens on loopback by default; outside only through a reverse proxy and
  `WEB_TOKEN`, which then guards every path except `/health`. A POST with a
  foreign `Origin`/`Sec-Fetch-Site` gets 403 in every mode; without these
  headers (not a browser) it passes. With a token, the `onSend` hook turns
  `public` into `private` on protected responses, so a shared proxy cache
  never serves them without the token.
- Player search (`GET /api/players`, the home page): nick prefixes and an
  exact WT user id from SQL, live, plus typo-tolerant matches
  (`src/nick-search.ts`). Both sides are folded: accents, separators and
  `@psn` dropped, Cyrillic and Greek look-alikes made Latin (the most active
  nick of 2026-10-08, `Zоroaster`, holds a Cyrillic о). A nick matches whole,
  by its start or inside it with edits by query length (`maxEdits`,
  `maxInfixEdits`; OSA: an adjacent swap is one edit; a query of digits gets
  none); a query typed in the other layout (ЙЦУКЕН, QWERTY) matches whole or
  by the start. Worker task `search-player-nicks` keeps an index of every
  replay, identity and alias key for `NICK_INDEX_TTL_MS` (20,031 keys on
  2026-10-08: built in ~120 ms, a query 2–5 ms); a failed task leaves the
  prefix matches. Rank: an exact id, the match (`compareNickScores`),
  identity before alias before replay, battles. `/scout`'s player
  autocomplete ranks the squadron's recent nicks the same way (`rankNicks`).
- Player page (`/players/…`): `/api/players/:key` — profile, clan with
  the roster role, sources with `account` (level, dates, clan and nickname
  history, WT leaderboard places); `/api/players/:key/insights?days=` — a
  breakdown of local replays (maps, vehicles, clans, teammates, weapons,
  opponents, hours) over the period's last 500 battles: worker task
  `read-player-insights` with its own read-only connection, 1 min cache, rate
  limit weight 2.
- Guides (`/guides`, `frontend/src/pages/GuidesPage.tsx`, `pages/guides/`)
  hold three kinds of facts. The PSR rule is `frontend/src/lib/psr.ts`: tables
  and the calculator compute from it for an enemy team at or below 1500 (the
  default), the prose quotes its results, so a new constant means rewriting
  those sentences in every locale; the battle image uses the bot's copy
  `src/psr.ts`, and `src/psr.test.ts` keeps both equal. Measurements are
  dated in `pages/guides/measurements.ts` (`MEASURED_AT`), reach the texts as
  arguments and are refreshed together. Live data comes from `/api/clans` and
  the season panel; a failed request leaves the static text, never stale
  numbers. `updates.site` quotes the `wt-clans` cadence (20 min / 12 h,
  rosters once a day): change both together. Texts are
  `frontend/src/i18n/guide/<locale>.ts`, each implementing `GuideText` (a
  missing translation is a type error); `**bold**` and `[label](/path#id)`
  become React nodes in `Rich`, never HTML.
- `POST /api/player-stats` (the player page on opening, the dashboard form) accepts
  only an exact known nickname or a stable WT user id. Every enabled external
  source has a single-slot lazy queue, 24 h TTL (younger snapshots are not
  refetched), stale fallback, schema validation and its own rate limit.
  Replay and account coverage are never summed; the primary snapshot is
  `account`, all of them `accountSources`. Precedence: Gaijin's companion API,
  the warthunder.com profile, StatShark; the primary is the first source with a
  fresh snapshot (last check `ok` within the TTL), else the first with any
  snapshot, and the site lists sources in the same order, fresh first. The
  player page takes level and title from companion, the registration date from
  the site profile, and only what neither publishes from StatShark: the last
  login, squadron and nickname history, WT leaderboard places.
- `POST /api/player-id` (asked once by a profile without an id, which then
  opens `/players/<id>`): `WtUserIdResolver` (`src/player-stats/id-lookup.ts`)
  answers from local data (one id; the nick's nick-only identity adopts it),
  else asks the public companion nick search (no cookie; a prefix list of 100
  may omit the nick), then the Replay API by name (random battles, the shared
  queue, one call per 10 s). Exactly one account with the case-folded nick is
  stored as identity + aliases (`exact_nick`, `medium`: a stale roster nick may
  now be another account), so the roster links it from then on; several or
  none link nothing (cached 12 h, failures 5 min). Only locally known nicks
  reach a source; one lookup at a time, one per nick, ≤ 32 queued (`busy`);
  the request waits 15 s, then answers `pending`.

Provider invariants:

- Official profile: overall/air/ground/naval blocks for three modes; the
  `Air/Ground/Naval battles` branches are respawns, not battles; `battles`
  exists only in the overall row; the account win rate uses the sum of three
  modes.
- `N/A` → `NULL`; losses = `battles − victories`; in durations a Latin `M` is
  a month and `m` a minute; month = 30 days, year = 365 (the source's
  precision).
- The official profile's `raw_json` holds extracted strings, not HTML, and
  creates no `player_external_vehicles`. "Vehicles and rewards" (vehicles,
  elite vehicles, medals per nation) → `player_external_countries`; a missing
  block or unknown markup gives an empty list, not a snapshot error.
- Companion uses its own official session and does not touch the site's
  Cloudflare. Its profile method answers only a logged-in session
  (`!ERROR:AUTH_RESPONSE_STATUS_IS_LOGINERROR` without one, 2026-10-07). A
  warthunder.com login is not one: its `identity_sid` is a `.warthunder.com`
  cookie, reaches the companion host and still gets HTTP 400, as does a fresh
  login's full set (`identity_sid`/`_token`/`_id`, `_identity`, `_csrf`) — the
  session comes from the WT Assistant app's own login, which is undocumented. Per
  mode and vehicle it gives battles, victories, deaths, respawns and air,
  ground and naval kills, plus level and title — not SL/RP.
- StatShark only by a numeric user id through the shared browser; the
  Turnstile token stays in the browser's `localStorage` (never in Node,
  SQLite, env or logs), the analytics endpoint is blocked.

`npm run analyze -- <limit>` is a manual paid operation; parsers and ingest
never call a model automatically. `analyses.item_id` is unique: at most one
analysis per item.

## 9. Code and text

- ESM (`"type": "module"`): TypeScript imports end in `.js`.
- Never weaken the strict `tsconfig`; `any` only when provably necessary.
- **English everywhere**: code, comments, logs, error messages, Discord, site,
  API and image texts, tests, docs, commits and PRs (no assistant attribution:
  `Co-Authored-By`, "Generated with"). User-facing English uses the official
  War Thunder terms of `frontend/src/i18n/en.ts` (squadron, PSR, AB/RB/SB).
  Cyrillic only as data: patterns matching Russian external content (the
  forum.warthunder.ru season post), test fixtures exercising UTF-8, varint
  lengths, nicknames or chat, the Russian UI dictionary
  `frontend/src/i18n/ru.ts` (values) and guide text
  `frontend/src/i18n/guide/ru.ts`, and old stored Russian text the code must
  still recognize. Code text is still mostly Russian (ROADMAP, "English
  everywhere"): when you change a function, translate its comments and strings
  in the same change and check whether the code is still needed — review
  happens on touch, not as a whole-repo sweep.
- Comments and docs carry the most information in the fewest words: the why,
  contract, limit, units, measurement date; never retell the code. Reference a
  constant or function instead of copying its value; fix or delete stale text
  in the same change.
- A new background task has an overlap guard and handles rejections of `void`
  promises and timer callbacks.

## 10. Commands and checks

Offline gates (full list — `package.json`):

```bash
npm run build                 # dist/ from tsconfig.build.json, no tests
npm run verify                # typecheck, npm test, offline verify:*, corpus
npm run verify:workers:dist
npm run build:web
```

`verify` = `typecheck` (all of `src/` with tests) + `npm test` (`*.test.ts`,
`*.spec.ts`) + `verify:workers`, `verify:site-db`, `verify:site-api`,
`verify:player-stats*`, `verify:player-board*`, `verify:benchmark-corpus`;
each can run alone for the affected subsystem. Baseline on **2026-10-08**: all
gates pass, **425 pass, 0 fail**, corpus — 6 scenarios (including 2.59). If
the test count changes, state the new one; any new failure is a regression.

CI (`.github/workflows/ci.yml`): the same steps on Linux (Node 26, as the
image) and Windows (Node 24), `npm audit`, a Docker image build. When changing
`FROM node:` in the `Dockerfile`, bump the Linux job's Node too. Never add
`--test-force-exit` to `npm test`: on Windows with Node 24 it crashes tests
that use fetch (libuv assert), and no test hangs. Dependabot runs weekly.

Only with explicit permission (external or local effects):

- `npm run dev`, `npm start`, `npm run dev:bot`, `npm run start:bot`;
- `npm run deploy:commands` — changes Discord slash commands;
- `npm run backfill -- <days>` — network and database writes;
- `npm run analyze -- <limit>` — paid API calls;
- `npm run battle -- <id>` — may download a replay and build media;
- `verify:player-stats-live`, `verify:statshark-live`, `verify:wt-transport`,
  `benchmark:performance-soak` — external services (soak clears
  `WT_BATTLES_CHANNEL` but still uses the network and the database).

An allowed live run: wait for Discord ready and web listen; check `/health`,
`/api/stats` (status of every source), `/api/items?limit=3`, `/api/voice`,
parser and ingest logs, and that unchanged items are not rewritten. Watch the
per-battle lines `[ingest] бой …: убийств N, победитель …` (battle: kills N,
winner): a run of `убийств 0, победитель ?` means a game patch broke parsing
(section 7). With `WT_BATTLES_CHANNEL` set, the announcement queue goes to the
real channel — estimate it first. Check the bot running in Docker through logs
and the API (skill `verify`). Windows: after a watch run check child node
processes and port 3000 — `process.kill(pid, 'SIGINT')` exits without
handlers; graceful shutdown is tested with Ctrl+C or `docker compose stop`.
`ExperimentalWarning: SQLite` is expected on Node ≤ 24; Node 26 does not print
it.

## 11. Licenses

AGPL-3.0-or-later (`LICENSE`, `package.json`). Part of `src/wrpl/*` is a port
of AGPL-3.0 `wrpl-inspector`; GMSync (`gm-sync.ts`) is based on BSD-3-Clause
`WrplReplayParser` and Dagor Engine; origins are in the SPDX headers. The
BSD-3-Clause texts live in `LICENSES/` and are copied into the Docker image (a
license condition). `/` and the SPA link to the source code (AGPL §13).
Licenses of runtime packages and the SPA font —
`frontend/public/THIRD_PARTY_NOTICES.txt`: extend it for a new frontend
dependency.

## 12. Git and handoff

- Stage only specific files (never `git add -A`/`git add .`). Never commit
  `data/`, `.env`, `dist/`, `node_modules/`, `.idea/`, archives, local backups,
  `*.tsbuildinfo`.
- Before a commit: `git status --porcelain -uall`, `git diff --cached`; the
  staged diff holds no secrets, databases, cookies, dumps or generated files.
- The commit message names everything in it: a new module or a behavior
  change never hides behind "change test timeout".
- Handoff: gates green, `git diff --check` clean, the diff only covers the
  request; name the live checks you deliberately did not run.
