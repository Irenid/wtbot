# wtbot

A Discord bot, website and War Thunder squadron battle statistics collector in
one Node.js process. The bot collects replays from warthunder.com, parses
`.wrpl` files and stores battles, players, kills and chat in SQLite. Results
appear in Discord (`/battle`, auto-announcements, `/scout` — an enemy
squadron's likely players and vehicles, a player board built from voice
channels) and on the site (`/`; the bot dashboard is `/statistics`).

## Documentation

| File | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | architecture and contracts for developers and agents |
| [ROADMAP.md](ROADMAP.md) | the only list of open tasks |
| [docs/database.md](docs/database.md) | database: measurements, blob format, data errors, migration rollback |
| [docs/performance.md](docs/performance.md) | performance measurements, gates, rollback |
| [docs/replay-data-quality.md](docs/replay-data-quality.md) | what replays can and cannot tell |
| [docs/opponent-scouting.md](docs/opponent-scouting.md) | naming the enemy squadron; the `/scout` model and its accuracy |
| [LICENSES/](LICENSES/README.md) | licenses of ported code |

## Where things run

| Environment | Purpose | How |
| --- | --- | --- |
| Docker on Linux | production | `docker compose up -d --build` |
| Linux or Windows | development and tests | `npm run dev`, `npm test`, `npm run verify` |

warthunder.com is polled with direct requests. Addresses that Cloudflare
checks (player profile and player search) are opened by a real browser
(Edge/Chromium) in a normal window — headless mode fails the check; in Docker
the window lives on an Xvfb virtual display.

Requirements: Docker Engine with Compose (production), Node.js ≥ 22.15
(development; CI tests 24 on Windows and 26 on Linux, as in the image), a
Discord bot token and an authorized warthunder.com session (`WT_COOKIE`).

## Production in Docker

1. Copy `.env.example` to `.env` and fill in at least `TOKEN`, `WT_COOKIE`
   and **`WEB_TOKEN`**: inside the container the server listens on `0.0.0.0`
   and refuses to start without a token.
2. Put the data in `./data` next to `docker-compose.yml`; when moving hosts,
   copy `wtbot.db`, `wt-cookies.json`, `fonts/`, `wt-vehicles.json`,
   `ecshashes.json`, `maps/`, `missions/`. Do not move the browser profile
   (`wt-browser-profile/`): it is tied to the OS, the container creates a new
   one. Nation flags come from the game client: copy `ui/fonts.vromfs.bin`
   and `ui/atlases.vromfs.bin` into `data/wt-game/ui/` and restart the bot;
   without them flags are drawn simplified.
3. `docker compose up -d --build`; logs — `docker compose logs -f wtbot`.
4. Site — `http://127.0.0.1:3000/` on the server itself, the bot dashboard —
   `/statistics`: any user name, password — `WEB_TOKEN`. Old `/app/…` links
   redirect to the same page at the root. For network access put a reverse proxy with TLS
   (nginx, caddy) in front of the bot and set `WEB_TRUST_PROXY`.
5. If Cloudflare wants a manual check or warthunder.com needs a new login,
   set `WT_VNC_PASSWORD`, uncomment port `5900` in `docker-compose.yml` and
   connect a VNC client to `127.0.0.1:5900`.

`wtbot` restarts after a crash (`restart: unless-stopped`);
`docker compose stop` is a clean shutdown (SIGTERM). The `backup` service puts
a checked copy of the database into `./backups` every day at
`WTBOT_BACKUP_TIME` (default 04:30 in `TZ`, default UTC) and keeps the last 3.

Updating: tag the running image for rollback
(`docker tag wtbot:latest wtbot:pre-<version>`), take a one-off backup (below)
and make sure the file is there, then `docker compose up -d --build`. A schema
migration cannot be undone: the previous image will not open the new
database, rollback means the backup ([docs/database.md](docs/database.md)).

The image does not update itself, and its Chromium visits warthunder.com and
StatShark: browser and Debian security fixes arrive only with a rebuild
without the layer cache (otherwise the `apt-get` layer stays old) — every one
or two weeks `docker compose build --pull --no-cache` and
`docker compose up -d`, preferably outside the evening squadron battles.

## Development

```bash
npm ci
npm --prefix frontend ci
cp .env.example .env     # Windows: copy; fill in TOKEN, WT_COOKIE, WT_PLAYER_NAMES
npm run dev              # bot + site http://127.0.0.1:3000 + parsers
```

There is one production database — the bot's in Docker; do not run a local
bot with the same `TOKEN`, or Discord announcements will be doubled. If your
checkout is the directory the compose project runs from, its `data/` is the
running bot's data: `npm run dev`, `npm run battle` and backfill write to the
production database.

- SPA on the server's data without a local database: `WTBOT_API_URL` (the
  site's address behind the reverse proxy) and `WTBOT_API_TOKEN` (its
  `WEB_TOKEN`) in `.env`, then `npm run dev:web` →
  `http://127.0.0.1:5173/`.
- Site on the `DB_PATH` database without the bot: `npm run site` →
  `http://127.0.0.1:3210/`.
- Demo on synthetic data without a database:
  `npx tsx src/analysis/site-preview.ts` (same address).
- Site design-system mockups — `frontend/design/`. Stop with `Ctrl+C`.

## Checks

```bash
npm run build            # backend into dist/ (no tests)
npm run verify           # typecheck, npm test and all offline smoke checks
npm run verify:workers:dist
npm run build:web        # SPA into frontend/dist/
```

No network and no writes to the working database: tests and smoke checks use
SQLite `:memory:` and temporary files. CI runs the same on Linux and Windows
(`.github/workflows/ci.yml`) and also builds the Docker image.

## Backup and restore

- One-off backup: `npm run db:backup` or
  `docker compose run --rm --no-deps backup node dist/analysis/db-backup.js /backups 3`
  (without `--no-deps` Compose recreates the running `wtbot` if its
  configuration changed). The copy is made with `VACUUM INTO`, checked with
  `PRAGMA quick_check` and published atomically.
- Restore: stop the bot, check the copy with `quick_check`, rename the current
  `wtbot.db` to `wtbot.db.pre-restore`, put the copy at `DB_PATH`, start the
  bot without `WTBOT_ALLOW_NEW_DB` and check `/health`.

Replay parts live on the CDN for about two weeks: battles from a longer
downtime cannot be collected any more.

## Security

- By default the site listens only on `127.0.0.1` and rejects a foreign
  `Host` (DNS rebinding) and cross-origin POSTs (CSRF); network mode needs
  `WEB_TOKEN` (Bearer or HTTP Basic password).
- Never publish `.env`, `data/wt-cookies.json` or `data/wtbot.db`: they hold
  tokens, cookies, Discord IDs and battle chat.

## License

GNU AGPL-3.0-or-later, see [LICENSE](LICENSE). Part of `src/wrpl/*` is a port
of [wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector)
(AGPL-3.0), `src/wrpl/gm-sync.ts` is based on
[WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser) and
Dagor Engine (BSD-3-Clause); origins are in the file headers, license texts in
[LICENSES/](LICENSES/README.md). The site and the dashboard link to the source
code, as the AGPL requires for network services.
