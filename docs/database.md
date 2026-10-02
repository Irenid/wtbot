# Database: analysis and optimization (October 2026)

Two optimization passes — 2026-10-01 (table layout, indexes, settings;
migration v17) and 2026-10-02 (events blob format, maintenance) — and an audit
of data errors (migration v18). Measured on page-level copies of the
production database (`.backup`) on the home server: NVMe behind LUKS, 31 GiB
RAM, connection set up as the bot's. "Cold" — after `posix_fadvise(DONTNEED)`
on the database file (no pages in the OS cache), "warm" — the median of five
runs.

## Summary

- `events_blob` moved from `battles` to `battle_events`: `battles` is 9 MiB
  instead of 5.5 GiB, `WITHOUT ROWID` by `session_id`; a full pass over the
  battles on a cold cache takes 10 ms instead of 2.4 s.
- Trajectories (99% of the blob) are stored as delta columns: 137 → 20 KiB per
  battle (−85%), compression in a worker 230 → 47 ms, reading 2.7 → 1.1 ms. The
  production database file and every backup are 1,357 MiB instead of 6,146;
  growth is ~57 MiB a day instead of ~147 with zstd-JSON at ~1,800 battles a
  day.
- Unused and duplicate indexes are gone (−76 MiB, less work on every battle
  write); the latest clan PSR snapshots are one pass over a covering index:
  477 → 37 ms cold, 51 → 23 ms warm.
- The planner has statistics (`ANALYZE`), kept fresh by `PRAGMA optimize`.
- Connections: WAL with `synchronous = NORMAL`, `temp_store = MEMORY`,
  `journal_size_limit`, mmap 1 GiB. Space is returned by
  `auto_vacuum = INCREMENTAL` from worker tasks in short transactions: no
  main-thread pauses and no multi-minute VACUUM on restart.
- PostgreSQL is not needed: the bottlenecks were the data layout and format,
  not the engine ("Should we move to PostgreSQL").

## First pass (1 October): layout, indexes, settings

Copy: 6.2 GiB, 41,385 battles, `user_version` 15; connection as the bot had it
then (mmap 256 MiB, cache 64 MiB). One SQLite file in WAL, synchronous
`node:sqlite` on the main thread (Discord, Fastify, scheduler) and separate
connections in `worker_threads` (writing parsed battles, heavy dashboard
reads, warmup).

| Object | Size | Comment |
|---|---:|---|
| `battles` | 5,653 MiB | of which 1,419,322 overflow pages — events blobs |
| `battle_players` | 138 MiB | + 170 MiB of eight indexes (more than the table) |
| `items` | 86 MiB | Replay API item JSON, 41.5k rows of ~1.5 KiB |
| `battle_kills` | 63 MiB | + 19 MiB of index |
| `clan_rating_snapshots` | 9 MiB | + 33 MiB of six indexes |
| the rest | ~25 MiB | players, clans, seasons, chat, state |

### What the analysis found

1. **Events blob inside the battle row.** The average `events_blob` was
   142 KiB (max 1.5 MiB); only the start of the row fits on a leaf page, so
   41k rows took 27.8k leaf pages (~1.5 rows per page) mixed with 1.4M
   overflow pages. A query over many `battles` rows read gigabytes: a full
   pass took 2.4 s on a cold cache. The startup warmup and the
   `idx_battles_metrics` index were workarounds for this.
2. **Columns after the blob.** `ingested_at`, `mission_settings`,
   `air_unit_count`, `chat_count` were added by `ALTER TABLE` and lay *after*
   `events_blob`: reading any of them walked the overflow chain (chat and air
   flags of 200 battles — 93 ms cold). The bootstrap orders columns
   differently, so `:memory:` tests never saw it.
3. **Planner without statistics:** `ANALYZE` had never run (no
   `sqlite_stat1`), indexes were picked heuristically.
4. **Indexes.** By `EXPLAIN QUERY PLAN` of all 195 code queries,
   `idx_bp_nick` (15 MiB) and `idx_bp_nick_nocase` (22 MiB) served none (search
   uses `nick_search`), `idx_bp_clan` (14 MiB) was a prefix of
   `idx_bp_clan_session`, and `idx_snapshots_clan_nick` and
   `idx_snapshots_clan_cover` nearly matched (the second had the rating, but the
   planner took the first). Every extra `battle_players` index is ~16 B-tree
   entries per battle.
