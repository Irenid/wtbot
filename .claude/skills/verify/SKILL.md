---
name: verify
description: How to build, run and verify wtbot live
---

# Verifying wtbot

Offline, without the network or the working database: `npm run verify`
(typecheck, tests, smoke checks, replay corpus), `npm run build`,
`npm run verify:workers:dist`, `npm run build:web`; baseline — AGENTS.md,
section 10.

## The running bot (Docker)

First `docker compose ps`: if `wtbot` and `backup` run from this directory,
`./data` is the production bot's volume. Then `npm run dev`/`npm start`,
`npm run battle` and backfill here need the owner's permission: a second
process would get the same Discord token and the same database.

- `docker` says permission denied — run the command through `newgrp docker`
  (`echo '…' | newgrp docker`).
- State and logs — `docker compose ps`, `docker compose logs --since 10m wtbot`.
- Readiness — `curl -s http://127.0.0.1:3000/health` → `{"ok":true}` (no
  token).
- `/api/stats` (`bot.online`, status of every parser), `/api/items?limit=3`,
  `/api/voice` — with `Authorization: Bearer`: read `WEB_TOKEN` from `.env`
  into a shell variable, never print it.
- Logs (the code still prints Russian): `[bot] Готов! Вошёл как …` (ready,
  logged in as); `[parser:*] OK — …` with `сохранено: N, без изменений: M`
  (saved, unchanged; a rerun saves 0); `[ingest] бой …: убийств N, победитель …`
  (battle: kills, winner; a run of `убийств 0, победитель ?` means a game patch
  broke parsing); `[watchdog]` — event-loop stalls.
- New code reaches the bot only through an image rebuild and restart — that is
  a deploy, only with permission (order — AGENTS.md, section 3).

## Local run (where no production bot runs)

`npm run dev` — bot, site (:3000) and parsers in one process; needs a filled
`.env` with its own `TOKEN`, otherwise announcements are doubled. Readiness —
`curl -s --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/health`.
`GET /statistics` — the HTML dashboard, `GET /` — the site; the `analysis`
field in `/api/items` is filled by `npm run analyze` (paid,
`ANTHROPIC_API_KEY`). `npm run deploy:commands`
(needs `CLIENT_ID`, `GUILD_ID`; changes the commands in Discord) prints
`Зарегистрировано команд: N — на сервере … (мгновенно)` (N commands
registered); only a live user can press the commands.

Windows: TaskStop of a background shell leaves the child node alive — find the
PID on port 3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`) and
`taskkill /PID <pid> /T /F`; in git-bash `/tmp` may point to a missing drive —
keep temporary files in the scratchpad; `ExperimentalWarning: SQLite` on
Node 24 is expected.

`.env` values may be quoted: dotenv strips the quotes, hand-written `.env`
readers must strip them too.
