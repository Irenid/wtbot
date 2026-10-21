# AGENTS.md

`wtbot` contracts for agents and developers — what the code does not show at
a glance. Behavior: the code and the SQLite schema; commands and env:
`package.json`, `src/config.ts`, `src/runtime-options.ts`, `.env.example`.

## 1. Working rules

- Use every available resource — the machine's full capacity, all available
  information, every tool and agent — and search everywhere; never hold back
  what the result needs. Save model tokens wherever it costs no quality
  (scripts extract exactly the text a model needs, small batches, a fresh
  session for a big job), and size parallel agent work to finish within the
  usage limit (a whole-repo sweep by eight agents hit it and returned
  nothing, 2026-10-02). Before doing a task by hand, look for a tool that
  makes it easier or cheaper.
- Search with targeted tools (`rg`, `git grep`, LSP) instead of reading the
  whole repository, then read what is relevant in full; no MCP server or
  shell wrapper is required. In Claude Code the `LSP` tool is deferred: load
  it (ToolSearch `select:LSP`) and use `findReferences`/`incomingCalls` to
  find callers before an edit; `rg` misses imports and re-exports.
- Before an edit, find the affected functions and their callers; after it,
  check the impact on neighbouring subsystems. No unrelated refactoring.
- Other people's changes and untracked files are the owner's work: do not
  revert, reformat, delete or include them in your commit.
- Documents: `README.md` — running; this file — contracts; `ROADMAP.md` — the
  only list of open tasks (closed items are deleted); `docs/` — measurements
  and notes (`performance.md`, `database.md`, `replay-data-quality.md`,
  `opponent-scouting.md`, `nick-search.md`, `tactical-maps.md`,
  `squadrons.md`); `LICENSES/` — licenses of ported code; `tools/oodle-wasm/`
  — the source of `src/tactical-map/oodle.wasm`; skills —
  `.claude/skills/verify/` (checks, live bot),
  `.agents/skills/monorepo-debug/` (diagnostics). Do not add new plans or
  audits to the repository root.
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
scheduler, ingest coordination. A bounded `worker_threads` pool takes CPU and
blocking work (task list — `src/workers/protocol.ts`): WRPL parsing,
compression, Resvg, OCR, tactical maps, heavy reads on their own connections,
long SQLite writes, maintenance. Entry point — `src/index.ts`; storage —
synchronous `node:sqlite`, SQL in `src/db/index.ts` (section 4), no ORM.
Modules call this API directly: moving to async storage would touch every
caller, not only `src/db/`.

```text
warthunder.com / CDN -> parser sources -> items -> staged WRPL ingest
  -> battles / players / kills / chat -> Discord + web API + media
```

`src/`: `index.ts` (startup, shutdown), `config.ts` and `runtime-options.ts`
(env, resource plan), `db/` (bootstrap, migrations, SQL, maintenance), `bot/`
(commands, announcer, voice tracker, player board), `web/` (API, dashboard
`/statistics`, SPA `/`), `parsers/` (scheduler, sources, cookies, browser,
backfill), `wrpl/` (replays, ingest, assets, media), `workers/` (pool,
protocol), `player-stats/` (external providers), `scout/` (`/scout`),
`tactical-map/` (tactical maps drawn from the game client), `analysis/`
(manual CLIs, smoke checks, paid AI analysis). Shared helpers at the top level
— reuse them instead of new copies: `atomic-file.ts` (`writeFileAtomic`),
`recoverable-file-lock.ts`, `http-response.ts` (bounded body reads),
`concurrency.ts` (`mapConcurrent`), `battle-lifecycle.ts` (ingest events),
`html-text.ts`, `psr.ts`, `nick-search.ts`, `clan-season*.ts`. `frontend/` —
React/Vite SPA; `data/` — database, cookies, caches, assets.

Startup: Discord token check → process lock → signal and fatal-error handlers
→ SQLite (no page warmup) → player stats → Discord → player board → voice
tracker → Fastify → SQLite warmup in a worker → WT cookie refresh (browser on
demand) → parsers → ingest → database maintenance; a stage that awaits the
network returns once shutdown has begun, so later stages never start.
Shutdown: refuse new work, up to 10 s (`PRODUCER_DRAIN_MS`) to drain
producers, then the browser, Discord, the CPU pool (`closeWorkerPool(10_000)`)
and SQLite last; compose's `stop_grace_period` (45 s) must stay above these
waits, or Docker kills the process mid-shutdown. Do not close the pool before
worker-task producers have stopped.

### Concurrency

- Independent I/O runs in parallel: `Promise.all` when the input is bounded by
  configuration or a small constant; otherwise a worker loop with an explicit
  concurrency cap, byte budget, timeout and cancellation (`mapConcurrent` for
  a plain cap: results in input order, every item runs, the first error is
  thrown at the end).
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
  `.env.example`. A new bot variable goes at once into `src/config.ts` or
  `src/runtime-options.ts` (exceptions: `WT_GAME_DIR`, read by
  `findWarThunderGameDir`; `WTBOT_BACKUP_*`, read by the backup service),
  `.env.example` and, if it is a contract, here; a knob of one CLI is
  documented in that CLI's header. No real values in tracked files.