5. **"Latest snapshots" of clans.** `clanLatestMembers`, `clanBaselineSumsAll`,
   `clanRatingBaseline` looked up `MAX(id)` per (clan, nick) and joined back by
   `id` — 28.6k table lookups per rebuild of the clan snapshot (once a minute
   while the site is open, on the main thread).
6. **Connection settings.** `synchronous` was unset — FULL in WAL, an fsync on
   every commit; sort B-trees went to a file; mmap 256 MiB was below the
   working set.
7. **Blob compression.** gzip gives ×6; on 150 battles zstd-3 −13%, zstd-9
   −25%, zstd-19 −47% with 0.4 ms decompression versus 0.8 ms for gzip.
8. **Foreign keys do nothing:** `REFERENCES … ON DELETE CASCADE` is declared
   but `PRAGMA foreign_keys` is never enabled. No orphans: the code deletes
   child rows itself, before the parent.
9. **Objects the code does not know:** `clan_poll_log` (47 rows) and snapshots
   of the `thunderinsights` source (4 rows) — dropped in v18.

### What was done (v17)

**Migration** (one transaction, then VACUUM at startup): table
`battle_events (session_id PRIMARY KEY, events_blob)` with the blobs moved in;
`battles` rebuilt without the blob, `WITHOUT ROWID` by `session_id`, with the
previous indexes (`start_time`, `session_hex`, dashboard metrics; an empty
`session_hex` is restored as in the old migration); dropped `idx_bp_clan`,
`idx_bp_nick`, `idx_bp_nick_nocase`, `idx_snapshots_clan_nick`,
`idx_snapshots_clan_cover`, added the covering
`idx_snapshots_clan_latest (clan_tag, nick, id DESC, rating, seen_at)`;
`ANALYZE` with `analysis_limit = 1000`.

**Code:** the `battles` row and the `battle_events` blob in one transaction;
the blob is zstd-19 instead of gzip (the replay corpus references are SHA-256
of the events JSON, independent of the codec); the "latest snapshot" is one
pass over the covering index (with a single `MAX()` SQLite takes the bare
columns from the row holding the maximum); `initDb` — `synchronous = NORMAL`,
mmap 1 GiB, `journal_size_limit` 64 MiB, `analysis_limit`, VACUUM after
migrations when much space is free, then `temp_store = MEMORY`.

### Before and after

| Query | Cold cache, ms | Warm, ms |
|---|---:|---:|
| Full pass over `battles` (GROUP BY mode) | 2,428 → **10.5** | 27.8 → 4.2 |
| Chat and air flags of the latest 200 battles | 93.0 → **1.4** | 0.73 → 0.10 |
| Clan PSR: latest snapshots (28.6k rows) | 476.5 → **37.4** | 50.8 → 22.6 |
| A clan's battles over 30 days | 90.9 → 37.5 | 3.2 → 1.5 |
| Battles per day over 90 days | 28.7 → 16.9 | 5.1 → 5.0 |
| Dashboard counters | 21.8 → 3.0 | 3.0 → 2.5 |
| Battle card (`mission_settings`) | 1.1 → 0.4 | 0.01 → 0.00 |
| Battle players | 1.4 → 0.9 | 0.04 → 0.03 |
| A player's battles, activity, insights (up to 500 battles) | ~120 → ~120 | 1.8–6.8 → 1.2–4.6 |

| Object | Before | After v17 |
|---|---:|---:|
| `battles` | 5,653 MiB | 9.3 MiB |
| `battle_players` indexes | 170 MiB | 103 MiB |
| PSR snapshot indexes | 33 MiB | ~24 MiB |

Player queries stayed ~120 ms on a cold cache: their cost is random reads of
`battle_players` rows (one per battle), not blobs; warm — 1–5 ms. `ANALYZE`
changed the plans of 35 of 192 queries, with no regressions on large tables.
Deploying v17 to production took 135 s of downtime (VACUUM 81 s, file
11,910 → 6,146 MiB).

## Second pass (2 October): after v17

Copy: 6,097 MiB, 41,540 battles, `user_version` 17, blobs still almost all
gzip. Besides sizes (`dbstat`) and the plans of all 198 queries: main-thread
time of every site route via `app.inject` (JS included), the clan snapshot
build, WAL checkpoints, `quick_check`, `foreign_key_check` and a comparison of
the production schema with a clean bootstrap.

### Load is three times the earlier estimate

