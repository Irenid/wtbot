# wtbot performance

Measured on 2026-08-01 on a Windows desktop; a profile under Docker on Linux
(production) has not been taken yet. Open tasks — [ROADMAP.md](../ROADMAP.md),
the database (October 2026) — [database.md](database.md).

Summary: the ingest bottlenecks of that profile were measured and fixed — WRPL
parsing is ~70% faster, exact reservation of replay memory removes the
artificial budget wait, frequent SQLite writes and the known-replay lookup left
the main thread. The end-to-end limit is the CDN and the network. Exact
reservation stays opt-in: a 15-minute live run did not prove an RSS plateau.

## Goals

1. Work through the backlog at the highest sustainable rate without more
   HTTP 429.
2. Never block Discord, Fastify and the voice tracker with synchronous work.
3. Keep retry semantics, WRPL bounds checks, worker limits and SQLite
   durability.
4. An optimization becomes the default only with a live measurement and a
   switch for rollback.

## Production profile

| Parameter | Value | Why |
| --- | ---: | --- |
| `WT_WORKER_THREADS` | `5` | proven bot/site/worker balance |
| `WT_WORKER_BACKGROUND_RESERVE` | `1` | a slot for interactive work |
| `WT_INGEST_CONCURRENCY` | `8` | AIMD upper bound |
| `WT_REPLAY_PROCESS_BUDGET_MB` | `384` | hard limit for replay buffers |
| `WT_INGEST_PIPELINE_ENABLED` | `true` | download → ready → parse |
| `WT_INGEST_ADAPTIVE_ENABLED` | `true` | on after a live A/B |
| `WT_REPLAY_EXACT_RESERVATION_ENABLED` | `false` | until an RSS plateau is proven |
| Parallel replay parts (`DEFAULT_REPLAY_FETCH_CONCURRENCY`) | `2` | CDN and RSS balance |

## Done

### WRPL parsing

- `BitReader` reads values without a temporary `Buffer` per bit or byte.
- GMSync: a reusable RLE buffer, an exact-size XOR patch, packed RLE writes.
- The MPI dispatcher and trajectory thinning create no extra objects.
- Parse profile: header/results, ECS, events, normalize, transform with blob
  compression (the log still says `transform+gzip`, though since October 2026
  the blob is columnar and zstd-19).
- Bounds checks, decompression limits and delta history are kept.

Fixture `large-mixed-air` (11.81 MiB), 1 worker, 10 warm runs:

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Parse p50 | 1246.4 ms | 375.8 ms | −69.9% |
| Parse p95 | 1321.1 ms | 406.7 ms | −69.2% |

Packet decoding is still the largest phase, but live CPU workers are not
saturated: rewriting it now brings nothing end to end.

### Replay memory and priority

- A body with a trusted `Content-Length` (identity) goes straight into the
  final buffer.
- The network reservation is 1× `Content-Length` instead of 2×.
- Compressed bodies and bodies without a length keep the conservative bounded
  fallback.
- An interactive request raises the priority of an already queued shared
  download on the fly.
- The replay byte budget is released after parsing, an error and a cancel.

### SQLite and the main thread

CPU profiles found three blocking operations:

| Operation | Main-thread CPU before | Fix |
| --- | ---: | --- |
| `recordParseResult()` | 9.402 s per 195 s | write in a worker |
| `updatePlayerStatBoardPublication()` | 3.823 s per 195 s | write in a worker |
| repeated `hasItem()` | 1.114 s per 130 s | a cache of known replay IDs at startup |

The cache loads once from a covering index before `wt-replays` starts: a hit
skips SQLite, a miss is confirmed by a point read (parallel backfill stays
correct). p95 of the event-loop window maximum: ~1.8–2.1 s before the fixes →
97 ms after moving the parse-result write (plus one pause at startup). The
final profile after moving the player board write and the ID cache — 2
minutes, 43 commits, one 3018 ms checkpoint in a worker, window maximum
133 ms: a long checkpoint no longer freezes Discord and Fastify through a
coinciding synchronous write or read.

## Live measurements

All runs: 5 workers, reserve 1, ingest up to 8, replay budget 384 MiB, web on
loopback, `WT_BATTLES_CHANNEL` forced empty.

### Exact reservation: A/B

| Mode | Duration | Commits | Battles/min | HTTP 429 | Budget wait, mean | RSS p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AIMD, exact off | 5 min | 64 | 12.8 | 1.34% | 12.8 s | 624.5 MiB |
| AIMD, exact on | 5 min | 72 | 14.4 | 1.78% | 0.1 ms | 631.0 MiB |

