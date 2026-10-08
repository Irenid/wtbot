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
  - OCR of the scoreboard — needs someone to press Tab;
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