Since 24 September the bot collects every clan's battles: 1,400–2,470 a day,
~1,840 on average over eight full days (the earlier ~490 was a 30-day average
including the August downtime). Growth at ~1,840 battles a day:

| | Per battle | Per day | Per year |
|---|---:|---:|---:|
| gzip blob (before 2 October) | 137 KiB | 246 MiB | ~88 GiB |
| zstd-JSON blob (v17) | 70 KiB | 126 MiB | ~45 GiB |
| columnar blob (now) | 20 KiB | 37 MiB | ~13 GiB |
| rows and indexes | ~11.6 KiB | ~21 MiB | ~7 GiB |

Among the rows, `battle_players` takes the most (~5.7 KiB per battle with
five indexes), then `items` (~2.1 KiB; 78% of a Replay API item is the player
list) and `battle_kills` (~1.9 KiB).

### Weak spots

1. **Events blobs — 92% of the file (5,599 MiB).** 99% of the events JSON is
   trajectories: `{"t":…,"x":…,"y":…,"z":…}` points as text, with structures
   repeating one point dozens of times; zstd over such text stops at ~70 KiB
   per battle.
2. **VACUUM at startup.** A restart with ≥ 20% of the file and ≥ 256 MiB free
   would keep the bot offline for minutes (the v17 deploy — 135 s), and a
   format conversion frees gigabytes — a restart in the middle would repeat
   that.
3. **Maintenance on the main thread:** returning 12.5k pages blocked the event
   loop for 157 ms, in portions every 10 minutes while a conversion runs.
4. **`PRAGMA optimize` does nothing on a fresh connection:** without flag
   `0x10000` it only looks at tables this connection has queried (checked on
   SQLite 3.53 with debug mode `0x10003`).
5. **A new database was created without `auto_vacuum`** — the same
   multi-minute VACUUM awaited it.
6. **Site clan snapshot** (`buildClanSnapshot`) — 89–103 ms of main thread per
   rebuild once a minute while the site is open: latest PSR snapshots (28.9k
   rows) 29 ms, roster (46.8k) 24 ms, the rest is JS. In a worker the main
   thread would keep ~13 ms of receiving the snapshot (3 MiB).
7. **WAL checkpoint on the main thread.** The main connection has the default
   `wal_autocheckpoint`: a commit crossing 1,000 frames synchronously moves the
   whole WAL — 1,200 frames 9 ms, 3,000 — 23 ms, 8,000 — 56 ms. The pauses are
   rare so far, ~10 ms: ingest checkpoints by itself (every 32 commits or with
   the first commit after 60 s).
8. **The production schema differs from the bootstrap:** columns from
   `ALTER TABLE` sit at the end of six tables' rows (harmless: no large values
   there); the `idx_items_updated` index (no query needs it: `COUNT(*)` takes
   any narrow index) and the `clan_poll_log` table existed only in production
   (dropped in v18).
9. **Fine:** `quick_check` ok; no foreign-key violations or rows without a
   battle in any child table; every `battle_players` index is used by plans,
   unused indexes only on tables with dozens of rows; 4.8 of 6 GiB of the
   database was in the OS cache; the other site routes take a few
   milliseconds of main thread on the first request (`/api/stats` the
   longest — 25 ms) and under 1 ms from the response cache.

### Decisions

| Candidate | Gain (measured) | Cost and risk | Decision |
|---|---|---|---|
| Columnar trajectories + zstd-19 | blob −85% across the database, compression ×5, reading ×2.5 | new format (~200 lines with checks); older images cannot read the blob | **done** |
| Binary format (varint) instead of JSON columns | another −4% | an own binary parser with bounds checks | no |
| Columns per battle instead of per unit | another −1.5% | harder restore | no |
| zstd-22, long window | ~0 | slower | no |
| Thinning trajectories | more | data loss, different images | no |
| Blobs as files or in a separate database | smaller main file | no shared transaction with the battle rows, two things to back up | no |
| Startup VACUUM only for a database without `auto_vacuum` | no multi-minute downtime on restart | — | **done** |
| Maintenance and conversion in workers, 256-page steps | no main-thread pauses (write wait ≤ 7 ms versus 129 ms — 1.3 s) | slower space return (~10 MiB/s) | **done** |
| Clan snapshot in a worker | 95 → ~13 ms of main thread per rebuild | rewrite the site snapshot build, two paths (`:memory:` in tests) | ROADMAP |
| Main without `wal_autocheckpoint` | no checkpoint pauses on main | the WAL grows while workers do not write | no, unless writes grow |
| Covering index per player | cold ~120 ms → a few ms | +35 MiB and a write per battle | no: since the conversion the database fits in the OS cache |
| INTEGER instead of TEXT ids | −50–70 MiB | ids above 2^53, rewrite queries and the API | no |
| Model and weapon dictionary in `battle_kills` | ~−30% of the table | dozens of queries | no |
| 16 KiB pages | −5–10% pages | a full VACUUM (minutes of downtime) | no |
| Foreign keys | integrity only | — | ROADMAP |

