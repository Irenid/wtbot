---
name: verify
description: Как собрать, запустить и проверить wtbot вживую
---

# Проверка wtbot

Запуск (Node ≥ 22.15, `.env` должен быть заполнен):

```bash
npm run dev        # фоном; бот + сайт (:3000) + парсеры в одном процессе
```

Готовность: `curl -s --retry 15 --retry-connrefused --retry-delay 1 http://localhost:3000/health` → `{"ok":true}`

Что наблюдать:

- лог запуска: `[bot] Готов! Вошёл как …`, `[parser:*] OK — … сохранено: N, без изменений: M` (дедупликация: при повторном запуске сохранено 0);
- `GET /api/stats` — `bot.online: true`, статусы парсеров, счётчики items;
- `GET /api/items?limit=3` — собранные записи; поле `analysis` заполняется после `npm run analyze` (нужен `ANTHROPIC_API_KEY` в `.env`);
- `GET /` — HTML-дашборд;
- регистрация slash-команд: `npm run deploy:commands` (нужны `CLIENT_ID` и `GUILD_ID` в `.env`) → «Зарегистрировано команд: N — на сервере … (мгновенно)». Сами команды в Discord нажать из сессии нельзя — только живым пользователем.

Docker (боевой запуск на Linux): `docker compose up -d --build`, логи — `docker compose logs -f wtbot`, `/health` отвечает на `127.0.0.1:3000` хоста; сайт требует `WEB_TOKEN` (HTTP Basic, пароль = токен).

Гочи (Windows):

- остановка dev-сервера: TaskStop фоновой оболочки оставляет дочерний node живым — найти PID на порту 3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`) и `taskkill /PID <pid> /T /F`;
- в git-bash `/tmp` указывает на несуществующий `D:\tmp` — временные файлы класть в scratchpad;
- значения в `.env` могут быть в кавычках: dotenv их снимает, самописные скрипты чтения `.env` должны снимать тоже;
- `ExperimentalWarning: SQLite` при старте — норма (node:sqlite в Node 24).