| Variable | Contract |
|---|---|
| `TOKEN` | read on first use (`config.token`): only the bot process needs it (checked first at startup); other CLIs run without it |
| `DB_PATH`, `WTBOT_ALLOW_NEW_DB=false` | a new database only when explicitly allowed |
| `PORT`, `WEB_HOST=127.0.0.1`, `WEB_TOKEN` | loopback accepts only a loopback `Host` (DNS rebinding); non-loopback (always `0.0.0.0` in Docker) only with `WEB_TOKEN`: Bearer or HTTP Basic password |
| `WEB_TRUST_PROXY` | `false`/`true`, or a list of IP/CIDR and `loopback`/`linklocal`/`uniquelocal`, for `X-Forwarded-For`; Fastify 5.12 has no hop count |
| `WTBOT_API_URL`, `WTBOT_API_TOKEN` | Vite dev proxy only (`frontend/vite.config.ts`): `/api` to the production server with Bearer, POSTs included; the bot does not read them, the token never reaches the bundle |
| `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL` + `WT_CLAN_TAG`, `WT_SCOUT_CHANNEL` | imported once per value into the per-server `/settings` (`src/bot/guild-settings.ts`, table `guild_channels`), which owns them after that; a voice category stands for every voice channel in it, rooms a join-to-create bot opens there later included; a server without voice channels tracks every one the bot can view (a hidden one never: the board would show who sits in a staff room); a battles channel without a squadron gets every squadron's battles (~1,500 a day, 869–2,466 over 2026-09-24…10-11); the squadron filters publishing, not collection |
| `WT_ANNOUNCE_ENABLED=true` | `false` — no battle posts anywhere: a dev run or the soak on a copy of the production database, whose `/settings` name real channels |
| `WT_BOT_LOCALE` | the language of servers without a `/language` choice (`src/i18n`: `en`, `ru`; any other value fails startup); unset — the server's Discord language if a catalog has it, else English (section 8); CLIs draw battle images in it |
| `WT_COMPANION_COOKIE` | separate `companion-app.warthunder.com` session; never mix with `WT_COOKIE` |
| `WT_BROWSER_*` (`ENABLED=true`) | Edge (Windows) or Edge/Chrome/Chromium (Linux) for addresses behind Cloudflare; `NO_SANDBOX=true` only in Docker; `WT_VNC_PASSWORD` opens VNC to its Xvfb display in Docker for a manual login or Cloudflare check |
| `WT_REPLAY_HOSTS` | allowlist of CDN hosts for replay parts (`src/wrpl/replay-url-policy.ts`); structural SSRF protection applies without it |
| `WT_PLAYER_STATS_ENABLED=true`, `WT_COMPANION_PROFILE_ENABLED=true`, `STATSHARK_PLAYER_STATS_ENABLED=false` | one switch per lazy account source: the warthunder.com profile, companion (runs only with `WT_COMPANION_COOKIE`), StatShark (only with a known numeric WT user id; also refreshed for the enemies of a `/scout` screenshot); precedence — section 8 |
| `WT_PLAYER_ID_LOOKUP_ENABLED=true` | with `WT_PLAYER_STATS_ENABLED`: a profile without an id looks its WT user id up (`POST /api/player-id`, section 8); the Replay API step only with `WT_COOKIE` |
| `WT_WORKER_THREADS=auto` | auto: CPUs minus `WT_WORKER_RESERVE_CPUS` (1); free RAM minus `WT_WORKER_MEMORY_RESERVE_MB` (15%, at least 512 MiB) and the replay budget, at `WT_WORKER_ESTIMATED_MB` (320) per worker; cap 8 |
| `WT_WORKER_BACKGROUND_RESERVE`, `WT_WORKER_MAX_OLD_SPACE_MB` | slots reserved for interactive work; old space of one worker |
| `WT_INGEST_CONCURRENCY` | cap 32; above the pool size it overlaps CDN I/O at the cost of RAM held by replays |
| `WT_INGEST_ADAPTIVE_ENABLED=true` | AIMD lowers concurrency on 429/retry/5xx and on replay-budget or SQLite-queue pressure |
| `WT_INGEST_PIPELINE_ENABLED=true` | staged pipeline; `false` — the previous runner (rollback) |
| `WT_REPLAY_PROCESS_BUDGET_MB` | shared limit for replay buffers, 128–8192 MiB; auto reserves it before sizing the pool |
| `WT_REPLAY_EXACT_RESERVATION_ENABLED=false` | reserve by cached size or 1× `Content-Length` instead of the 96 MiB worst case; off until an RSS plateau is proven (`docs/performance.md`) |
| `WT_GAME_DIR`, `WT_GAME_HOST_DIR` | the War Thunder client (found in the Steam libraries of Windows and Linux without it): flags, clan-tag font, tactical maps (section 7); compose mounts `./data/wt-game` (copies of `TACTICAL_MAP_SOURCES` and, when installed, the HQ textures of `TACTICAL_MAP_OPTIONAL_SOURCES`, at the game's paths; recopy after a patch; `ui/` alone: flags and font, maps from the wt-tools snapshots) or `WT_GAME_HOST_DIR` read-only at `/opt/war-thunder` |

- Production runs in Docker on Linux (`Dockerfile`, `docker-compose.yml`,
  `docker/entrypoint.sh`): Chromium under Xvfb, `node` user, `./data` volume,
  `restart: unless-stopped`. Development and tests — Linux or Windows (CI runs
  both). `data/*` paths are relative to the working directory (`/app` in
  Docker). If your checkout is the production compose directory, its `data/`
  is the running bot's: `npm run dev`, `site`, `battle` and backfill write to
  that database (`initDb()` migrates every database it opens), and a second
  bot would use the same Discord token.
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
parameterized. Connection settings, VACUUM, maintenance cadence,
measurements, decisions and migration rollback — `docs/database.md`.

- SQL lives in typed functions of `src/db/index.ts` (a worker passes its own
  connection); batch writes run in a transaction. The inline SELECTs of
  `repair-battle-events` and `read-site-dashboard-stats` in
  `workers/entry.ts` move there when touched.
- Check a new or changed heavy SELECT with `EXPLAIN QUERY PLAN`, also on a
  copy of the production database: since v17 the planner has statistics
  (`ANALYZE`, then `PRAGMA optimize`), and the `:memory:` plan may differ.
- The events blob lives in `battle_events` and is read only by one battle's
  key (`SCAN battle_events` is forbidden); `battles` is compact,
  `WITHOUT ROWID` by `session_id`. Keep values over ~1 KiB (blob, JSON) out of
  hot rows: the columns after them are read through an overflow chain.
- Each `battle_players` index costs ~16 entries (the battle's players) per
  battle: add one only for a query whose plan uses it.
- `getIngestStats().pending` counts exactly what `getPendingBattleItems()`
  selects (no `battle_ingest` row, or `error` with
  `attempts < BATTLE_INGEST_MAX_ATTEMPTS`): change both together
  (`ingest-stats.test.ts`).
- `initDb()` is the idempotent bootstrap of a clean database and migrates any
  database it opens; `runDbMigrations()` versions via `PRAGMA user_version`.
  A change to a table, index or constraint is a new migration version plus the
  matching bootstrap change; never hide migration errors behind a broad
  `catch`. The code refuses a database with `user_version > DB_SCHEMA_VERSION`,
  so after a migration the previous image needs a backup.
- Every connection sets `busy_timeout = 5000`: without it a connection next to
  a writer fails at once with `SQLITE_BUSY`.
- Declared foreign keys hold (since v25): every connection that writes sets
  `foreign_keys = ON`, the main one after migrations, so cascades from
  identities, snapshots and seasons run and a child row without its parent is
  refused. Migrations run without them, as SQLite's table rebuild needs: one
  that rebuilds a parent table keeps its children consistent itself.
- Maintenance (`db/maintenance.ts`) runs only in worker tasks `db-maintenance`
  and `repair-battle-events`, `incremental_vacuum` in `VACUUM_STEP_PAGES` steps
  with a pause, and stops before the CPU pool.
- A background write transaction (worker, maintenance, a one-off script next
  to the bot) takes tens of milliseconds at most: a main-thread write waits for
  the foreign lock synchronously and the event loop stalls.
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
  `record-parse-result`, `update-player-stat-board-publication`. Without a
  file (`getDbWorkerPath()` null, `:memory:`) parse history and the player
  board write synchronously; ingest persists only through the worker.
- A worker write changes `PRAGMA data_version`: main-thread read caches are
  invalidated through it, never on the assumption that only main writes.
- `primeKnownItemExternalIds('wt-replays')` loads known IDs before the parsers
  start; a miss still queries SQLite, because backfill writes from another
  process.
- Player search keys (`canonical_nick_search`, `nick_search`,
  `battle_players.nick_search`) are JS `NFKC` + locale-neutral lowercase
  (`normalizePlayerSearchKey`); new nick matching uses them, never
  `COLLATE NOCASE` (`findKnownPlayerMatches` still matches voice and
  clan-snapshot nicks with it). Typo-tolerant matches scan these keys in a
  worker (section 8, "Player search").
- `items`: transactional writes, `UNIQUE(source, external_id)`, changes
  detected by `content_hash` of title + JSON; new sources and backfill keep it.
- `db:backup`: `VACUUM INTO`, lock, free-space check, rotation, read-only
  `quick_check`; the compose `backup` service runs it daily
  (`db-backup-schedule`, `WTBOT_BACKUP_*`, time in `TZ`). Restore only with the
  service stopped: check the backup, save the current database as
  `.pre-restore`, check a temporary copy, then replace `DB_PATH`.
- Offsite: the compose service `offsite` (profile `offsite`, `offsite/offsite.sh`,
  settings in `.env.offsite`, never committed) snapshots the whole project
  directory nightly with restic to Google Drive through rclone. Host label
  `wtbot` and path `/project` stay the same on any machine, so the snapshot line
  survives a move (README, «Backup and restore»); `offsite/exclude` keeps the
  live database (a copy could catch a write half done; `backups/` holds checked
  copies), caches and the browser profile out.

## 5. Workers

- Only structured-clone values and exact transferable `ArrayBuffer`s go to a
  worker; Discord, Fastify and SQLite handles never do.
- Not on the main thread: synchronous WRPL/BLK/VROMFS/ECS parsing, large JSON
  transforms, compression, base64 images, Resvg (`@resvg/resvg-js` is created
  only in workers), provably long SQLite writes. Summaries never read
  `events_blob` (`reconstructBattleSummary()`); media hands the compressed blob
  to a worker.
- A caller's `timeoutMs` covers queueing and execution (defaults per priority:
  `DEFAULT_TIMEOUT_MS` in `workers/pool.ts`). The pool also caps queued tasks
  and transferable bytes, keeps interactive slots, replaces hung workers and
  recycles a render worker after `MAX_RENDER_JOBS_PER_WORKER` jobs (Resvg's
  native memory).
- An interactive request raises the priority of the shared background task
  instead of starting a duplicate.
- Attempts (`BATTLE_INGEST_MAX_ATTEMPTS`): `EXEC_TIMEOUT`, queue timeout,
  startup or scheduling failure and queue overflow spend no ingest or
  announcement attempt — except 3 parse or render timeouts in a row
  (`ExecTimeoutBudget`), otherwise a deterministically slow task would repeat
  forever. SQLite write timeouts never spend one (disk overload would turn
  into lost battles); a replay-budget timeout defers the item. A failure of a
  parse that already ran, and `TASK_TOO_LARGE`, are normal attempts.
- Discord handlers still `deferReply`/`deferUpdate` right away.

## 6. Parsers and warthunder.com access

Sources (constants live in their files under `src/parsers/sources/`):

- `wt-replays` — every 20 s, up to 50 pages (`PLANNED_REPLAYS_MAX_PAGES`),
  `stopAtKnown`, no `fetchDetails`; stops at the first page holding a known
  battle, a page under 20 items or the cap (backfill: at its date cutoff).
- `wt-players` — every 30 min, `WT_PLAYER_NAMES` one by one, only the first
  Replay API page. Player collection (`collectPlayerItem`: this source and the
  player board) runs through one queue, one collection per nick; a session
  error or 429 ends the batch.
- `wt-clans` — every 20 min the first 5 pages of the squadron leaderboard (top
  100); a full crawl every `FULL_CRAWL_INTERVAL_SEC` (12 h, due from 0.9 of
  it) while the season rating (`dr_era5_hist`) is above zero, up to 100 pages
  (hitting the cap shows in the source status). A tag missing from the
  dictionary has no claninfo name, so no PSR: the battle post's last update
  asks for the full crawl at once (`lookupUnknownClanTags` → `runParserNow`;
  one lookup at a time; a tag not found is retried after 15 min, doubling up
  to 12 h), then fetches claninfo and redraws the post. A crawl writes `clans`
  with one shared `rating_at`; `clan_crawls` (the core tags read, in place
  order, and whether the crawl was full) is kept `CLAN_CRAWL_KEEP_SEC`:
  change points cannot tell an unchanged squadron from one the crawl missed.
  Text fields are stored as plain text (no HTML escapes or game markup); tag
  and name stay as they are (keys of battles and claninfo); `_id` survives tag
  changes; the founding date is the leaderboard's `cdate` (claninfo shows
  1970). Then the claninfo rosters of 5 leaders whose roster is older than a
  day. Stored fields, history and the season check: `docs/squadrons.md`.