### Columnar events format

`events-codec.ts`: the blob is `'WTEV'`, a version byte and a zstd frame
(level 19) of the events JSON document, where a suitable unit's `path` is an
object `{t, x, y, z}` of four arrays: the first value as is, then the
differences between neighbours. A trajectory is suitable if every point has
exactly the keys `t, x, y, z` in this order and integers `|v| < 2^40` (the
differences and their sums are then exact); the rest of the document is
unchanged. Reading rebuilds the points into the same object `JSON.parse` used
to give, without an intermediate trajectory JSON.

The write checks itself: the restored JSON must match the original byte for
byte, otherwise zstd-JSON of the same text is stored — the format loses no
data on any input. The replay corpus checks both the events JSON hash and that
the parsed blob is columnar.

| Sample | Blob, KiB per battle | Compression, ms | Reading, ms |
|---|---:|---:|---:|
| 500 random battles: zstd-JSON → columnar | 70.0 → **20.1** | 230 → 35 | 2.7 → 1.1 |
| whole database, 41,540 battles (gzip and zstd-JSON → columnar) | 137.1 → **20.3** | 47 (max 490) | — |

All 41,540 battles of the database matched byte for byte; 8 stayed zstd-JSON:
seven July 2.57.1 battles with the fractional coordinates of the old parser
and a battle without trajectories (after the v18 repair only that one).
Variants on 120 and 500 battles, KiB per battle: columns without deltas —
42.8, deltas in JSON — 20.0, binary varint deltas — 19.2, columns per battle —
19.8, second-order time deltas — 20.5; zstd levels for columns: 9 — 22.8
(2 ms), 15 — 20.9 (14 ms), 19 — 20.1 (33 ms).

### Converting the production database (2 October)

The schema did not change (`user_version` 17), and new battles were written
columnar at once. A background task converted the old ones (since v18 the
`repair-battle-events` pass does its job): batches of 20 battles every 2 s
(~1 s of worker time per batch, ~2 hours for 41.5k battles); a blob was
replaced only if it had not changed since it was read, and the freed pages
went back to the OS after every batch, so the file shrank during the
conversion. Maintenance now: every 6 hours `PRAGMA optimize(0x10002)` and
`incremental_vacuum` of up to 32 MiB per task (the next portion in 2 minutes
while free space remains), all in worker tasks, in 256-page steps with a
100 ms pause.

In production: the restart took 6 s instead of v17's 135, startup VACUUM did
not run. The bot's task converted ~2,860 battles in 7.5 minutes, the other
38,603 a one-off run on 26 threads (workers encode, one writer commits
transactions of 48 battles with the same "blob unchanged" check, the process
under `nice`): 184 s, blobs 5,138 → 765 MiB, no errors and no changed blobs;
then the space return — file 5,722 → 1,357 MiB, `quick_check` ok. Speed:
~6 battles/s inside the bot, ~210 on all cores.

During the run the bot's watchdog saw event-loop pauses of 0.9–1.5 s three
times: an 8,192-page maintenance portion held the write lock for 1.27 s (it
matched to the millisecond), and a main-thread write waits for a foreign
transaction synchronously; moving one blob page costs 50–150 µs, more under
load. Fixed with 256-page steps and a 100 ms pause (longer than SQLite's busy
wait interval): on a copy with scattered free pages a "main-thread" write
every 5 ms waited at most 6.5 ms (p99 5.4) versus 129 ms with a single
8,192-page transaction.

## Data errors (2 October, migration v18)

An audit of every table on a copy of the production database: each value's
type against the declared one, empty values and ranges, links between tables,
duplicates, normalized columns against the code's functions, and all 41.5k
events blobs against the database rows and the Replay API items (26 threads —
7 s).

