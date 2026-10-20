# Squadrons

What the bot stores about squadrons and how the site ranks them. Contracts:
AGENTS.md section 6 (`wt-clans`, claninfo) and section 8 (the site); this
file keeps the stored fields, the reasons and the measurements.

## Leaderboard crawl (`wt-clans`)

- A tag missing from the dictionary belongs to a squadron that began playing
  after the last full crawl (1.9% of teams on 2026-10-03); the battle post's
  last update then asks for the full crawl at once (AGENTS.md section 6).
- A crawl writes `clans` with one shared `rating_at`; the change points of
  rating, battles, wins, kills and deaths to `clan_rating_history`; the core
  tags it read, in place order, and whether it was full to `clan_crawls`,
  kept `CLAN_CRAWL_KEEP_SEC` (3 days): change points cannot tell an unchanged
  squadron from one the crawl missed. The leaderboard's season goes to
  `bot_state` `wt-clans:season`; a mismatch with the forum's season
  (`wt-clan-season`) shows in the source status. Both run on UTC days
  (season 62: [2026-09-01, 11-01) 00:00 UTC); only a stage's max BR switches
  later, at 14:00 UTC (`STAGE_SWITCH_DELAY_SEC`, AGENTS.md section 8).
- A forum post in a new format fails `wt-clan-season` with a parse error (the
  dashboard and the source status show it): fix `src/clan-season-forum.ts`;
  the seasons already stored stay.
- Region, type, slogan and rewards arrive HTML-escaped with game markup
  (`<color=#…>`, `<b>`): plain text is stored. Tag and name stay as they are:
  they key battles and claninfo.
- Profile: `_id` (survives tag changes), description and announcement (line
  breaks kept, ≤ 2048 chars), `membership_req` `{ranks, battles}`,
  auto-accept, the undecorated tag `lastPaidTag`, last season's decoration.
  The founding date is the leaderboard's `cdate`: claninfo shows
  "01.01.1970".

## Rosters (claninfo)

- After a crawl, the claninfo rosters of 5 leaders whose roster is older than
  a day: otherwise only clans from drawn battles would have rosters and PSR.
  Per member: role (the deputy's cell reads the untranslated key
  `clan/deputy`), join date, activity; an unknown cell value becomes `NULL`.
- `clan_roster` is the last non-empty roster, keyed by the core tag (a
  decoration change does not bring back members who left). A member missing
  from a read has left, but a read with fewer than half of a stored roster of
  at least 4 removes nobody: a broken parse must not empty a squadron. The
  site filters the roster, members' PSR and their deltas by it.
- A member links to an identity by alias, else to the single WT user id of
  the exact nick in replays (a reused nick: none), else to
  `/players/nick/:nick` — the matching of `resolveKnownPlayer` without its
  writes: a GET creates no identity; that page then looks the id up
  (`POST /api/player-id`).

## Ranking on the site

- Rating, place, the list's 24 h change, the clan page's "30 days" delta and
  chart are official, from the leaderboard: PSR snapshots exist only for
  clans from drawn battles, and their sum missed the leaders.
- Tiers (`RANK_TIER_*` in `src/web/routes/site.ts`): the latest crawl;
  earlier crawls since the last full one; clans with a rating above zero that
  the last full crawl missed (`wt-clans:full-crawl-at`; disbanded or fallen
  to zero: a stale rating would outrank clans in the table); then clans
  without official data, rated by the PSR sum from snapshots (a zero sum —
  seen only in an earlier season — is left out of the list and the home
  count; its page still opens). A zero rating below the crawled part is
  confirmed by the full crawl, not dropped.
- A renamed squadron (one leaderboard `_id`, else one founding time) is one
  row under its newest core tag (`renamedClanCores`; its old core used to
  keep its last row among the dropped: 4 squadrons on 2026-10-05); old links,
  favourites and search resolve to it, its history and crawl reads stay under
  the old core.
- The 24 h change and the day's battles and wins end at the clan's own
  confirmation time (top 100 every 20 min, the rest at full crawls) and start
  at the `clan_crawls` read nearest a day before it, at most
  `DAY_BASE_MAX_SHIFT_SEC` (6 h) off and no further than the log's start;
  otherwise at the last history point before that mark (alone it gave the
  rest 32–36 h, 2026-10-05). `/api/clans` returns the window (`delta24hFrom`,
  `delta24hTo`; null after that fallback: history cannot tell when the base
  was read).
- A squadron's page (`/api/clans/:coreTag`) carries its row's day figures,
  places moved and live mark from the same snapshot, and `ranking`: the
  table's size, leader, tier cut-offs, records and the neighbours one place
  up and down (null unless both are `current`: a dropped or estimated rating
  is no score to pass).

## `/api/clans` views

`src/web/clan-ranking.ts`: `sort` (place/change/battles/winRate/kd/members),
`dir`, `live`, `tags` (≤ 50 core tags: the SPA's favourites, kept only in the
browser's localStorage); search → filters → sort → page.

- A win rate or K/D from fewer than `MIN_RATE_BATTLES` (50) season battles
  sorts after the rest and holds no record.
- Places moved compare with the table a day before the latest crawl, rebuilt
  from `clan_crawls` (`clanPlacesAt`: squadrons dropped since keep their
  place; none until the log holds a full crawl before that moment).
- "Playing now" (`recentBattles`): squadron battles from replays that ended
  within `LIVE_WINDOW_SEC` (45 min), for every squadron; a team counts when
  its tagged players share one core tag; no marks while `wt-replays` has had
  no successful run for `LIVE_MAX_REPLAY_AGE_SEC` (10 min). The leaderboard's
  battle counts lagged a crawl or two and marked top-100 entrants for old
  battles.