- `wt-clan-season` — every 6 h the first post of
  `forum.warthunder.ru/raw/2509/1` (not warthunder.com: no Cloudflare, a plain
  bounded fetch) → seasons `forum-YYYY-MM-DD` in `clan_seasons`.

The scheduler starts sources at once, never overlaps runs of one source and
backs off exponentially up to 30 min; a worker task writes parse history for
a file database. A run that ends after stop or restart saves nothing and
counts no failure (the source collects its items again); `runParserNow()`
waits for the active run and never starts a second. A new source is a
`ParserSource` with a unique `name`, `intervalMs` and
`run(signal): Promise<{ summary, items? }>` that checks `signal` between
requests, registered in `src/parsers/sources/index.ts`; rerunning unchanged
items yields `unchanged`.

Access:

- `wt-replays` and `wt-players` need a signed-in session; HTTP 200 with an
  empty list does not prove it works (source status
  `API returned an empty list`).
- A sign-in lives 14 days (`WT_SESSION_LIFETIME_MS`); use never extends it
  (measurements: `wt-sign-in.ts`). A day after the jar's sign-in (`signedInAt`
  in the jar; unknown counts as due) and on an empty list the bot signs in
  again through Gaijin's SSO (`renewWtSessionThroughGaijin`) the way the
  site's gsea.js does: `api/gsea/fetch` with the page's queryContext
  (`GAIJIN_RELOGIN_URL` if the page has none) returns the Gaijin session's
  refresh token, then `/extLogin?refresh_token=` signs in; both run in an
  isolated browser context holding copies of the browser's login.gaijin.net
  cookies (the reLogin page itself asks for the password). The new sign-in
  goes to the jar, Gaijin's rotated cookies back to the browser. It needs one
  manual sign-in at https://login.gaijin.net in the bot's browser (VNC,
  README); without it GSEA reports no session, the bot sends nothing more
  until those cookies change, and the log names the sign-in's end every 6 h. A failure waits
  30 min; while a login.gaijin.net tab is open in the shared context (a
  person signing in) the visit waits up to `SIGN_IN_PAGE_WAIT_MS`, since it
  rotates the Gaijin cookies under their form. State: `/api/stats` → `wtTransport.session`.