| Error | Volume | Cause | Fix |
|---|---:|---|---|
| Chat sender is the replay's anonymous name (`Hachiro3906`), not the nickname from the battle roster | 690 messages | the parser got only `userId → name` pairs, but the chat is signed with `fakeName` | parser: `fakeName → name` pairs from the Replay API item (`fakeNamesFromItem`); stored battles — repair |
| Bot userIds unsigned (`18446744073709551603` instead of `−13`): their kills, trajectories and damage are not linked to the player | 1,689 values in 319 battles | the slot id was read with `readU64` | parser: `BigInt.asIntN(64, …)`; stored ones — repair |
| Long chat messages (> 127 bytes) truncated, a length byte at the start, the "channel" is a letter from the middle of the text | 486 messages in 304 battles | the string length is a varint but was read as one byte | parser: `readVarLenStr`; 116 fresh battles — parsed again from the CDN, 178 messages complete; 308 have the length byte removed and the tail lost (`channel_valid` = 0) |
| Exact duplicate kills (one AA gun twice in one millisecond) | 8 | a repeated event in the replay | parser and repair: an exact duplicate is dropped |
| `air_unit_count` and `chat_count` empty | 20,334 battles (July) | early parser versions | from the events blob |
| Players' `slot` and `title` empty | ~110k rows | early parser versions | from the events blob (where the event knows the value) |
| Fractional trajectory coordinates and times | 7 battles, 381,733 values | the first parser version (15–17 July) | rounding, as in the current parser; the blobs became columnar |
| Fractional `duration_sec` in an INTEGER column | 1 battle | the first parser version | migration: rounding |
| A battle with rows but ingest status `error` | 1 | an old migration's re-parse could not download the parts | migration: `ok`; code: a final failure to re-parse a stored battle keeps `ok` with the reason |
| Downloads of fresh battles failed on timeout/504 | 4 | network, 3 attempts | migration: requeued while the parts are on the CDN; all 4 are now in the database |
| Fresh battles with results but no winner | 7 (+1 that ran out of time) | 5 have no winner in the replay itself | migration: parsed again from the CDN; 2 got a winner, 5 did not (the Replay API item has no outcome field either) |
| Table `clan_poll_log` (47 rows, July) and index `idx_items_updated` | — | leftovers of earlier versions, unknown to the code | migration: dropped |
| ThunderInsights source snapshots | 4 | the source was removed; the snapshots hold only request errors | migration: deleted |

Migration v18 does only what SQL can fix (0.1–0.2 s on the production
database). Fields and events inside the blobs are fixed by the background
`repair-battle-events` pass (`db/maintenance.ts`, `REPAIR_VERSION` 1) with the
ingest rules (`events-repair.ts`): the blob and the kill and chat rows are
replaced together and only if the blob did not change since it was read. A
new rule is the next `REPAIR_VERSION`: the pass repeats over all battles, and
correct data is not rewritten.

- On the copy: 106 s without pauses, 1,216 battles rewritten, 129,736 rows
  filled, the batch write transaction — median 4 ms, max 27 ms. The repeated
  audit: no unsigned ids, foreign chat senders, duplicate kills or empty
  counters; kill and message counts match the rows for every battle.
- In the bot on 2 October (08:24–08:33 UTC, with pauses): 41,550 battles,
  1,100 rewritten — 116 fewer than on the copy, because ingest had already
  parsed those fresh battles again with the new code; 129,735 rows filled, no
  event-loop pauses. All 127 battles requeued by the migration were parsed
  again; the repeated audit of the production database matched the copy.

### Checked and left as is

- Normalized columns (`nick_search`, `nick_base`, `canonical_nick_search`),
  clan tag cores, battle row links, foreign keys — no mismatches.
- 5,617 players without a clan tag — the battle events have none either.
- 49,961 kills without a player victim (scout drones, AA guns) and 13,027
  without a killer — real feed events; 151 kills by AI aircraft outside the
  roster (removed by the rule for phantom bots outside the Replay API roster).
- 888 players without a vehicle list in the battle results (`disconnected`) —
  they left the battle or never appeared: 177 scored points, 547 have no slot,
  55 no team. That is what the replay itself records.
