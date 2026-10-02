---
name: verify
description: Как собрать, запустить и проверить wtbot вживую
---

# Проверка wtbot

Офлайн (без сети и рабочей базы, Node ≥ 22.15): `npm run verify` — typecheck,
тесты, офлайн-smoke и корпус реплеев; плюс `npm run build`,
`npm run verify:workers:dist`, `npm run build:web`. Baseline — AGENTS.md,
раздел 10.

## Работающий бот (Docker)

Сначала `docker compose ps`: если сервисы `wtbot` и `backup` запущены из
этого каталога, `./data` — том боевого бота с рабочей базой. Тогда здесь не
запускай `npm run dev`/`npm start`, `npm run battle` и backfill без
разрешения пользователя: второй процесс получил бы тот же Discord-токен и ту
же базу.

- Если `docker` отвечает permission denied — команду через `newgrp docker`
  (`echo '…' | newgrp docker`).
- Состояние и логи: `docker compose ps`, `docker compose logs --since 10m wtbot`.
- Готовность: `curl -s http://127.0.0.1:3000/health` → `{"ok":true}` (без токена).
- `/api/stats` (`bot.online`, статус каждого парсера), `/api/items?limit=3`,
  `/api/voice` — с `Authorization: Bearer`; `WEB_TOKEN` читать из `.env` в
  переменную оболочки и не выводить.
- В логах: `[bot] Готов! Вошёл как …`; `[parser:*] OK — … сохранено: N, без
  изменений: M` (повторный запуск — сохранено 0); `[ingest] бой …: убийств N,
  победитель …` (сплошные «убийств 0, победитель ?» — поломка разбора после
  патча игры); `[watchdog]` — паузы event loop.
- Новый код попадает в бота только пересборкой образа и перезапуском — это
  выкатка, только с разрешения пользователя.

## Локальный запуск (где нет боевого бота)

`npm run dev` — бот, сайт (:3000) и парсеры в одном процессе; нужен
заполненный `.env` и свой `TOKEN`, иначе анонсы задвоятся. Готовность —
`curl -s --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/health`.
`GET /` — HTML-дашборд; поле `analysis` в `/api/items` заполняет
`npm run analyze` (платно, `ANTHROPIC_API_KEY`). Регистрация slash-команд —
`npm run deploy:commands` (нужны `CLIENT_ID` и `GUILD_ID`; меняет команды в
Discord) → «Зарегистрировано команд: N — на сервере … (мгновенно)». Нажать
команды в Discord из сессии нельзя — только живым пользователем.

Windows:

- остановка dev-сервера: TaskStop фоновой оболочки оставляет дочерний node
  живым — найти PID на порту 3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`)
  и `taskkill /PID <pid> /T /F`;
- в git-bash `/tmp` может указывать на несуществующий диск — временные файлы
  класть в scratchpad;
- `ExperimentalWarning: SQLite` при старте на Node 24 — норма.

Значения в `.env` могут быть в кавычках: dotenv их снимает, самописные
скрипты чтения `.env` должны снимать тоже.