- The bot's Chromium blocks third-party cookies, so the site's own Gaijin
  client (`gsea.js`) never sees the SSO session, and on a signed-in page it
  posts `/<lang>/logout`: the browser never sends that request
  (`isSiteLogout`), and the renewal visit loads no Gaijin script on
  warthunder.com pages.
- Every request to the warthunder.com site and API goes through
  `fetchWtResponse()` or `waitForRequestSlot()`: one queue per process,
  1,500 ms spacing, `Retry-After`. A direct `fetch()` to the site's HTML or
  API is forbidden. Outside the queue: `companion-app.warthunder.com`, a
  separate service (section 8), and clearance probes (hence
  `MAX_FAILED_CLEARANCE_PROBES`).
- Cloudflare challenges single addresses (in October 2026 only the player
  profile and player search: the `wt-request.ts` header), so the transport is
  chosen per route (first three path segments): a direct request first, the
  browser after a 403 `cf-mitigated: challenge`, the direct path re-probed
  every 6 h; modes are in `/api/stats` → `wtTransport.routes`. A network
  failure of a direct request is retried once through the browser without
  changing the route's mode.
- Jar `data/wt-cookies.json`: live cookies in plain text, written atomically
  (0600 in a 0700 directory) under an inter-process lock and keyed by the
  sha256 of `WT_COOKIE` (a new `WT_COOKIE` restarts the session from it); it
  also keeps the User-Agent of the browser that issued the session (direct
  requests present themselves as that browser).
- The jar owns the WT session (`identity_*`); only the Replay API needs it. A
  public direct request goes without cookies and leaves the jar alone; direct
  requests never send Cloudflare cookies. The browser gets the jar session
  only while the Replay API goes through it, and writes it back then;
  otherwise it browses anonymously: the server rotates `identity_sid`, and two
  live copies of one session would diverge. The jar takes `identity_*` only
  from a response to a request that carried its own `identity_token` and
  from browser copies of that sign-in, so a late response to a replaced
  session never undoes a renewal. Never seed host-only cookie copies next to
  the domain ones (`removeDuplicateCookies`: the server read the stale
  `identity_sid`).
- On an empty list (one attempt at a time, at most every 5 min;
  `refreshWtSession`) the order is: the Gaijin renewal; the browser's own
  sign-in (`identity_id` + `identity_token` of another sign-in, e.g. a VNC
  sign-in at warthunder.com; never an anonymous `identity_sid`); a refresh
  through a browser carrying the session; else the Replay API route moves to
  the browser until the 6 h re-probe.
- claninfo (`src/wrpl/clan-info.ts`) uses its own direct `fetch` without
  cookies, but after `waitForRequestSlot()`; a 429 delays the whole queue. If
  it starts answering 403 `cf-mitigated: challenge`, switch it to
  `fetchWtResponse()`. A clan is read at most every 2 min (10 min after a
  failure; only `force` and `freshAfter` skip the wait); 404s from 3
  different clans pause claninfo for 1 h, and renders use stored snapshots.
  `fetchClanMembers()` returns the whole roster or throws: its list replaces
  `clan_roster`, so a parser change keeps the member-anchor count check.
- The browser is a normal process driven over CDP, hidden as an off-screen
  window (a persistent Playwright context and true headless mode fail
  Cloudflare); CAPTCHAs are never solved automatically. CDP binds 127.0.0.1
  with `--remote-allow-origins` pinned to it: the port drives a logged-in
  session. Stale-browser cleanup refuses short and personal Edge/Chrome
  profiles (`profileTooBroadToKill`). Platform code lives in
  `wt-browser-platform.ts`; Linux needs `DISPLAY` or `WAYLAND_DISPLAY`.
  Clearance probes: pause 0.5→4 s, at most `MAX_FAILED_CLEARANCE_PROBES`
  failures per attempt.
- `.wrpl` parts come from the CDN through a plain bounded `fetch`: the browser
  transport decodes bodies as text.
- Every external fetch has a timeout, a response byte limit
  (`readResponseBuffer`/`Text`/`Json` in `src/http-response.ts`) and a schema
  or format check before anything is cached permanently.
- `npm run backfill -- <days>` closes a gap (3 days by default, parsing left to
  ingest) while the parts are still on the CDN (~2 weeks).

## 7. Ingest, WRPL and media

### Ingest

- Pipeline (tick, sweep order, queues, consumers — `docs/performance.md`):
  downloads start ≥ 500 ms apart (`PAUSE_MS`) into a bounded ready queue →
  worker `parse-battle` → `persist-ingested-battle`, serialized on the ingest
  connection: one transaction writes `battles`, `battle_events`,
  `battle_players`, `battle_kills`, `battle_chat`, `battle_ingest`. That
  connection disables autocheckpoint: a PASSIVE checkpoint follows a commit
  once 32 commits or 60 s have accumulated, and worker task
  `checkpoint-ingest-database` runs on shutdown.
- AIMD and the process byte budget bound the load on the CDN, the pool, SQLite
  and RAM (what spends an attempt — section 5).
- After the commit the session's old artifacts in `data/battles/` are dropped,
  then `committed` is emitted, then the cached parts: the announcement and the
  site build media from the new rows, and the battle can be rebuilt from its
  rows and events blob. `battle-lifecycle.ts` listeners are synchronous:
  parsers emit `discovered` (wakes ingest), ingest emits `committed` (the
  announcer).
- Every path that parses a battle passes the Replay API item's user ids
  (`listedUserIdsFromItem`): without them `battleParticipants` keeps phantom
  bot rows.
- Only ingest writes a battle. Media of a battle not stored yet (`/battle`
  buttons, `npm run battle -- --media`) parse its replay with the unlisted
  tail parts and the item's roster, draw it and store nothing
  (`loadBattleRenderSource`); ingest's commit drops those artifacts.
- The events blob (`battle_events`, `events-codec.ts`) is columnar. A write
  verifies a byte-exact round trip, otherwise it stores zstd-JSON; readers
  also accept zstd-JSON and gzip. Read through
  `decodeEventsPayload`/`decodeEventsBlob`; `inflateEventsBlob` (JSON text)
  only for the corpus hash. An image without the columnar format cannot read
  these blobs (sizes and rollback — `docs/database.md`).
