# Opponent scouting

Whether the bot can name the enemy squadron of a squadron battle at or before
its start, and predict the enemy's players and vehicles. Measured on
2026-10-06 and 2026-10-07: read-only queries on the production database
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
  host's `/tmp`), held open by the game, grows in 128 KiB steps every 4–43 s
  (air and ground battles), deleted 7 s after the mission status turns
  `fail`.
- **Format:** the saved file is a WRPL with `isServer` false (byte 742 is not
  `0x5a`), so `extractReplayEvents` skips it. Header `e5ac0010`, version
  101404, the session ID at offset 732 (e.g. `127b004900818a7a`), a 1,157-byte
  settings BLK, then one zstd stream in 24–32 blocks of ~50–75 KB and the
  results BLK at `resultsBlkOffset`.
- **Player slots** (`02 58 2d f0` packets, `SlotParser` in
  `src/wrpl/replay-events.ts`): user ID (signed), nickname, squadron tag,
  title, team, real nickname; a table of 64 slots. In two custom battles the
  player's slot came at 7.5–8.3 s of stream time, inside the first compressed
  block (it ends at file byte 51,572–54,530): it reaches the disk with the
  temp file's first 128 KiB write.
- **Not measured:** when that first write happens relative to loading and
  spawn; both teams' slots in a battle with other players; whether the
  in-progress header already holds the session ID; the path on Windows.
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
| In-progress replay, slots only | with the first 128 KiB write (timing not measured) | exact roster | game rules unclear; never read past the slots |
| Server replay on the CDN | at the end (+4 s) | exact roster and lineups | too late for the battle |
| `8111` kill feed | first line naming both sides p50 103 s (p10 61, p90 156) | exact tag; a nickname gives squadron and group through the database | the game's own read-only API |
| `8111` all-chat | within 60 s in 9.7% (either team) | bonus | — |
| Server data only | before the battle | top 1 13.0%, top 5 46.5% when visible (90.5%) | — |
| A person after Tab (`/scout`) | ~10–20 s (estimate) | exact tag | needs a person |

Only the in-progress replay can name the enemy before the first spawn without
a person; its first-write timing is the open measurement. The kill feed is the
verified, low-risk automatic source at ~1.7 min. Server data cannot pick the
enemy before the battle ends; once the squadron is known, its last battle (or
the last battle of the first enemy seen) predicts players and vehicles well.

## Ban-safe measurement

What the measurements touched, from no risk to the rules' grey zone:

- **The local API on `8111`** — the game's own browser map, read-only GETs at
  ~1 Hz, as its page polls; no access to the game process.
- **File metadata** of `/tmp/wt_replay_*` and `Replays/` (name, size, times).
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
