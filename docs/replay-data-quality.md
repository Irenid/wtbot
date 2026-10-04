# Replay data quality

What replays can and cannot tell, and how complete the data is. Started as
notes in July 2026 (`src/bot/my.md`), checked against the code and the
production database on 2026-10-02: 41,550 battles since 2026-07-15. Data errors
found and how they were fixed — [database.md](database.md), "Data errors".

## Limits of the replays themselves

- **Trajectories are thinned and rounded.** A point is kept if at least
  500 ms passed since the previous one or the unit moved at least 4 m
  horizontally (`thinPath` in `src/wrpl/replay-events.ts`); time and
  coordinates are integers. Exact accelerations, small maneuvers and
  packet-level behavior cannot be restored: trajectories suit routes, activity
  areas and heatmaps, not physics.
- **Capture zones are only points on the map** (name and coordinates), with no
  capture log: who started capturing, when, which team held the point and when
  it lost it. Heatmaps draw zones from mission data (`mission.zones`), and
  `events.zones` is the fallback; the latest 200 battles (2026-10-02) have no
  zones in their events at all. A capture timeline and an analysis of attacks
  and defense around points are not available from replays.
- **Damage** — only critical and severe damage events (`critical`/`severe`, a
  fire flag) without the damage amount: a pressure indicator, not a metric.
- **Chat** suits linking tactics to time; publishing it follows a separate
  privacy policy.
- **The winner** comes only from the battle events: the Replay API item has no
  outcome field. `team_won = 0` means "winner unknown", not a loss.
- **`battle_players.squad_id`** is a team marker (4096/4097), not a squad:
  squad analytics are impossible.

## What is stored where

- `slot`, `title` and `auto_squad` are `battle_players` columns since
  2026-07-22. For older battles the repair pass of 2026-10-02 filled `slot`
  and `title` from the events blob (where the event knows them); `auto_squad`
  is not in the blob, so ~110k July rows keep `NULL` for good.
- `game_version` is written to `battles` and read when a battle is rebuilt
  from the database (`src/wrpl/battle-data.ts`).
- A chat message's channel is checked on write (`battle_chat.channel_valid`).
  Channels outside 0–3 in older data turned out to be a parser error: the
  message string length is a varint but was read as one byte, so in messages
  longer than 127 bytes the channel came from the middle of the text (fixed on
  2026-10-02). 308 such messages keep a lost tail and `channel_valid = 0`: the
  replays are gone from the CDN.

## Results-BLK against the events

An audit of 2026-10-02 compared every `battle_players` row with its slot's
tracks, kills and damage in the decoded events blob (42,332 battles, 677,634
rows, on a copy). wtbot errors, fixed by `src/wrpl/player-events.ts` (ingest
and repair pass v2, migration v19 — `database.md`):

- **Vehicles.** Results list the lineup (matchingInfo `crafts_info`, ~3.8
  vehicles), not what was driven: 46.2% of spawned players never drove the
  lineup's first vehicle (38.5% a different class), so the Discord
  composition and flags were wrong in 94% of team rows and player vehicle
  statistics counted whole lineups. Now `played_vehicles` holds the unit tracks
  in spawn order and `vehicle` is its first. One battle without tracks
  (16 rows) keeps the lineup; 1,156 rows drove nothing (684 players, 472 bots).
- **Bot slots.** The game hands the slot of a squadron-battle player who did
  not load in to a `coop/Bot…` slot (negative userId) and credits its kills
  and score to the player's row (kills agree in 507 of 510 pairs; the bot
  keeps its deaths). wtbot showed the player as disconnected and credited the
  log, heatmaps and scene to the bot. 511 pairs (`bot_user_id`); a team with
  two slotless players or two bot slots stays unpaired — 4 such players have
  kills and keep the disconnect mark.