- The Replay API lists some battles before they end, with early `partsCount`
  and `endTime`, and the bot reads an item only once. So before downloading,
  ingest probes for parts after the known ones (`withUnlistedReplayParts`: a
  one-byte GET until the first 404; a 429 is retried, any other error fails
  the attempt instead of ending the list, otherwise an old battle with an
  incomplete list would become `expired`). A 404/410 within
  `PART_UPLOAD_GRACE_MS` (1 h) of the earlier of `endTime` and first sighting
  means "not uploaded yet". Intermediate results (part 0001, no status) are
  not stored; the final results of a battle that ran out of time (also
  without a status) last within 10 s of the listed duration
  (`hasFinalReplayResults`). Such a battle waits in memory
  (`ReplayPartWaitList`, 1→3 min) without an attempt; `expired` only after
  that window. Shares, durations and the truncated-battle signature —
  `docs/replay-data-quality.md`.
- results-BLK is not what happened (its quirks —
  `docs/replay-data-quality.md`). `player-events.ts` (ingest and repair)
  derives from the events: `played_vehicles` in spawn order (`vehicle` is its
  first; NULL — no tracks, readers use the lineup), `bot_user_id` (only the
  team's single slotless player and single negative-id slot pair up),
  `team_kills` from the kill feed, the team from the squad marker, `slot_nick`
  (the ECS slot's nick of a row named after the bot; `nick` keeps the bot's
  name, so player statistics leave the row out). Readers hide a paired bot
  row and credit its tracks, kills and damage to the player (`creditBotSlots`,
  scene `botSlots`). The site draws no card for team ≤ 0; the battle image
  (`buildRosters`) puts such a player into the smaller team (equal teams: no
  row), draws the AI's row under `slot_nick`, and a bot's own row only when it
  filled a place the squadron left empty.
- The game sometimes records no squadron tag for a player for a whole login
  session. `fillSquadronTags` (`squadron-tags.ts`) gives such a player the
  team's tag when every real player of the team carries its squadron-battle
  marker (`squad_id` 4096/4097; never a random battle's platoons) and the
  team's tags share one core: ingest after the event facts, the results-only
  render of an unstored battle, migration v21 for stored rows. The chat text
  takes the results tags over the slots'; the events blob keeps the slots as
  recorded.

### Untrusted binary input

`.wrpl`, BLK, VROMFS, DxP2 and ECS packets — replays and game files alike —
are untrusted data without a schema. In the decoders of `src/wrpl/`
(`bit-reader`, `packet-stream`, `lz4`, `ecs`, `gm-sync`, `replay-events`,
`blk`, `vromfs`), `tactical-map/dxp.ts`, `oodle.ts` and new ones:

- check lengths, counts, offsets and ranges before arithmetic and allocation;
  never remove bounds checks of varints, LZ4, ECS, FAT BLK, VROMFS, XOR/RLE or
  packet fields; a TypeScript non-null assertion is not a runtime guard;
- decompression gets output limits (`decompression-limits.ts`), workers an
  execution timeout;
- after a parser change run the corpus (`npm run verify:benchmark-corpus`:
  hash, outcome, data contract).

The format (stream offset, codecs by game version, userIds, chat strings, ECS
and track sources) is described in the headers of `replay.ts`,
`replay-events.ts`, `ecs.ts`, `gm-sync.ts` and `bit-reader.ts`. A non-zero ECS
construct format byte (`ECS_CONSTRUCT_PREFIX_VERSION`) is a new format: the
parse fails loudly, never skips it. The chat is signed with the anonymous
`fakeName`s of the Replay API item — ingest replaces them with real names
(`fakeNamesFromItem`) before storing.

A game patch breaks parsing silently — results-BLK (players, scores) still
reads, the events do not:

- a part that fails to decompress goes to `events.errors`; a battle with no
  decompressible part is a parse error, not an empty battle;
- one failing ECS entity does not abort the packet (the block boundary is
  known): the others, player vehicles included, still parse, and the error
  goes to `events.errors`;
- the symptom in the data: `kill_count = 0` and empty trajectories while
  `battle_players` has kills; compare by `game_version`;
- add a replay of each new game version to `benchmarks/replay-corpus.json`;
- re-parse stored bad battles with a migration that clears their
  `battle_ingest` status (example: v6/v7) while the parts are on the CDN
  (~2 weeks).

### Media and cache

- Media is built from SQLite, from the CDN only when needed; parallel builds of
  one session are merged, and an interactive request raises the priority.
- `buildBattleMediaKind()` + `render-media-kind` build only the requested log,
  chat or heatmap; `buildBattleMedia()` + `render-media` build the full set for
  the `battle` CLI; the 2× heatmap is separate. Ground/air/team heatmaps reuse
  `PreparedHeatmapScene`; SVG builders are pure functions.
- A change to what media, a scene or a map draws bumps its version, otherwise
  cached artifacts keep the old drawing: `BATTLE_MEDIA_VERSION`
  (`battle-media.ts`, checked in `*-meta.json`), `BATTLE_SCENE_VERSION`
  (`battle-scene-core.ts`, in `-scene-v<N>` file names),
  `TACTICAL_MAP_VERSION` (`tactical-map/spec.ts`, in the map cache hash;
  `pruneStaleMaps` deletes older hashes).
- Heatmaps and the site's battle player draw the mission's tactical map as
  the game's respawn screen shows it, built from the game client
  (`src/tactical-map/`; drawing, mission objects, air maps and cache —
  `docs/tactical-maps.md`), plus one addition: the dashed outlines of the
  spawn detection zones, which the game shows only near a player. Both
  perspectives are built, and the renderer
  picks by the team's first ground positions (the scene's `map.team` →
  `map.png?team=`); squadron battles force the airfield spawn
  (`SQUADRON_BATTLE_DESCRIPTOR`); maps are cached per
  `BALANCE_LEVEL_THRESHOLDS` bucket (a `[maps]` warning that a rank's map
  differs means a new threshold); an air map's spec is cached only with its
  texture installed. A mission path must match `MISSION_PATTERN` before it
  reaches the file system; a failed build is retried after `FAILURE_TTL_MS`.
  Without the client: the wt-tools snapshot of the mission's mode (exactly
  battleArea), else the local level map; never substitute another mode's map.
  `/api/battles/:key/map.png` builds a game-client ground map on a miss, a
  snapshot only from disk.
- The winner comes from events and the database, never from results-BLK;
  anonymized names are restored by `userId`, not only by nickname.
- Resvg font order (`src/workers/render-fonts.ts`) is the fallback order: a UI
  font without box-drawing glyphs (Linux — Noto Sans from `fonts-noto-core`,
  Windows — Segoe UI), the game font, scripts, symbols. Of the asset fonts a
  render gets only `symbols_skyquake.ttf` (`clanFontFiles`): `map-icons.ttf`
  (family `indicators`) maps digits and letters to icons and must never join
  glyph selection.

