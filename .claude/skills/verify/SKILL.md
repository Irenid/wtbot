---
name: verify
description: Как собрать, запустить и проверить wtbot вживую
---

# Проверка wtbot

Офлайн, без сети и рабочей базы: `npm run verify` (typecheck, тесты, smoke,
корпус реплеев), `npm run build`, `npm run verify:workers:dist`,
`npm run build:web`; baseline — AGENTS.md, раздел 10.

## Работающий бот (Docker)

Сначала `docker compose ps`: если `wtbot` и `backup` запущены из этого
каталога, `./data` — том боевого бота. Тогда `npm run dev`/`npm start`,
`npm run battle` и backfill здесь — только с разрешения пользователя: второй
процесс получил бы тот же Discord-токен и ту же базу.

- `docker` отвечает permission denied — команду через `newgrp docker`
  (`echo '…' | newgrp docker`).
- Состояние и логи — `docker compose ps`, `docker compose logs --since 10m wtbot`.
- Готовность — `curl -s http://127.0.0.1:3000/health` → `{"ok":true}` (без
  токена).
- `/api/stats` (`bot.online`, статус каждого парсера), `/api/items?limit=3`,
  `/api/voice` — с `Authorization: Bearer`: `WEB_TOKEN` прочитать из `.env` в
  переменную оболочки, не выводить.
- Логи: `[bot] Готов! Вошёл как …`; `[parser:*] OK — …` с
  `сохранено: N, без изменений: M` (повторный запуск — сохранено 0);
  `[ingest] бой …: убийств N, победитель …` (сплошные
  «убийств 0, победитель ?» — разбор сломан патчем игры); `[watchdog]` — паузы
  event loop.
- Новый код попадает в бота только пересборкой образа и перезапуском — это
  выкатка, только с разрешения (порядок — AGENTS.md, раздел 3).

## Локальный запуск (где нет боевого бота)

`npm run dev` — бот, сайт (:3000) и парсеры в одном процессе; нужен
заполненный `.env` со своим `TOKEN`, иначе анонсы задвоятся. Готовность —
`curl -s --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/health`.
`GET /` — HTML-дашборд; поле `analysis` в `/api/items` заполняет
`npm run analyze` (платно, `ANTHROPIC_API_KEY`). `npm run deploy:commands`
(нужны `CLIENT_ID`, `GUILD_ID`; меняет команды в Discord) печатает
«Зарегистрировано команд: N — на сервере … (мгновенно)»; нажать команды можно
только живым пользователем.

Windows: TaskStop фоновой оболочки оставляет дочерний node — найти PID на
порту 3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`) и
`taskkill /PID <pid> /T /F`; в git-bash `/tmp` может указывать на
несуществующий диск — временные файлы класть в scratchpad;
`ExperimentalWarning: SQLite` на Node 24 — норма.

Значения `.env` бывают в кавычках: dotenv их снимает, самописный разбор `.env`
должен снимать тоже.