Exact on — +12.5% throughput and no artificial budget wait; the RSS p95 rise in
a short A/B is insignificant, but not enough to change the default.

### Exact on, 15 minutes

196 commits, 13.07 battles/min, backlog 1165 → 969; HTTP 429 — 23 of 1733
attempts (1.33%); budget wait ~0, budget peak ~107 MiB; parse mean 461 ms,
SQLite transaction 167 ms; API p95 ~39 ms; RSS p95 ~758 MiB, max ~767 MiB,
warm range ~271 MiB — no plateau; graceful shutdown 2.14 s, port 3000 freed.
Conclusion: exact on admits and runs better, but stays off until RSS is
explained and a long exact-off control run is done.

## Bottlenecks

1. **CDN and network.** On 429 AIMD reliably drops the actual concurrency to
   2; the ready and worker queues are nearly empty, CPU is not saturated.
2. **RSS breakdown.** Process RSS mixes worker isolates, replay buffers, SQLite
   mmap and page cache, native allocations: a slope is not a leak until it is
   broken down by component.
3. **WRPL packet decoding** — the largest offline CPU phase, but not the live
   limit.
4. **Discord delivery latency** — the runs deliberately published nothing, so
   discovery → preliminary → final edit is not measured live.

No longer bottlenecks: the worst-case replay budget wait, `recordParseResult`,
the player board publication write, repeated known-replay lookups, the ready
and worker queues.

## How to close the ROADMAP items

**P0 — RSS plateau.** Break memory down: retained replay bytes, worker RSS and
native memory, SQLite and page cache. A comparable 15-minute exact-off run on a
non-empty backlog. Compare not only the slope but also the warm range,
external/ArrayBuffer, worker peaks and RSS after graceful shutdown. Exact on by
default only with ≥ 10% more throughput, 429 < 2% and a proven plateau or an
explained bounded RSS.

**P1 — Discord latency.** Timestamps discovery → preliminary send → commit →
final edit; a short run only in a dedicated test channel. Gate: preliminary p95
< 5 s, final edit p95 < 5 s, zero duplicates after a restart.

**P2 — parsing, only under CPU pressure.** GMSync and packet decoding — if the
live parse queue p95 exceeds 100 ms or CPU workers stay saturated;
Rust/napi-rs — only with ≥ 15% end-to-end gain or ≥ 2× speedup of the
remaining hot phase.

## Not without new measurements

- more than 5 workers, 3 parallel replay parts;
- exact reservation by default, removing the interactive reserve;
- weaker retries, bounds checks, output limits or timeouts;
- a move to Postgres, a Rust or GPU rewrite without a proven gate.

## Gates

Offline — `npm run verify`, `npm run build`, `npm run verify:workers:dist`
(baseline — AGENTS.md, section 10). A live run only with an empty
`WT_BATTLES_CHANNEL` and web on loopback.

| Metric | Gate |
| --- | ---: |
| Throughput with a backlog | ≥ 10 battles/min |
| HTTP 429 share | < 2% of attempts |
| Ready and worker queue p95 | < 100 ms |
| API p95 after warmup | < 75 ms |
| Event-loop window maximum p95 | < 250 ms |
| Watchdog pauses after warmup | 0 events > 500 ms |
| Graceful shutdown | < 10 s, zero retained budget |
| Exact on by default | only after the RSS gate |

## Rollback

| Problem | Action |
| --- | --- |
| Pipeline regression | `WT_INGEST_PIPELINE_ENABLED=false` |
| AIMD regression | `WT_INGEST_ADAPTIVE_ENABLED=false` |
| RSS growth | `WT_REPLAY_EXACT_RESERVATION_ENABLED=false` |
| Worker pressure | lower `WT_INGEST_CONCURRENCY` |
| CDN pressure | keep the shared limiter, AIMD and `Retry-After` |
| Risk of flooding Discord | clear `WT_BATTLES_CHANNEL` |

## Artifacts of 2026-08-01

Local, outside Git, in `data/benchmarks/`:
`performance-p2-parser-optimized-20260801.json`,
`performance-p2-replay-preallocated-20260801.json`,
`performance-live-audit-{exact-off,exact-on,exact-on-15m,parser-db-worker,final-cpuprof}-20260801.*`,
`performance-live-cpu-profile-final-20260801/*.cpuprofile`.