Data:

- `data/wtbot.db` — the source of truth and the dataset;
- `data/replays/<sid>/` — TTL cache of replay parts;
- `data/battles/` — LRU of rendered artifacts up to `WT_BATTLE_CACHE_MB`, one
  file per language (`<hex>-<kind>.<locale>.png`): `*-meta.json` (each
  language's artifact list) is published last as the commit marker, eviction
  removes the whole session set; `WT_BATTLE_CACHE_ENABLED=false` disables
  reuse, not saving;
- `benchmarks/fixtures/replays/` — the only permanent WRPL corpus;
- `data/missions/`, `maps/`, `unit-icons/`, `fonts/`, `weapons.json`,
  `ecshashes.json`, `wt-vehicles.json` — assets and rebuildable indexes;
  `data/maps/game/` — tactical maps from the game client (rebuilt after a game
  patch);
- `data/wt-game/` — copies of the game files for Docker (section 3,
  `WT_GAME_DIR`). The game's flags load from its atlas once per process
  (`game-flags.ts`); without them the battle image keeps its built-in flags
  and `/scout` reads pictures without flags.

## 8. Discord, site and player statistics

- The bot is public-ready: what it does on a server is that server's
  `/settings` (`src/bot/commands/settings.ts`): battle-post
  channels (every squadron or one, several rows per channel post a battle
  once), scoreboard-screenshot channels, the board's voice channels or categories; at most
  `MAX_GUILD_CHANNELS` of each. A channel is accepted only with the bot's
  permissions there (`NEEDS`); a deleted channel or a server that removed the
  bot drops its rows (`ChannelDelete`, `GuildDelete`). The bot always asks for
  `GuildMessages`, and `MessageContent` only when the application has it
  (asking without it fails the login, 4014); messages are not cached.
- `/settings stats set squadron:` (`src/bot/squadron-stats.ts`, state in `bot_state`
  `squadron-stats:<guildId>`): two locked voice channels at the top of the list
  carry a squadron's leaderboard place and rating in their names; a 60 s tick
  (only with `WT_ANNOUNCE_ENABLED`: it renames channels on real servers) renames
  one only when its text differs (Discord: 2 renames per 10 min), so a crawl
  (20 min) shows within a minute. Needs Manage Channels; deleting one channel
  removes both.
- Access (`src/bot/access.ts`): Discord's per-command permissions are the
  only gate on commands — the registered defaults (Manage Server for
  `/settings`, `/language`, `/playerboard`; everyone for the rest) plus a
  server's Server Settings → Integrations changes (a command-level allow
  passes a member without the default permission, an app-level one does
  not). No role check in code: it would refuse the roles a server opened a
  command to; a manager acts only on channels they can view. The bot reads
  these permissions (`/settings show`), never writes them (a user's Bearer
  token only); renaming a command drops every server's permissions for it.
  The rest follows channel access: buttons answer whoever sees the post,
  screenshots are read from whoever can post in the channel, and the player
  board shows a voice channel only if every role that sees the board sees it
  too (per role: a second role's deny and member overwrites aside), whatever
  the bot itself sees. `/stats` shows the parsers to the application's owner
  only.
- Slash command: a file in `src/bot/commands/` (`definition(t)` in one
  language; autocomplete: `Command.autocomplete`), listed in
  `src/bot/commands/index.ts`. The bot registers the commands itself
  (`command-sync.ts`): guild commands on every server it is in, descriptions in
  the server's language plus every catalog's as Discord localizations; a
  server is rewritten when it is joined or its body's hash (`bot_state`
  `commands:<guildId>`) changes, so every start of changed code — a deploy, or
  a dev run with the production token — registers its commands; global
  commands are removed at start.
- Bot text — replies, posts, embeds, buttons, command descriptions, image
  labels — lives only in the `BotText` catalogs of `src/i18n/` (`en`
  canonical): code reads `botText(locale)`, a worker gets `locale` in its
  input, a pure renderer defaults to English. The language
  (`src/bot/locale.ts`): what the channel sees (posts, public replies, the
  player board, screenshot replies) is in the server's — its `/language`
  choice (`bot_state` `guild-locale:<guildId>`), else `WT_BOT_LOCALE`, else
  the server's Discord language, else English; what one user sees (ephemeral
  replies, autocomplete) is in that user's Discord language if a catalog has
  it, else the server's. A post's redraws keep its language; after
  `/language` only the player board is redrawn. A new text goes into
  `types.ts` and every catalog (a missing one is a type error); a new language
  is one catalog file plus its `CATALOGS` entry; `i18n.test.ts` holds the
  length limits. Internal errors never reach Discord (the catalog's generic
  reply; details go to the log); parser summaries in `/stats` are English
  operator text for the owner, not translated.
- `/battle` and the announcer share `renderBattlePost()`; `battle:*` buttons
  are routed in `src/bot/index.ts`; chat, log and heatmaps are ephemeral. A
  post's updates run in order — ratings, winner, unknown-tag lookup
  (`queueBattlePostUpdates`), then the PSR recheck — in bounded queues
  (`MAX_WINNER_UPDATES`, `MAX_WINNER_UPDATE_BYTES`, `MAX_POST_RECHECKS`,
  `MAX_POST_RECHECK_BYTES`); a `/battle` reply is edited for at most
  `INTERACTION_EDIT_MS` (14 min: the interaction token expires at 15).
- `/scout squadron [player]` (`src/scout/`; read `docs/opponent-scouting.md`
  before changing the model: method, accuracy, backtests) reads history in
  worker task `read-scout-history`. `model.ts` holds logistic weights and
  calibrations that `npm run scout:backtest -- <copy.db> --fit-all` fits
  (`--fit`: train before `--split`, test after; `--known-team` for a
  screenshot's roster: all cores but two, ~7 GB); refit after a rules or
  format change and update the accuracy in the doc.
- `/scout` by picture: a Tab screenshot in a `/settings scout` channel; OCR, nick
  matching and flag drawing run only in worker tasks (`read-scoreboard-image`,
  `read-scout-players`, `render-flag-templates`), Tesseract with the models of
  `OCR_PASSES` that the `Dockerfile` installs; team colours are never assumed.
  Intake: one read at a time, ≤ 20 queued, ≤ 4 images a message,
  ≤ `MAX_IMAGE_BYTES` (25 MiB) each, bots ignored. `data/scout-images/<day>/`
  keeps every image, its reading and the prediction (`scoutPredictionRecord`;
  Discord IDs inside: never publish); with `truth.json` the days are the test
  set (`npm run scout:images`), and `npm run scout:outcomes -- <copy.db>`
  scores the replies against their stored battles. A lone unread enemy row
  shaped like the game's anonymiser name is guessed as the enemy squadron's
  only player who recently hid their nick (`src/scout/anonymous.ts`,
  `battle_players.fake_name`); the reply says "probably".
- The image's PSR column (`src/wrpl/battle-psr.ts`; method and accuracy in its
  header): the battle's points by the guides' formula (`src/psr.ts`) above,
  PSR after the battle below (before it while the winner is unknown).
  `PSR_RECHECK_AFTER_SEC` (16 min) after the battle the post rereads the pages
  (`freshAfter`) and `PSR_RECHECK_STORE_WAIT_SEC` (3 min) later redraws when a
  number changes; the recheck queue is in memory: a restart drops the waiting
  ones. `battlePsr()` reads SQLite on the main thread inside
  `renderBattlePost()` (3.7 ms a battle on average, 14 ms at most): a new read
  there stays indexed or moves to a worker. A falling `psrFormulaCheck()`
  (`/api/stats` → `psrFormula`; a log warning under 90% once 300 of the last
  1,000 checks exist) means Gaijin changed the rule.