- `coop/Bot…`: 339 rows with a negative id are bots; 607 with a real userId
  are player slots driven by the AI (0 points, the account has a normal
  nickname in other battles, the site's item shows a random name); player
  statistics exclude them.
- Chat messages starting with a tab (PSN players) or with ANSI color codes —
  message content.
- 5 July battles without a winner — no parts on the CDN, no other source of
  the outcome; the battle that ran out of time (September) is recorded
  correctly.
- 148 `expired` and 16 `error` downloads older than two weeks — bookkeeping so
  the battle is not downloaded again; they have no data and never will.

## Rollback

The code refuses a database whose `user_version` is above its own schema. The
safe path for any version is the backup taken before the deploy and the
previous image; battles after the backup are collected again from the site and
the CDN while their parts are there (~2 weeks).

- **v17** changes the schema irreversibly — backup only.
- **Columnar format** (same schema): an image without it reads the database,
  but scenes, heatmaps and logs of converted battles fail with
  «Неизвестный формат events_blob» ("unknown events_blob format").
  Compatibility comes back with a reverse conversion by the new image with the
  bot stopped (the database grows by ~2 GiB), then start the previous image:

  ```bash
  docker compose stop wtbot
  docker compose run --rm --no-deps wtbot node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite'
  import { compressEventsJson, inflateEventsBlob } from './dist/wrpl/events-codec.js'
  const db = new DatabaseSync('data/wtbot.db')
  const ids = db.prepare(\"SELECT session_id FROM battle_events WHERE substr(events_blob, 1, 4) = x'57544556'\").all()
  const read = db.prepare('SELECT events_blob FROM battle_events WHERE session_id = ?')
  const write = db.prepare('UPDATE battle_events SET events_blob = ? WHERE session_id = ?')
  for (const { session_id } of ids) write.run(compressEventsJson(inflateEventsBlob(read.get(session_id).events_blob)), session_id)
  db.close()"
  ```

- **v18** does not change the schema: it fixes data and drops objects the code
  did not know. So image 848e01b (v17) opens a v18 database after
  `PRAGMA user_version = 17` with the bot stopped (untested in production); an
  image without the columnar format also needs the reverse conversion above.

## Should we move to PostgreSQL

**What it would give:** an async driver — queries do not block the event loop
(the main weakness of synchronous `node:sqlite` next to Discord); concurrent
writes (MVCC) from several processes and machines — say, the site on a VPS and
the bot at home sharing one database; TOAST — large values stored separately
and compressed (the blob-in-row problem would not have happened, but the
trajectory JSON would get only generic compression, no columns); automatic
statistics and VACUUM, parallel queries, BRIN/GIN; `pg_dump`, WAL archiving,
point-in-time recovery and replication (would close "database copies on
another disk" in the ROADMAP).

**What it would cost:** rewriting the data layer — `src/db/index.ts` (~6,700
lines of synchronous SQL) and every caller (bot, site, parsers, ingest, worker
tasks) to async, the dialect (`WITHOUT ROWID`, `json_each`, `GLOB`,
`unixepoch()`, `COLLATE NOCASE`, bare columns with `MAX()`) and 18
migrations; ~300 tests on `:memory:` SQLite → a test PostgreSQL (a container in
CI, slower); a data migration with downtime; one more service to run
(container, `shared_buffers` and `work_mem`, backups and their checks, major
upgrades via `pg_upgrade`, monitoring, +200–500 MiB RAM); a socket round trip
(~0.05–0.2 ms) per query instead of an in-process call (microseconds) — the
many small queries get slower.

**The project's load:** one writer process with worker threads, ~1,800 battles
a day, a ~1.3 GiB database growing ~20 GiB a year, one server; a typical site
or bot query takes a few milliseconds.

**Recommendation:** stay on SQLite. The measured bottlenecks were in the
layout, format, indexes and queries — PostgreSQL alone would not have removed
them; the data layer is collected in typed functions of `src/db/index.ts`, so
a move stays possible. Revisit if one of these appears:

- a public site with real concurrent load and heavy queries that cannot be
  precomputed or moved to a worker;
- several processes or machines writing to one database;
- a requirement for replication and point-in-time recovery (SQLite handles
  tens of GiB, but a full daily backup gets heavy as the data grows);
- event-loop stalls that worker tasks cannot remove.

For heavy analytics (vehicle metastatistics, "who kills whom"), DuckDB fits
better than switching the main database: the columnar engine reads the SQLite
file directly and aggregates millions of rows many times faster — as a
separate offline computation. PostgreSQL in Docker is good operations practice
(backups, replication to a VPS, upgrades) as a learning lab, not as a rewrite
of the production bot.

## What else can be done

Open database items — the clan snapshot in a worker, WAL checkpoints off the
main thread, a covering index per player, snapshot retention, foreign keys —
are in [ROADMAP.md](../ROADMAP.md), section "Code", with the conditions for
taking them on.