- **Team kills.** Results `teamKills` is non-zero in 57 rows (mostly drone
  kills); the kill feed has 8,225 teammate kills, now counted from it (a bot
  slot's go to its player).
- **Team 0.** 58 players who never loaded in got team 0 (the site drew a
  phantom "Team 0" card) while `squad_id` keeps the marker 4096/4097: all got
  their team back, 56 of them played by a bot.

Game-side, not errors:

- score 0 — 2.6% of rows, all explained: idle, a team-kill penalty, never
  spawned, bot;
- results freeze once the battle is decided: kills in the last ~5 s of the
  replay are missing from the results 92% of the time;
- scout-drone kills count as air kills (50,322);
- the game credits more kills than enemy deaths in 1,625 team-battles.

## Completeness

| Metric | July 2026, sample | 2026-10-02, whole database |
|---|---:|---:|
| Battles without a winner (`team_won = 0`) | 56 | 11 |
| Battles without `status` | 53 | 4 |
| Battles without `mission_settings` | 7 | 7 |
| Players marked disconnected | 172 | 888 of 665,115 |
| Players with a clan tag | 99.2% | 99.2% |
| Kills with both positions | 97.3% | 97.5% |
| Kills without `victim_id` | 10.5% | 9.4% |
| Kills without `weapon` | 5.2% | 5.5% |

Of the 11 battles without a winner, the 5 July ones have no parts on the CDN
any more, the 5 fresh ones got no winner from a second parse — the replay
itself has none; one more battle ran out of time without an outcome. Without
`status`: three battles played to the time limit (~25 minutes) and one
seven-minute July battle. Without `mission_settings`: battles of the first
parser version (15–17 July). Disconnected players have no vehicle list in the
battle results: they left or never appeared (547 have no slot either); those
who scored points were played by a bot slot (176 of 181 on 2026-10-02,
previous section). A kill without `victim_id` has a non-player victim (scout
drones, AA guns).

## What is reliable

Team and clan win rates; players' kills/assists/deaths/score (a bot-played
slot's are the bot's); driven vehicles (`played_vehicles`) and vehicle
efficiency; team kills from the kill feed; player participation and
disconnect rate; the kill graph by userId and time; kill positions and distances between
participants; ground and air heatmaps filtered by `userId != ''`; matching
battle statistics with clan rating snapshots; parser and ingest quality
control by how complete IDs, positions and errors are. With caveats — damage,
trajectories and chat (limits above).

## Collection check of 2026-10-01

- **Incomplete replays.** The Replay API lists ~2% of battles before they end:
  such an item's `partsCount` and `endTime` are early. Parsing without the last
  parts takes the intermediate results from part 0001: ~95 s,
  `battles.status` NULL, no winner. Example: the item lists 12 parts, the CDN
  has 16; 12 parts give 95 s without a winner, 16 — 711 s and a winner. Since
  2026-10-01 ingest probes the CDN for missing parts and does not store a
  battle without final results; migrations v12–v14 requeued such battles. A
  battle that runs out of time also writes final results without a status
  (example: 25 minutes, timePlayed 1513 s versus 1509 s in the item); the
  duration tells them from intermediate ones. The July "53 battles without
  status" in the table above probably have the same origin; it cannot be
  checked, the parts are gone from the CDN.
- **Gap 2026-08-02 … 2026-09-23.** No battles for these days: the bot was not
  running, and parts live on the CDN for ~2 weeks. The first three weeks of
  season 62 (from 2026-09-01) are missing from the dataset. So a clan that
  played only then (season leader AVR, 2,545 battles, official statistics
  unchanged since 2026-09-29) has no battles on the site.
- **The official clan rating history** starts on 2026-09-29, so the clan
  page's "30 days" delta appears no earlier than 2026-10-29; the `/clans` list
  shows the 24 h change instead.
- **Leaderboard text** (region, slogan, rewards) came HTML-escaped with game
  markup (`&lt;color=#…&gt;`). Since 2026-10-01 it is cleaned on collection;
  rows of clans that dropped out of the crawls keep the old text, but the site
  does not show them.