- Under each squadron's players the post's text has a subtext line
  (`squadronStanding()`, `commands/battle.ts`): the leaderboard's own place
  (`clans.position` by the replay's decorated tag; only a row read since the
  last full crawl and within `PLACE_MAX_SHIFT_SEC`, 12 h, of the battle) and
  the wins and losses of the battle's UTC day up to it (`getSquadronResults`;
  both squadron-battle windows lie in one UTC day). It is rebuilt with every
  payload, so the record counts the battle once its winner is stored. Two more
  main-thread reads, 1–2 ms a team: the day's battles drive the join
  (`CROSS JOIN`); from the tag's index a busy squadron reads its whole history.
- Announcer: attempts in `announce_state`, the baseline in `bot_state`; the
  first start does not publish history, and while no server has a battles
  channel the baseline follows the newest battle; battles older than
  `WT_ANNOUNCE_MAX_AGE_HOURS` are skipped by one `skipStaleAnnounce()`. A
  battle is posted once per matching channel, in battle start order, after a
  commit that stored its winner, rendered once per server language; a
  terminal ingest without a winner resolves it unposted
  (`battleAnnouncementDecision`). A channel the bot cannot post to is skipped
  without an attempt (permissions are checked first: Discord bans an IP after
  10,000 invalid requests in 10 min); a retry posts only to the channels not
  reached yet (in memory). Preliminary messages are gone (none was left).
- `/playerboard setup` stores the channel and one editable message in SQLite;
  the board shows the current voice snapshot and writes its publication state
  through a worker task only when the hash changes. The WT nickname is the
  display name up to the first `(`.
- The site's squadron ranking (`buildClanSnapshot`, `src/web/clan-snapshot.ts`)
  is rebuilt at most once a minute, after the request that found it stale, in
  worker task `build-clan-snapshot` (main thread for `:memory:`, or when the
  task fails and the snapshot is missing or older than
  `CLAN_STALE_MAIN_BUILD_MS`).
- Squadrons on the site — `docs/squadrons.md` (ranking tiers `RANK_TIER_*`,
  renamed squadrons, the 24 h window, `ranking`, rosters, the `/api/clans`
  views of `src/web/clan-ranking.ts`). Official figures come from the
  leaderboard; a PSR sum from snapshots rates only a clan without official
  data. A GET creates no player identity: roster links use
  `resolveKnownPlayer`'s matching without its writes. The SPA copies
  `MIN_RATE_BATTLES`, `REWARD_TIERS` (`CLAN_REWARD_TIER_PLACES`) and the
  `tags` cap (`MAX_FAVORITE_CLANS`, 50) from the server: change both sides
  together.
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
- `CLAN_SEASON_SCHEDULES` — UTC `[startsAt, endsAt)`; a stage's max BR plays
  from `STAGE_SWITCH_DELAY_SEC` after its start (14:00 UTC of its first day):
  whatever names the cap that plays — the season context, the site's
  countdown, `/stats`, battle posts, maps, `/scout` — goes through `stageAt`,
  while the season's bounds (PSR, leaderboard) stay UTC days. Changing a
  built-in schedule takes reconciliation or a data migration, never a manual
  database edit. New seasons come from `wt-clan-season` (`src/clan-season-forum.ts`),
  not code. The forum post is untrusted: any oddity fails the whole parse; a
  forum season with a shifted start replaces the old one, overlapping a
  built-in one is an error.
- Dashboard `/statistics` (`DASHBOARD_PATH`) — HTML in
  `src/web/routes/pages.ts`: user data goes through `textContent`, never
  `innerHTML`. SPA at the root (`src/web/routes/spa.ts`) — only when
  `frontend/dist` exists: named routes (`/api/*`, `/health`, the dashboard)
  win over its static wildcard; other GET and HEAD paths get `index.html`,
  except `/api/*` and `/assets/*`, which get the JSON 404 (a missing hashed
  asset after a deploy is never HTML). `/app/*`, the SPA's address until
  2026-10-04, redirects 301 to the same path at the root (`legacySpaTarget`
  collapses leading slashes: no open redirect).
- Responses over 1 KiB leave compressed (brotli 4 or gzip 6) with a weak ETag
  (`src/web/index.ts`); a route that compresses its own body sets
  `Content-Encoding` (the battle scene). Request bodies are never inflated.
- A new route goes to `src/web/routes/`, dependencies through an explicit
  `WebDeps`, no hidden singletons; APIs have a schema, bounded limits and a
  rate limit (site routes: `passRateLimit`, 60 weight units per IP and 240 in
  all per minute).
- Web listens on loopback by default; outside only through a reverse proxy and
  `WEB_TOKEN`, which then guards every path except `/health` (judged by the
  matched route, else the normalized path: `isProtectedRequest`). A POST with
  a foreign `Origin`/`Sec-Fetch-Site` gets 403 in every mode; without these
  headers (not a browser) it passes. With a token, the `onSend` hook turns
  `public` into `private` on protected responses, so a shared proxy cache
  never serves them without the token.
- Player search (`GET /api/players`, the home page; views, weights and
  measurements — `docs/nick-search.md`): nick prefixes and an exact WT user id
  from SQL, live, plus typo-tolerant matches (`src/nick-search.ts`) from
  worker task `search-player-nicks`, whose index of every replay, identity
  and alias key lives `NICK_INDEX_TTL_MS`; a failed task leaves the prefix
  matches. Rank: an exact id, the match (`compareNickScores`), identity before
  alias before replay, battles. `/scout`'s player autocomplete (`rankNicks`)
  and screenshot matcher (`lookAlike`) reuse it. After changing a rule rerun
  `npm run bench:nick-search -- <copy.db>`: plain typos must not drop.
- Player page (`/players/…`): `/api/players/:key` (profile, clan with the
  roster role, account sources) and `/api/players/:key/insights?days=` (local
  replays, the period's last 500 battles: worker task `read-player-insights`
  on its own read-only connection, 1 min cache, rate limit weight 2).
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
- `POST /api/player-stats` (the player page on opening, the dashboard form)
  accepts only an exact known nickname or a stable WT user id (route limits
  `STATS_PER_IP_LIMIT`, `STATS_GLOBAL_LIMIT`). Every enabled external source
  has a single-slot lazy queue, 24 h TTL (younger snapshots are not
  refetched), stale fallback, schema validation and its own rate limit. A
  player's failed check is retried after 5 min, doubling up to 6 h
  (`DEFAULT_RETRY_*_SECONDS`); a 429 pauses the whole source, doubling from
  the same base while they repeat (StatShark answered 429 after ~60 profiles
  in a row on 2026-10-09 and kept it for over 15 minutes). Replay and account
  coverage are never summed; the primary snapshot is `account`, all of them
  `accountSources`. Precedence: Gaijin's companion API, the warthunder.com
  profile, StatShark; the primary is the first source with a fresh snapshot
  (last check `ok` within the TTL), else the first with any snapshot, and the
  site lists sources in the same order, fresh first. The player page takes
  each field from the first source that has it: level (companion, site
  profile, StatShark), title (companion, StatShark), registration date (site
  profile, StatShark); the last login, squadron and nickname history and WT
  leaderboard places come from StatShark only.
- `POST /api/player-id` (asked once by a profile without an id, which then
  opens `/players/<id>`; route limits `ID_PER_IP_LIMIT`, `ID_GLOBAL_LIMIT`):
  `WtUserIdResolver` (`src/player-stats/id-lookup.ts`) answers from local
  data (one id; the nick's nick-only identity adopts it), else asks the
  public companion nick search (no cookie; a prefix list of 100 may omit the
  nick), then the Replay API by name (random battles, the shared queue, one
  call per 10 s). Exactly one account with the case-folded nick is stored as
  identity + aliases (`exact_nick`, `medium`: a stale roster nick may now be
  another account), so the roster links it from then on; several or none link
  nothing (cached 12 h, failures 5 min). Only locally known nicks reach a
  source; one lookup at a time, one per nick, ≤ 32 queued (`busy`); the
  request waits 15 s, then answers `pending`.

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
  Cloudflare. Its profile method answers only a session from the WT Assistant
  app's own, undocumented login: without one
  `!ERROR:AUTH_RESPONSE_STATUS_IS_LOGINERROR`, and warthunder.com login
  cookies get HTTP 400 (2026-10-07). A missing or logged-out session is the
  source's `error` (retried), never `private` (would wait the TTL). Per mode:
  battles, victories, deaths, time played and air, ground and naval kills (no
  respawns); per vehicle: flyouts, victories, defeats, deaths and kills; plus
  level and title — not SL/RP.
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
  `frontend/src/i18n/ru.ts` (values), the bot catalog `src/i18n/ru.ts`, guide
  text `frontend/src/i18n/guide/ru.ts`, and old stored Russian text the code
  must still recognize. Russian code text remains (ROADMAP, "English
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
npm run build:web             # the SPA: its own tsc -b and Vite build
npm run test:web              # the SPA's Vitest suite (frontend/src/**/*.test.ts[x])
```

`verify` = `typecheck` (`src/` with tests) + `npm test` (`*.test.ts`,
`*.spec.ts`) + `verify:workers`, `verify:site-db`, `verify:site-api`,
`verify:player-stats`, `verify:player-stats-provider`,
`verify:player-stats-api`, `verify:player-board`,
`verify:player-board-voice`, `verify:benchmark-corpus` (needs
`data/ecshashes.json`; CI downloads it with a pinned sha256); each can run
alone for the affected subsystem. It never type-checks `frontend/`: after a
frontend change run `build:web` and `test:web` (Vitest in Node: logic and
components rendered with `react-dom/server`, no DOM). Baseline on
**2026-10-20**: all gates pass, **583 pass, 0 fail**, corpus — 6 scenarios
(including 2.59), the SPA 34 tests. If the test
count changes, state the new one; any new failure is a regression. After a
game patch or a map-drawing change rerun `npm run maps:build`
(`docs/tactical-maps.md`).

CI (`.github/workflows/ci.yml`): the same steps on Linux (Node 26, as the
image) and Windows (Node 24), `npm audit`, a Docker image build. When changing
`FROM node:` in the `Dockerfile`, bump the Linux job's Node too. Never add
`--test-force-exit` to `npm test`: on Windows with Node 24 it crashes tests
that use fetch (libuv assert), and no test hangs. Dependabot runs weekly.

Only with explicit permission (external or local effects):

- `npm run dev`, `npm start`, `npm run dev:bot`, `npm run start:bot` — the
  bot registers its code's slash commands on every server (section 8);
- `npm run site` — the API over `DB_PATH`, which `initDb()` migrates;
- `npm run dev:web` with `WTBOT_API_URL` — its POSTs act on production;
- `npm run backfill -- <days>` — network and database writes;
- `npm run analyze -- <limit>` — paid API calls;
- `npm run battle -- <id>` — may download a replay, build media and write
  squadron PSR snapshots;
- `npm run capture:map` — reads a running game client (port 8111), writes
  `data/maps/` and `data/fonts/`;
- `verify:player-stats-live`, `verify:statshark-live`, `verify:wt-transport`,
  `benchmark:performance-soak` — external services (soak sets
  `WT_ANNOUNCE_ENABLED=false` but still uses the network and the database).

An allowed live run follows skill `verify` (checks, logs, the bot in Docker);
a run of `[ingest]` lines with `убийств 0, победитель ?` (kills 0, winner ?)
means a game patch broke parsing (section 7). The announcement queue goes to
the real `/settings` channels of the database unless `WT_ANNOUNCE_ENABLED=false`
— estimate it first. Windows:
after a watch run check child node processes and port 3000 —
`process.kill(pid, 'SIGINT')` exits without handlers; graceful shutdown is
tested with Ctrl+C or `docker compose stop`.

## 11. Licenses

AGPL-3.0-or-later (`LICENSE`, `package.json`). Part of `src/wrpl/*` is a port
of AGPL-3.0 `wrpl-inspector`; GMSync (`gm-sync.ts`) is based on BSD-3-Clause
`WrplReplayParser` and Dagor Engine; the slim BLK, DxP2 and DDSx readers follow
Dagor's formats; `src/tactical-map/oodle.wasm` is GPL-3.0-or-later (oozextract,
a port of ooz), rebuilt by `tools/oodle-wasm/build.sh`; origins are in the SPDX
headers and `LICENSES/README.md`. The BSD-3-Clause and GPL-3.0 texts live in
`LICENSES/` and are copied into the Docker image (a license condition). `/` and the SPA link to the source code (AGPL §13).
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
